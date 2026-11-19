import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectUsageStore } from "../src/node/usage.js";

test("model usage upserts streaming totals per fenced attempt and summarizes projects", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-usage-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const usage = new ProjectUsageStore(database);
  try {
    projects.create({ id: "alpha", name: "Alpha" });
    const base = {
      projectId: "alpha",
      taskId: "task-1",
      attemptId: "attempt-1",
      fenceEpoch: 1,
      memberId: "coder",
      provider: "codex",
      model: "current-model",
      threadId: "thread-1",
      turnId: "turn-1",
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 5,
      contextWindow: 128_000,
    };
    usage.record({ ...base, inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    usage.record({ ...base, contextWindow: undefined, inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    usage.record({ ...base, taskId: "task-2", attemptId: "attempt-2", fenceEpoch: 2, inputTokens: 50, outputTokens: 10, totalTokens: 60 });
    usage.record({ ...base, attemptId: "attempt-3", fenceEpoch: 3, inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    assert.equal(usage.list("alpha").length, 3);
    assert.equal(usage.summaryTask("alpha", "task-1").totalTokens, 205);
    assert.equal(usage.summaryTask("alpha", "task-2").totalTokens, 60);
    assert.deepEqual(usage.observedContextWindow("codex", "current-model"), {
      contextWindow: 128_000,
      samples: 3,
      lastObservedAt: usage.list("alpha")[0]!.updatedAt,
    });
    assert.equal(usage.observedContextWindow("codex", "missing-model"), undefined);
    assert.deepEqual(usage.summary("alpha"), {
      projectId: "alpha",
      requests: 3,
      inputTokens: 220,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      outputTokens: 45,
      reasoningOutputTokens: 15,
      totalTokens: 265,
    });
  } finally {
    usage.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
