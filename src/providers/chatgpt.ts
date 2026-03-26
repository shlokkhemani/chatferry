import type { Locator, Page } from "playwright";
import { humanPause, insertPromptText } from "../human.js";
import {
  buildModelInfo,
  findMatchingInput,
  storedModelCatalog,
  storedModelFamilies,
} from "../models.js";
import {
  WAIT_FOR_COMPOSER_MS,
  COMPOSER_POLL_MS,
  NAV_RETRY_PAUSE_MS,
  NAV_TIMEOUT_MS,
  LOGIN_CHECK_TIMEOUT_MS,
  LOGIN_CHECK_POLL_MS,
  MODEL_PICKER_OPEN_MS,
  EFFORT_PICKER_OPEN_MS,
  MODEL_FAMILY_SETTLE_MS,
  EFFORT_OPTION_SETTLE_MS,
  MODEL_VERIFY_PAUSE_MS,
  NEW_CHAT_SETTLE_MS,
  PRE_TYPE_PAUSE,
  PRE_SEND_PAUSE,
  CURRENT_MODEL_PASSIVE_TIMEOUT_MS,
  CURRENT_MODEL_PASSIVE_POLL_MS,
  CURRENT_MODEL_ACTIVE_TIMEOUT_MS,
  CURRENT_MODEL_ACTIVE_POLL_MS,
} from "../timing.js";
import type {
  ConversationTurn,
  ModelInfo,
  ModelOption,
  PromptSubmission,
  ProviderModelCatalog,
  ProviderSelectorConfig,
} from "../types.js";
import { normalizeText } from "../utils.js";
import { BaseProvider } from "./base.js";

export class ChatGPTProvider extends BaseProvider {
  constructor(config: ProviderSelectorConfig) {
    super(config);
  }

