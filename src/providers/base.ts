import type { Locator, Page } from "playwright";
import { selectorCandidates } from "../config.js";
import { buildModelInfo } from "../models.js";
import {
  ATTACHED_LOCATOR_POLL_MS,
  ATTACHED_LOCATOR_TIMEOUT_MS,
  SCROLL_IDLE_SETTLE_MS,
  SCROLL_MAX_PASSES,
  SCROLL_MOVED_SETTLE_MS,
  SCROLL_SETTLED_POLL_MS,
  SETTLED_MAX_PASSES,
} from "../timing.js";
import type {
  ConversationTurn,
  ModelInfo,
  ModelOption,
  ProviderAdapter,
  PromptSubmission,
  ProviderModelCatalog,
  ProviderSelectorConfig,
} from "../types.js";
import {
  clickFirstVisible,
  firstAttachedSelector,
  firstVisibleLocator,
  firstVisibleSelector,
  normalizeText,
} from "../utils.js";

export abstract class BaseProvider implements ProviderAdapter {
  readonly name;
  readonly config;

  protected constructor(config: ProviderSelectorConfig) {
    this.name = config.provider;
    this.config = config;
  }

  protected candidates(name: string): string[] {
    const selector = this.config.selectors[name];
    if (!selector) {
      throw new Error(`Missing selector ${name} for ${this.name}`);
    }
    return selectorCandidates(selector);
  }

  protected async clickNamedSelector(page: Page, name: string): Promise<string> {
    return clickFirstVisible(page, this.candidates(name));
  }

  protected async visibleNamedSelector(page: Page, name: string): Promise<string | null> {
    return firstVisibleSelector(page, this.candidates(name));
  }

  protected async visibleNamedLocator(page: Page, name: string): Promise<Locator | null> {
    return (await firstVisibleLocator(page, this.candidates(name)))?.locator ?? null;
  }

  protected async attachedNamedSelector(page: Page, name: string): Promise<string | null> {
    return firstAttachedSelector(page, this.candidates(name));
  }

