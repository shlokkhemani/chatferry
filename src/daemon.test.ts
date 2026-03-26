import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright";
import { __daemonTestHelpers } from "./daemon.js";

function makePage(url = "about:blank"): Page {
  let closed = false;
  return {
    url: () => url,
    isClosed: () => closed,
    close: async () => { closed = true; },
  } as unknown as Page;
}

test("daemon slots: buildSlots creates lazy page slots without pre-opening tabs", async () => {
  const slots = await __daemonTestHelpers.buildSlots(3);
  assert.equal(slots.length, 3);
  for (const slot of slots) {
    assert.equal(slot.page, null);
    assert.equal(slot.task, null);
  }
});

test("daemon slots: ensureSlotPage opens one page and reuses it until closed", async () => {
  let newPageCount = 0;
  const firstPage = makePage();
  const secondPage = makePage("https://chatgpt.com");
  const context = {
    newPage: async () => {
      newPageCount += 1;
      return newPageCount === 1 ? firstPage : secondPage;
    },
  } as unknown as BrowserContext;

  const slot = (await __daemonTestHelpers.buildSlots(1))[0]!;
  const page1 = await __daemonTestHelpers.ensureSlotPage(context, slot);
  const page2 = await __daemonTestHelpers.ensureSlotPage(context, slot);
  assert.equal(page1, firstPage);
  assert.equal(page2, firstPage);
  assert.equal(newPageCount, 1);

  await __daemonTestHelpers.closeSlotPage(slot);
  const page3 = await __daemonTestHelpers.ensureSlotPage(context, slot);
  assert.equal(page3, secondPage);
  assert.equal(newPageCount, 2);
});

test("closeStartupBlankPages: closes a lone about:blank tab", async () => {
  const blank = makePage();
  const context = { pages: () => [blank] } as unknown as BrowserContext;
  await __daemonTestHelpers.closeStartupBlankPages(context);
  assert.equal(blank.isClosed(), true);
});

test("closeStartupBlankPages: preserves non-blank tabs", async () => {
  const page = makePage("https://chatgpt.com");
  const context = { pages: () => [page] } as unknown as BrowserContext;
  await __daemonTestHelpers.closeStartupBlankPages(context);
  assert.equal(page.isClosed(), false);
});

test("isDaemonStateStale: flags heartbeat drift", () => {
  assert.equal(
    __daemonTestHelpers.isDaemonStateStale({
      pid: 123,
      startedAt: "2026-03-26T06:00:00.000Z",
      updatedAt: "2026-03-26T06:00:00.000Z",
      providers: { chatgpt: { concurrency: 3, activeSlots: [] }, claude: { concurrency: 3, activeSlots: [] } },
    }, Date.parse("2026-03-26T06:00:20.000Z")),
    true,
  );

  assert.equal(
    __daemonTestHelpers.isDaemonStateStale({
      pid: 123,
      startedAt: "2026-03-26T06:00:00.000Z",
      updatedAt: "2026-03-26T06:00:10.000Z",
      providers: { chatgpt: { concurrency: 3, activeSlots: [] }, claude: { concurrency: 3, activeSlots: [] } },
    }, Date.parse("2026-03-26T06:00:20.000Z")),
    false,
  );
});