  private async waitForComposerOrLogin(page: Page, timeoutMs = WAIT_FOR_COMPOSER_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.visibleNamedLocator(page, "input")) !== null) {
        return;
      }
      if (await this.hasVisibleLoginButton(page)) {
        return;
      }
      await page.waitForTimeout(COMPOSER_POLL_MS);
    }
  }

  private topLevelFamilyLabel(label: string): string {
    const normalized = normalizeText(label);
    if (normalized.startsWith("instant")) {
      return "Instant";
    }
    if (normalized.startsWith("thinking")) {
      return "Thinking";
    }
    if (normalized.startsWith("pro")) {
      return "Pro";
    }
    return label.replace(/\s+/g, " ").trim();
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
  }

  private canonicalFamilyLabel(label: string | null | undefined): string | null {
    const normalized = normalizeText(label ?? "");
    if (!normalized || normalized === "chatgpt") {
      return null;
    }

    for (const family of storedModelFamilies("chatgpt")) {
      const normalizedFamily = normalizeText(family.label);
      if (normalized === normalizedFamily || normalized.startsWith(normalizedFamily)) {
        return family.label;
      }
    }

    return null;
  }

  private canonicalVariantLabel(familyLabel: string | null, label: string | null | undefined): string | null {
    if (!familyLabel) {
      return null;
    }

    const family = storedModelFamilies("chatgpt").find(
      (entry) => normalizeText(entry.label) === normalizeText(familyLabel),
    );
    if (!family) {
      return null;
    }

    const normalized = normalizeText(label ?? "");
    if (!normalized) {
      return null;
    }

    for (const variant of family.variants) {
      const normalizedVariant = normalizeText(variant.label);
      if (
        normalized === normalizedVariant ||
        normalized.includes(normalizedVariant) ||
        normalizedVariant.includes(normalized)
      ) {
        return variant.label;
      }
    }

    return null;
  }

  private async hasVisibleLoginButton(page: Page): Promise<boolean> {
    const loginButton = page.getByRole("button", { name: /^log in$/i });
    const count = await loginButton.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await loginButton.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const deadline = Date.now() + LOGIN_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.hasVisibleLoginButton(page)) {
        return false;
      }
      if ((await this.visibleNamedSelector(page, "input")) !== null) {
        return true;
      }
      await page.waitForTimeout(LOGIN_CHECK_POLL_MS);
    }

    return !(await this.hasVisibleLoginButton(page)) && (await this.visibleNamedSelector(page, "input")) !== null;
  }

  private async openModelPicker(page: Page): Promise<void> {
    await this.clickNamedSelector(page, "model_picker");
    await page.waitForTimeout(MODEL_PICKER_OPEN_MS);
  }

  private async openEffortPicker(page: Page): Promise<boolean> {
    const locator = await this.visibleNamedLocator(page, "effort_picker");
    if (!locator) {
      return false;
    }

    await locator.click();
    await page.waitForTimeout(EFFORT_PICKER_OPEN_MS);
    return true;
  }

  private async collectTopLevelModels(page: Page): Promise<ModelOption[]> {
    await this.openModelPicker(page);
    const options = await this.collectModelOptions(page);
    await page.keyboard.press("Escape").catch(() => undefined);
    const seen = new Set<string>();
    return options
      .filter((option) => !normalizeText(option.label).includes("configure"))
      .map((option) => ({
        ...option,
        label: this.topLevelFamilyLabel(option.label),
      }))
      .filter((option) => {
        if (seen.has(option.label)) {
          return false;
        }
        seen.add(option.label);
        return true;
      });
  }

  private async collectEffortOptions(page: Page): Promise<ModelOption[]> {
    const opened = await this.openEffortPicker(page);
    if (!opened) {
      return [];
    }

    const options: ModelOption[] = [];
    for (const selector of this.candidates("effort_option")) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        const label = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!label) {
          continue;
        }
        options.push({
          label,
          rawText: label,
          selected: await this.isSelectedOption(option),
        });
      }
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    return options.filter((option) => /\b(light|standard|extended|heavy)\b/i.test(option.label));
  }

  private async selectTopLevelModel(page: Page, requestedFamily: string): Promise<string> {
    await this.openModelPicker(page);
    const selectedLabel = await this.clickModelOption(page, requestedFamily);
    if (!selectedLabel) {
      const options = await this.collectModelOptions(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(
        `Model "${requestedFamily}" not found for ChatGPT. Available: ${options.map((option) => option.label).join(", ")}`,
      );
    }

    await page.waitForTimeout(MODEL_FAMILY_SETTLE_MS);
    return this.topLevelFamilyLabel(selectedLabel);
  }

  private async selectEffort(page: Page, requestedEffort: string): Promise<string> {
    const opened = await this.openEffortPicker(page);
    if (!opened) {
      throw new Error("ChatGPT effort pill is not visible for the current model");
    }

    for (const selector of this.candidates("effort_option")) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        const label = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const normalizedLabel = normalizeText(label);
        const normalizedRequested = normalizeText(requestedEffort);
        if (
          normalizedLabel === normalizedRequested ||
          normalizedLabel.includes(normalizedRequested) ||
          normalizedRequested.includes(normalizedLabel)
        ) {
          await option.click();
          await page.waitForTimeout(EFFORT_OPTION_SETTLE_MS);
          return label;
        }
      }
    }

    const options = await this.collectEffortOptions(page);
    throw new Error(
      `Effort "${requestedEffort}" not found for ChatGPT. Available: ${options.map((option) => option.label).join(", ")}`,
    );
  }

  private async readCurrentFamilyFromMenu(page: Page): Promise<string | null> {
    await this.openModelPicker(page);
    try {
      const options = await this.collectModelOptions(page);
      const selected = options.find((option) => option.selected) ?? null;
      return this.canonicalFamilyLabel(selected?.label ?? null);
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  private async readCurrentVariantFromMenu(page: Page, familyLabel: string | null): Promise<string | null> {
    if (!familyLabel) {
      return null;
    }

    const opened = await this.openEffortPicker(page);
    if (!opened) {
      return null;
    }

    try {
      const options: ModelOption[] = [];
      for (const selector of this.candidates("effort_option")) {
        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const option = locator.nth(index);
          const label = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
          if (!label) {
            continue;
          }
          options.push({
            label,
            rawText: label,
            selected: await this.isSelectedOption(option),
          });
        }
      }

      const selected = options.find((option) => option.selected) ?? null;
      return this.canonicalVariantLabel(familyLabel, selected?.label ?? null);
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  async listModels(page: Page): Promise<ProviderModelCatalog> {
    return storedModelCatalog("chatgpt", await this.inspectCurrentModel(page));
  }

  async selectModel(page: Page, requestedModel: string): Promise<ModelInfo> {
    const catalog = storedModelCatalog("chatgpt", await this.getCurrentModel(page));
    let input = findMatchingInput(catalog, requestedModel);
    if (!input) {
      // Fallback: enumerate live UI models before failing
      const liveModels = await this.collectTopLevelModels(page);
      const liveLabels = liveModels.map((m) => m.label);
      throw new Error(
        `Model "${requestedModel}" not found for ChatGPT. Available: ${liveLabels.join(", ")} (live) / ${catalog.inputs.map((entry) => entry.label).join(", ")} (catalog)`,
      );
    }

    await this.selectTopLevelModel(page, input.family);
    let selectedEffort: string | null = null;
    if (input.effort) {
      selectedEffort = await this.selectEffort(page, input.effort);
    }

    await page.waitForTimeout(MODEL_VERIFY_PAUSE_MS);
    const observed = await this.getCurrentModel(page);
    if (observed) {
      if (selectedEffort && normalizeText(observed.effort ?? "") !== normalizeText(selectedEffort)) {
        throw new Error(`ChatGPT mode mismatch after selecting ${requestedModel}. Observed=${observed.label ?? "unknown"}`);
      }
      if (normalizeText(observed.family ?? "") !== normalizeText(input.family)) {
        throw new Error(`ChatGPT family mismatch after selecting ${requestedModel}. Observed=${observed.label ?? "unknown"}`);
      }
      return observed;
    }

    return buildModelInfo({
      family: input.family,
      effort: selectedEffort ?? input.effort,
    })!;
  }

  async startNewChat(page: Page): Promise<void> {
    const locator = await this.visibleNamedLocator(page, "new_chat");
    if (locator) {
      try {
        await locator.click();
      } catch {
        await page.keyboard.press(`Shift+${process.platform === "darwin" ? "Meta" : "Control"}+O`).catch(() => undefined);
      }
      await this.waitForComposerOrLogin(page, NEW_CHAT_SETTLE_MS);
      return;
    }

    await this.navigateWithRetry(page, this.config.url);
  }

  async focusInput(page: Page): Promise<Locator> {
    const locator = await this.visibleNamedLocator(page, "input");
    if (!locator) {
      throw new Error("Could not find ChatGPT input");
    }
    await locator.click();
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
    if (!sendButton) {
      throw new Error("Could not find ChatGPT send button");
    }
    await sendButton.click();
    return {
      baselineResponseCount,
      conversationUrlBeforeSend,
    };
  }

  async getLatestResponseHtml(page: Page): Promise<string> {
    return this.extractLatestHtml(page, ["response_container"]);
  }

  private normalizeEffortLabel(label: string): string | null {
    const normalized = normalizeText(label);
    if (!normalized) {
      return null;
    }
    if (normalized.includes("heavy")) {
      return "Heavy";
    }
    if (normalized.includes("extended")) {
      return "Extended";
    }
    if (normalized.includes("light")) {
      return "Light";
    }
    if (normalized.includes("standard")) {
      return "Standard";
    }
    return label.replace(/\s+/g, " ").trim() || null;
  }

  async getCurrentModel(page: Page): Promise<ModelInfo | null> {
    const deadline = Date.now() + CURRENT_MODEL_PASSIVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const model = await this.readPassiveCurrentModel(page);
      if (model) {
        return model;
      }
      await page.waitForTimeout(CURRENT_MODEL_PASSIVE_POLL_MS);
    }

    return this.readPassiveCurrentModel(page);
  }

  private async inspectCurrentModel(page: Page): Promise<ModelInfo | null> {
    const deadline = Date.now() + CURRENT_MODEL_ACTIVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const model = await this.readActiveCurrentModel(page);
      if (model) {
        return model;
      }
      await page.waitForTimeout(CURRENT_MODEL_ACTIVE_POLL_MS);
    }

    return this.readActiveCurrentModel(page);
  }

  private async readPassiveCurrentModel(page: Page): Promise<ModelInfo | null> {
    const locator = await this.visibleNamedLocator(page, "model_picker");
    if (!locator) {
      return null;
    }

    const pickerText = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const family = this.canonicalFamilyLabel(pickerText);
    if (!family) {
      return null;
    }

    const familyDefinition = storedModelFamilies("chatgpt").find(
      (entry) => normalizeText(entry.label) === normalizeText(family),
    );

    let effort: string | null = null;
    if (familyDefinition && familyDefinition.variants.length > 0) {
      const effortLocator = await this.visibleNamedLocator(page, "effort_picker");
      const effortText = effortLocator
        ? (await effortLocator.innerText().catch(() => "")).replace(/\s+/g, " ").trim()
        : "";
      effort = this.canonicalVariantLabel(family, effortText) ?? this.normalizeEffortLabel(effortText);
      if (!effort || !this.canonicalVariantLabel(family, effort)) {
        effort = await this.readCurrentVariantFromMenu(page, family);
      }
      if (!effort) {
        return null;
      }
    }

    return this.modelInfo({
      family,
      effort,
    });
  }

  private async readActiveCurrentModel(page: Page): Promise<ModelInfo | null> {
    const passive = await this.readPassiveCurrentModel(page);
    if (passive) {
      return passive;
    }

    const locator = await this.visibleNamedLocator(page, "model_picker");
    if (!locator) {
      return null;
    }

    let family = await this.readCurrentFamilyFromMenu(page);
    if (!family) {
      return null;
    }

    const familyDefinition = storedModelFamilies("chatgpt").find(
      (entry) => normalizeText(entry.label) === normalizeText(family),
    );

    let effort: string | null = null;
    if (familyDefinition && familyDefinition.variants.length > 0) {
      const effortLocator = await this.visibleNamedLocator(page, "effort_picker");
      const effortText = effortLocator
        ? (await effortLocator.innerText().catch(() => "")).replace(/\s+/g, " ").trim()
        : "";
      effort = this.canonicalVariantLabel(family, effortText) ?? this.normalizeEffortLabel(effortText);
      if (!effort || !this.canonicalVariantLabel(family, effort)) {
        effort = await this.readCurrentVariantFromMenu(page, family);
      }
      if (!effort) {
        return null;
      }
    }

    return this.modelInfo({
      family,
      effort,
    });
  }

  override async extractConversation(page: Page): Promise<ConversationTurn[]> {
    return super.extractConversation(page);
  }

  protected override isModelOption(label: string): boolean {
    const normalized = normalizeText(label);
    if (!super.isModelOption(label)) {
      return false;
    }
    return /\b(?:gpt(?:-\d+(?:\.\d+)?)?|o1|o3|o4|mini|auto|pro|thinking|instant|4o|5(?:\.\d+)?)\b/.test(normalized);
  }
}