  protected async waitForAttachedNamedLocator(
    page: Page,
    name: string,
    timeoutMs = ATTACHED_LOCATOR_TIMEOUT_MS,
  ): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of this.candidates(name)) {
        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
          return locator;
        }
      }
      await page.waitForTimeout(ATTACHED_LOCATOR_POLL_MS);
    }

    return null;
  }

  protected async collectModelOptions(page: Page): Promise<ModelOption[]> {
    const optionSelectors = this.candidates("model_option");
    const seen = new Set<string>();
    const options: ModelOption[] = [];

    for (const selector of optionSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        if (!(await option.isVisible().catch(() => false))) {
          continue;
        }
        const rawText = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const label = rawText.split("\n")[0]?.trim() ?? rawText;
        if (!label || seen.has(label)) {
          continue;
        }
        seen.add(label);
        options.push({
          label,
          rawText,
          selected: await this.isSelectedOption(option),
        });
      }
    }

    return options.filter((option) => this.isModelOption(option.label));
  }

  protected isModelOption(label: string): boolean {
    const normalized = normalizeText(label);
    if (!normalized) {
      return false;
    }
    return ![
      "log in",
      "sign up",
      "manage cookies",
      "reject non-essential",
      "accept all",
      "try advanced features for free",
    ].includes(normalized);
  }

  protected async isSelectedOption(option: Locator): Promise<boolean> {
    const ariaChecked = await option.getAttribute("aria-checked").catch(() => null);
    if (ariaChecked === "true") {
      return true;
    }

    const dataState = await option.getAttribute("data-state").catch(() => null);
    if (dataState === "checked" || dataState === "active") {
      return true;
    }

    const ariaSelected = await option.getAttribute("aria-selected").catch(() => null);
    if (ariaSelected === "true") {
      return true;
    }

    const nestedSelected = option.locator('[aria-checked="true"], [data-state="checked"], [data-state="active"], [aria-selected="true"]');
    return (await nestedSelected.count().catch(() => 0)) > 0;
  }

  protected async clickModelOption(page: Page, requestedModel: string): Promise<string | null> {
    const normalizedRequested = normalizeText(requestedModel);
    for (const selector of this.candidates("model_option")) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        if (!(await option.isVisible().catch(() => false))) {
          continue;
        }
        const rawText = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const normalizedLabel = normalizeText(rawText);
        if (
          normalizedLabel === normalizedRequested ||
          normalizedLabel.includes(normalizedRequested) ||
          normalizedRequested.includes(normalizedLabel)
        ) {
          await option.click();
          return rawText.split("\n")[0]?.trim() ?? rawText;
        }
      }
    }

    return null;
  }

  protected async extractLatestHtml(page: Page, selectorNames: string[]): Promise<string> {
    for (const name of selectorNames) {
      const selectors = this.candidates(name);
      for (const selector of selectors) {
        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        if (count === 0) {
          continue;
        }
        for (let index = count - 1; index >= 0; index -= 1) {
          const candidate = locator.nth(index);
          const text = (await candidate.innerText().catch(() => "")).trim();
          if (!text) {
            continue;
          }
          const html = await candidate.innerHTML().catch(() => "");
          if (html.trim()) {
            return html;
          }
        }
      }
    }

    throw new Error(`Could not extract a response container for ${this.name}`);
  }

  protected async responseContainerCount(page: Page): Promise<number> {
    for (const selector of this.candidates("response_container")) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return count;
      }
    }

    return 0;
  }

  protected modelInfo(args: {
    family: string | null;
    effort?: string | null;
  }): ModelInfo | null {
    return buildModelInfo(args);
  }

  private async conversationSignature(page: Page): Promise<string> {
    const locator = await this.waitForAttachedNamedLocator(page, "conversation_messages", 5_000);
    if (!locator) {
      return "0::";
    }

    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      return "0::";
    }

    const first = locator.first();
    const last = locator.nth(count - 1);
    const [firstText, lastText] = await Promise.all([
      first.textContent().catch(() => ""),
      last.textContent().catch(() => ""),
    ]);

    return [
      count,
      normalizeText((firstText ?? "").slice(0, 160)),
      normalizeText((lastText ?? "").slice(0, 160)),
    ].join("::");
  }

  private async scrollConversationViewport(page: Page): Promise<{
    moved: boolean;
    atTop: boolean;
  }> {
    return page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const overflowY = style.overflowY;
          if (!["auto", "scroll"].includes(overflowY)) {
            return false;
          }
          if (element.scrollHeight <= element.clientHeight + 80) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.height >= 240 && rect.width >= 320;
        })
        .sort((left, right) => {
          const leftArea = left.clientHeight * left.clientWidth;
          const rightArea = right.clientHeight * right.clientWidth;
          return rightArea - leftArea;
        });

      const target = candidates[0] ?? (document.scrollingElement as HTMLElement | null);
      if (!target) {
        return { moved: false, atTop: true };
      }

      const before = target.scrollTop;
      const next = Math.max(0, before - Math.max(target.clientHeight * 0.9, 600));
      target.scrollTop = next;
      return {
        moved: next !== before,
        atTop: next <= 0,
      };
    });
  }

  abstract gotoHome(page: Page): Promise<void>;
  abstract isLoggedIn(page: Page): Promise<boolean>;
  abstract listModels(page: Page): Promise<ProviderModelCatalog>;
  abstract selectModel(page: Page, requestedModel: string): Promise<ModelInfo>;
  abstract startNewChat(page: Page): Promise<void>;
  abstract focusInput(page: Page): Promise<Locator>;
  abstract submitPrompt(page: Page, prompt: string): Promise<PromptSubmission>;
  async getLatestResponseMarkdown(_page: Page): Promise<string | null> {
    return null;
  }
  abstract getLatestResponseHtml(page: Page): Promise<string>;
  abstract getCurrentModel(page: Page): Promise<ModelInfo | null>;
  async getCurrentModelLabel(page: Page): Promise<string | null> {
    return (await this.getCurrentModel(page))?.label ?? null;
  }
  async prepareConversationForRead(page: Page): Promise<void> {
    let stablePasses = 0;
    let lastSignature = "";

    for (let pass = 0; pass < SCROLL_MAX_PASSES; pass += 1) {
      const beforeSignature = await this.conversationSignature(page);
      const scroll = await this.scrollConversationViewport(page);
      await page.waitForTimeout(scroll.moved ? SCROLL_MOVED_SETTLE_MS : SCROLL_IDLE_SETTLE_MS);
      const afterSignature = await this.conversationSignature(page);

      if (afterSignature === beforeSignature && afterSignature === lastSignature) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }
      lastSignature = afterSignature;

      if ((scroll.atTop && !scroll.moved && stablePasses >= 1) || stablePasses >= 2) {
        break;
      }
    }

    let settledPasses = 0;
    let settledSignature = await this.conversationSignature(page);
    for (let pass = 0; pass < SETTLED_MAX_PASSES; pass += 1) {
      await page.waitForTimeout(SCROLL_SETTLED_POLL_MS);
      const signature = await this.conversationSignature(page);
      if (signature === settledSignature) {
        settledPasses += 1;
      } else {
        settledPasses = 0;
        settledSignature = signature;
      }
      if (settledPasses >= 2) {
        break;
      }
    }
  }
  async extractConversation(page: Page): Promise<ConversationTurn[]> {
    const locator = await this.waitForAttachedNamedLocator(page, "conversation_messages");
    if (!locator) {
      throw new Error(`Could not find conversation messages for ${this.name}`);
    }

    const turns: ConversationTurn[] = [];
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const turn = locator.nth(index);
      const snapshot = await turn.evaluate((element) => {
        const roleAttr = element.getAttribute("data-message-author-role");
        let role: "user" | "assistant" | null = null;
        if (roleAttr === "user" || roleAttr === "assistant") {
          role = roleAttr;
        } else {
          const testId = element.getAttribute("data-testid") ?? "";
          const className = String((element as HTMLElement).className ?? "");
          if (
            testId === "user-message" ||
            /(?:^|\s)!?font-user-message(?:\s|$)/.test(className) ||
            /user-message/.test(className)
          ) {
            role = "user";
          } else if (
            element.getAttribute("data-is-streaming") !== null ||
            /assistant/.test(testId) ||
            /claude-response|assistant/.test(className)
          ) {
            role = "assistant";
          }
        }

        return {
          role,
          html: element.innerHTML,
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        };
      });

      if (!snapshot.role || !snapshot.text || !snapshot.html.trim()) {
        continue;
      }

      turns.push({
        role: snapshot.role,
        html: snapshot.html,
      });
    }

    return turns;
  }
}
