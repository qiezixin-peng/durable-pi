import { parseModelSelection, type LocalPiProviderId } from "./model-selection.js";
import type { LocalCapabilitySupport, LocalProviderModelSpec } from "./local-model-providers.js";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

export function parseVerifiedModelsJson(
  provider: LocalPiProviderId,
  rawJson: string | undefined,
): Map<string, LocalProviderModelSpec> {
  const result = new Map<string, LocalProviderModelSpec>();
  if (!rawJson?.trim()) return result;
  try {
    const parsed = JSON.parse(rawJson);
    const items = Array.isArray(parsed) ? parsed : [];
    for (const entry of items) {
      const obj = asObject(entry);
      if (!obj || typeof obj.id !== "string") continue;
      const sel = parseModelSelection(obj.id, provider);
      if (sel.provider !== provider) continue;
      const contextWindow = typeof obj.contextWindow === "number" && Number.isSafeInteger(obj.contextWindow) && obj.contextWindow > 0
        ? obj.contextWindow
        : null;
      const maxOutputTokens = typeof obj.maxOutputTokens === "number" && Number.isSafeInteger(obj.maxOutputTokens) && obj.maxOutputTokens > 0
        ? obj.maxOutputTokens
        : null;
      const reasoning: LocalCapabilitySupport =
        obj.reasoning === "supported" || obj.reasoning === true
          ? "supported"
          : obj.reasoning === "unsupported" || obj.reasoning === false
            ? "unsupported"
            : "unknown";
      const modalities = Array.isArray(obj.inputModalities)
        ? obj.inputModalities.filter((m): m is "text" | "image" => m === "text" || m === "image")
        : [];
      result.set(sel.modelId, {
        id: sel.modelId,
        qualifiedId: sel.qualified,
        provider,
        runtime: provider === "deepseek" ? "deepseek-harness" : "antigravity",
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : sel.modelId,
        icon: provider === "google" ? "gemini.png" : "deepseek.png",
        verified: true,
        verificationSource: "runtime-probe",
        contextWindow,
        maxOutputTokens,
        reasoning,
        inputModalities: modalities,
      });
    }
  } catch {
    // Ignore malformed probe JSON.
  }
  return result;
}
