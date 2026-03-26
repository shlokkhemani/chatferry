import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { closeBrowser, launchPage, withBrowserLock } from "./browser.js";
import { captureConversationWithDeferredRecovery, type CaptureValidationMode } from "./capture.js";
import { COMPLETION_POLICY, waitForCompletion } from "./completion.js";
import { loadProviderConfig, selectorCandidates } from "./config.js";
import {
  artifactDirectoryForOutput,
  artifactFileName,
  buildConversationDocument,
  buildConversationSidecar,
  buildMarkdownDocument,
  buildPromptResponseSidecar,
  defaultReadOutputPath,
  sidecarPathForOutput,
} from "./extract.js";
import { ChatGPTProvider } from "./providers/chatgpt.js";
import { ClaudeProvider } from "./providers/claude.js";
import { hasTransientFailure } from "./recovery.js";
import type {
  ConversationTurn,
  ModelInfo,
  PromptSubmission,
  ProviderAdapter,
  ProviderName,
} from "./types.js";
import {
  ACCEPTANCE_POLL_MS,
  CONVERSATION_NAV_TIMEOUT_MS,
  CONVERSATION_SETTLE_MS,
} from "./timing.js";
import { firstVisibleLocator, saveDebugArtifacts, sleep, slugify, writeFileAtomic } from "./utils.js";

export async function buildProvider(providerName: ProviderName): Promise<ProviderAdapter> {
  const config = await loadProviderConfig(providerName);
  if (providerName === "chatgpt") {
    return new ChatGPTProvider(config);
  }
  return new ClaudeProvider(config);
}

export function providerFromConversationUrl(rawUrl: string): ProviderName {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "claude.ai" || hostname.endsWith(".claude.ai")) {
    return "claude";
  }
  if (
    hostname === "chatgpt.com" ||
    hostname.endsWith(".chatgpt.com") ||
    hostname === "chat.openai.com" ||
    hostname.endsWith(".chat.openai.com")
  ) {
    return "chatgpt";
  }

  throw new Error(`Unsupported conversation URL host: ${hostname}`);
}

export async function withProviderSession<T>(
  providerName: ProviderName,
  fn: (provider: ProviderAdapter, page: Page) => Promise<T>,
): Promise<T> {
  return withBrowserLock(async () => {
    const provider = await buildProvider(providerName);
    const page = await launchPage();

    try {
      await provider.gotoHome(page);
      return await fn(provider, page);
    } catch (error) {
      await saveDebugArtifacts(page, providerName, "failure").catch(() => undefined);
      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(error);
      }
      throw error;
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      await closeBrowser();
    }
  });
}

export async function persistConversationArtifacts(
  outputPath: string,
  turns: ConversationTurn[],
): Promise<{
  turns: ConversationTurn[];
  artifactDir: string | null;
}> {
  const artifactDirPath = artifactDirectoryForOutput(outputPath);
  const outputDir = path.dirname(outputPath);
  let artifactCount = 0;

  await fs.rm(artifactDirPath, { recursive: true, force: true }).catch(() => undefined);

  const persistedTurns: ConversationTurn[] = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    if (!turn.artifacts || turn.artifacts.length === 0) {
      persistedTurns.push(turn);
      continue;
    }

    const persistedArtifacts = [];
    for (let artifactIndex = 0; artifactIndex < turn.artifacts.length; artifactIndex += 1) {
      const artifact = turn.artifacts[artifactIndex]!;
      const fallbackName = {
        ...artifact,
        filename: artifact.filename || `${slugify(turn.role)}-artifact-${artifactIndex + 1}.md`,
      };
      const artifactPath = path.join(
        artifactDirPath,
        artifactFileName(turnIndex, artifactIndex, fallbackName),
      );
      await writeFileAtomic(artifactPath, artifact.content);
      artifactCount += 1;
      persistedArtifacts.push({
        ...artifact,
        savedPath: path.relative(outputDir, artifactPath),
      });
    }

    persistedTurns.push({
      ...turn,
      artifacts: persistedArtifacts,
    });
  }

  const artifactDir = artifactCount > 0 ? path.relative(outputDir, artifactDirPath) : null;
  if (!artifactDir) {
    await fs.rm(artifactDirPath, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    turns: persistedTurns,
    artifactDir,
  };
}

async function safeResponseCount(page: Page, selectors: string[]): Promise<number> {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return count;
    }
  }
  return 0;
}

async function safeVisible(page: Page, selectors: string[]): Promise<boolean> {
  return (await firstVisibleLocator(page, selectors)) !== null;
}

