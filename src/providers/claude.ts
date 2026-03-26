import fs from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { htmlToMarkdown } from "../extract.js";
import { humanPause, insertPromptText } from "../human.js";
import { findMatchingInput, storedModelCatalog } from "../models.js";
import {
  ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  CLAUDE_FOCUS_RETRY_MS,
  CLAUDE_MESSAGES_TIMEOUT_MS,
  CLAUDE_MODEL_SETTLE_MS,
  CLAUDE_PICKER_DISMISS_MS,
  CLAUDE_PICKER_OPEN_MS,
  CLAUDE_THINKING_TOGGLE_MS,
  COMPOSER_POLL_MS,
  NAV_RETRY_PAUSE_MS,
  NAV_TIMEOUT_MS,
  NEW_CHAT_SETTLE_MS,
  PRE_SEND_PAUSE,
  PRE_TYPE_PAUSE,
  WAIT_FOR_COMPOSER_MS,
} from "../timing.js";
import type {
  ConversationArtifact,
  ConversationTurn,
  ModelInfo,
  PromptSubmission,
  ProviderModelCatalog,
  ProviderSelectorConfig,
} from "../types.js";
import { normalizeText } from "../utils.js";
import { BaseProvider } from "./base.js";

export class ClaudeProvider extends BaseProvider {
  constructor(config: ProviderSelectorConfig) {
    super(config);
  }

