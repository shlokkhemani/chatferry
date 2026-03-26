import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { closeBrowser, getSharedContext, withBrowserLock } from "./browser.js";
import { readSavedChatDocument } from "./document.js";
import { appendRunStatus, listRuns, mutateRun, readRun, readRunPrompt, transitionRunRecord } from "./runs.js";
import {
  buildProvider,
  executeAskOperationInSession,
  executeReadOperationInSession,
  executeReloadOperationInSession,
} from "./service.js";
import type { ProviderName } from "./types.js";
import { DAEMON_LAUNCH_LOCK_STALE_MS, DAEMON_LAUNCH_LOCK_TIMEOUT_MS, DAEMON_SIGKILL_GRACE_MS, DAEMON_SIGTERM_GRACE_MS, DAEMON_STARTUP_TIMEOUT_MS } from "./timing.js";
import { DATA_ROOT, PROJECT_ROOT, acquireFileLock, ensureDir, pidIsAlive, sleep, timestampSlug, writeFileAtomic } from "./utils.js";

const DEFAULT_PROVIDER_CONCURRENCY = 3;
const DEFAULT_IDLE_EXIT_MS = 60_000;
const DEFAULT_STALE_DAEMON_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 300_000;

const ALL_PROVIDERS: ProviderName[] = ["chatgpt", "claude"];

export interface DaemonState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  providers: Record<ProviderName, {
    concurrency: number;
    activeSlots: Array<{
      slotId: string;
      kind: "run" | "request";
      ref: string;
    }>;
  }>;
}

type ControlRequest =
  | {
      id: string;
      type: "models";
      provider: ProviderName;
      createdAt: string;
    }
  | {
      id: string;
      type: "read";
      provider: ProviderName;
      createdAt: string;
      url: string;
      output?: string;
    }
  | {
      id: string;
      type: "reload";
      provider: ProviderName;
      createdAt: string;
      source: string;
      output?: string;
    };

export type ControlRequestInput =
  | {
      type: "models";
    }
  | {
      type: "read";
      url: string;
      output?: string;
    }
  | {
      type: "reload";
      source: string;
      output?: string;
    };

