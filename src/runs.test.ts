import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendRunStatus,
  createRun,
  mutateRun,
  previewPrompt,
  readRun,
  reconcileRun,
  runDirectory,
} from "./runs.js";

test("previewPrompt: compresses whitespace and truncates long prompts", () => {
  const prompt = `${"alpha ".repeat(50)}beta`;
  const preview = previewPrompt(prompt);
  assert.equal(preview.includes("\n"), false);
  assert.equal(preview.length <= 160, true);
});

test("reconcileRun: marks a stale run completed when the output artifact exists", async () => {
  const outputPath = path.join(os.tmpdir(), `chatferry-reconcile-${Date.now()}.md`);
  const run = await createRun({
    provider: "chatgpt",
    prompt: "test prompt",
    requestedModel: "thinking/standard",
    output: outputPath,
  });
  try {
    await mutateRun(run.id, (current) => ({
      ...current,
      status: "running",
      workerPid: null,
    }));
    await fs.writeFile(outputPath, "# Response\n\nOK\n", "utf8");

    const reconciled = await reconcileRun(run.id);
    assert.equal(reconciled.status, "completed");
    assert.notEqual(reconciled.completedAt, null);

    await fs.rm(outputPath, { force: true });
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("reconcileRun: leaves queued runs alone before a daemon claims them", async () => {
  const run = await createRun({
    provider: "chatgpt",
    prompt: "queued prompt",
  });
  try {
    const reconciled = await reconcileRun(run.id);
    assert.equal(reconciled.status, "queued");
    assert.equal(reconciled.error, null);
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("reconcileRun: marks a stale run failed when no output artifact exists", async () => {
  const outputPath = path.join(os.tmpdir(), `chatferry-reconcile-missing-${Date.now()}.md`);
  const run = await createRun({
    provider: "claude",
    prompt: "test prompt",
    requestedModel: "Opus 4.6/extended",
    output: outputPath,
  });
  try {
    await mutateRun(run.id, (current) => ({
      ...current,
      status: "running",
      workerPid: null,
    }));

    const reconciled = await reconcileRun(run.id);
    assert.equal(reconciled.status, "failed");
    assert.match(reconciled.error ?? "", /no output artifact/i);
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("appendRunStatus: does not overwrite a cancelled run", async () => {
  const run = await createRun({
    provider: "claude",
    prompt: "cancel me",
  });
  try {
    await appendRunStatus({
      runId: run.id,
      status: "cancelled",
      message: "Cancelled by test",
      patch: { cancelledAt: new Date().toISOString() },
    });

    const afterCancelled = await appendRunStatus({
      runId: run.id,
      status: "completed",
      message: "Should not stick",
    });

    assert.equal(afterCancelled.status, "cancelled");
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("appendRunStatus: rejects invalid transitions from terminal states", async () => {
  const run = await createRun({
    provider: "chatgpt",
    prompt: "terminal test",
  });
  try {
    await appendRunStatus({
      runId: run.id,
      status: "running",
      message: "Claimed",
    });
    await appendRunStatus({
      runId: run.id,
      status: "completed",
      message: "Done",
      patch: { completedAt: new Date().toISOString() },
    });

    // Try to move completed → running (invalid)
    const afterInvalid = await appendRunStatus({
      runId: run.id,
      status: "running",
      message: "Should not stick",
    });
    assert.equal(afterInvalid.status, "completed");

    // Try to move completed → failed (invalid)
    const afterFailed = await appendRunStatus({
      runId: run.id,
      status: "failed",
      message: "Should not stick",
    });
    assert.equal(afterFailed.status, "completed");
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("appendRunStatus: auto-stamps completedAt on completed transition", async () => {
  const run = await createRun({
    provider: "claude",
    prompt: "timestamp test",
  });
  try {
    await appendRunStatus({
      runId: run.id,
      status: "running",
      message: "Claimed",
    });
    const completed = await appendRunStatus({
      runId: run.id,
      status: "completed",
      message: "Done",
    });
    assert.notEqual(completed.completedAt, null);
    assert.equal(completed.failedAt, null);
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("appendRunStatus: serializes concurrent writers without losing history", async () => {
  const run = await createRun({
    provider: "chatgpt",
    prompt: "serialize me",
  });
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendRunStatus({
          runId: run.id,
          status: "running",
          message: `writer-${index}`,
        })),
    );

    const current = await readRun(run.id);
    assert.equal(current.history.length, 13);
    assert.deepEqual(
      new Set(current.history.slice(1).map((event) => event.message)),
      new Set(Array.from({ length: 12 }, (_, index) => `writer-${index}`)),
    );
  } finally {
    await fs.rm(runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
  }
});
