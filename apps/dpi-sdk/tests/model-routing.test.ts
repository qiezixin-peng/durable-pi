import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../src/api.js";
import { eligibleModels, modelCompatibility } from "../src/model-routing.js";

const model = (toolCalling: "supported" | "unsupported" | "unknown"): ModelInfo => ({
  id: `model-${toolCalling}`,
  provider: "test",
  name: "Test",
  tier: "T",
  icon: "test.png",
  contextWindow: 128_000,
  reasoning: true,
  cost: { input: 0, output: 0 },
  capabilities: {
    textInput: "supported",
    imageInput: "unsupported",
    toolCalling,
    streaming: "supported",
    structuredOutput: "unknown",
    reasoning: "supported",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    source: "provider-metadata",
  },
});

test("model routing rejects unknown required capabilities by default", () => {
  const unknown = model("unknown");
  assert.deepEqual(modelCompatibility(unknown, { toolCalling: true }), {
    eligible: false,
    reasons: ["tool calling is unknown"],
  });
  assert.equal(modelCompatibility(unknown, { toolCalling: true, allowUnknown: true }).eligible, true);
});

test("model routing gates modality and token budgets without price guesses", () => {
  const supported = model("supported");
  const unsupported = model("unsupported");
  assert.deepEqual(eligibleModels([supported, unsupported], { toolCalling: true }), [supported]);
  const incompatible = modelCompatibility(supported, {
    imageInput: true,
    minimumContextWindow: 200_000,
    minimumOutputTokens: 10_000,
  });
  assert.equal(incompatible.eligible, false);
  assert.deepEqual(incompatible.reasons, [
    "image input is unsupported",
    "context window 128000 is below 200000",
    "max output 8192 is below 10000",
  ]);
});
