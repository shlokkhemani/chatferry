import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { COMPLETION_POLL_MS, COMPLETION_SETTLE_MS } from "./timing.js";
import { firstVisibleLocator } from "./utils.js";

export interface CompletionPolicy {
  acceptanceTimeoutMs: number;
  activeGenerationTimeoutMs: number;
  deferredPollBudgetMs: number;
  deferredPollIntervalMs: number;
}

export const COMPLETION_POLICY: CompletionPolicy = {
  acceptanceTimeoutMs: 60_000,
  activeGenerationTimeoutMs: 300_000,
  deferredPollBudgetMs: 4_500_000,
  deferredPollIntervalMs: 60_000,
};

export type ActiveCompletionOutcome = "completed" | "active_timeout";

export interface ActiveCompletionResult {
  outcome: ActiveCompletionOutcome;
  timeoutMs: number;
  minimumResponseCount: number;
  responseChangedFromBaseline: boolean;
}

export interface CompletionWaitOptions {
  timeoutMs?: number;
  minimumResponseCount?: number;
  previousSnapshot?: {
    count: number;
    text: string;
  };
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function asList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function safeInnerText(page: Page, selectors: string | string[]): Promise<string> {
  for (const selector of asList(selectors)) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }
      return await locator.last().innerText();
    } catch {
      continue;
    }
  }
  return "";
}

async function safeResponseSnapshot(
  page: Page,
  selectors: string | string[],
): Promise<{ count: number; text: string }> {
  for (const selector of asList(selectors)) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }
      return {
        count,
        text: await locator.last().innerText(),
      };
    } catch {
      continue;
    }
  }
  return { count: 0, text: "" };
}

async function safeVisible(page: Page, selectors: string | string[]): Promise<boolean> {
  return (await firstVisibleLocator(page, asList(selectors))) !== null;
}

export function isLikelyProgressStub(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length >= 900) {
    return false;
  }

  if (/^#{1,6}\s/m.test(text) || /^\s*[-*]\s/m.test(text) || /^\s*\|/m.test(text) || /```/.test(text)) {
    return false;
  }

  return [
    /\b(i['’]?m|i am|i['’]?ve|i have)\b.{0,120}\b(checking|writing|drafting|turning|finishing|finished|gathering|reviewing|pulling|synthes(?:is|izing))\b/i,
    /\b(i have enough|i['’]?ve finished|i['’]?m writing|i am writing|i['’]?m checking)\b/i,
    /\b(the evidence is converging|the clearest current pattern is|the key pattern is|i['’]?ve finished the synthesis)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

export function isUnexpectedCompletionNavigation(initialUrl: string, currentUrl: string): boolean {
  const stripHash = (value: string) => value.replace(/#.*$/, "");
  if (stripHash(initialUrl) === stripHash(currentUrl)) {
    return false;
  }

  let initial: URL;
  let current: URL;
  try {
    initial = new URL(initialUrl);
    current = new URL(currentUrl);
  } catch {
    return initialUrl !== currentUrl;
  }

  if (initial.origin !== current.origin) {
    return true;
  }
  if (/\/(login|signin|auth)\b/i.test(current.pathname)) {
    return true;
  }

  const looksLikeConversationPath = (pathname: string) => /\/(c|chat)\//.test(pathname);
  const initialConversation = looksLikeConversationPath(initial.pathname);
  const currentConversation = looksLikeConversationPath(current.pathname);
  if (initialConversation && !currentConversation) {
    return true;
  }
  if (initialConversation && currentConversation && initial.pathname !== current.pathname) {
    return true;
  }

  return false;
}

export async function waitForCompletion(
  page: Page,
  selectors: {
    response_container: string | string[];
    send_button?: string | string[];
    stop_button?: string | string[];
  },
  options: CompletionWaitOptions = {},
): Promise<ActiveCompletionResult> {
  const timeoutMs = options.timeoutMs ?? COMPLETION_POLICY.activeGenerationTimeoutMs;
  const minimumResponseCount = Math.max(0, options.minimumResponseCount ?? 0);
  const previousSnapshot = options.previousSnapshot ?? null;
  const startedAt = Date.now();
  const initialUrl = page.url();
  let sawContent = false;
  let lastHash = "";
  let stableCount = 0;
  let outcome: ActiveCompletionOutcome = "active_timeout";
  let responseChangedFromBaseline = previousSnapshot === null;

  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    if (isUnexpectedCompletionNavigation(initialUrl, currentUrl)) {
      throw new Error(
        `Page navigated away during completion wait. initial=${initialUrl} current=${currentUrl}`,
      );
    }

    const snapshot = await safeResponseSnapshot(page, selectors.response_container);
    const text = snapshot.text.trim();
    responseChangedFromBaseline = previousSnapshot === null
      ? true
      : snapshot.count > previousSnapshot.count || text !== previousSnapshot.text.trim();
    const responseReady = snapshot.count >= minimumResponseCount && responseChangedFromBaseline;
    if (responseReady && text.length > 0) {
      sawContent = true;
      const currentHash = hashText(`${snapshot.count}:${text}`);
      stableCount = currentHash === lastHash ? stableCount + 1 : 0;
      lastHash = currentHash;
    } else if (!responseReady) {
      stableCount = 0;
      lastHash = "";
    }

    const stopVisible = selectors.stop_button ? await safeVisible(page, selectors.stop_button) : false;
    const sendVisible = selectors.send_button ? await safeVisible(page, selectors.send_button) : false;
    const progressStub = isLikelyProgressStub(text);

    if (responseReady && sawContent && !stopVisible && !progressStub && stableCount >= 2) {
      outcome = "completed";
      break;
    }

    if (responseReady && sawContent && !stopVisible && sendVisible && !progressStub && stableCount >= 1) {
      outcome = "completed";
      break;
    }

    await page.waitForTimeout(COMPLETION_POLL_MS);
  }

  await page.waitForTimeout(COMPLETION_SETTLE_MS);
  return {
    outcome,
    timeoutMs,
    minimumResponseCount,
    responseChangedFromBaseline,
  };
}
