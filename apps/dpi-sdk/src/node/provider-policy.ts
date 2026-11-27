import { parseModelSelection, type ModelProviderId } from "./model-selection.js";
import { isDurableDelegationAllowed, PROTECTED_PROVIDER_MESSAGE } from "./provider-isolation.js";

export interface UnifiedProviderPolicy {
  provider: "codex" | "deepseek";
  primaryModel: string;
  fallbackModels: readonly string[];
  reasoningEffort: "medium";
  serviceTier: "fast";
}

export const CODEX_PROVIDER_POLICY: UnifiedProviderPolicy = Object.freeze({
  provider: "codex",
  primaryModel: "gpt-5.6-sol",
  fallbackModels: Object.freeze(["gpt-6-astra", "gpt-6.1-sol"]),
  reasoningEffort: "medium",
  serviceTier: "fast",
});

// These are the model IDs exposed by DeepSeek Harness for V4.1 Flash and Pro.
export const DEEPSEEK_PROVIDER_POLICY: UnifiedProviderPolicy = Object.freeze({
  provider: "deepseek",
  primaryModel: "deepseek/deepseek-flash",
  fallbackModels: Object.freeze(["deepseek/deepseek-v4-pro"]),
  reasoningEffort: "medium",
  serviceTier: "fast",
});

export function unifiedProviderPolicy(provider: ModelProviderId): UnifiedProviderPolicy {
  if (!isDurableDelegationAllowed(provider)) throw Error(PROTECTED_PROVIDER_MESSAGE);
  if (provider === "codex") return CODEX_PROVIDER_POLICY;
  if (provider === "deepseek") return DEEPSEEK_PROVIDER_POLICY;
  throw Error(`Provider ${provider} has no Durable execution policy`);
}

export function defaultFallbackPolicy(model: string): { allowModelFallback: boolean; fallbackModels: string[] } {
  const selected = parseModelSelection(model);
  if (!isDurableDelegationAllowed(selected.provider)) throw Error(PROTECTED_PROVIDER_MESSAGE);
  const policy = unifiedProviderPolicy(selected.provider);
  return selected.qualified === policy.primaryModel
    ? { allowModelFallback: true, fallbackModels: [...policy.fallbackModels] }
    : { allowModelFallback: false, fallbackModels: [] };
}

export function validateProviderChain(primary: string, fallbacks: readonly string[]): void {
  const selected = parseModelSelection(primary);
  if (!isDurableDelegationAllowed(selected.provider)) throw Error(PROTECTED_PROVIDER_MESSAGE);
  const seen = new Set([selected.qualified]);
  for (const fallback of fallbacks) {
    const parsed = parseModelSelection(fallback);
    if (!isDurableDelegationAllowed(parsed.provider)) throw Error(PROTECTED_PROVIDER_MESSAGE);
    if (parsed.provider !== selected.provider)
      throw Error("Fallback models must stay within the selected Provider");
    if (seen.has(parsed.qualified)) throw Error("Provider fallback chain must not contain cycles or duplicates");
    seen.add(parsed.qualified);
  }
}
