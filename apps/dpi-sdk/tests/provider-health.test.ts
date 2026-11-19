import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderHealthStore } from "../src/node/provider-health.js";

test("provider circuit persists, opens after threshold and permits one half-open probe", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-provider-"));
  const database = join(root, "projects.sqlite");
  let store = new ProviderHealthStore(database, 3, 1_000, 500);
  try {
    assert.deepEqual(store.beforeRequest("codex", "model-a", "task-1", 100), { allowed: true, probe: false, generation: 0 });
    const firstFailure = store.recordFailure(
      "codex",
      "model-a",
      { code: "PROVIDER_NETWORK", message: "Bearer secret-value token=abc123 api_key=xyz987 sk-abcdefghijk" },
      0,
      100,
    ).record;
    assert.equal(firstFailure.state, "CLOSED");
    assert.equal(firstFailure.lastErrorMessage?.includes("secret-value"), false);
    assert.equal(firstFailure.lastErrorMessage?.includes("abc123"), false);
    assert.equal(firstFailure.lastErrorMessage?.includes("xyz987"), false);
    assert.equal(firstFailure.lastErrorMessage?.includes("sk-abcdefghijk"), false);
    assert.equal(store.recordFailure("codex", "model-a", { code: "PROVIDER_NETWORK", message: "two" }, 0, 200).record.state, "CLOSED");
    const opened = store.recordFailure("codex", "model-a", { code: "PROVIDER_RATE_LIMIT", message: "three" }, 0, 300).record;
    assert.equal(opened.state, "OPEN");
    assert.equal(opened.openUntil, 1_300);
    assert.deepEqual(store.beforeRequest("codex", "model-a", "task-2", 400), { allowed: false, retryAt: 1_300, state: "OPEN", generation: 1 });

    store.close();
    store = new ProviderHealthStore(database, 3, 1_000, 500);
    assert.deepEqual(store.beforeRequest("codex", "model-a", "probe-a", 1_300), { allowed: true, probe: true, generation: 2 });
    assert.deepEqual(store.beforeRequest("codex", "model-a", "probe-b", 1_301), { allowed: false, retryAt: 1_800, state: "HALF_OPEN", generation: 2 });
    const staleSuccess = store.recordSuccess("codex", "model-a", 0, 1_350);
    assert.equal(staleSuccess.applied, false, "pre-open requests cannot close a newer circuit generation");
    const reopened = store.recordFailure("codex", "model-a", { code: "MODEL_TIMEOUT", message: "probe failed" }, 2, 1_400).record;
    assert.equal(reopened.state, "OPEN");
    assert.equal(reopened.openUntil, 3_400, "a failed probe doubles the open interval");
    assert.deepEqual(store.beforeRequest("codex", "model-a", "probe-c", 3_400), { allowed: true, probe: true, generation: 4 });
    const closed = store.recordSuccess("codex", "model-a", 4, 3_500).record;
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.consecutiveFailures, 0);
    assert.deepEqual(store.beforeRequest("codex", "model-a", "normal", 3_501), { allowed: true, probe: false, generation: 4 });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
