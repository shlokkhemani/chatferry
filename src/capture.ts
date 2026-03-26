import path from "node:path";
import type { Page } from "playwright";
import {
  COMPLETION_POLICY,
  waitForCompletion,
  type ActiveCompletionOutcome,
  isLikelyProgressStub,
} from "./completion.js";
import { selectorCandidates } from "./config.js";
import {
  buildMarkdownDocument,
  buildPromptResponseSidecar,
  defaultOutputPath,
  htmlToMarkdown,
  sidecarPathForOutput,
} from "./extract.js";
import type { ModelInfo, ProviderAdapter, ProviderName } from "./types.js";
import { CONVERSATION_SETTLE_MS, CONVERSATION_NAV_TIMEOUT_MS } from "./timing.js";
import { ensureDir, normalizeText, writeFileAtomic } from "./utils.js";

function completionSelectors(provider: ProviderAdapter): {
  response_container: string[];
  send_button: string[];
  stop_button: string[];
} {
  return {
    response_container: selectorCandidates(provider.config.selectors.response_container),
    send_button: selectorCandidates(provider.config.selectors.send_button),
    stop_button: selectorCandidates(provider.config.selectors.stop_button),
  };
}

export function isPromptShapeMismatch(prompt: string, markdownBody: string): boolean {
  const normalizedPrompt = prompt.toLowerCase();
  const trimmed = markdownBody.trim();
  const hasHeading = /^#{1,6}\s/m.test(trimmed);
  const hasList = /^\s*[-*]\s/m.test(trimmed);
  const hasChecklistSyntax = /^\s*[-*]\s+\[[ x]\]/m.test(trimmed);
  const hasChecklistSection = /^#{1,6}\s+.*checklist\b/m.test(trimmed) || /\bchecklist\b/i.test(trimmed);
  const hasChecklist = hasChecklistSyntax || (hasChecklistSection && hasList);
  const hasTable = /^\|.+\|$/m.test(trimmed);
  const hasCodeBlock = /```/.test(trimmed);
  const hasStructuredMarkdown = hasHeading || hasList || hasTable || hasCodeBlock;
  const expectsStructuredMemo =
    normalizedPrompt.includes("sections:") ||
    normalizedPrompt.includes("markdown memo") ||
    normalizedPrompt.includes("markdown brief") ||
    normalizedPrompt.includes("markdown report") ||
    normalizedPrompt.includes("markdown decision memo") ||
    normalizedPrompt.includes("markdown operations memo");

  if (expectsStructuredMemo && trimmed.length < 1200 && !hasStructuredMarkdown) {
    return true;
  }
  if (normalizedPrompt.includes("table") && !hasTable) {
    return true;
  }
  if (normalizedPrompt.includes("checklist") && !hasChecklist) {
    return true;
  }
  if (normalizedPrompt.includes("code block") && !hasCodeBlock) {
    return true;
  }
  return false;
}

function extractChatId(chatUrl: string): string | null {
  const match = chatUrl.match(/\/c\/([^/?#]+)/);
  return match?.[1] ?? null;
}

async function getChatGptConversationMeta(
  page: Page,
  chatUrl: string,
): Promise<{
  assistantTurnCount: number | null;
  asyncStatus: number | null;
  updateTime: string | null;
  hasResumeToken: boolean;
}> {
  const chatId = extractChatId(chatUrl);
  if (!chatId) {
    return {
      assistantTurnCount: null,
      asyncStatus: null,
      updateTime: null,
      hasResumeToken: false,
    };
  }

  return page.evaluate((currentChatId) => {
    let asyncStatus: number | null = null;
    let updateTime: string | null = null;

    for (const [key, value] of Object.entries(localStorage)) {
      if (!key.includes("/conversation-history")) {
        continue;
      }
      try {
        const parsed = JSON.parse(value);
        const pages = parsed?.value?.pages ?? [];
        for (const pageEntry of pages) {
          const items = pageEntry?.items ?? [];
          for (const item of items) {
            if (item?.id === currentChatId) {
              asyncStatus = item.async_status ?? null;
              updateTime = item.update_time ?? null;
              break;
            }
          }
          if (updateTime) {
            break;
          }
        }
        if (updateTime) {
          break;
        }
      } catch {
        continue;
      }
    }

    let hasResumeToken = false;
    try {
      const raw = localStorage.getItem("RESUME_TOKEN_STORE_KEY");
      if (raw) {
        const parsed = JSON.parse(raw);
        hasResumeToken = Boolean(parsed?.[currentChatId]);
      }
    } catch {
      hasResumeToken = false;
    }

    const assistantTurnCount = document.querySelectorAll("[data-message-author-role='assistant']").length || null;
    return {
      assistantTurnCount,
      asyncStatus,
      updateTime,
      hasResumeToken,
    };
  }, chatId);
}

export function isExtendedProModel(model: ModelInfo | null): boolean {
  const family = normalizeText(model?.family ?? "");
  const effort = normalizeText(model?.effort ?? "");
  const label = normalizeText(model?.label ?? "");
  return (
    (family.includes("pro") && effort.includes("extended")) ||
    label.includes("extended pro") ||
    label.includes("pro research-grade intelligence/extended")
  );
}

export type CaptureValidationMode = "none" | "structured_markdown";

export function isLikelyDeferredChatGptPlaceholder(snapshot: ConversationSnapshot): boolean {
  if (!isExtendedProModel(snapshot.model)) {
    return false;
  }

  const meta = snapshot.chatgptMeta;
  const markdownLength = snapshot.markdownBody.trim().length;
  return (
    markdownLength < 1_200 &&
    (
      meta?.asyncStatus !== null ||
      meta?.hasResumeToken === true ||
      (meta?.assistantTurnCount ?? 0) > 1
    )
  );
}

export interface ConversationSnapshot {
  chatUrl: string;
  markdownBody: string;
  markdownSource: "provider_markdown" | "html_to_markdown";
  model: ModelInfo | null;
  modelLabel: string | null;
  rawHtml?: string;
  validation: {
    progressStub: boolean;
    shapeMismatch: boolean;
    deferredPlaceholder: boolean;
  };
  chatgptMeta?: {
    assistantTurnCount: number | null;
    asyncStatus: number | null;
    updateTime: string | null;
    hasResumeToken: boolean;
  };
}

export async function inspectCurrentConversation(args: {
  provider: ProviderName;
  providerAdapter: ProviderAdapter;
  page: Page;
  prompt: string;
  waitForSettledResponse?: boolean;
  validationMode?: CaptureValidationMode;
  preferredModel?: ModelInfo | null;
}): Promise<ConversationSnapshot> {
  const { provider, providerAdapter, page, prompt } = args;
  if (args.waitForSettledResponse !== false) {
    await waitForCompletion(page, completionSelectors(providerAdapter));
  }

  const chatUrl = page.url();
  const model = (await providerAdapter.getCurrentModel(page)) ?? args.preferredModel ?? null;
  const modelLabel = model?.label ?? null;
  const providerMarkdown = await providerAdapter.getLatestResponseMarkdown(page);
  const rawHtml = providerMarkdown ? undefined : await providerAdapter.getLatestResponseHtml(page);
  const markdownBody = providerMarkdown ?? htmlToMarkdown(rawHtml ?? "");
  const markdownSource = providerMarkdown ? "provider_markdown" : "html_to_markdown";
  const validation = {
    progressStub: provider === "chatgpt" && isLikelyProgressStub(markdownBody),
    shapeMismatch:
      args.validationMode === "structured_markdown" && isPromptShapeMismatch(prompt, markdownBody),
    deferredPlaceholder: false,
  };
  const snapshot: ConversationSnapshot = {
    chatUrl,
    markdownBody,
    markdownSource,
    model,
    modelLabel,
    rawHtml,
    validation,
    ...(provider === "chatgpt" ? { chatgptMeta: await getChatGptConversationMeta(page, chatUrl) } : {}),
  };
  snapshot.validation.deferredPlaceholder = provider === "chatgpt" && isLikelyDeferredChatGptPlaceholder(snapshot);
  return snapshot;
}

async function writeConversationSnapshot(args: {
  provider: ProviderName;
  prompt: string;
  output?: string;
  snapshot: ConversationSnapshot;
}): Promise<{
  chatUrl: string;
  markdownBody: string;
  markdownSource: "provider_markdown" | "html_to_markdown";
  model: ModelInfo | null;
  modelLabel: string | null;
  outputPath: string;
  rawHtml?: string;
}> {
  const document = buildMarkdownDocument({
    provider: args.provider,
    model: args.snapshot.model,
    prompt: args.prompt,
    body: args.snapshot.markdownBody,
    chatUrl: args.snapshot.chatUrl,
  });
  const outputPath = args.output ? path.resolve(args.output) : defaultOutputPath(args.provider, args.prompt);
  const sidecar = buildPromptResponseSidecar({
    provider: args.provider,
    outputPath,
    model: args.snapshot.model,
    prompt: args.prompt,
    response: args.snapshot.markdownBody,
    chatUrl: args.snapshot.chatUrl,
    markdownSource: args.snapshot.markdownSource,
  });
  await ensureDir(path.dirname(outputPath));
  await writeFileAtomic(outputPath, document);
  await writeFileAtomic(sidecarPathForOutput(outputPath), `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    chatUrl: args.snapshot.chatUrl,
    markdownBody: args.snapshot.markdownBody,
    markdownSource: args.snapshot.markdownSource,
    model: args.snapshot.model,
    modelLabel: args.snapshot.modelLabel,
    outputPath,
    rawHtml: args.snapshot.rawHtml,
  };
}

