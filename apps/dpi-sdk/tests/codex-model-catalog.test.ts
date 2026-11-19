import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexModelCatalog, DEFAULT_CODEX_MODEL, normalizeCodexModelList } from "../src/node/codex-model-catalog.js";

test("Codex model metadata is normalized without inventing unreported capabilities", () => {
  const models = normalizeCodexModelList({ data: [{
    id: "model-a",
    displayName: "Model A",
    description: "Test model",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "high",
  }] }, new Set());
  assert.equal(models.length, 1);
  assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(models[0]?.supportedReasoningEfforts, ["low", "high"]);
  assert.equal(models[0]?.capabilities.textInput, "supported");
  assert.equal(models[0]?.capabilities.imageInput, "supported");
  assert.equal(models[0]?.capabilities.reasoning, "supported");
  assert.equal(models[0]?.capabilities.dynamicTools, "unknown");
  assert.equal(models[0]?.capabilities.source.dynamicTools, "unknown");
});

test("only models with a recorded real Dynamic Tools turn are enabled by default", () => {
  const models = normalizeCodexModelList({ data: [
    { id: "gpt-5.6-sol", inputModalities: ["text"] },
    { id: "gpt-6.2-sol", inputModalities: ["text"] },
    { id: "gpt-6.2-astra", inputModalities: ["text"] },
    { id: "gpt-6.1-terra", inputModalities: ["text"] },
  ] });
  assert.equal(models.find((item) => item.id === "gpt-6.2-sol")?.capabilities.dynamicTools, "supported");
  assert.equal(models.find((item) => item.id === "gpt-6.2-astra")?.capabilities.dynamicTools, "supported");
  assert.equal(models.find((item) => item.id === "gpt-6.1-terra")?.capabilities.dynamicTools, "unknown");
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(models.find((item) => item.id === DEFAULT_CODEX_MODEL)?.capabilities.dynamicTools, "supported");
});

test("Codex model catalog caches concurrent loads and rejects unavailable models", async () => {
  let calls = 0;
  const catalog = new CodexModelCatalog(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { data: [{ id: "verified-model", inputModalities: ["text"] }] };
  }, 60_000, new Set(["verified-model"]));
  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);
  assert.equal((await catalog.requireAvailable("verified-model")).capabilities.dynamicTools, "supported");
  await assert.rejects(() => catalog.requireAvailable("missing-model"), /not available/);
  assert.equal(calls, 1);
});

test("failed Codex model catalog loads are not cached as success", async () => {
  let calls = 0;
  const catalog = new CodexModelCatalog(async () => {
    calls += 1;
    return calls === 1 ? { data: [] } : { data: [{ id: "recovered" }] };
  });
  await assert.rejects(() => catalog.list(), /no usable models/);
  assert.equal((await catalog.list())[0]?.id, "recovered");
  assert.equal(calls, 2);
});
