import test from "node:test";
import assert from "node:assert/strict";
import { clickFirstVisible, firstVisibleLocator, firstVisibleSelector } from "./utils.js";

interface LocatorState {
  visible: boolean;
  text?: string;
}

class FakeLocator {
  constructor(
    private readonly selectors: Record<string, LocatorState[]>,
    private readonly clicks: string[],
    private readonly selector: string,
    private readonly index: number | null = null,
  ) {}

  async count() { return this.selectors[this.selector]?.length ?? 0; }
  nth(index: number) { return new FakeLocator(this.selectors, this.clicks, this.selector, index); }
  async isVisible() {
    if (this.index === null) return false;
    return Boolean(this.selectors[this.selector]?.[this.index]?.visible);
  }
  async click() {
    if (this.index === null) throw new Error("Cannot click locator collection");
    this.clicks.push(`${this.selector}:${this.index}`);
  }
}

class FakePage {
  readonly clicks: string[] = [];
  constructor(private readonly selectors: Record<string, LocatorState[]>) {}
  locator(selector: string) { return new FakeLocator(this.selectors, this.clicks, selector); }
}

test("firstVisibleSelector: skips hidden first matches and finds the visible candidate", async () => {
  const page = new FakePage({ "[data-send]": [{ visible: false }, { visible: true }] });
  assert.equal(await firstVisibleSelector(page as never, ["[data-send]"]), "[data-send]");
});

test("firstVisibleLocator: returns the visible candidate instead of the hidden first match", async () => {
  const page = new FakePage({ "[data-send]": [{ visible: false }, { visible: true }] });
  const match = await firstVisibleLocator(page as never, ["[data-send]"]);
  assert.equal(match?.selector, "[data-send]");
  assert.equal(await match?.locator.isVisible(), true);
});

test("clickFirstVisible: clicks the visible candidate instead of the hidden first match", async () => {
  const page = new FakePage({ "[data-send]": [{ visible: false }, { visible: true }] });
  await clickFirstVisible(page as never, ["[data-send]"]);
  assert.deepEqual(page.clicks, ["[data-send]:1"]);
});
