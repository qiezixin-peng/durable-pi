import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_PROVIDER_POLICY,
  DEEPSEEK_PROVIDER_POLICY,
  defaultFallbackPolicy,
  unifiedProviderPolicy,
  validateProviderChain,
} from "../src/node/provider-policy.js";

test("unified Provider policies use the supported ordered model IDs", () => {
  assert.deepEqual(CODEX_PROVIDER_POLICY, {
    provider: "codex",
    primaryModel: "gpt-5.6-sol",
    fallbackModels: ["gpt-6-astra", "gpt-6.1-sol"],
    reasoningEffort: "medium",
    serviceTier: "fast",
  });
  assert.deepEqual(DEEPSEEK_PROVIDER_POLICY, {
    provider: "deepseek",
    primaryModel: "deepseek/deepseek-flash",
    fallbackModels: ["deepseek/deepseek-v4-pro"],
    reasoningEffort: "medium",
    serviceTier: "fast",
  });
  assert.deepEqual(defaultFallbackPolicy("gpt-5.6-sol"), {
    allowModelFallback: true,
    fallbackModels: ["gpt-6-astra", "gpt-6.1-sol"],
  });
  assert.deepEqual(defaultFallbackPolicy("deepseek/deepseek-flash"), {
    allowModelFallback: true,
    fallbackModels: ["deepseek/deepseek-v4-pro"],
  });
});

test("fallback policy stays within one Provider and cannot route back to Antigravity", () => {
  assert.doesNotThrow(() => validateProviderChain("gpt-5.6-sol", ["gpt-6-astra", "gpt-6.1-sol"]));
  assert.doesNotThrow(() => validateProviderChain("deepseek/deepseek-flash", ["deepseek/deepseek-v4-pro"]));
  assert.throws(
    () => validateProviderChain("gpt-5.6-sol", ["deepseek/deepseek-v4-pro"]),
    /selected Provider/i,
  );
  assert.throws(
    () => validateProviderChain("gpt-5.6-sol", ["google/gemini-4-neon"]),
    /protected upstream Provider/i,
  );
  assert.throws(
    () => validateProviderChain("gpt-5.6-sol", ["gpt-6-astra", "gpt-6-astra"]),
    /cycles or duplicates/i,
  );
  assert.throws(() => unifiedProviderPolicy("google"), /protected upstream Provider/i);
});
