import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistConversationArtifacts } from "./service.js";

test("persistConversationArtifacts: removes stale artifact files before rewriting", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatferry-artifacts-"));
  try {
    const outputPath = path.join(tempDir, "conversation.md");
    const artifactDir = path.join(tempDir, "conversation.artifacts");

    const first = await persistConversationArtifacts(outputPath, [
      { role: "assistant", html: "", artifacts: [{ filename: "draft.md", content: "first artifact\n" }] },
    ]);
    assert.equal(first.artifactDir, "conversation.artifacts");
    assert.equal((await fs.readdir(artifactDir)).length, 1);

    await persistConversationArtifacts(outputPath, [
      { role: "assistant", html: "", artifacts: [{ filename: "replacement.md", content: "second artifact\n" }] },
    ]);
    assert.deepEqual(await fs.readdir(artifactDir), ["01-01-replacement.md"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("persistConversationArtifacts: removes the artifact directory when no artifacts remain", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatferry-artifacts-"));
  try {
    const outputPath = path.join(tempDir, "conversation.md");
    const artifactDir = path.join(tempDir, "conversation.artifacts");

    await persistConversationArtifacts(outputPath, [
      { role: "assistant", html: "", artifacts: [{ filename: "artifact.md", content: "artifact\n" }] },
    ]);

    const result = await persistConversationArtifacts(outputPath, [
      { role: "assistant", html: "<p>No artifacts now</p>" },
    ]);
    assert.equal(result.artifactDir, null);
    await assert.rejects(fs.stat(artifactDir), /ENOENT/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