async function waitForSubmissionAcceptance(args: {
  page: Page;
  provider: ProviderAdapter;
  submission: PromptSubmission;
  timeoutMs?: number;
}): Promise<{
  confirmed: boolean;
  chatUrl: string;
}> {
  const responseSelectors = selectorCandidates(args.provider.config.selectors.response_container);
  const stopSelectors = selectorCandidates(args.provider.config.selectors.stop_button);
  const deadline = Date.now() + (args.timeoutMs ?? 20_000);
  const baseline = args.submission.baselineResponseCount + 1;

  while (Date.now() < deadline) {
    const currentUrl = args.page.url();
    const responseCount = await safeResponseCount(args.page, responseSelectors);
    const stopVisible = await safeVisible(args.page, stopSelectors);
    if (
      responseCount >= baseline ||
      stopVisible ||
      currentUrl !== args.submission.conversationUrlBeforeSend
    ) {
      return { confirmed: true, chatUrl: currentUrl };
    }
    await args.page.waitForTimeout(ACCEPTANCE_POLL_MS);
  }

  return { confirmed: false, chatUrl: args.page.url() };
}

export interface AskStageUpdate {
  stage: "running" | "completed";
  provider: ProviderName;
  chatUrl?: string | null;
  observedModel?: ModelInfo | null;
}

export interface AskExecutionResult {
  provider: ProviderName;
  chatUrl: string;
  outputPath: string;
  markdownSource: "provider_markdown" | "html_to_markdown";
  observedModel: ModelInfo | null;
}

export async function executeAskOperationInSession(args: {
  provider: ProviderName;
  providerAdapter: ProviderAdapter;
  page: Page;
  prompt: string;
  model?: string;
  output?: string;
  validationMode?: CaptureValidationMode;
  onStage?: (update: AskStageUpdate) => Promise<void> | void;
}): Promise<AskExecutionResult> {
  if (!(await args.providerAdapter.isLoggedIn(args.page))) {
    throw new Error(`${args.provider} is not logged in. Run: npm exec -- chatferry login`);
  }

  let observedModel: ModelInfo | null = null;
  if (args.model) {
    observedModel = await args.providerAdapter.selectModel(args.page, args.model);
  }

  const responseSelector = selectorCandidates(args.providerAdapter.config.selectors.response_container);
  const sendSelector = selectorCandidates(args.providerAdapter.config.selectors.send_button);
  const stopSelector = selectorCandidates(args.providerAdapter.config.selectors.stop_button);

  const submission = await args.providerAdapter.submitPrompt(args.page, args.prompt);
  const acceptance = await waitForSubmissionAcceptance({
    page: args.page,
    provider: args.providerAdapter,
    submission,
    timeoutMs: COMPLETION_POLICY.acceptanceTimeoutMs,
  });

  if (!acceptance.confirmed) {
    throw new Error(
      `Prompt was not accepted by ${args.provider} within ${COMPLETION_POLICY.acceptanceTimeoutMs}ms. The prompt may not have been sent.`,
    );
  }

  await args.onStage?.({
    stage: "running",
    provider: args.provider,
    chatUrl: acceptance.chatUrl,
    observedModel,
  });

  const activeCompletion = await waitForCompletion(args.page, {
    response_container: responseSelector,
    send_button: sendSelector,
    stop_button: stopSelector,
  }, {
    timeoutMs: COMPLETION_POLICY.activeGenerationTimeoutMs,
    minimumResponseCount: submission.baselineResponseCount + 1,
  });

  if (await hasTransientFailure(args.page, args.provider)) {
    throw new Error(`${args.provider} reported an incomplete or failed generation`);
  }

  const activeOutcome = activeCompletion.outcome;
  const isSlowModel = /\b(pro|thinking)\b/i.test(observedModel?.family ?? "");
  if (activeOutcome === "active_timeout" && !isSlowModel) {
    throw new Error(
      `${args.provider} response generation timed out after ${COMPLETION_POLICY.activeGenerationTimeoutMs}ms`,
    );
  }

  const capture = await captureConversationWithDeferredRecovery({
    provider: args.provider,
    providerAdapter: args.providerAdapter,
    page: args.page,
    prompt: args.prompt,
    output: args.output,
    waitForSettledResponse: false,
    activeOutcome,
    validationMode: args.validationMode ?? "none",
    preferredModel: observedModel,
    onDeferredStart: async () => {
      await args.onStage?.({
        stage: "running",
        provider: args.provider,
        chatUrl: args.page.url(),
        observedModel,
      });
    },
  });

  const captureModel = capture.model ?? observedModel;

  const result: AskExecutionResult = {
    provider: args.provider,
    chatUrl: capture.chatUrl,
    outputPath: capture.outputPath,
    markdownSource: capture.markdownSource,
    observedModel: captureModel,
  };

  await args.onStage?.({
    stage: "completed",
    provider: args.provider,
    chatUrl: result.chatUrl,
    observedModel: captureModel,
  });

  return result;
}

