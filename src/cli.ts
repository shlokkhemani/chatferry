#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  cliSchema,
  jsonErrorPayload,
  validateCliPath,
  validateConversationUrl,
  validateRunId,
} from "./cli-contract.js";
import {
  ensureDaemon,
  isDaemonActive,
  readDaemonState,
  submitDaemonRequest,
} from "./daemon.js";
import { readSavedChatDocument } from "./document.js";
import {
  buildProvider,
  executeReadOperation,
  executeReloadOperation,
  providerFromConversationUrl,
  withProviderSession,
} from "./service.js";
import {
  appendRunStatus,
  createRun,
  isTerminalRunStatus,
  listRunsResolved,
  readRunResolved,
  type RunRecord,
  type RunStatus,
} from "./runs.js";
import { LOGIN_REMINDER_INTERVAL_MS, LOGIN_WAIT_POLL_MS } from "./timing.js";
import type { ProviderModelCatalog, ProviderName } from "./types.js";
import { renderModelCatalog } from "./models.js";

function emitResult(json: boolean | undefined, value: unknown, fallback: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${fallback}\n`);
}

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  return prompt.length > 0 ? prompt : null;
}

async function resolvePromptInput(args: {
  promptTokens?: string[];
  promptFile?: string;
}): Promise<string> {
  const hasTokens = Boolean(args.promptTokens && args.promptTokens.length > 0);
  if (hasTokens && args.promptFile) {
    throw new Error("Provide either positional prompt text or --file, not both.");
  }

  if (args.promptFile) {
    return fs.readFile(path.resolve(validateCliPath(args.promptFile, "prompt file")), "utf8");
  }

  if (hasTokens) {
    return args.promptTokens!.join(" ");
  }

  const stdinPrompt = await readPromptFromStdin();
  if (stdinPrompt !== null) {
    return stdinPrompt;
  }

  throw new Error("No prompt provided. Pass prompt text, use --file, or pipe stdin.");
}

function serializeRun(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.id,
    provider: run.provider,
    status: run.status,
    model: run.observedModel?.label ?? run.requestedModel ?? null,
    prompt_preview: run.promptPreview,
    output_path: run.outputPath,
    chat_url: run.chatUrl,
    created_at: run.createdAt,
    completed_at: run.completedAt,
    error: run.error,
  };
}

function humanRunSummary(run: RunRecord): string {
  return [
    `run_id=${run.id}`,
    `status=${run.status}`,
    `provider=${run.provider}`,
    `model=${run.observedModel?.label ?? run.requestedModel ?? "-"}`,
    `chat_url=${run.chatUrl ?? "-"}`,
    `output_path=${run.outputPath}`,
    ...(run.error ? [`error=${run.error.split("\n")[0]}`] : []),
  ].join("\n");
}

async function waitForRun(args: {
  runId: string;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<RunRecord> {
  const deadline = Date.now() + args.timeoutMs;
  const intervalMs = args.intervalMs ?? 1_000;
  let current = await readRunResolved(args.runId);
  while (Date.now() < deadline) {
    if (isTerminalRunStatus(current.status)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    current = await readRunResolved(args.runId);
  }
  return current;
}

async function submitRunInternal(args: {
  provider: ProviderName;
  prompt: string;
  model?: string;
  output?: string;
  acceptanceTimeoutMs: number;
}): Promise<RunRecord> {
  const run = await createRun({
    provider: args.provider,
    prompt: args.prompt,
    requestedModel: args.model ?? null,
    output: args.output,
  });

  try {
    await ensureDaemon();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await appendRunStatus({
      runId: run.id,
      status: "failed",
      message: "Failed to start provider daemon",
      patch: {
        failedAt: new Date().toISOString(),
        error: message,
      },
    });
    throw error;
  }

  // Wait until the run is picked up (moves from queued to running/completed/failed)
  const deadline = Date.now() + args.acceptanceTimeoutMs;
  let current = await readRunResolved(run.id);
  while (Date.now() < deadline && current.status === "queued") {
    await new Promise((resolve) => setTimeout(resolve, 750));
    current = await readRunResolved(run.id);
  }
  return current;
}

async function login(providerName: ProviderName): Promise<void> {
  if (await isDaemonActive()) {
    throw new Error(`${providerName} provider daemon is active. Wait for it to go idle before running login.`);
  }

  await withProviderSession(providerName, async (provider, page) => {
    const profilePath = path.resolve("profiles", "shared");
    process.stdout.write(
      [
        `Starting ${providerName} login`,
        "",
        `Profile: ${profilePath}`,
        "",
        "What to do in the browser:",
        "1. Sign in to your account.",
        "2. Complete any MFA or email verification.",
        "3. Wait until the normal chat composer is visible.",
        "",
        "Login detection is automatic. Leave the browser window open.",
        "Press Ctrl+C in this terminal to cancel.",
        "",
      ].join("\n"),
    );

    if (await provider.isLoggedIn(page)) {
      process.stdout.write(`${providerName} already looks logged in.\n`);
    } else {
      let lastReminderAt = 0;
      let dotCount = 0;
      while (!(await provider.isLoggedIn(page))) {
        if (Date.now() - lastReminderAt >= LOGIN_REMINDER_INTERVAL_MS) {
          process.stdout.write(`Waiting for ${providerName} login`);
          lastReminderAt = Date.now();
          dotCount = 0;
        }
        process.stdout.write(".");
        dotCount += 1;
        if (dotCount >= 20) {
          process.stdout.write("\n");
          dotCount = 0;
        }
        await page.waitForTimeout(LOGIN_WAIT_POLL_MS);
      }
      process.stdout.write("\n");
    }

    process.stdout.write(`${providerName} login detected.\n`);
    const catalog = await provider.listModels(page).catch(() => null);
    if (catalog && catalog.inputs.length > 0) {
      for (const line of renderModelCatalog(catalog)) {
        process.stdout.write(`${line}\n`);
      }
    }

    process.stdout.write(
      [
        "",
        "Next steps:",
        `- npm exec -- chatferry models ${providerName}`,
        `- npm exec -- chatferry ask ${providerName} "Reply with exactly: hello"`,
        "",
      ].join("\n"),
    );
  });
}

async function setupCommand(provider?: ProviderName): Promise<void> {
  const providers: ProviderName[] = provider ? [provider] : ["chatgpt", "claude"];
  process.stdout.write(
    [
      "ChatFerry setup",
      "",
      "This will launch one provider at a time in a dedicated persistent browser profile.",
      "If you are already logged in, the step will auto-detect that and continue.",
      "",
    ].join("\n"),
  );

  for (const currentProvider of providers) {
    await login(currentProvider);
  }

  process.stdout.write(
    [
      "Setup complete.",
      "",
      "Try one of these next:",
      "- npm exec -- chatferry models chatgpt",
      '- npm exec -- chatferry ask chatgpt "Reply with exactly: hello"',
      '- npm exec -- chatferry ask claude "Reply with exactly: hello"',
      "",
    ].join("\n"),
  );
}

async function listModelsCommand(providerName: ProviderName, json: boolean): Promise<void> {
  if (await isDaemonActive()) {
    const result = await submitDaemonRequest({
      provider: providerName,
      request: { type: "models" },
    }) as ProviderModelCatalog;
    if (json) {
      emitResult(true, result, "");
      return;
    }
    for (const line of renderModelCatalog(result as never)) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  await withProviderSession(providerName, async (provider, page) => {
    if (!(await provider.isLoggedIn(page))) {
      throw new Error(`${providerName} is not logged in. Run: npm exec -- chatferry login ${providerName}`);
    }

    const catalog = await provider.listModels(page);
    if (catalog.inputs.length === 0) {
      throw new Error(`No models detected for ${providerName}`);
    }

    if (json) {
      emitResult(true, catalog, "");
      return;
    }

    for (const line of renderModelCatalog(catalog)) {
      process.stdout.write(`${line}\n`);
    }
  });
}

async function askCommand(args: {
  provider: ProviderName;
  prompt: string;
  model?: string;
  output?: string;
  json?: boolean;
  wait: boolean;
  acceptanceTimeoutSeconds: number;
  timeoutSeconds: number;
}): Promise<void> {
  const initial = await submitRunInternal({
    provider: args.provider,
    prompt: args.prompt,
    model: args.model,
    output: args.output,
    acceptanceTimeoutMs: Math.max(1, args.acceptanceTimeoutSeconds) * 1_000,
  });

  if (!args.wait) {
    emitResult(args.json, serializeRun(initial), humanRunSummary(initial));
    if (isTerminalRunStatus(initial.status) && initial.status !== "completed") {
      throw new Error(initial.error ?? `Run ${initial.id} ended with status ${initial.status}`);
    }
    return;
  }

  const run = await waitForRun({
    runId: initial.id,
    timeoutMs: Math.max(1, args.timeoutSeconds) * 1_000,
  });

  if (run.status !== "completed") {
    throw new Error(run.error ?? `Run ${run.id} ended with status ${run.status}`);
  }

  emitResult(args.json, serializeRun(run), run.outputPath);
}

async function statusCommand(args: {
  runId: string;
  json?: boolean;
}): Promise<void> {
  const run = await readRunResolved(validateRunId(args.runId));
  emitResult(args.json, serializeRun(run), humanRunSummary(run));
}

async function resultCommand(args: {
  runId: string;
  json?: boolean;
}): Promise<void> {
  const run = await readRunResolved(validateRunId(args.runId));
  if (run.status !== "completed") {
    throw new Error(run.error ?? `Run ${run.id} is not completed yet. Current status=${run.status}`);
  }

  emitResult(args.json, serializeRun(run), run.outputPath);
}

async function waitCommand(args: {
  runId: string;
  timeoutSeconds: number;
  json?: boolean;
}): Promise<void> {
  const runId = validateRunId(args.runId);
  const run = await waitForRun({
    runId,
    timeoutMs: Math.max(1, args.timeoutSeconds) * 1_000,
  });

  emitResult(
    args.json,
    serializeRun(run),
    run.status === "completed" ? run.outputPath : humanRunSummary(run),
  );

  if (!isTerminalRunStatus(run.status)) {
    throw new Error(`Timed out waiting for ${runId}. Current status=${run.status}`);
  }
  if (run.status !== "completed") {
    throw new Error(run.error ?? `Run ${runId} ended with status ${run.status}`);
  }
}

async function runsCommand(args: {
  provider?: ProviderName;
  status?: RunStatus;
  limit: number;
  json?: boolean;
}): Promise<void> {
  const allRuns = await listRunsResolved();
  const filtered = allRuns
    .filter((run) => !args.provider || run.provider === args.provider)
    .filter((run) => !args.status || run.status === args.status)
    .slice(0, args.limit);

  if (args.json) {
    emitResult(true, filtered.map((run) => serializeRun(run)), "");
    return;
  }

  if (filtered.length === 0) {
    process.stdout.write("No runs.\n");
    return;
  }

  for (const run of filtered) {
    process.stdout.write(`${run.id} ${run.status} ${run.provider} ${run.observedModel?.label ?? run.requestedModel ?? "-"} ${run.outputPath}\n`);
  }
}

async function cancelCommand(args: {
  runId: string;
  json?: boolean;
}): Promise<void> {
  const runId = validateRunId(args.runId);
  const run = await readRunResolved(runId);
  if (!isTerminalRunStatus(run.status)) {
    await appendRunStatus({
      runId: run.id,
      status: "cancelled",
      message: "Run cancelled",
      patch: {
        cancelledAt: new Date().toISOString(),
        error: run.error,
      },
    });
  }

  const updated = await readRunResolved(runId);
  emitResult(args.json, serializeRun(updated), humanRunSummary(updated));
}

async function daemonStatusCommand(args: {
  provider?: ProviderName;
  json?: boolean;
}): Promise<void> {
  const daemon = await readDaemonState();
  const providers: ProviderName[] = args.provider ? [args.provider] : ["chatgpt", "claude"];

  const payload = providers.map((provider) => {
    const providerState = daemon?.providers?.[provider];
    return {
      provider,
      active: daemon !== null,
      pid: daemon?.pid ?? null,
      concurrency: providerState?.concurrency ?? null,
      active_runs: providerState?.activeSlots?.filter((s) => s.kind === "run").length ?? 0,
    };
  });

  if (args.json) {
    emitResult(true, args.provider ? payload[0] ?? null : payload, "");
    return;
  }

  for (const item of payload) {
    process.stdout.write(`${item.provider} active=${item.active} concurrency=${item.concurrency ?? "-"} running=${item.active_runs}\n`);
  }
}

async function reloadCommand(args: {
  source: string;
  output?: string;
  json?: boolean;
}): Promise<void> {
  const source = validateCliPath(args.source, "source path");
  const saved = await readSavedChatDocument(source);
  if (!saved.chatUrl) {
    throw new Error(`No chat_url found in ${saved.sourcePath}`);
  }

  if (await isDaemonActive()) {
    const result = await submitDaemonRequest({
      provider: saved.provider,
      request: {
        type: "reload",
        source: saved.sourcePath,
        output: args.output ? validateCliPath(args.output, "output path") : undefined,
      },
    }) as Record<string, unknown>;
    emitResult(args.json, result, String(result.output_path ?? saved.sourcePath));
    return;
  }

  const result = await executeReloadOperation({
    provider: saved.provider,
    prompt: saved.prompt,
    chatUrl: saved.chatUrl,
    output: args.output ? validateCliPath(args.output, "output path") : saved.sourcePath,
  });

  emitResult(
    args.json,
    {
      provider: saved.provider,
      status: "completed",
      output_path: result.outputPath,
      chat_url: result.chatUrl,
      model: result.observedModel?.label ?? null,
      markdown_source: result.markdownSource,
    },
    result.outputPath,
  );
}

async function readConversationCommand(args: {
  url: string;
  output?: string;
  json?: boolean;
}): Promise<void> {
  const validatedUrl = validateConversationUrl(args.url);
  const provider = providerFromConversationUrl(validatedUrl);
  if (await isDaemonActive()) {
    const result = await submitDaemonRequest({
      provider,
      request: {
        type: "read",
        url: validatedUrl,
        output: args.output ? validateCliPath(args.output, "output path") : undefined,
      },
    }) as Record<string, unknown>;
    emitResult(args.json, result, String(result.output_path ?? args.output ?? ""));
    return;
  }

  const result = await executeReadOperation({
    provider,
    url: validatedUrl,
    output: args.output ? validateCliPath(args.output, "output path") : undefined,
  });

  emitResult(
    args.json,
    {
      provider: result.provider,
      status: "completed",
      output_path: result.outputPath,
      chat_url: result.chatUrl,
      turns: result.turns,
      artifacts: result.artifacts,
      artifact_dir: result.artifactDir,
    },
    result.outputPath,
  );
}

void yargs(hideBin(process.argv))
  .scriptName("chatferry")
  .command(
    "schema [command]",
    "Describe the CLI contract in machine-readable form",
    (command) =>
      command
        .positional("command", { type: "string" })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      const payload = cliSchema(argv.command ? String(argv.command) : undefined);
      emitResult(true, payload, "");
      if (payload.status === "invalid_command") {
        process.exitCode = 1;
      }
    },
  )
  .command(
    "setup [provider]",
    "Guided first-run setup for one provider or both providers",
    (command) =>
      command.positional("provider", {
        choices: ["chatgpt", "claude"] as const,
        type: "string",
      }),
    async (argv) => {
      await setupCommand(argv.provider as ProviderName | undefined);
    },
  )
  .command(
    "login <provider>",
    "Open a headed browser and auto-detect manual login completion",
    (command) =>
      command.positional("provider", {
        choices: ["chatgpt", "claude"] as const,
        type: "string",
      }),
    async (argv) => {
      await login(argv.provider as ProviderName);
    },
  )
  .command(
    "models <provider>",
    "List visible models for a logged-in provider",
    (command) =>
      command
        .positional("provider", {
          choices: ["chatgpt", "claude"] as const,
          type: "string",
        })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await listModelsCommand(argv.provider as ProviderName, Boolean(argv.json));
    },
  )
  .command(
    "daemon-status [provider]",
    "Show whether provider daemons are running",
    (command) =>
      command
        .positional("provider", {
          choices: ["chatgpt", "claude"] as const,
          type: "string",
        })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await daemonStatusCommand({
        provider: argv.provider as ProviderName | undefined,
        json: argv.json,
      });
    },
  )
  .command(
    "ask <provider> [prompt...]",
    "Send a prompt and get the markdown export (use --no-wait for async)",
    (command) =>
      command
        .positional("provider", {
          choices: ["chatgpt", "claude"] as const,
          type: "string",
        })
        .positional("prompt", { type: "string", array: true })
        .option("file", {
          alias: "f",
          type: "string",
          describe: "Read the prompt body from a file path",
        })
        .option("model", {
          type: "string",
          describe: "Model label or alias to choose first",
        })
        .option("output", {
          alias: "o",
          type: "string",
          describe: "Output markdown path",
        })
        .option("wait", {
          type: "boolean",
          default: true,
          describe: "Wait for completion (use --no-wait for fire-and-forget)",
        })
        .option("acceptance-timeout", {
          type: "number",
          default: 45,
          describe: "Seconds to wait for the daemon to pick up the run",
        })
        .option("timeout", {
          type: "number",
          default: 1800,
          describe: "Seconds to wait for final completion",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Emit structured JSON instead of plain text",
        }),
    async (argv) => {
      await askCommand({
        provider: argv.provider as ProviderName,
        prompt: await resolvePromptInput({
          promptTokens: (argv.prompt as string[] | undefined) ?? [],
          promptFile: argv.file,
        }),
        model: argv.model,
        output: argv.output ? validateCliPath(String(argv.output), "output path") : undefined,
        json: argv.json,
        wait: Boolean(argv.wait),
        acceptanceTimeoutSeconds: Number(argv.acceptanceTimeout),
        timeoutSeconds: Number(argv.timeout),
      });
    },
  )
  .command(
    "status <runId>",
    "Inspect the current state of a run",
    (command) =>
      command
        .positional("runId", { type: "string" })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await statusCommand({
        runId: argv.runId as string,
        json: argv.json,
      });
    },
  )
  .command(
    "wait <runId>",
    "Wait for a run to complete",
    (command) =>
      command
        .positional("runId", { type: "string" })
        .option("timeout", {
          type: "number",
          describe: "Seconds to wait before returning the current state",
          default: 1800,
        })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await waitCommand({
        runId: argv.runId as string,
        timeoutSeconds: Number(argv.timeout),
        json: argv.json,
      });
    },
  )
  .command(
    "result <runId>",
    "Return the output path for a completed run",
    (command) =>
      command
        .positional("runId", { type: "string" })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await resultCommand({
        runId: argv.runId as string,
        json: argv.json,
      });
    },
  )
  .command(
    "runs",
    "List recent runs",
    (command) =>
      command
        .option("provider", {
          choices: ["chatgpt", "claude"] as const,
          type: "string",
        })
        .option("status", {
          choices: ["queued", "running", "completed", "failed", "cancelled"] as const,
          type: "string",
        })
        .option("limit", { type: "number", default: 20 })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await runsCommand({
        provider: argv.provider as ProviderName | undefined,
        status: argv.status as RunStatus | undefined,
        limit: Number(argv.limit),
        json: argv.json,
      });
    },
  )
  .command(
    "cancel <runId>",
    "Cancel a queued or in-flight run",
    (command) =>
      command
        .positional("runId", { type: "string" })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await cancelCommand({
        runId: argv.runId as string,
        json: argv.json,
      });
    },
  )
  .command(
    "read <url>",
    "Extract a full multi-turn conversation from a private Claude or ChatGPT URL",
    (command) =>
      command
        .positional("url", {
          type: "string",
          describe: "Claude or ChatGPT conversation URL",
        })
        .option("output", {
          alias: "o",
          type: "string",
          describe: "Output markdown path",
        })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await readConversationCommand({
        url: argv.url as string,
        output: argv.output,
        json: argv.json,
      });
    },
  )
  .command(
    "reload <source>",
    "Reopen a saved chat URL from an existing markdown export and refresh that export",
    (command) =>
      command
        .positional("source", {
          type: "string",
          describe: "Existing markdown export containing provider, prompt, and chat_url frontmatter",
        })
        .option("output", {
          alias: "o",
          type: "string",
          describe: "Write the refreshed export to a different path instead of overwriting the source",
        })
        .option("json", { type: "boolean", default: false }),
    async (argv) => {
      await reloadCommand({
        source: argv.source as string,
        output: argv.output,
        json: argv.json,
      });
    },
  )
  .demandCommand(1)
  .strict()
  .fail((msg, err, yargsInstance) => {
    const argv = hideBin(process.argv);
    const wantsJson = argv.includes("--json");
    const message = err instanceof Error ? err.message : (msg || "Unknown error");
    if (wantsJson) {
      process.stderr.write(jsonErrorPayload(message));
      process.exit(2);
    }
    if (msg) {
      yargsInstance.showHelp();
      process.stderr.write(`\n${msg}\n`);
      process.exit(2);
    }
    throw err;
  })
  .help()
  .parseAsync();
