import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSavedChatDocument } from "./document.js";
import { buildMarkdownDocument, buildPromptResponseSidecar, sidecarPathForOutput } from "./extract.js";
import { buildModelInfo } from "./models.js";

test("readSavedChatDocument: reads exact prompt and response from sidecar metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatferry-document-"));
  try {
    const markdownPath = path.join(tempDir, "export.md");
    const prompt = "# Prompt Heading\n\nKeep this exact heading in the prompt.";
    const response = "# Response Heading\n\nKeep this exact heading in the response.";

    await fs.writeFile(markdownPath, buildMarkdownDocument({
      provider: "chatgpt",
      model: buildModelInfo({ family: "Thinking", effort: "Standard" }),
      prompt,
      body: response,
      chatUrl: "https://chatgpt.com/c/example",
    }), "utf8");

    const sidecar = buildPromptResponseSidecar({
      provider: "chatgpt",
      outputPath: markdownPath,
      model: buildModelInfo({ family: "Thinking", effort: "Standard" }),
      prompt,
      response,
      chatUrl: "https://chatgpt.com/c/example",
      markdownSource: "html_to_markdown",
    });
    await fs.writeFile(sidecarPathForOutput(markdownPath), `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

    const saved = await readSavedChatDocument(markdownPath);
    assert.equal(saved.metadataPath, sidecarPathForOutput(markdownPath));
    assert.equal(saved.prompt, prompt);
    assert.equal(saved.response, response);
    assert.equal(saved.chatUrl, "https://chatgpt.com/c/example");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("readSavedChatDocument: fails when the sidecar is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatferry-document-"));
  try {
    const markdownPath = path.join(tempDir, "export.md");
    await fs.writeFile(markdownPath, "# Prompt\n\nhello\n", "utf8");
    await assert.rejects(readSavedChatDocument(markdownPath), /meta\.json|ENOENT|sidecar/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
