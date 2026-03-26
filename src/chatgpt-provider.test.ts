import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderSelectorConfig } from "./types.js";
import { ChatGPTProvider } from "./providers/chatgpt.js";

interface FakeNode {
  visible: boolean;
  text?: string;
  attrs?: Record<string, string>;
  onClick?: () => void;
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
    private readonly index: number | null = null,
  ) {}

  async count() { return this.page.nodesFor(this.selector).length; }
  nth(index: number) { return new FakeLocator(this.page, this.selector, index); }
  first() { return this.nth(0); }
  async isVisible() { return this.node()?.visible ?? false; }
  async innerText() { return this.node()?.text ?? ""; }
  async getAttribute(name: string) { return this.node()?.attrs?.[name] ?? null; }
  locator(selector: string) { return new FakeLocator(this.page, `${this.selector} >> ${selector}`); }
  async click() { this.node()?.onClick?.(); }

  private node(): FakeNode | null {
    if (this.index === null) return null;
    return this.page.nodesFor(this.selector)[this.index] ?? null;
  }
}

class FakePage {
  selectedFamily = "Pro";
  selectedVariant = "Extended";
  modelMenuOpen = false;
  effortMenuOpen = false;

  readonly keyboard = {
    press: async (key: string) => {
      if (key === "Escape") {
        this.modelMenuOpen = false;
        this.effortMenuOpen = false;
      }
    },
  };

  locator(selector: string) { return new FakeLocator(this, selector); }
  async waitForTimeout(_ms: number) { return; }

  nodesFor(selector: string): FakeNode[] {
    if (selector.includes(">>")) return [];

    if (selector === "[data-model-picker]") {
      return [{ visible: true, text: "ChatGPT", onClick: () => { this.modelMenuOpen = true; } }];
    }

    if (selector === "[data-effort-picker]") {
      return [{
        visible: this.selectedFamily !== "Instant",
        text: this.selectedFamily === "Thinking" ? "Thinking" : this.selectedVariant,
        onClick: () => { this.effortMenuOpen = true; },
      }];
    }

    if (selector === "[role='menuitemradio']" && this.modelMenuOpen) {
      return ["Instant", "Thinking", "Pro"].map((label) => ({
        visible: true,
        text: label,
        attrs: { "aria-checked": this.selectedFamily === label ? "true" : "false" },
        onClick: () => {
          this.selectedFamily = label;
          this.selectedVariant = label === "Thinking" ? "Standard" : label === "Pro" ? "Extended" : "";
        },
      }));
    }

    if (selector === "[role='option']" && this.effortMenuOpen) {
      const variants = this.selectedFamily === "Thinking"
        ? ["Light", "Standard", "Extended", "Heavy"]
        : this.selectedFamily === "Pro"
          ? ["Standard", "Extended"]
          : [];
      return variants.map((label) => ({
        visible: true,
        text: label,
        attrs: { "aria-checked": this.selectedVariant === label ? "true" : "false" },
        onClick: () => { this.selectedVariant = label; },
      }));
    }

    return [];
  }
}

const config: ProviderSelectorConfig = {
  version: 1,
  provider: "chatgpt",
  url: "https://chatgpt.com",
  selectors: {
    model_picker: { description: "Model picker", primary: "[data-model-picker]" },
    model_option: { description: "Model option", primary: "[role='menuitemradio']" },
    effort_picker: { description: "Effort picker", primary: "[data-effort-picker]" },
    effort_option: { description: "Effort option", primary: "[role='option']" },
  },
};

test("ChatGPTProvider: getCurrentModel stays passive when the visible chrome is ambiguous", async () => {
  const provider = new ChatGPTProvider(config);
  const page = new FakePage();
  page.selectedFamily = "Thinking";
  page.selectedVariant = "Standard";
  const model = await provider.getCurrentModel(page as never);
  assert.equal(model, null);
});

test("ChatGPTProvider: selectModel requires concrete inputs and exposes the full canonical list", async () => {
  const provider = new ChatGPTProvider(config);
  const page = new FakePage();

  await assert.rejects(
    provider.selectModel(page as never, "Thinking"),
    /not found for ChatGPT/,
  );

  const exact = await provider.selectModel(page as never, "Thinking/Standard");
  assert.deepEqual(exact, {
    label: "Thinking/Standard",
    family: "Thinking",
    familyId: "thinking",
    effort: "Standard",
    effortId: "standard",
  });

  const catalog = await provider.listModels(page as never);
  assert.deepEqual(catalog.inputs.map((i) => i.label), [
    "Instant", "Thinking/Light", "Thinking/Standard", "Thinking/Extended", "Thinking/Heavy", "Pro/Standard", "Pro/Extended",
  ]);
});