  private async waitForComposerOrLogin(page: Page, timeoutMs = WAIT_FOR_COMPOSER_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.visibleNamedLocator(page, "input")) !== null) {
        return;
      }
      if (page.url().includes("/login")) {
        return;
      }
      await page.waitForTimeout(COMPOSER_POLL_MS);
    }
  }

  private async navigateWithRetry(page: Page, url: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await this.waitForComposerOrLogin(page);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("ERR_ABORTED") || attempt === 2) {
          throw error;
        }
        await page.waitForTimeout(NAV_RETRY_PAUSE_MS);
      }
    }
  }

  async gotoHome(page: Page): Promise<void> {
    await this.navigateWithRetry(page, this.config.url);
    // Auto-dismiss cookie/consent banners that block interaction
    const acceptButton = page.locator('[data-testid="consent-banner"] button').filter({ hasText: /accept/i });
    if (await acceptButton.isVisible().catch(() => false)) {
      await acceptButton.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    if (page.url().includes("/login")) {
      return false;
    }

    return (await this.visibleNamedLocator(page, "input")) !== null;
  }

  private async openModelPicker(page: Page): Promise<void> {
    for (const selector of this.candidates("model_picker")) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }
        await candidate.click().catch(() => undefined);
        await page.waitForTimeout(CLAUDE_PICKER_OPEN_MS);
        const options = await this.collectModelOptions(page);
        if (options.length > 0) {
          return;
        }
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }

    throw new Error("Could not open Claude model picker");
  }

  async listModels(page: Page): Promise<ProviderModelCatalog> {
    const current = await this.getCurrentModel(page);
    return storedModelCatalog("claude", current);
  }

  private async ensureModelPickerOpen(page: Page): Promise<void> {
    const options = await this.collectModelOptions(page);
    if (options.length > 0) {
      return;
    }
    await this.openModelPicker(page);
  }

  private extendedThinkingToggle(page: Page): Locator {
    return page.locator('[role="menuitem"]').filter({ hasText: /Extended thinking/i }).first();
  }

  private async readExtendedThinkingState(page: Page): Promise<boolean | null> {
    const toggle = this.extendedThinkingToggle(page);
    const visible = await toggle.isVisible().catch(() => false);
    if (!visible) {
      return null;
    }

    const input = toggle.locator('input[role="switch"], input[type="checkbox"]').first();
    if (await input.count().catch(() => 0)) {
      return input.isChecked().catch(() => null);
    }

    return null;
  }

  private async setExtendedThinking(page: Page, enabled: boolean): Promise<void> {
    await this.ensureModelPickerOpen(page);
    const current = await this.readExtendedThinkingState(page);
    if (current === enabled) {
      return;
    }

    const toggle = this.extendedThinkingToggle(page);
    if (!(await toggle.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error("Claude extended thinking toggle was not found");
    }

    const switchLabel = toggle.locator("label").first();
    if (await switchLabel.isVisible().catch(() => false)) {
      await switchLabel.click();
    } else {
      await toggle.click();
    }

    await page.waitForTimeout(CLAUDE_THINKING_TOGGLE_MS);
    const next = await this.readExtendedThinkingState(page);
    if (next !== enabled) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(`Claude extended thinking toggle did not switch to ${enabled ? "enabled" : "disabled"}`);
    }
  }

  async selectModel(page: Page, requestedModel: string): Promise<ModelInfo> {
    const catalog = storedModelCatalog("claude", await this.getCurrentModel(page));
    const input = findMatchingInput(catalog, requestedModel);
    if (!input) {
      // Fallback: enumerate live UI models before failing
      await this.openModelPicker(page).catch(() => undefined);
      const liveModels = await this.collectModelOptions(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      const liveLabels = liveModels.map((m) => m.label);
      throw new Error(
        `Model "${requestedModel}" not found for Claude. Available: ${liveLabels.join(", ")} (live) / ${catalog.inputs.map((entry) => entry.label).join(", ")} (catalog)`,
      );
    }
    await this.openModelPicker(page);
    const selectedLabel = await this.clickModelOption(page, input.family);
    if (!selectedLabel) {
      const options = await this.collectModelOptions(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(
        `Model "${requestedModel}" not found for Claude. Available: ${options.map((option) => option.label).join(", ")}`,
      );
    }
    await page.waitForTimeout(CLAUDE_MODEL_SETTLE_MS);

    if (input.effort) {
      await this.setExtendedThinking(page, normalizeText(input.effort).includes("extended"));
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(CLAUDE_PICKER_DISMISS_MS);

    const observed = await this.getCurrentModel(page);
    if (!observed) {
      throw new Error(`Could not observe Claude model after selecting ${requestedModel}`);
    }
    if (normalizeText(observed.family ?? "") !== normalizeText(input.family)) {
      throw new Error(`Claude family mismatch after selecting ${requestedModel}. Observed=${observed.label ?? "unknown"}`);
    }
    if (input.effort) {
      const expectsExtended = normalizeText(input.effort).includes("extended");
      if (expectsExtended !== normalizeText(observed.effort ?? "").includes("extended")) {
        throw new Error(`Claude mode mismatch after selecting ${requestedModel}. Observed=${observed.label ?? "unknown"}`);
      }
    }
    return observed;
  }

  async startNewChat(page: Page): Promise<void> {
    const locator = await this.visibleNamedLocator(page, "new_chat");
    if (locator) {
      await locator.click().catch(() => undefined);
      await this.waitForComposerOrLogin(page, NEW_CHAT_SETTLE_MS);
      return;
    }

    await this.navigateWithRetry(page, this.config.url);
  }

  async focusInput(page: Page): Promise<Locator> {
    const locator = await this.visibleNamedLocator(page, "input");
    if (!locator) {
      throw new Error("Could not find Claude input");
    }
    try {
      await locator.click();
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(CLAUDE_FOCUS_RETRY_MS);
      await locator.click();
    }
    return locator;
  }

  async submitPrompt(page: Page, prompt: string): Promise<PromptSubmission> {
    // Only start a new chat if the page has existing responses (i.e. we're in a conversation).
    // Caller (daemon/withProviderSession) already navigated to home which IS a blank chat.
    const existingResponses = await this.responseContainerCount(page);
    if (existingResponses > 0) {
      await this.startNewChat(page);
    }
    const input = await this.focusInput(page);
    const baselineResponseCount = await this.responseContainerCount(page);
    const conversationUrlBeforeSend = page.url();
    await humanPause(PRE_TYPE_PAUSE.min, PRE_TYPE_PAUSE.max);
    await insertPromptText(page, input, prompt);
    await humanPause(PRE_SEND_PAUSE.min, PRE_SEND_PAUSE.max);
    const sendButton = await this.visibleNamedLocator(page, "send_button");
    if (sendButton) {
      await sendButton.click();
      return {
        baselineResponseCount,
        conversationUrlBeforeSend,
      };
    }
    await page.keyboard.press("Enter");
    return {
      baselineResponseCount,
      conversationUrlBeforeSend,
    };
  }

  async getLatestResponseHtml(page: Page): Promise<string> {
    return this.extractLatestHtml(page, ["response_container"]);
  }

  private async latestAssistantTurn(page: Page): Promise<Locator | null> {
    const locator = await this.waitForAttachedNamedLocator(page, "conversation_messages", CLAUDE_MESSAGES_TIMEOUT_MS);
    if (!locator) {
      return null;
    }

    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      const isAssistant = await candidate.evaluate((element) => element.getAttribute("data-is-streaming") !== null)
        .catch(() => false);
      if (isAssistant) {
        return candidate;
      }
    }

    return null;
  }

  override async getLatestResponseMarkdown(page: Page): Promise<string | null> {
    const latestTurn = await this.latestAssistantTurn(page);
    if (!latestTurn) {
      return null;
    }

    // Use the same multi-artifact download logic as the read path
    const artifacts = await this.downloadTurnArtifacts(page, latestTurn);
    if (artifacts.length === 0) {
      return null;
    }

    // Combine inline markdown segments with all artifact contents
    const segmentLocator = latestTurn.locator(".standard-markdown, .progressive-markdown");
    const segmentCount = await segmentLocator.count().catch(() => 0);
    const htmlSegments: string[] = [];
    for (let i = 0; i < segmentCount; i += 1) {
      const html = await segmentLocator.nth(i).innerHTML().catch(() => "");
      if (html.trim()) {
        htmlSegments.push(html);
      }
    }

    const inlineMarkdown = htmlSegments.length > 0
      ? htmlToMarkdown(htmlSegments.join("\n")).trim()
      : "";
    const artifactMarkdown = artifacts.map((a) => a.content.trim()).join("\n\n");

    return inlineMarkdown
      ? `${inlineMarkdown}\n\n${artifactMarkdown.trim()}\n`
      : `${artifactMarkdown.trim()}\n`;
  }

  async getCurrentModel(page: Page): Promise<ModelInfo | null> {
    const locator = await this.visibleNamedLocator(page, "model_picker");
    if (!locator) {
      return null;
    }
    const label = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim() || null;
    if (!label) {
      return null;
    }

    const normalized = normalizeText(label);
    const effort = normalized.includes("extended") ? "Extended" : null;
    const family = label.replace(/\bextended\b/gi, "").replace(/\s+/g, " ").trim() || label;
    return this.modelInfo({
      family,
      effort,
    });
  }

  private async downloadTurnArtifacts(page: Page, turn: Locator): Promise<ConversationArtifact[]> {
    const buttons = turn.getByRole("button", { name: /^download$/i });
    const count = await buttons.count().catch(() => 0);
    const artifacts: ConversationArtifact[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < count; index += 1) {
      const downloadButton = buttons.nth(index);
      if (!(await downloadButton.isVisible().catch(() => false))) {
        continue;
      }

      try {
        await downloadButton.scrollIntoViewIfNeeded().catch(() => undefined);
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: ARTIFACT_DOWNLOAD_TIMEOUT_MS }),
          downloadButton.click(),
        ]);
        if (!download.suggestedFilename().toLowerCase().endsWith(".md")) {
          continue;
        }

        const filePath = await download.path();
        if (!filePath) {
          continue;
        }

        const content = await fs.readFile(filePath, "utf8");
        const trimmed = content.trim();
        if (!trimmed) {
          continue;
        }

        const key = `${download.suggestedFilename()}::${trimmed}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        artifacts.push({
          filename: download.suggestedFilename(),
          content: `${trimmed}\n`,
        });
      } catch {
        continue;
      }
    }

    return artifacts;
  }

  override async extractConversation(page: Page): Promise<ConversationTurn[]> {
    const locator = await this.waitForAttachedNamedLocator(page, "conversation_messages");
    if (!locator) {
      throw new Error("Could not find Claude conversation messages");
    }

    const turns: ConversationTurn[] = [];
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const turn = locator.nth(index);
      const meta = await turn.evaluate((element) => ({
        isUser: element.getAttribute("data-testid") === "user-message",
        isAssistant: element.getAttribute("data-is-streaming") !== null,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        fallbackLabels: Array.from(element.querySelectorAll("button"))
          .map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((text) => text.length > 0 && !/^(retry|download)$/i.test(text)),
      }));

      if (!meta.text) {
        continue;
      }

      if (meta.isUser) {
        const html = await turn.innerHTML().catch(() => "");
        if (html.trim()) {
          turns.push({ role: "user", html });
        }
        continue;
      }

      if (!meta.isAssistant) {
        continue;
      }

      const segmentLocator = turn.locator(".standard-markdown, .progressive-markdown");
      const segmentCount = await segmentLocator.count().catch(() => 0);
      const htmlSegments: string[] = [];
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        const html = await segmentLocator.nth(segmentIndex).innerHTML().catch(() => "");
        if (html.trim()) {
          htmlSegments.push(html);
        }
      }

      const html = htmlSegments.join("\n");
      const artifacts = await this.downloadTurnArtifacts(page, turn);
      if (artifacts.length > 0) {
        const inlineMarkdown = html.trim() ? htmlToMarkdown(html).trim() : "";
        const artifactMarkdown = artifacts.map((artifact) => artifact.content.trim()).join("\n\n");
        turns.push({
          role: "assistant",
          html,
          markdown: inlineMarkdown ? `${inlineMarkdown}\n\n${artifactMarkdown.trim()}\n` : `${artifactMarkdown.trim()}\n`,
          artifacts,
        });
        continue;
      }

      if (html.trim()) {
        turns.push({
          role: "assistant",
          html,
        });
        continue;
      }

      if (meta.fallbackLabels.length > 0 || /response was interrupted/i.test(meta.text)) {
        const uniqueLabels = Array.from(new Set(meta.fallbackLabels));
        const fallbackParts = uniqueLabels.map((label) => `_${label}_`);
        if (/response was interrupted/i.test(meta.text)) {
          fallbackParts.push("_Claude's response was interrupted._");
        }
        turns.push({
          role: "assistant",
          html: "",
          markdown: `${fallbackParts.join("\n\n")}\n`,
        });
      }
    }

    return turns;
  }

  protected override isModelOption(label: string): boolean {
    const normalized = normalizeText(label);
    if (!super.isModelOption(label)) {
      return false;
    }
    return /claude|sonnet|opus|haiku|extended thinking/.test(normalized);
  }
}
