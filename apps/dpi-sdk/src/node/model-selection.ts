export type LocalPiProviderId = "google" | "deepseek";
export type ModelProviderId = "codex" | LocalPiProviderId;

export interface ParsedModelSelection {
  provider: ModelProviderId;
  executor: "codex" | "pi";
  runtime: "codex-app-server" | "deepseek-harness" | "antigravity";
  modelId: string;
  qualified: string;
  localOnlyByDefault: boolean;
}

export const DEFAULT_GEMINI_MODEL = "gemini-4-neon";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function isValidModelSegment(value: string): boolean {
  return MODEL_SEGMENT.test(value);
}
const ROLE_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function normalizeProviderAlias(value: string): ModelProviderId {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "google" || normalized === "gemini" || normalized === "antigravity" || normalized === "agy")
    return "google";
  if (normalized === "deepseek" || normalized === "deepseek-harness" || normalized === "dsh")
    return "deepseek";
  throw Error(`Unsupported model provider: ${value}. Expected codex, google (or gemini/antigravity), or deepseek`);
}

function validateModelSegment(value: string, label = "Model ID") {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || !MODEL_SEGMENT.test(trimmed))
    throw Error(`${label} is invalid: ${value}`);
  return trimmed;
}

export function defaultModelForProvider(provider: LocalPiProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const raw = provider === "google"
    ? (env.DPI_GEMINI_DEFAULT_MODEL ?? DEFAULT_GEMINI_MODEL)
    : (env.DPI_DEEPSEEK_DEFAULT_MODEL ?? DEFAULT_DEEPSEEK_MODEL);
  const parsed = parseModelSelection(raw, provider);
  if (parsed.provider !== provider)
    throw Error(`Default model for ${provider} must belong to ${provider}`);
  return parsed.qualified;
}

export function parseModelSelection(
  rawModel?: string,
  explicitProvider?: string,
  env: NodeJS.ProcessEnv = process.env,
): ParsedModelSelection {
  const providerHint = explicitProvider ? normalizeProviderAlias(explicitProvider) : undefined;
  const trimmed = rawModel?.trim() ?? "";

  if (!trimmed) {
    if (!providerHint || providerHint === "codex") throw Error("Model ID is required");
    const defaultQualified = defaultModelForProvider(providerHint, env);
    const modelId = defaultQualified.slice(defaultQualified.indexOf("/") + 1);
    return {
      provider: providerHint,
      executor: "pi",
      runtime: providerHint === "deepseek" ? "deepseek-harness" : "antigravity",
      modelId,
      qualified: defaultQualified,
      localOnlyByDefault: true,
    };
  }

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    const suffix = validateModelSegment(trimmed.slice(slash + 1));
    const parsedProvider = normalizeProviderAlias(prefix);
    if (providerHint && providerHint !== parsedProvider)
      throw Error(`Model ${trimmed} does not match explicit provider ${explicitProvider}`);
    if (parsedProvider === "codex") {
      return {
        provider: "codex", executor: "codex", runtime: "codex-app-server",
        modelId: suffix, qualified: suffix, localOnlyByDefault: false,
      };
    }
    return {
      provider: parsedProvider,
      executor: "pi",
      runtime: parsedProvider === "deepseek" ? "deepseek-harness" : "antigravity",
      modelId: suffix,
      qualified: `${parsedProvider}/${suffix}`,
      localOnlyByDefault: true,
    };
  }

  const segment = validateModelSegment(trimmed);
  if (providerHint === "google" || providerHint === "deepseek") {
    return {
      provider: providerHint,
      executor: "pi",
      runtime: providerHint === "deepseek" ? "deepseek-harness" : "antigravity",
      modelId: segment,
      qualified: `${providerHint}/${segment}`,
      localOnlyByDefault: true,
    };
  }
  if (providerHint === "codex") {
    return {
      provider: "codex", executor: "codex", runtime: "codex-app-server",
      modelId: segment, qualified: segment, localOnlyByDefault: false,
    };
  }

  const lower = segment.toLowerCase();
  if (lower.startsWith("gemini-") || lower.startsWith("gemma-") || lower.startsWith("deep-research-")) {
    return {
      provider: "google", executor: "pi", runtime: "antigravity",
      modelId: segment, qualified: `google/${segment}`, localOnlyByDefault: true,
    };
  }
  if (lower.startsWith("deepseek-")) {
    return {
      provider: "deepseek", executor: "pi", runtime: "deepseek-harness",
      modelId: segment, qualified: `deepseek/${segment}`, localOnlyByDefault: true,
    };
  }
  return {
    provider: "codex", executor: "codex", runtime: "codex-app-server",
    modelId: segment, qualified: segment, localOnlyByDefault: false,
  };
}

export function isLocalPiModel(model?: string | null): boolean {
  if (!model || !model.trim()) return false;
  try {
    return parseModelSelection(model).localOnlyByDefault;
  } catch {
    return false;
  }
}

export function isWorkspacePiMember(member: {
  executor: "pi" | "codex";
  cwd?: string | null;
  model?: string | null;
}): boolean {
  return member.executor === "pi" && Boolean(member.cwd?.trim()) && Boolean(member.model?.trim());
}

export function parseRoleModelMap(rawJson?: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const source = rawJson ?? env.DPI_ROLE_MODEL_MAP_JSON;
  if (!source || !source.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw Error(`DPI_ROLE_MODEL_MAP_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("DPI_ROLE_MODEL_MAP_JSON must be a JSON object mapping role names to model IDs");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) throw Error("DPI_ROLE_MODEL_MAP_JSON may define at most 32 role mappings");
  const map: Record<string, string> = {};
  for (const [rawRole, rawModel] of entries) {
    const role = rawRole.trim().toLowerCase();
    if (!ROLE_NAME.test(role)) throw Error(`Invalid role in DPI_ROLE_MODEL_MAP_JSON: ${rawRole}`);
    if (role === "coordinator")
      throw Error("DPI_ROLE_MODEL_MAP_JSON cannot override the coordinator role; use DPI_COORDINATOR_MODEL");
    if (typeof rawModel !== "string" || !rawModel.trim())
      throw Error(`Model mapping for role ${role} must be a non-empty string`);
    map[role] = parseModelSelection(rawModel, undefined, env).qualified;
  }
  return map;
}

export function resolveLocalRoleModel(input: {
  role: string;
  explicitModel?: string;
  explicitProvider?: string;
  fallbackModel: string;
  env?: NodeJS.ProcessEnv;
}): ParsedModelSelection {
  const env = input.env ?? process.env;
  if (input.explicitModel !== undefined || input.explicitProvider !== undefined)
    return parseModelSelection(input.explicitModel, input.explicitProvider, env);
  const roleMap = parseRoleModelMap(undefined, env);
  const mapped = roleMap[input.role.trim().toLowerCase()];
  if (mapped) return parseModelSelection(mapped, undefined, env);
  return parseModelSelection(input.fallbackModel, undefined, env);
}
