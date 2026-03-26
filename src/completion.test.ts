import test from "node:test";
import assert from "node:assert/strict";
import {
  hashText,
  isLikelyProgressStub,
  isUnexpectedCompletionNavigation,
  waitForCompletion,
} from "./completion.js";

test("hashText: is deterministic for equal input", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abcd"));
});

test("isLikelyProgressStub: detects short progress-style updates", () => {
  assert.equal(
    isLikelyProgressStub("I'm checking the best sources and finishing the synthesis now."),
    true,
  );
});

test("isLikelyProgressStub: ignores already-structured markdown", () => {
  assert.equal(isLikelyProgressStub("# Memo\n\n- point one\n- point two"), false);
  assert.equal(isLikelyProgressStub("```md\n# Report\n```"), false);
});

test("isUnexpectedCompletionNavigation: allows home-to-conversation transitions", () => {
  assert.equal(
    isUnexpectedCompletionNavigation("https://chatgpt.com/", "https://chatgpt.com/c/abc123"),
    false,
  );
});

test("isUnexpectedCompletionNavigation: flags auth redirects and conversation swaps", () => {
  assert.equal(
    isUnexpectedCompletionNavigation("https://chatgpt.com/c/abc123", "https://chatgpt.com/auth/login"),
    true,
  );
  assert.equal(
    isUnexpectedCompletionNavigation("https://claude.ai/chat/abc123", "https://claude.ai/chat/xyz999"),
    true,
  );
});

interface SnapshotStep {
  responseCount: number;
  responseText: string;
  sendVisible?: boolean;
  stopVisible?: boolean;
}

class FakeLocator {
  constructor(
    private readonly resolver: () => SnapshotStep,
    private readonly selector: string,
    private readonly index: number | null = null,
  ) {}

  async count(): Promise<number> {
    const step = this.resolver();
    if (this.selector === "[data-response]") return step.responseCount;
    if (this.selector === "[data-send]" && step.sendVisible) return 1;
    if (this.selector === "[data-stop]" && step.stopVisible) return 1;
    return 0;
  }

  last() {
    return new FakeLocator(this.resolver, this.selector, Math.max(this.countSync() - 1, 0));
  }

  first() {
    return new FakeLocator(this.resolver, this.selector, 0);
  }

  nth(index: number) {
    return new FakeLocator(this.resolver, this.selector, index);
  }

  async innerText() {
    return this.resolver().responseText;
  }

  async isVisible() {
    const step = this.resolver();
    if (this.selector === "[data-send]") return this.index === 0 && Boolean(step.sendVisible);
    if (this.selector === "[data-stop]") return this.index === 0 && Boolean(step.stopVisible);
    return this.selector === "[data-response]" && (this.index ?? 0) < step.responseCount;
  }

  private countSync() {
    const step = this.resolver();
    if (this.selector === "[data-response]") return step.responseCount;
    if (this.selector === "[data-send]" && step.sendVisible) return 1;
    if (this.selector === "[data-stop]" && step.stopVisible) return 1;
    return 0;
  }
}

class FakePage {
  private index = 0;
  constructor(private readonly steps: SnapshotStep[], private readonly currentUrl = "https://chatgpt.com/c/test") {}

  url() { return this.currentUrl; }
  locator(selector: string) { return new FakeLocator(() => this.steps[Math.min(this.index, this.steps.length - 1)]!, selector); }
  async waitForTimeout(_ms: number) { this.index += 1; }
}

test("waitForCompletion: completes one poll earlier when send button returns", async () => {
  const page = new FakePage([
    { responseCount: 0, responseText: "", sendVisible: false, stopVisible: true },
    { responseCount: 1, responseText: "Final answer", sendVisible: true, stopVisible: false },
    { responseCount: 1, responseText: "Final answer", sendVisible: true, stopVisible: false },
  ]);

  const outcome = await waitForCompletion(
    page as never,
    { response_container: "[data-response]", send_button: "[data-send]", stop_button: "[data-stop]" },
    { timeoutMs: 5_000, minimumResponseCount: 1 },
  );

  assert.equal(outcome.outcome, "completed");
});

test("waitForCompletion: still requires an extra stable poll without send visibility", async () => {
  const page = new FakePage([
    { responseCount: 0, responseText: "", sendVisible: false, stopVisible: true },
    { responseCount: 1, responseText: "Final answer", sendVisible: false, stopVisible: false },
    { responseCount: 1, responseText: "Final answer", sendVisible: false, stopVisible: false },
    { responseCount: 1, responseText: "Final answer", sendVisible: false, stopVisible: false },
  ]);

  const outcome = await waitForCompletion(
    page as never,
    { response_container: "[data-response]", send_button: "[data-send]", stop_button: "[data-stop]" },
    { timeoutMs: 5_000, minimumResponseCount: 1 },
  );

  assert.equal(outcome.outcome, "completed");
});