export function shouldAttemptDeferredChatGptRecovery(
  snapshot: ConversationSnapshot,
  activeOutcome?: ActiveCompletionOutcome,
): boolean {
  const meta = snapshot.chatgptMeta;
  const hasDeferredEvidence =
    snapshot.validation.deferredPlaceholder ||
    (meta?.assistantTurnCount ?? 0) > 1 ||
    meta?.asyncStatus !== null ||
    meta?.hasResumeToken === true;
  return (
    hasDeferredEvidence ||
    (
      activeOutcome === "active_timeout" &&
      (snapshot.validation.progressStub || snapshot.validation.shapeMismatch || hasDeferredEvidence)
    )
  );
}

async function waitForDeferredChatGptCompletion(args: {
  providerAdapter: ProviderAdapter;
  page: Page;
  prompt: string;
  initialSnapshot: ConversationSnapshot;
  maxWaitMs?: number;
  reloadIntervalMs?: number;
  validationMode?: CaptureValidationMode;
  preferredModel?: ModelInfo | null;
  onDeferredStart?: () => Promise<void> | void;
}): Promise<void> {
  const deadline = Date.now() + (args.maxWaitMs ?? COMPLETION_POLICY.deferredPollBudgetMs);
  const chatUrl = args.initialSnapshot.chatUrl;
  let lastAssistantTurnCount = args.initialSnapshot.chatgptMeta?.assistantTurnCount ?? 0;
  let lastAsyncStatus = args.initialSnapshot.chatgptMeta?.asyncStatus ?? null;
  let stagnantPolls = 0;
  let lastSnapshot = args.initialSnapshot;

  await args.onDeferredStart?.();

  while (Date.now() < deadline) {
    await args.page.waitForTimeout(args.reloadIntervalMs ?? COMPLETION_POLICY.deferredPollIntervalMs);
    await args.page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: CONVERSATION_NAV_TIMEOUT_MS });
    await args.page.waitForTimeout(CONVERSATION_SETTLE_MS);
    if (!(await args.providerAdapter.isLoggedIn(args.page))) {
      throw new Error("chatgpt session expired during deferred completion polling. Run: npm exec -- chatferry login chatgpt");
    }

    const snapshot = await inspectCurrentConversation({
      provider: "chatgpt",
      providerAdapter: args.providerAdapter,
      page: args.page,
      prompt: args.prompt,
      waitForSettledResponse: false,
      validationMode: args.validationMode,
      preferredModel: args.preferredModel,
    });
    lastSnapshot = snapshot;

    if (!snapshot.validation.progressStub && !snapshot.validation.shapeMismatch && !snapshot.validation.deferredPlaceholder) {
      return;
    }

    const assistantTurnCount = snapshot.chatgptMeta?.assistantTurnCount ?? 0;
    const asyncStatus = snapshot.chatgptMeta?.asyncStatus ?? null;
    if (assistantTurnCount === lastAssistantTurnCount && asyncStatus === lastAsyncStatus) {
      stagnantPolls += 1;
    } else {
      stagnantPolls = 0;
      lastAssistantTurnCount = assistantTurnCount;
      lastAsyncStatus = asyncStatus;
    }

    const isSlowModel = isExtendedProModel(snapshot.model) || /\b(thinking|pro)\b/i.test(snapshot.model?.family ?? "");
    if (!isSlowModel && asyncStatus === null && stagnantPolls >= 3) {
      break;
    }
  }

  throw new Error(
    `ChatGPT deferred completion did not yield a structured response. Last model=${lastSnapshot.modelLabel ?? "unknown"} async_status=${lastSnapshot.chatgptMeta?.asyncStatus ?? "null"} assistant_turns=${lastSnapshot.chatgptMeta?.assistantTurnCount ?? "unknown"} preview=${lastSnapshot.markdownBody.slice(0, 200)}`,
  );
}

