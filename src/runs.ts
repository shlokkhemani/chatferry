import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultOutputPath } from "./extract.js";
import type { ModelInfo, ProviderName } from "./types.js";
import { RUN_LOCK_TIMEOUT_MS } from "./timing.js";
import { DATA_ROOT, acquireFileLock, ensureDir, normalizeText, pidIsAlive, timestampSlug, writeFileAtomic } from "./utils.js";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunEvent {
  at: string;
  status: RunStatus;
  message: string;
}

export interface RunRecord {
  id: string;
  provider: ProviderName;
  requestedModel: string | null;
  observedModel: ModelInfo | null;
  promptPath: string;
  promptPreview: string;
  outputPath: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  chatUrl: string | null;
  markdownSource: "provider_markdown" | "html_to_markdown" | null;
  workerPid: number | null;
  error: string | null;
  history: RunEvent[];
}

const RUNS_ROOT = path.join(DATA_ROOT, "state", "runs");

export function previewPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 160);
}

function createRunId(): string {
  return `run_${timestampSlug()}_${randomBytes(3).toString("hex")}`;
}

export function runDirectory(runId: string): string {
  return path.join(RUNS_ROOT, runId);
}

export function runRecordPath(runId: string): string {
  return path.join(runDirectory(runId), "run.json");
}

export function runPromptPath(runId: string): string {
  return path.join(runDirectory(runId), "prompt.md");
}

export function runWorkerLogPath(runId: string): string {
  return path.join(runDirectory(runId), "worker.log");
}

function runLockPath(runId: string): string {
  return path.join(runDirectory(runId), "run.lock");
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionRunRecord(
  record: RunRecord,
  to: RunStatus,
  message: string,
  patch?: Partial<RunRecord>,
): RunRecord {
  if (!ALLOWED_TRANSITIONS[record.status].includes(to)) {
    return record;
  }
  const now = new Date().toISOString();
  return {
    ...record,
    ...patch,
    status: to,
    ...(to === "completed" ? { completedAt: patch?.completedAt ?? now } : {}),
    ...(to === "failed" ? { failedAt: patch?.failedAt ?? now } : {}),
    ...(to === "cancelled" ? { cancelledAt: patch?.cancelledAt ?? now } : {}),
    history: [
      ...record.history,
      { at: now, status: to, message },
    ],
  };
}

export async function ensureRunsRoot(): Promise<void> {
  await ensureDir(RUNS_ROOT);
}

export async function createRun(args: {
  provider: ProviderName;
  prompt: string;
  requestedModel?: string | null;
  output?: string;
}): Promise<RunRecord> {
  const id = createRunId();
  const dir = runDirectory(id);
  const createdAt = new Date().toISOString();
  const outputPath = args.output ? path.resolve(args.output) : defaultOutputPath(args.provider, args.prompt);
  const record: RunRecord = {
    id,
    provider: args.provider,
    requestedModel: args.requestedModel ?? null,
    observedModel: null,
    promptPath: runPromptPath(id),
    promptPreview: previewPrompt(args.prompt),
    outputPath,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    chatUrl: null,
    markdownSource: null,
    workerPid: null,
    error: null,
    history: [
      {
        at: createdAt,
        status: "queued",
        message: "Run created",
      },
    ],
  };

  await ensureDir(dir);
  await writeFileAtomic(record.promptPath, args.prompt);
  await writeFileAtomic(runRecordPath(id), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function readRun(runId: string): Promise<RunRecord> {
  const source = await fs.readFile(runRecordPath(runId), "utf8");
  return JSON.parse(source) as RunRecord;
}

export async function readRunPrompt(run: Pick<RunRecord, "promptPath">): Promise<string> {
  return fs.readFile(run.promptPath, "utf8");
}

export async function mutateRun(
  runId: string,
  mutator: (record: RunRecord) => RunRecord,
): Promise<RunRecord> {
  const release = await acquireFileLock(runLockPath(runId), { staleMs: RUN_LOCK_TIMEOUT_MS, timeoutMs: RUN_LOCK_TIMEOUT_MS });
  try {
    const current = await readRun(runId);
    const next = mutator(current);
    const updated = {
      ...next,
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(runRecordPath(runId), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  } finally {
    await release();
  }
}

export async function appendRunStatus(args: {
  runId: string;
  status: RunStatus;
  message: string;
  patch?: Partial<RunRecord>;
}): Promise<RunRecord> {
  return mutateRun(args.runId, (record) =>
    transitionRunRecord(record, args.status, args.message, args.patch),
  );
}

export async function reconcileRun(runId: string): Promise<RunRecord> {
  const run = await readRun(runId);
  if (isTerminalRunStatus(run.status) || run.status === "queued") {
    return run;
  }
  if (pidIsAlive(run.workerPid)) {
    return run;
  }

  const outputStat = await fs.stat(run.outputPath).catch(() => null);
  if (outputStat && outputStat.isFile() && outputStat.size > 0) {
    return appendRunStatus({
      runId,
      status: "completed",
      message: "Reconciled stale run from existing output artifact",
      patch: {
        completedAt: run.completedAt ?? outputStat.mtime.toISOString(),
        error: null,
      },
    });
  }

  return appendRunStatus({
    runId,
    status: "failed",
    message: "Reconciled stale run after worker exit without output artifact",
    patch: {
      failedAt: run.failedAt ?? new Date().toISOString(),
      error:
        run.error ??
        `Worker exited before ${run.id} reached a terminal state and no output artifact was found at ${run.outputPath}`,
    },
  });
}

export async function readRunResolved(runId: string): Promise<RunRecord> {
  return reconcileRun(runId);
}

export async function listRuns(): Promise<RunRecord[]> {
  await ensureRunsRoot();
  const entries = await fs.readdir(RUNS_ROOT, { withFileTypes: true }).catch(() => []);
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      records.push(await readRun(entry.name));
    } catch {
      continue;
    }
  }

  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listRunsResolved(): Promise<RunRecord[]> {
  const records = await listRuns();
  const resolved: RunRecord[] = [];
  for (const record of records) {
    resolved.push(await reconcileRun(record.id));
  }
  return resolved.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
