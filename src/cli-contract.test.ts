import test from "node:test";
import assert from "node:assert/strict";
import { cliSchema, validateCliPath, validateConversationUrl, validateRunId } from "./cli-contract.js";

test("validateRunId: accepts canonical run ids", () => {
  assert.equal(validateRunId("run_2026-03-26-120000_a1b2c3"), "run_2026-03-26-120000_a1b2c3");
});

test("validateRunId: rejects control chars", () => {
  assert.throws(() => validateRunId("run_2026-03-26-120000_a1b2c3\n"));
});

test("validateCliPath: rejects parent traversal in relative paths", () => {
  assert.throws(() => validateCliPath("../escape.md", "output path"));
});

test("validateConversationUrl: rejects control chars", () => {
  assert.throws(() => validateConversationUrl("https://chatgpt.com/c/test\n"));
});

test("cliSchema: returns command details for ask", () => {
  const payload = cliSchema("ask");
  assert.equal(payload.command, "ask");
});

test("cliSchema: returns invalid_command for unknown commands", () => {
  const payload = cliSchema("nonexistent");
  assert.equal(payload.status, "invalid_command");
});
