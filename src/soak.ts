import path from "node:path";
import { closeBrowser, launchPage, withBrowserLock } from "./browser.js";
import { buildModelInfo } from "./models.js";
import {
  buildProvider,
  executeAskOperationInSession,
} from "./service.js";
import { SOAK_INTER_PROMPT_COOLDOWN_MS } from "./timing.js";
import type { Page } from "playwright";
import type { ProviderAdapter, ProviderName } from "./types.js";
import { DATA_ROOT, ensureDir, saveDebugArtifacts, timestampSlug, writeFileAtomic } from "./utils.js";

interface SoakPrompt {
  id: string;
  label: string;
  prompt: string;
  chatgptModel: string;
  claudeModel: string;
  expectsTable?: boolean;
  expectsCodeBlock?: boolean;
  expectsChecklist?: boolean;
}

interface PromptRunResult {
  id: string;
  label: string;
  provider: ProviderName;
  requestedModel: string;
  resolvedModel: string | null;
  status: "ok" | "warning" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputPath?: string;
  chatUrl?: string;
  markdownSource?: "provider_markdown" | "html_to_markdown";
  warnings: string[];
  error?: string;
  debugHtmlPath?: string;
  debugScreenshotPath?: string;
}

interface ProviderRunSummary {
  provider: ProviderName;
  status: "ok" | "warning" | "failed";
  results: PromptRunResult[];
  error?: string;
}

const COMMON_INSTRUCTIONS = [
  "Return a single standalone markdown document inline in chat.",
  "Do not create, attach, or reference a separate file unless the product forces you to.",
  "Do not wrap the entire answer in triple backticks.",
].join(" ");

const SOAK_PROMPTS: SoakPrompt[] = [
  {
    id: "selector-drift-audit",
    label: "Selector Drift Audit",
    prompt: [
      "Research the most failure-prone selector surfaces in consumer AI chat web apps used for browser automation.",
      "Produce a markdown memo with these sections in order: Executive Summary; Drift Surfaces; Ranking Table; Heuristics; Recommended Fallback Ladder; Acceptance Checklist.",
      "Include one table and one TypeScript code block.",
      COMMON_INSTRUCTIONS,
    ].join(" "),
    chatgptModel: "pro/standard",
    claudeModel: "Sonnet 4.6/standard",
    expectsTable: true,
    expectsCodeBlock: true,
    expectsChecklist: true,
  },
  {
    id: "artifact-export-strategy",
    label: "Artifact Export Strategy",
    prompt: [
      "Research robust export strategies for long-form responses when chat products may emit artifacts, downloadable documents, or side-panel files instead of inline text.",
      "Produce a markdown decision memo with these sections: Problem Statement; Failure Cases; Export Strategy Comparison; Preferred Pipeline; Edge Cases; Runbook.",
      "Include one comparison table and one bash code block.",
      COMMON_INSTRUCTIONS,
    ].join(" "),
    chatgptModel: "thinking/standard",
    claudeModel: "Sonnet 4.6/extended",
    expectsTable: true,
    expectsCodeBlock: true,
  },
  {
    id: "anti-bot-operating-model",
    label: "Anti-Bot Operating Model",
    prompt: [
      "Research pragmatic anti-bot-safe operating practices for low-volume automation of paid AI chat products.",
      "Produce a markdown brief with sections: Threat Model; Behavioral Constraints; Browser Strategy; Retry Policy; Human Escalation; Do and Don't Checklist.",
      "Include one table and one checklist.",
      COMMON_INSTRUCTIONS,
    ].join(" "),
    chatgptModel: "pro/extended",
    claudeModel: "Opus 4.6/standard",
    expectsTable: true,
    expectsChecklist: true,
  },
  {
    id: "completion-detection-matrix",
    label: "Completion Detection Matrix",
    prompt: [
      "Research completion detection strategies for streamed chat UIs with thinking phases, tool calls, and rendering lag.",
      "Produce a markdown report with sections: Summary; Signal Inventory; Failure Taxonomy; Scoring Matrix; Recommended State Machine; Verification Checklist.",
      "Include one table and one TypeScript or pseudocode code block.",
      COMMON_INSTRUCTIONS,
    ].join(" "),
    chatgptModel: "thinking/extended",
    claudeModel: "Opus 4.6/extended",
    expectsTable: true,
    expectsCodeBlock: true,
    expectsChecklist: true,
  },
  {
    id: "nightly-doctor-runbook",
    label: "Nightly Doctor Runbook",
    prompt: [
      "Research an end-to-end nightly health-check and doctor system for DOM drift, session expiry, extraction regressions, and flaky provider behavior.",
      "Produce a markdown operations memo with sections: Objectives; Probe Sequence; Failure Classification; Metrics and Alerts; Repair Workflow; Incident Checklist.",
      "Include one metrics table and one bash code block.",
      COMMON_INSTRUCTIONS,
    ].join(" "),
    chatgptModel: "thinking/heavy",
    claudeModel: "Opus 4.6/extended",
    expectsTable: true,
    expectsCodeBlock: true,
    expectsChecklist: true,
  },
];