export async function captureConversationWithDeferredRecovery(args: {
  provider: ProviderName;
  providerAdapter: ProviderAdapter;
  page: Page;
  prompt: string;
  output?: string;
  waitForSettledResponse?: boolean;
  activeOutcome?: ActiveCompletionOutcome;
  validationMode?: CaptureValidationMode;
  preferredModel?: ModelInfo | null;
  onDeferredStart?: () => Promise<void> | void;
}): Promise<{
  chatUrl: string;
  markdownBody: string;
  markdownSource: "provider_markdown" | "html_to_markdown";
  model: ModelInfo | null;
  modelLabel: string | null;
  outputPath: string;
  rawHtml?: string;
  deferredUsed: boolean;
}> {
  // Step 1: Inspect (read-only, no file writes)
  let snapshot = await inspectCurrentConversation(args);
  let deferredUsed = false;

  // Step 2: Decide — if validation fails and this is a ChatGPT deferred scenario, poll
  const hasValidationIssue =
    snapshot.validation.progressStub ||
    snapshot.validation.deferredPlaceholder ||
    (args.validationMode === "structured_markdown" && snapshot.validation.shapeMismatch);

  if (hasValidationIssue && args.provider === "chatgpt" && shouldAttemptDeferredChatGptRecovery(snapshot, args.activeOutcome)) {
    await waitForDeferredChatGptCompletion({
      providerAdapter: args.providerAdapter,
      page: args.page,
      prompt: args.prompt,
      initialSnapshot: snapshot,
      validationMode: args.validationMode,
      preferredModel: args.preferredModel,
      onDeferredStart: args.onDeferredStart,
    });
    snapshot = await inspectCurrentConversation({
      ...args,
      waitForSettledResponse: false,
    });
    deferredUsed = true;
  }

  // Validate the final snapshot
  if (snapshot.validation.progressStub) {
    throw new Error(`ChatGPT response still looks like an in-progress status update: ${snapshot.markdownBody.slice(0, 200)}`);
  }
  if (snapshot.validation.deferredPlaceholder) {
    throw new Error(`ChatGPT response still looks like a deferred placeholder: ${snapshot.markdownBody.slice(0, 200)}`);
  }
  if (args.validationMode === "structured_markdown" && snapshot.validation.shapeMismatch) {
    throw new Error(`Response does not satisfy the requested markdown structure: ${snapshot.markdownBody.slice(0, 200)}`);
  }

  // Step 3: Write (file I/O errors propagate directly, never trigger deferred recovery)
  const result = await writeConversationSnapshot({
    provider: args.provider,
    prompt: args.prompt,
    output: args.output,
    snapshot,
  });

  return { ...result, deferredUsed };
}