interface ControlResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface ProviderSlot {
  id: string;
  provider: ProviderName;
  page: Page | null;
  activeRunId: string | null;
  activeRequestId: string | null;
  task: Promise<void> | null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function daemonRoot(): string {
  return path.join(DATA_ROOT, "state", "daemons");
}

export function providerConcurrency(provider: ProviderName): number {
  const envName = `CHATFERRY_${provider.toUpperCase()}_CONCURRENCY`;
  return parsePositiveInteger(process.env[envName], DEFAULT_PROVIDER_CONCURRENCY);
}

export function daemonIdleExitMs(): number {
  return parsePositiveInteger(process.env.CHATFERRY_DAEMON_IDLE_EXIT_MS, DEFAULT_IDLE_EXIT_MS);
}

function daemonStaleMs(): number {
  return parsePositiveInteger(process.env.CHATFERRY_DAEMON_STALE_MS, DEFAULT_STALE_DAEMON_MS);
}

export function daemonLogPath(): string {
  return path.join(daemonRoot(), "daemon.log");
}

export function daemonStatePath(): string {
  return path.join(daemonRoot(), "daemon.json");
}

function daemonLaunchLockPath(): string {
  return path.join(daemonRoot(), "daemon.launch.lock");
}

function providerRequestDirectory(provider: ProviderName): string {
  return path.join(daemonRoot(), provider, "requests");
}

function providerActiveRequestDirectory(provider: ProviderName): string {
  return path.join(daemonRoot(), provider, "active");
}

function providerResponseDirectory(provider: ProviderName): string {
  return path.join(daemonRoot(), provider, "responses");
}

function providerResponsePath(provider: ProviderName, requestId: string): string {
  return path.join(providerResponseDirectory(provider), `${requestId}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const source = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(source) as T;
  } catch {
    return null;
  }
}

function isDaemonStateStale(state: DaemonState, now = Date.now()): boolean {
  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  return now - updatedAtMs > daemonStaleMs();
}

export async function readDaemonState(): Promise<DaemonState | null> {
  const state = await readJsonFile<DaemonState>(daemonStatePath());
  if (!state) {
    return null;
  }
  if (!pidIsAlive(state.pid)) {
    await fsPromises.unlink(daemonStatePath()).catch(() => undefined);
    return null;
  }
  if (isDaemonStateStale(state)) {
    await fsPromises.unlink(daemonStatePath()).catch(() => undefined);
    return null;
  }
  return state;
}

export async function isDaemonActive(): Promise<boolean> {
  return (await readDaemonState()) !== null;
}


async function writeDaemonState(state: DaemonState): Promise<void> {
  await writeFileAtomic(daemonStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

async function removeDaemonState(): Promise<void> {
  await fsPromises.unlink(daemonStatePath()).catch(() => undefined);
}

async function terminateStaleDaemon(state: DaemonState): Promise<void> {
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    await removeDaemonState();
    return;
  }

  const deadline = Date.now() + DAEMON_SIGTERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidIsAlive(state.pid)) {
      await removeDaemonState();
      return;
    }
    await sleep(250);
  }

  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // Ignore
  }

  const killDeadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
  while (Date.now() < killDeadline) {
    if (!pidIsAlive(state.pid)) {
      break;
    }
    await sleep(250);
  }

  await removeDaemonState();
}

// Also clean up old per-provider daemon state files from before the unified daemon
async function terminateLegacyDaemons(): Promise<void> {
  for (const provider of ALL_PROVIDERS) {
    const legacyPath = path.join(daemonRoot(), `${provider}.json`);
    const state = await readJsonFile<{ pid: number }>(legacyPath);
    if (!state) {
      continue;
    }
    if (pidIsAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // ignore
      }
      const deadline = Date.now() + DAEMON_SIGKILL_GRACE_MS;
      while (Date.now() < deadline && pidIsAlive(state.pid)) {
        await sleep(250);
      }
    }
    await fsPromises.unlink(legacyPath).catch(() => undefined);
  }
}

function createRequestId(): string {
  return `req_${timestampSlug()}_${randomBytes(3).toString("hex")}`;
}

async function listControlRequests(provider: ProviderName): Promise<ControlRequest[]> {
  const dir = providerRequestDirectory(provider);
  const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const requests: ControlRequest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const request = await readJsonFile<ControlRequest>(path.join(dir, entry.name));
    if (!request) {
      continue;
    }
    requests.push(request);
  }
  return requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function reclaimActiveRequests(provider: ProviderName): Promise<void> {
  const activeDir = providerActiveRequestDirectory(provider);
  const entries = await fsPromises.readdir(activeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const source = path.join(activeDir, entry.name);
    const dest = path.join(providerRequestDirectory(provider), entry.name);
    await fsPromises.rename(source, dest).catch(() => undefined);
  }
}

async function claimControlRequest(provider: ProviderName, requestId: string): Promise<ControlRequest | null> {
  const source = path.join(providerRequestDirectory(provider), `${requestId}.json`);
  const dest = path.join(providerActiveRequestDirectory(provider), `${requestId}.json`);
  await ensureDir(path.dirname(dest));
  try {
    await fsPromises.rename(source, dest);
  } catch {
    return null;
  }
  return readJsonFile<ControlRequest>(dest);
}

async function consumeControlRequest(provider: ProviderName, requestId: string): Promise<void> {
  await fsPromises.unlink(path.join(providerActiveRequestDirectory(provider), `${requestId}.json`)).catch(() => undefined);
}

async function writeControlResponse(provider: ProviderName, requestId: string, response: ControlResponse): Promise<void> {
  await writeFileAtomic(providerResponsePath(provider, requestId), `${JSON.stringify(response, null, 2)}\n`);
}

export async function submitDaemonRequest(args: {
  provider: ProviderName;
  request: ControlRequestInput;
  timeoutMs?: number;
}): Promise<unknown> {
  const requestId = createRequestId();
  const request: ControlRequest = {
    id: requestId,
    provider: args.provider,
    createdAt: new Date().toISOString(),
    ...args.request,
  } as ControlRequest;
  const requestPath = path.join(providerRequestDirectory(args.provider), `${requestId}.json`);
  const responsePath = providerResponsePath(args.provider, requestId);
  const timeoutMs = args.timeoutMs ?? REQUEST_TIMEOUT_MS;

  await ensureDir(path.dirname(requestPath));
  await ensureDir(path.dirname(responsePath));
  await writeFileAtomic(requestPath, `${JSON.stringify(request, null, 2)}\n`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await readJsonFile<ControlResponse>(responsePath);
    if (response) {
      await fsPromises.unlink(responsePath).catch(() => undefined);
      if (!response.ok) {
        throw new Error(response.error ?? `Daemon request ${requestId} failed`);
      }
      return response.value ?? null;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for daemon request ${requestId}`);
}

async function closeSlotPage(slot: ProviderSlot): Promise<void> {
  if (slot.page && !slot.page.isClosed()) {
    await slot.page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
  slot.page = null;
}

function buildSlots(provider: ProviderName, concurrency: number): ProviderSlot[] {
  const slots: ProviderSlot[] = [];
  while (slots.length < concurrency) {
    slots.push({
      id: `${provider}-slot-${slots.length + 1}`,
      provider,
      page: null,
      activeRunId: null,
      activeRequestId: null,
      task: null,
    });
  }
  return slots;
}

async function ensureSlotPage(context: BrowserContext, slot: ProviderSlot): Promise<Page> {
  if (slot.page && !slot.page.isClosed()) {
    return slot.page;
  }
  slot.page = await context.newPage();
  return slot.page;
}

async function closeStartupBlankPages(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) {
    if (!page.isClosed() && page.url() === "about:blank") {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }
}

async function claimQueuedRun(runId: string, slotId: string): Promise<boolean> {
  const run = await mutateRun(runId, (record) =>
    transitionRunRecord(record, "running", `Run claimed by daemon on ${slotId}`, {
      workerPid: process.pid,
      error: null,
    }),
  );
  return run.status === "running" && run.workerPid === process.pid;
}

async function runQueuedAsk(args: {
  providerName: ProviderName;
  context: BrowserContext;
  slot: ProviderSlot;
}): Promise<void> {
  const runId = args.slot.activeRunId;
  if (!runId) {
    return;
  }

  try {
    const provider = await buildProvider(args.providerName);
    const run = await readRun(runId);
    if (run.workerPid !== process.pid) {
      return;
    }
    const prompt = await readRunPrompt(run);
    const page = await ensureSlotPage(args.context, args.slot);
    await provider.gotoHome(page);

    const result = await executeAskOperationInSession({
      provider: args.providerName,
      providerAdapter: provider,
      page,
      prompt,
      model: run.requestedModel ?? undefined,
      output: run.outputPath,
      onStage: async (update) => {
        if (update.stage === "running") {
          await appendRunStatus({
            runId,
            status: "running",
            message: `Running on ${args.slot.id}`,
            patch: {
              chatUrl: update.chatUrl ?? null,
              observedModel: update.observedModel ?? null,
            },
          });
        }
      },
    });

    await appendRunStatus({
      runId,
      status: "completed",
      message: `Run completed on ${args.slot.id}`,
      patch: {
        chatUrl: result.chatUrl,
        observedModel: result.observedModel,
        markdownSource: result.markdownSource,
        completedAt: new Date().toISOString(),
        error: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const loginRequired = /not logged in|chatferry login|still does not look logged in/i.test(message);
    await appendRunStatus({
      runId,
      status: "failed",
      message: loginRequired ? "Provider login required" : "Run failed",
      patch: {
        failedAt: new Date().toISOString(),
        error: message,
      },
    });
    throw error;
  } finally {
    if (runId) {
      const finalRun = await readRun(runId).catch(() => null);
      if (finalRun && finalRun.status === "running") {
        await appendRunStatus({
          runId,
          status: "failed",
          message: "Run abandoned by daemon slot",
          patch: {
            failedAt: new Date().toISOString(),
            error: finalRun.error ?? "Run did not reach a terminal state before the daemon slot released it",
          },
        }).catch(() => undefined);
      }
    }
    await closeSlotPage(args.slot).catch(() => undefined);
    args.slot.activeRunId = null;
  }
}

async function handleControlRequest(args: {
  providerName: ProviderName;
  context: BrowserContext;
  slot: ProviderSlot;
  request: ControlRequest;
}): Promise<void> {
  const { providerName, context, slot, request } = args;
  try {
    const provider = await buildProvider(providerName);
    const page = await ensureSlotPage(context, slot);
    await provider.gotoHome(page);

    if (request.type === "models") {
      if (!(await provider.isLoggedIn(page))) {
        throw new Error(`${providerName} is not logged in. Run: chatferry login ${providerName}`);
      }
      const catalog = await provider.listModels(page);
      await writeControlResponse(providerName, request.id, {
        ok: true,
        value: catalog,
      });
      return;
    }

    if (request.type === "read") {
      const result = await executeReadOperationInSession({
        provider: providerName,
        providerAdapter: provider,
        page,
        url: request.url,
        output: request.output,
      });
      await writeControlResponse(providerName, request.id, {
        ok: true,
        value: {
          provider: result.provider,
          status: "completed",
          output_path: result.outputPath,
          chat_url: result.chatUrl,
          turns: result.turns,
          artifacts: result.artifacts,
          artifact_dir: result.artifactDir,
        },
      });
      return;
    }

    const saved = await readSavedChatDocument(request.source);
    if (!saved.chatUrl) {
      throw new Error(`No chat_url found in ${saved.sourcePath}`);
    }
    const result = await executeReloadOperationInSession({
      provider: providerName,
      providerAdapter: provider,
      page,
      prompt: saved.prompt,
      chatUrl: saved.chatUrl,
      output: request.output ?? saved.sourcePath,
    });
    await writeControlResponse(providerName, request.id, {
      ok: true,
      value: {
        provider: saved.provider,
        status: "completed",
        output_path: result.outputPath,
        chat_url: result.chatUrl,
        model: result.observedModel?.label ?? null,
        markdown_source: result.markdownSource,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeControlResponse(providerName, request.id, {
      ok: false,
      error: message,
    }).catch(() => undefined);
    throw error;
  } finally {
    await consumeControlRequest(providerName, request.id).catch(() => undefined);
    await closeSlotPage(slot).catch(() => undefined);
    slot.activeRequestId = null;
  }
}

async function updateCancelledRuns(slots: ProviderSlot[]): Promise<void> {
  for (const slot of slots) {
    if (!slot.activeRunId) {
      continue;
    }
    const run = await readRun(slot.activeRunId).catch(() => null);
    if (!run || run.status !== "cancelled") {
      continue;
    }
    await closeSlotPage(slot).catch(() => undefined);
  }
}

async function refreshDaemonState(
  allSlots: Record<ProviderName, ProviderSlot[]>,
  startedAt: string,
): Promise<void> {
  const providers: Record<ProviderName, DaemonState["providers"][ProviderName]> = {} as never;
  for (const providerName of ALL_PROVIDERS) {
    const slots = allSlots[providerName] ?? [];
    const activeSlots: DaemonState["providers"][ProviderName]["activeSlots"] = [];
    for (const slot of slots) {
      if (slot.activeRunId) {
        activeSlots.push({ slotId: slot.id, kind: "run", ref: slot.activeRunId });
      } else if (slot.activeRequestId) {
        activeSlots.push({ slotId: slot.id, kind: "request", ref: slot.activeRequestId });
      }
    }
    providers[providerName] = {
      concurrency: slots.length,
      activeSlots,
    };
  }

  await writeDaemonState({
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    providers,
  });
}

async function daemon(): Promise<void> {
  const idleExitMs = daemonIdleExitMs();
  const startedAt = new Date().toISOString();

  await withBrowserLock(async () => {
    for (const provider of ALL_PROVIDERS) {
      await reclaimActiveRequests(provider);
    }

    const context = await getSharedContext();
    await closeStartupBlankPages(context);

    const allSlots: Record<ProviderName, ProviderSlot[]> = {} as never;
    for (const provider of ALL_PROVIDERS) {
      allSlots[provider] = buildSlots(provider, providerConcurrency(provider));
    }

    let lastActiveAt = Date.now();

    try {
      while (true) {
        let anyWork = false;

        for (const providerName of ALL_PROVIDERS) {
          const slots = allSlots[providerName]!;
          await updateCancelledRuns(slots);

          const requests = await listControlRequests(providerName);
          const queuedRuns = (await listRuns())
            .filter((run) => run.provider === providerName)
            .filter((run) => run.status === "queued")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

          const activeCount = slots.filter((slot) => slot.task !== null).length;
          if (requests.length > 0 || queuedRuns.length > 0 || activeCount > 0) {
            anyWork = true;
          }

          for (const slot of slots) {
            if (slot.task !== null) {
              continue;
            }

            const nextPendingRequest = requests.shift();
            if (nextPendingRequest) {
              const nextRequest = await claimControlRequest(providerName, nextPendingRequest.id);
              if (!nextRequest) {
                continue;
              }
              slot.activeRequestId = nextRequest.id;
              slot.task = handleControlRequest({
                providerName,
                context,
                slot,
                request: nextRequest,
              })
                .catch((error) => {
                  if (error instanceof Error) {
                    console.error(error.stack ?? error.message);
                  } else {
                    console.error(error);
                  }
                })
                .finally(() => {
                  slot.task = null;
                });
              continue;
            }

            const nextRun = queuedRuns.shift();
            if (!nextRun) {
              continue;
            }
            const claimed = await claimQueuedRun(nextRun.id, slot.id);
            if (!claimed) {
              continue;
            }

            slot.activeRunId = nextRun.id;
            slot.task = runQueuedAsk({
              providerName,
              context,
              slot,
            })
              .catch((error) => {
                if (error instanceof Error) {
                  console.error(error.stack ?? error.message);
                } else {
                  console.error(error);
                }
              })
              .finally(() => {
                slot.task = null;
              });
          }
        }

        if (anyWork) {
          lastActiveAt = Date.now();
        }

        await refreshDaemonState(allSlots, startedAt);

        const allIdle = ALL_PROVIDERS.every((p) =>
          (allSlots[p] ?? []).every((s) => s.task === null),
        );
        if (allIdle && !anyWork && Date.now() - lastActiveAt >= idleExitMs) {
          break;
        }

        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      const allSlotsList = ALL_PROVIDERS.flatMap((p) => allSlots[p] ?? []);
      await Promise.all(allSlotsList.map((slot) => slot.task ?? Promise.resolve()));
      await closeBrowser();
      await removeDaemonState().catch(() => undefined);
    }
  });
}

async function isDaemonCodeStale(state: DaemonState): Promise<boolean> {
  const daemonScript = path.join(PROJECT_ROOT, "dist", "daemon.js");
  try {
    const stat = await fsPromises.stat(daemonScript);
    const startedAtMs = Date.parse(state.startedAt);
    return Number.isFinite(startedAtMs) && stat.mtimeMs > startedAtMs;
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<number> {
  await ensureDir(daemonRoot());
  await terminateLegacyDaemons();

  const existingRaw = await readJsonFile<DaemonState>(daemonStatePath());
  if (existingRaw && pidIsAlive(existingRaw.pid)) {
    if (isDaemonStateStale(existingRaw) || await isDaemonCodeStale(existingRaw)) {
      await terminateStaleDaemon(existingRaw);
    }
  }

  const existing = await readDaemonState();
  if (existing) {
    if (await isDaemonCodeStale(existing)) {
      await terminateStaleDaemon(existing);
    } else {
      return existing.pid;
    }
  }

  const lockPath = daemonLaunchLockPath();
  const release = await acquireFileLock(lockPath, { staleMs: DAEMON_LAUNCH_LOCK_STALE_MS, timeoutMs: DAEMON_LAUNCH_LOCK_TIMEOUT_MS, pollMs: 250 });
  try {
    const current = await readDaemonState();
    if (current) {
      return current.pid;
    }

    const daemonScript = path.join(PROJECT_ROOT, "dist", "daemon.js");
    const logPath = daemonLogPath();
    await ensureDir(path.dirname(logPath));
    const logFd = fs.openSync(logPath, "a");
    try {
      const child = fs.existsSync(daemonScript)
        ? spawnDetached(process.execPath, [daemonScript], logFd)
        : null;
      if (!child) {
        throw new Error("Failed to start daemon");
      }
      const pid = child;

      const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const state = await readDaemonState();
        if (state) {
          return state.pid;
        }
        if (!pidIsAlive(pid)) {
          break;
        }
        await sleep(250);
      }

      try {
        if (pidIsAlive(pid)) {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        // Ignore
      }

      throw new Error(
        `Daemon did not become healthy. Check ${logPath} for launch errors.`,
      );
    } finally {
      fs.closeSync(logFd);
    }
  } finally {
    await release();
  }
}

function spawnDetached(command: string, args: string[], logFd: number): number | null {
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  return child.pid ?? null;
}

export const __daemonTestHelpers = {
  buildSlots: (n: number) => buildSlots("chatgpt", n),
  ensureSlotPage,
  closeSlotPage,
  closeStartupBlankPages,
  isDaemonStateStale,
};

async function main(): Promise<void> {
  const logPath = daemonLogPath();
  await ensureDir(path.dirname(logPath));
  await fsPromises.appendFile(
    logPath,
    `[${new Date().toISOString()}] starting unified daemon concurrency chatgpt=${providerConcurrency("chatgpt")} claude=${providerConcurrency("claude")}\n`,
    "utf8",
  ).catch(() => undefined);

  await daemon();
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  void main().catch((error) => {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