function providerRequestedModel(prompt: SoakPrompt, provider: ProviderName): string {
  return provider === "chatgpt" ? prompt.chatgptModel : prompt.claudeModel;
}

function countMatches(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

function analyzeMarkdown(prompt: SoakPrompt, markdown: string): string[] {
  const warnings: string[] = [];
  const trimmed = markdown.trim();
  const tableRows = countMatches(trimmed, /^\|/gm);
  const fencedBlocks = countMatches(trimmed, /```/g) / 2;
  const hasChecklistSyntax = /^\s*[-*]\s+\[[ x]\]/m.test(trimmed);
  const hasChecklistSection = /^#{1,6}\s+.*checklist\b/m.test(trimmed) || /\bchecklist\b/i.test(trimmed);
  const hasList = /^\s*[-*]\s/m.test(trimmed);
  const hasChecklist = hasChecklistSyntax || (hasChecklistSection && hasList);

  if (trimmed.length < 1500) {
    warnings.push("response_shorter_than_expected");
  }
  if (prompt.expectsTable && tableRows < 2) {
    warnings.push("expected_table_missing");
  }
  if (prompt.expectsCodeBlock && fencedBlocks < 1) {
    warnings.push("expected_code_block_missing");
  }
  if (prompt.expectsChecklist && !hasChecklist) {
    warnings.push("expected_checklist_missing");
  }
  if (/Cookie Preferences|Scroll to bottom|ChatGPT can make mistakes/i.test(trimmed)) {
    warnings.push("ui_chrome_leaked_into_export");
  }
  if (/Document\s*[·.]?\s*MD|Open artifact:|Download$/im.test(trimmed) && trimmed.length < 4000) {
    warnings.push("artifact_stub_detected");
  }

  return warnings;
}

function formatReportMarkdown(runId: string, summaries: ProviderRunSummary[]): string {
  const lines = [
    `# Soak Report ${runId}`,
    "",
  ];

  for (const summary of summaries) {
    lines.push(`## ${summary.provider}`);
    lines.push("");
    lines.push(`Status: ${summary.status}`);
    lines.push("");
    if (summary.error) {
      lines.push(`Failure: ${summary.error.split("\n")[0]}`);
      lines.push("");
    }
    if (summary.results.length === 0) {
      lines.push("_No prompt results captured._");
      lines.push("");
      continue;
    }
    lines.push("| Query | Model | Status | Duration (s) | Warnings | Output | Chat |");
    lines.push("| --- | --- | --- | ---: | --- | --- | --- |");
    for (const result of summary.results) {
      const output = result.outputPath ? path.relative(DATA_ROOT, result.outputPath) : "-";
      const chat = result.chatUrl ?? "-";
      lines.push(
        `| ${result.label} | ${result.resolvedModel ?? result.requestedModel} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)} | ${result.warnings.join(", ") || "-"} | ${output} | ${chat} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function isPageUsable(page: Page): boolean {
  return !page.isClosed();
}

async function relaunchPage(
  provider: ProviderAdapter,
  currentPage: Page,
): Promise<Page> {
  if (!currentPage.isClosed()) {
    await currentPage.close({ runBeforeUnload: false }).catch(() => undefined);
  }
  const page = await launchPage();
  await provider.gotoHome(page);
  return page;
}

async function runProviderSoak(providerName: ProviderName, runId: string): Promise<ProviderRunSummary> {
  const provider = await buildProvider(providerName);
  let page = await launchPage();
  const outDir = path.join(DATA_ROOT, "out", "soak", runId, providerName);
  const snapshotPath = path.join(outDir, "partial-results.json");
  await ensureDir(outDir);

  const results: PromptRunResult[] = [];
  let lastPromptFinishedAt = 0;

  try {
    await provider.gotoHome(page);
    if (!(await provider.isLoggedIn(page))) {
      throw new Error(`${providerName} is not logged in. Run: npm exec -- chatferry login ${providerName}`);
    }

    for (const prompt of SOAK_PROMPTS) {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const requestedModel = providerRequestedModel(prompt, providerName);
      const outputPath = path.join(outDir, `${String(results.length + 1).padStart(2, "0")}-${prompt.id}.md`);

      process.stdout.write(
        `[${providerName}] starting ${prompt.id} with ${requestedModel} at ${startedAt}\n`,
      );

      if (lastPromptFinishedAt > 0) {
        const elapsed = Date.now() - lastPromptFinishedAt;
        if (elapsed < SOAK_INTER_PROMPT_COOLDOWN_MS) {
          await page.waitForTimeout(SOAK_INTER_PROMPT_COOLDOWN_MS - elapsed);
        }
      }

      try {
        const result = await executeAskOperationInSession({
          provider: providerName,
          providerAdapter: provider,
          page,
          prompt: prompt.prompt,
          model: requestedModel,
          output: outputPath,
          validationMode: "structured_markdown",
        });

        const finishedAtMs = Date.now();
        lastPromptFinishedAt = finishedAtMs;

        const { default: fs } = await import("node:fs/promises");
        const markdown = await fs.readFile(result.outputPath, "utf8").catch(() => "");
        const warnings = analyzeMarkdown(prompt, markdown);

        results.push({
          id: prompt.id,
          label: prompt.label,
          provider: providerName,
          requestedModel,
          resolvedModel: result.observedModel?.label ?? null,
          status: warnings.length > 0 ? "warning" : "ok",
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          outputPath: result.outputPath,
          chatUrl: result.chatUrl,
          markdownSource: result.markdownSource,
          warnings,
        });
        await writeFileAtomic(snapshotPath, `${JSON.stringify(results, null, 2)}\n`);
        process.stdout.write(
          `[${providerName}] finished ${prompt.id} with ${warnings.length > 0 ? "warning" : "ok"} -> ${result.outputPath}\n`,
        );
      } catch (error) {
        const finishedAtMs = Date.now();
        lastPromptFinishedAt = finishedAtMs;
        const debug = await saveDebugArtifacts(page, providerName, prompt.id).catch(() => undefined);
        results.push({
          id: prompt.id,
          label: prompt.label,
          provider: providerName,
          requestedModel,
          resolvedModel: null,
          status: "failed",
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          warnings: [],
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          debugHtmlPath: debug?.htmlPath,
          debugScreenshotPath: debug?.screenshotPath,
        });
        await writeFileAtomic(snapshotPath, `${JSON.stringify(results, null, 2)}\n`);
        process.stdout.write(
          `[${providerName}] failed ${prompt.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (!isPageUsable(page)) {
          process.stdout.write(
            `[${providerName}] page is no longer usable after ${prompt.id}; getting fresh page\n`,
          );
          page = await relaunchPage(provider, page);
        }
      }
    }
  } finally {
    if (!page.isClosed()) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }

  const summaryStatus = results.some((result) => result.status === "failed")
    ? "failed"
    : results.some((result) => result.status === "warning")
      ? "warning"
      : "ok";

  return {
    provider: providerName,
    status: summaryStatus,
    results,
  };
}

async function main(): Promise<void> {
  await withBrowserLock(async () => {
    const runId = timestampSlug();
    const reportDir = path.join(DATA_ROOT, "out", "soak", runId);
    await ensureDir(reportDir);
    process.stdout.write(`run_id=${runId}\n`);

    const providers: ProviderName[] = ["chatgpt", "claude"];
    const settled = await Promise.allSettled(providers.map((provider) => runProviderSoak(provider, runId)));
    const summaries = settled.map((result, index): ProviderRunSummary => {
      if (result.status === "fulfilled") {
        return result.value;
      }

      return {
        provider: providers[index]!,
        status: "failed",
        results: [],
        error: result.reason instanceof Error ? result.reason.stack ?? result.reason.message : String(result.reason),
      };
    });

    const reportPath = path.join(reportDir, "report.md");
    const jsonPath = path.join(reportDir, "report.json");
    await writeFileAtomic(reportPath, formatReportMarkdown(runId, summaries));
    await writeFileAtomic(jsonPath, `${JSON.stringify({ runId, summaries }, null, 2)}\n`);

    process.stdout.write(`${reportPath}\n${jsonPath}\n`);
    await closeBrowser();
  });
}

void main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
