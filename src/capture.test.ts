import test from "node:test";
import assert from "node:assert/strict";
import { buildModelInfo } from "./models.js";
import {
  isExtendedProModel,
  isLikelyDeferredChatGptPlaceholder,
  isPromptShapeMismatch,
  shouldAttemptDeferredChatGptRecovery,
  type ConversationSnapshot,
} from "./capture.js";

function baseSnapshot(): ConversationSnapshot {
  return {
    chatUrl: "https://chatgpt.com/c/test",
    markdownBody: "Short placeholder",
    markdownSource: "html_to_markdown",
    model: buildModelInfo({ family: "Thinking", effort: "Standard" }),
    modelLabel: "Thinking/Standard",
    validation: {
      progressStub: false,
      shapeMismatch: false,
      deferredPlaceholder: false,
    },
    chatgptMeta: {
      assistantTurnCount: 1,
      asyncStatus: null,
      updateTime: null,
      hasResumeToken: false,
    },
  };
}

test("isPromptShapeMismatch: catches missing structure requested by the prompt", () => {
  assert.equal(
    isPromptShapeMismatch("Write a markdown memo with a table and checklist.", "Just a paragraph."),
    true,
  );
  assert.equal(
    isPromptShapeMismatch(
      "Write a markdown memo with a table and checklist.",
      "# Memo\n\n## Checklist\n\n- item one\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    ),
    false,
  );
});

test("isExtendedProModel: identifies the async ChatGPT model family", () => {
  assert.equal(isExtendedProModel(buildModelInfo({ family: "Pro", effort: "Extended" })), true);
  assert.equal(isExtendedProModel(buildModelInfo({ family: "Thinking", effort: "Heavy" })), false);
});

test("isLikelyDeferredChatGptPlaceholder: keys off async metadata for extended pro", () => {
  const snapshot: ConversationSnapshot = {
    ...baseSnapshot(),
    model: buildModelInfo({ family: "Pro", effort: "Extended" }),
    modelLabel: "Pro/Extended",
    chatgptMeta: {
      assistantTurnCount: 2,
      asyncStatus: 4,
      updateTime: null,
      hasResumeToken: true,
    },
  };
  assert.equal(isLikelyDeferredChatGptPlaceholder(snapshot), true);
  assert.equal(isLikelyDeferredChatGptPlaceholder(baseSnapshot()), false);
});

test("shouldAttemptDeferredChatGptRecovery: only triggers on real defer signals", () => {
  assert.equal(shouldAttemptDeferredChatGptRecovery(baseSnapshot()), false);

  const placeholder = baseSnapshot();
  placeholder.validation.deferredPlaceholder = true;
  assert.equal(shouldAttemptDeferredChatGptRecovery(placeholder), true);

  assert.equal(shouldAttemptDeferredChatGptRecovery(baseSnapshot(), "active_timeout"), false);

  const timedOutStructuredFailure = baseSnapshot();
  timedOutStructuredFailure.validation.shapeMismatch = true;
  assert.equal(shouldAttemptDeferredChatGptRecovery(timedOutStructuredFailure, "active_timeout"), true);
});