export async function executeAskOperation(args: {
  provider: ProviderName;
  prompt: string;
  model?: string;
  output?: string;
  validationMode?: CaptureValidationMode;
  onStage?: (update: AskStageUpdate) => Promise<void> | void;
}): Promise<AskExecutionResult> {
  return withProviderSession(args.provider, async (provider, page) => {
    return executeAskOperationInSession({
      provider: args.provider,
      providerAdapter: provider,
      page,
      prompt: args.prompt,
      model: args.model,
      output: args.output,
      validationMode: args.validationMode,
      onStage: args.onStage,
    });
  });
}

export async function executeReadOperation(args: {
  provider: ProviderName;
  url: string;
  output?: string;
}): Promise<{
  provider: ProviderName;
  outputPath: string;
  chatUrl: string;
  turns: number;
  artifacts: number;
  artifactDir: string | null;
}> {
  return withProviderSession(args.provider, async (provider, page) =>
    executeReadOperationInSession({
      provider: args.provider,
      providerAdapter: provider,
      page,
      url: args.url,
      output: args.output,
    }));
}

export async function executeReadOperationInSession(args: {
  provider: ProviderName;
  providerAdapter: ProviderAdapter;
  page: Page;
  url: string;
  output?: string;
}): Promise<{
  provider: ProviderName;
  outputPath: string;
  chatUrl: string;
  turns: number;
  artifacts: number;
  artifactDir: string | null;
}> {
  if (!(await args.providerAdapter.isLoggedIn(args.page))) {
    throw new Error(`${args.provider} is not logged in. Run: npm exec -- chatferry login`);
  }

  await args.page.goto(args.url, { waitUntil: "domcontentloaded", timeout: CONVERSATION_NAV_TIMEOUT_MS });
  await args.page.waitForTimeout(CONVERSATION_SETTLE_MS);
  if (!(await args.providerAdapter.isLoggedIn(args.page))) {
    throw new Error(`${args.provider} session expired during navigation. Run: npm exec -- chatferry login ${args.provider}`);
  }
  await args.providerAdapter.prepareConversationForRead(args.page);
  const turns = await args.providerAdapter.extractConversation(args.page);
  if (turns.length === 0) {
    throw new Error(`No conversation turns were extracted from ${args.url}`);
  }

  const outputPath = args.output ? path.resolve(args.output) : defaultReadOutputPath(args.provider);
  const { turns: persistedTurns, artifactDir } = await persistConversationArtifacts(outputPath, turns);
  const document = buildConversationDocument({
    provider: args.provider,
    chatUrl: args.page.url(),
    turns: persistedTurns,
    artifactDir,
  });
  const sidecar = buildConversationSidecar({
    provider: args.provider,
    outputPath,
    chatUrl: args.page.url(),
    turns: persistedTurns,
    artifactDir,
  });
  await writeFileAtomic(outputPath, document);
  await writeFileAtomic(sidecarPathForOutput(outputPath), `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    provider: args.provider,
    outputPath,
    chatUrl: args.page.url(),
    turns: persistedTurns.length,
    artifacts: persistedTurns.reduce((count, turn) => count + (turn.artifacts?.length ?? 0), 0),
    artifactDir,
  };
}

export async function executeReloadOperation(args: {
  provider: ProviderName;
  prompt: string;
  chatUrl: string;
  output: string;
  validationMode?: CaptureValidationMode;
}): Promise<AskExecutionResult> {
  return withProviderSession(args.provider, async (provider, page) =>
    executeReloadOperationInSession({
      provider: args.provider,
      providerAdapter: provider,
      page,
      prompt: args.prompt,
      chatUrl: args.chatUrl,
      output: args.output,
      validationMode: args.validationMode,
    }));
}

export async function executeReloadOperationInSession(args: {
  provider: ProviderName;
  providerAdapter: ProviderAdapter;
  page: Page;
  prompt: string;
  chatUrl: string;
  output: string;
  validationMode?: CaptureValidationMode;
}): Promise<AskExecutionResult> {
  if (!(await args.providerAdapter.isLoggedIn(args.page))) {
    throw new Error(`${args.provider} is not logged in. Run: npm exec -- chatferry login`);
  }

  await args.page.goto(args.chatUrl, { waitUntil: "domcontentloaded", timeout: CONVERSATION_NAV_TIMEOUT_MS });
  await args.page.waitForTimeout(CONVERSATION_SETTLE_MS);
  if (!(await args.providerAdapter.isLoggedIn(args.page))) {
    throw new Error(`${args.provider} session expired during navigation. Run: npm exec -- chatferry login ${args.provider}`);
  }
  const capture = await captureConversationWithDeferredRecovery({
    provider: args.provider,
    providerAdapter: args.providerAdapter,
    page: args.page,
    prompt: args.prompt,
    output: args.output,
    waitForSettledResponse: false,
    validationMode: args.validationMode ?? "none",
  });

  return {
    provider: args.provider,
    chatUrl: capture.chatUrl,
    outputPath: capture.outputPath,
    markdownSource: capture.markdownSource,
    observedModel: capture.model,
  };
}
