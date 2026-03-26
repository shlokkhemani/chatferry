import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultOutputPath, defaultReadOutputPath, sidecarPathForOutput } from "./extract.js";

test("defaultOutputPath: is unique for same prompt and provider", () => {
  const first = defaultOutputPath("chatgpt", "same prompt");
  const second = defaultOutputPath("chatgpt", "same prompt");
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.dirname(second));
  assert.equal(path.basename(first).endsWith(".md"), true);
});

test("defaultReadOutputPath: is unique for repeated reads", () => {
  const first = defaultReadOutputPath("claude");
  const second = defaultReadOutputPath("claude");
  assert.notEqual(first, second);
  assert.equal(path.basename(first).endsWith(".md"), true);
});

test("sidecarPathForOutput: derives a sibling metadata file", () => {
  assert.equal(sidecarPathForOutput("/tmp/chatferry/example.md"), "/tmp/chatferry/example.meta.json");
});
