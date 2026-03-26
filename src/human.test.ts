import test from "node:test";
import assert from "node:assert/strict";
import { promptMatchesEditor, semanticPromptLines } from "./human.js";

test("semanticPromptLines: normalizes line endings and trims trailing whitespace", () => {
  assert.deepEqual(semanticPromptLines("alpha  \r\n\r\nbeta\u00a0\r\ngamma   "), ["alpha", "beta", "gamma"]);
});

test("promptMatchesEditor: compares prompts semantically rather than byte-for-byte", () => {
  assert.equal(promptMatchesEditor("alpha  \n\nbeta\n", "alpha\nbeta"), true);
  assert.equal(promptMatchesEditor("alpha\nbeta", "alpha\ngamma"), false);
});
