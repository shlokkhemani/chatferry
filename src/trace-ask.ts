#!/usr/bin/env node
/**
 * Diagnostic script: traces every step of a ChatGPT ask with timestamps.
 * Usage: npx tsx src/trace-ask.ts chatgpt "Reply with exactly: hello" [--model instant]
 */
import { closeBrowser, launchPage, withBrowserLock } from "./browser.js";
import { captureConversationWithDeferredRecovery } from "./capture.js";
import { COMPLETION_POLICY, waitForCompletion } from "./completion.js";
import { selectorCandidates } from "./config.js";
import { buildProvider } from "./service.js";
import { hasTransientFailure } from "./recovery.js";
import type { ProviderName } from "./types.js";
import { firstVisibleLocator, sleep } from "./utils.js";

function ts(): string {
  return `[${new Date().toISOString()}]`;
}

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

async function trace(providerName: ProviderName, prompt: string, model?: string): Promise<void> {
  const t0 = Date.now();
  console.error(`${ts()} START provider=${providerName} model=${model ?? "default"} prompt="${prompt.slice(0, 80)}"`);

  await withBrowserLock(async () => {
    console.error(`${ts()} +${elapsed(t0)} provider lock acquired`);

    const provider = await buildProvider(providerName);
    console.error(`${ts()} +${elapsed(t0)} provider built`);

    const page = await launchPage();
    console.error(`${ts()} +${elapsed(t0)} browser launched`);

    try {
      // --- gotoHome ---
      const tNav = Date.now();
      await provider.gotoHome(page);
      console.error(`${ts()} +${elapsed(t0)} gotoHome done (${elapsed(tNav)})`);

      // --- isLoggedIn ---
      const tLogin = Date.now();
      const loggedIn = await provider.isLoggedIn(page);
      console.error(`${ts()} +${elapsed(t0)} isLoggedIn=${loggedIn} (${elapsed(tLogin)})`);
      if (!loggedIn) throw new Error("Not logged in");

      // --- selectModel ---
      if (model) {
        const tModel = Date.now();
        const observed = await provider.selectModel(page, model);
        console.error(`${ts()} +${elapsed(t0)} selectModel done → ${observed.label} (${elapsed(tModel)})`);
      }

      // --- submitPrompt calls startNewChat only if responses exist ---
      const tSubmitCheck = Date.now();
      const responseSelectors0 = selectorCandidates(provider.config.selectors.response_container);
      const existingResponses = await page.locator(responseSelectors0[0]!).count().catch(() => 0);
      console.error(`${ts()} +${elapsed(t0)} existingResponses=${existingResponses} (${elapsed(tSubmitCheck)})`);
      if (existingResponses > 0) {
        const tNewChat = Date.now();
        await provider.startNewChat(page);
        console.error(`${ts()} +${elapsed(t0)} startNewChat done (${elapsed(tNewChat)})`);
      } else {
        console.error(`${ts()} +${elapsed(t0)} startNewChat SKIPPED (already on fresh chat)`);
      }

      // --- focusInput ---
      const tFocus = Date.now();
      const input = await provider.focusInput(page);
      console.error(`${ts()} +${elapsed(t0)} focusInput done (${elapsed(tFocus)})`);

      // --- humanPause 1 ---
      const tPause1 = Date.now();
      await sleep(200 + Math.random() * 250);
      console.error(`${ts()} +${elapsed(t0)} humanPause1 done (${elapsed(tPause1)})`);

      // --- insertPromptText ---
      const { insertPromptText } = await import("./human.js");
      const tInsert = Date.now();
      await insertPromptText(page, input, prompt);
      console.error(`${ts()} +${elapsed(t0)} insertPromptText done (${elapsed(tInsert)})`);

      // --- humanPause 2 ---
      const tPause2 = Date.now();
      await sleep(120 + Math.random() * 140);
      console.error(`${ts()} +${elapsed(t0)} humanPause2 done (${elapsed(tPause2)})`);

      // --- click send ---
      const tSend = Date.now();
      const responseSelectors = selectorCandidates(provider.config.selectors.response_container);
      const baselineResponseCount = await page.locator(responseSelectors[0]!).count().catch(() => 0);
      const conversationUrlBeforeSend = page.url();
      const sendButton = await (async () => {
        const match = await firstVisibleLocator(page, selectorCandidates(provider.config.selectors.send_button));
        return match?.locator ?? null;
      })();
      if (!sendButton) throw new Error("No send button");
      await sendButton.click();
      console.error(`${ts()} +${elapsed(t0)} send clicked (${elapsed(tSend)})`);

      // --- waitForSubmissionAcceptance ---
      const tAccept = Date.now();
      const stopSelectors = selectorCandidates(provider.config.selectors.stop_button);
      let accepted = false;
      const acceptDeadline = Date.now() + COMPLETION_POLICY.acceptanceTimeoutMs;
      while (Date.now() < acceptDeadline) {
        const currentUrl = page.url();
        const responseCount = await page.locator(responseSelectors[0]!).count().catch(() => 0);
        const stopVisible = await firstVisibleLocator(page, stopSelectors) !== null;
        if (responseCount > baselineResponseCount || stopVisible || currentUrl !== conversationUrlBeforeSend) {
          accepted = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      const acceptModel = await provider.getCurrentModel(page);
      console.error(`${ts()} +${elapsed(t0)} acceptance=${accepted} model=${acceptModel?.label ?? "null"} (${elapsed(tAccept)})`);

      // --- waitForCompletion ---
      const tCompletion = Date.now();
      const sendSelector = selectorCandidates(provider.config.selectors.send_button);
      const activeCompletion = await waitForCompletion(page, {
        response_container: responseSelectors,
        send_button: sendSelector,
        stop_button: stopSelectors,
      }, {
        timeoutMs: COMPLETION_POLICY.activeGenerationTimeoutMs,
        minimumResponseCount: baselineResponseCount + 1,
      });
      console.error(`${ts()} +${elapsed(t0)} waitForCompletion outcome=${activeCompletion.outcome} (${elapsed(tCompletion)})`);

      // --- hasTransientFailure ---
      const tFailCheck = Date.now();
      const hasFail = await hasTransientFailure(page, providerName);
      console.error(`${ts()} +${elapsed(t0)} hasTransientFailure=${hasFail} (${elapsed(tFailCheck)})`);

      // --- captureConversation ---
      const tCapture = Date.now();
      const capture = await captureConversationWithDeferredRecovery({
        provider: providerName,
        providerAdapter: provider,
        page,
        prompt,
        waitForSettledResponse: false,
        activeOutcome: activeCompletion.outcome,
        validationMode: "none",
        preferredModel: acceptModel,
      });
      console.error(`${ts()} +${elapsed(t0)} capture done → ${capture.outputPath} (${elapsed(tCapture)})`);

      console.error(`${ts()} +${elapsed(t0)} TOTAL DONE`);
      process.stdout.write(`${capture.outputPath}\n`);
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      await closeBrowser();
    }
  });
}

const providerArg = process.argv[2] as ProviderName;
const promptArg = process.argv[3];
const modelIdx = process.argv.indexOf("--model");
const modelArg = modelIdx >= 0 ? process.argv[modelIdx + 1] : undefined;

if (!providerArg || !promptArg) {
  console.error("Usage: npx tsx src/trace-ask.ts <chatgpt|claude> \"<prompt>\" [--model NAME]");
  process.exit(1);
}

trace(providerArg, promptArg, modelArg).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
