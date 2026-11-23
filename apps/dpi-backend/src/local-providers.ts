import type { Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export type BackendProviderId = "faux" | "openrouter" | "openai" | "deepseek";
export type BackendProviderSpec = BackendProviderId | "local" | (string & {});

const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function normalizeProviderToken(token: string): BackendProviderId[] {
  const value = token.trim().toLowerCase();
  if (!value) return [];
  if (value === "faux") return ["faux"];
  if (value === "openrouter") return ["openrouter"];
  if (value === "openai") return ["openai"];
  if (value === "deepseek") return ["deepseek"];
  if (value === "google" || value === "gemini") {
    throw Error(
      "Gemini API key mode is disabled in dpi-backend. Use local Gemini CLI (@google/gemini-cli) with your Google AI Pro OAuth subscription instead.",
    );
  }
  if (value === "local") return ["deepseek", "openai"];
  throw Error(`Unsupported DPI_PROVIDER token: ${token}`);
}

export function parseBackendProviders(raw?: string): BackendProviderId[] {
  const input = (raw ?? "openrouter").trim();
  if (!input) return ["openrouter"];
  const tokens = input.split(",").flatMap(normalizeProviderToken);
  const unique = [...new Set(tokens)];
  if (!unique.length) return ["openrouter"];
  if (unique.includes("faux") && unique.length > 1)
    throw Error("DPI_PROVIDER=faux cannot be combined with live providers");
  return unique;
}

function cleanBaseUrl(value: string | undefined, fallback: string, label: string): string {
  const candidate = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw Error(`${label} must use http: or https:`);
  return candidate.replace(/\/+$/, "");
}

function parseExtraIds(raw: string | undefined, provider: "deepseek"): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const stripped = entry.startsWith(`${provider}/`)
        ? entry.slice(provider.length + 1)
        : entry;
      if (!MODEL_SEGMENT.test(stripped)) throw Error(`Invalid ${provider} model id: ${entry}`);
      return stripped;
    });
}

export function createDeepSeekBackendProvider(env: NodeJS.ProcessEnv = process.env): Provider<"openai-completions"> {
  const base = deepseekProvider();
  const baseUrl = cleanBaseUrl(env.DEEPSEEK_BASE_URL, base.baseUrl ?? "https://api.deepseek.com", "DEEPSEEK_BASE_URL");
  const builtin = base.getModels().map((model) => ({ ...model, baseUrl }));
  const template = builtin.find((model) => model.id === "deepseek-v4-pro") ?? builtin[0];
  const models: Model<"openai-completions">[] = [];
  const seen = new Set<string>();
  const add = (model: Model<"openai-completions">) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    models.push(model);
  };

  // Expose DeepSeek's standard official API slugs first alongside pi-ai's catalog entries.
  if (template) {
    add({
      ...template,
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      baseUrl,
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      compat: {
        ...template.compat,
        requiresReasoningContentOnAssistantMessages: false,
      },
    });
    add({
      ...template,
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      baseUrl,
      reasoning: true,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 64_000,
      compat: {
        ...template.compat,
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
  }
  for (const model of builtin) add(model);

  const extras = parseExtraIds(
    [env.DPI_DEEPSEEK_MODELS, env.DPI_DEEPSEEK_DEFAULT_MODEL].filter(Boolean).join(","),
    "deepseek",
  );
  if (template) {
    for (const id of extras) {
      add({
        ...template,
        id,
        name: id,
        baseUrl,
      });
    }
  }
  return {
    ...base,
    baseUrl,
    getModels: () => models,
  };
}
