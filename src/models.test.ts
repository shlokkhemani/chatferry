import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelInfo,
  findMatchingInput,
  renderModelCatalog,
  storedModelCatalog,
  storedModelFamilies,
} from "./models.js";
import type { ProviderModelCatalog } from "./types.js";

test("buildModelInfo: returns stable ids alongside human labels", () => {
  assert.deepEqual(buildModelInfo({ family: "Pro", effort: "Extended" }), {
    label: "Pro/Extended",
    family: "Pro",
    familyId: "pro",
    effort: "Extended",
    effortId: "extended",
  });
});

test("findMatchingInput: resolves exact ids and labels only", () => {
  const catalog: ProviderModelCatalog = {
    provider: "chatgpt",
    current: buildModelInfo({ family: "Thinking", effort: "Heavy" }),
    inputs: [
      { id: "thinking-heavy", label: "Thinking/Heavy", selected: true, family: "Thinking", familyId: "thinking", effort: "Heavy", effortId: "heavy" },
      { id: "pro-extended", label: "Pro/Extended", selected: false, family: "Pro", familyId: "pro", effort: "Extended", effortId: "extended" },
    ],
  };

  assert.equal(findMatchingInput(catalog, "pro/extended")?.label, "Pro/Extended");
  assert.equal(findMatchingInput(catalog, "thinking")?.label, undefined);
});

test("renderModelCatalog: produces stable human-readable output", () => {
  const catalog: ProviderModelCatalog = {
    provider: "claude",
    current: buildModelInfo({ family: "Sonnet 4.6", effort: "Extended" }),
    inputs: [
      { id: "sonnet-4-6-standard", label: "Sonnet 4.6/Standard", selected: false, family: "Sonnet 4.6", familyId: "sonnet-4-6", effort: "Standard", effortId: "standard" },
      { id: "sonnet-4-6-extended", label: "Sonnet 4.6/Extended", selected: true, family: "Sonnet 4.6", familyId: "sonnet-4-6", effort: "Extended", effortId: "extended" },
    ],
  };
  assert.deepEqual(renderModelCatalog(catalog), [
    "claude models:",
    "Current: Sonnet 4.6/Extended",
    "- Sonnet 4.6/Standard",
    "* Sonnet 4.6/Extended",
  ]);
});

test("storedModelFamilies: exposes canonical greenfield catalogs", () => {
  assert.deepEqual(storedModelFamilies("chatgpt").map((f) => ({ label: f.label, variants: f.variants.map((v) => v.label) })), [
    { label: "Instant", variants: [] },
    { label: "Thinking", variants: ["Light", "Standard", "Extended", "Heavy"] },
    { label: "Pro", variants: ["Standard", "Extended"] },
  ]);
  assert.deepEqual(storedModelFamilies("claude").map((f) => f.label), ["Opus 4.6", "Sonnet 4.6", "Haiku 4.5"]);
});

test("storedModelCatalog: marks current family and variant", () => {
  const catalog = storedModelCatalog("chatgpt", buildModelInfo({ family: "Thinking", effort: "Heavy" }));
  assert.equal(catalog.current?.label, "Thinking/Heavy");
  assert.deepEqual(
    catalog.inputs
      .filter((i) => i.selected || i.label === "Instant" || i.label === "Pro/Extended")
      .map((i) => ({ label: i.label, selected: i.selected })),
    [
      { label: "Instant", selected: false },
      { label: "Thinking/Heavy", selected: true },
      { label: "Pro/Extended", selected: false },
    ],
  );
});
