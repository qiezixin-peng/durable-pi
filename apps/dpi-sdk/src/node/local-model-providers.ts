import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { inspectAntigravityCliInstallation, resolveGeminiHomeDir } from "./antigravity-client.js";
import { discoverAntigravityModels } from "./antigravity-model-catalog.js";
import {
  defaultDshHome,
  findDeepSeekHarnessLaunchSpec,
  inspectDshCredentialsFile,
} from "./deepseek-harness-client.js";
import {
  defaultModelForProvider,
  isValidModelSegment,
  parseModelSelection,
  parseRoleModelMap,
  type LocalPiProviderId,
} from "./model-selection.js";
import { parseVerifiedModelsJson } from "./verified-model-catalog.js";

export { discoverAntigravityModels } from "./antigravity-model-catalog.js";

export {
  defaultModelForProvider,
  isLocalPiModel,
  isValidModelSegment,
  isWorkspacePiMember,
  normalizeProviderAlias,
  parseModelSelection,
  parseRoleModelMap,
  resolveLocalRoleModel,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from "./model-selection.js";
export type { LocalPiProviderId, ModelProviderId, ParsedModelSelection } from "./model-selection.js";

export type LocalCapabilitySupport = "supported" | "unsupported" | "unknown";
export type LocalModelVerificationSource =
  | "dsh-session-evidence"
  | "antigravity-session-evidence"
  | "runtime-probe"
  | "unverified";

export interface LocalProviderModelSpec {
  id: string;
  qualifiedId: string;
  provider: LocalPiProviderId;
  runtime: "deepseek-harness" | "antigravity";
  name: string;
  icon: "gemini.png" | "deepseek.png";
  verified: boolean;
  verificationSource: LocalModelVerificationSource;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: LocalCapabilitySupport;
  inputModalities: readonly ("text" | "image")[];
}

export interface LocalProviderInspection {
  provider: LocalPiProviderId;
  runtime: "deepseek-harness" | "antigravity";
  displayName: string;
  authMode: "antigravity-oauth" | "deepseek-harness-account" | "api-key";
  apiKeyForbidden: boolean;
  runtimeInstalled: boolean;
  envKey?: "DEEPSEEK_API_KEY";
  baseUrlEnvKey?: "DEEPSEEK_BASE_URL";
  baseUrl?: string;
  defaultModel: string;
  configured: boolean;
  authSource:
    | "dsh-account"
    | "dsh-credentials"
    | "env"
    | "pi-auth"
    | "both"
    | "antigravity-cli-account"
    | "none";
  remoteAllowedByDefault: false;
  durableDelegationAllowed: boolean;
  interactionMode: "direct-t3-only" | "durable-worker";
  verifiedModels: string[];
  models: LocalProviderModelSpec[];
}

export interface LocalModelsSummary {
  t3PiWorkerProviderInstanceId: string;
  t3GeminiWorkerProviderInstanceId?: string;
  providers: LocalProviderInspection[];
  roleModelMap: Record<string, string>;
}

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_T3_PI_WORKER_PROVIDER_INSTANCE = "pi_durable_worker";

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

/**
 * Discover real DeepSeek models from `$DSH_HOME/storages/session_projcache/sessions/*.json`
 * (recorded by DeepSeek Harness after actual turns) and explicit runtime probe evidence.
 * Capabilities are never invented: unreported dimensions stay `null` or `"unknown"`.
 */
export function discoverDeepSeekHarnessModels(
  dshHome: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalProviderModelSpec[] {
  const discovered = parseVerifiedModelsJson("deepseek", env.DPI_DEEPSEEK_VERIFIED_MODELS_JSON);
  const probeFile = join(dshHome, "verified-models.json");
  if (existsSync(probeFile)) {
    try {
      for (const [id, spec] of parseVerifiedModelsJson("deepseek", readFileSync(probeFile, "utf8"))) {
        discovered.set(id, spec);
      }
    } catch {}
  }

  const sessionsDir = join(dshHome, "storages", "session_projcache", "sessions");
  if (existsSync(sessionsDir)) {
    try {
      const files = readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
      for (const file of files) {
        try {
          const doc = asObject(JSON.parse(readFileSync(join(sessionsDir, file), "utf8")));
          const rows = asObject(asObject(doc?.record)?.rows);
          if (!rows) continue;
          const turnOutline = asObject(asObject(rows.turnOutline)?.val);
          const turns = Array.isArray(turnOutline?.turns) ? turnOutline.turns : [];
          if (turns.length === 0) continue;

          const modelSelection = asObject(asObject(rows.modelSelection)?.val);
          const lastUsed = asObject(modelSelection?.lastUsed);
          const rawModelId = typeof lastUsed?.model === "string" ? lastUsed.model.trim() : "";
          if (!rawModelId || !isValidModelSegment(rawModelId)) continue;

          const contextPressure = asObject(asObject(rows.contextPressure)?.val);
          const observedContextWindow =
            typeof contextPressure?.contextWindow === "number" &&
            Number.isSafeInteger(contextPressure.contextWindow) &&
            contextPressure.contextWindow > 0
              ? contextPressure.contextWindow
              : null;
          const hasReasoningEffort =
            typeof lastUsed?.reasoningEffort === "string" && lastUsed.reasoningEffort.trim().length > 0;

          const existing = discovered.get(rawModelId);
          discovered.set(rawModelId, {
            id: rawModelId,
            qualifiedId: `deepseek/${rawModelId}`,
            provider: "deepseek",
            runtime: "deepseek-harness",
            name: existing?.name ?? rawModelId,
            icon: "deepseek.png",
            verified: true,
            verificationSource: "dsh-session-evidence",
            contextWindow: observedContextWindow ?? existing?.contextWindow ?? null,
            maxOutputTokens: existing?.maxOutputTokens ?? null,
            reasoning: hasReasoningEffort ? "supported" : (existing?.reasoning ?? "unknown"),
            inputModalities: existing?.inputModalities?.length ? existing.inputModalities : ["text"],
          });
        } catch {
          // Ignore individual unreadable session cache files.
        }
      }
    } catch {
      // Ignore unreadable session directory.
    }
  }

  const requestedIds = [env.DPI_DEEPSEEK_MODELS, env.DPI_DEEPSEEK_DEFAULT_MODEL]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const candidate of requestedIds) {
    try {
      const parsed = parseModelSelection(candidate, "deepseek", env);
      if (parsed.provider !== "deepseek" || discovered.has(parsed.modelId)) continue;
      discovered.set(parsed.modelId, {
        id: parsed.modelId,
        qualifiedId: parsed.qualified,
        provider: "deepseek",
        runtime: "deepseek-harness",
        name: parsed.modelId,
        icon: "deepseek.png",
        verified: false,
        verificationSource: "unverified",
        contextWindow: null,
        maxOutputTokens: null,
        reasoning: "unknown",
        inputModalities: [],
      });
    } catch {}
  }

  return [...discovered.values()];
}

function readPiAuthProviders(authFile: string): Set<string> {
  if (!existsSync(authFile)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const configured = new Set<string>();
    for (const [providerId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const hasCredential =
        (typeof record.key === "string" && record.key.trim().length > 0) ||
        (typeof record.access === "string" && record.access.trim().length > 0);
      if (hasCredential) configured.add(providerId.trim().toLowerCase());
    }
    return configured;
  } catch {
    return new Set();
  }
}

export function defaultPiAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DPI_AUTH_FILE?.trim()) return env.DPI_AUTH_FILE.trim();
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "auth.json");
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

export function inspectLocalModelProviders(options: {
  env?: NodeJS.ProcessEnv;
  authFile?: string;
  geminiHome?: string;
  t3UserDataDir?: string;
  dshHome?: string;
} = {}): LocalModelsSummary {
  const env = options.env ?? process.env;
  const authFile = options.authFile ?? defaultPiAuthFile(env);
  const dshHome = options.dshHome ?? defaultDshHome(env);
  const geminiHome = resolveGeminiHomeDir(options.geminiHome, env);

  const piAuth = readPiAuthProviders(authFile);
  const agyStatus = inspectAntigravityCliInstallation(geminiHome, env, options.t3UserDataDir);
  const dshSpec = findDeepSeekHarnessLaunchSpec(env);
  const dshCreds = inspectDshCredentialsFile(dshHome);

  const t3PiWorkerProviderInstanceId =
    env.DPI_T3_PI_WORKER_PROVIDER_INSTANCE?.trim() || DEFAULT_T3_PI_WORKER_PROVIDER_INSTANCE;
  const t3GeminiWorkerProviderInstanceId =
    env.DPI_T3_GEMINI_WORKER_PROVIDER_INSTANCE?.trim() || undefined;
  let roleModelMap: Record<string, string> = {};
  try {
    roleModelMap = parseRoleModelMap(undefined, env);
  } catch {
    roleModelMap = {};
  }

  const deepseekHasEnv = Boolean(env.DEEPSEEK_API_KEY?.trim());
  const deepseekHasPiAuth = piAuth.has("deepseek");

  const deepseekAuthSource: LocalProviderInspection["authSource"] = dshCreds.hasAccountToken
    ? "dsh-account"
    : dshCreds.hasStoredSecret
      ? "dsh-credentials"
      : deepseekHasEnv && deepseekHasPiAuth
        ? "both"
        : deepseekHasEnv
          ? "env"
          : deepseekHasPiAuth
            ? "pi-auth"
            : "none";

  const googleModels = discoverAntigravityModels(geminiHome, env, options.t3UserDataDir);
  const deepseekModels = discoverDeepSeekHarnessModels(dshHome, env);

  const verifiedGoogleDefault = googleModels.find((m) => m.verified)?.qualifiedId;
  const googleDefault = env.DPI_GEMINI_DEFAULT_MODEL?.trim()
    ? defaultModelForProvider("google", env)
    : (verifiedGoogleDefault ?? defaultModelForProvider("google", env));
  const deepseekDefault = defaultModelForProvider("deepseek", env);

  return {
    t3PiWorkerProviderInstanceId,
    ...(t3GeminiWorkerProviderInstanceId ? { t3GeminiWorkerProviderInstanceId } : {}),
    roleModelMap,
    providers: [
      {
        provider: "google",
        runtime: "antigravity",
        displayName: "Google Gemini (Antigravity CLI)",
        authMode: "antigravity-oauth",
        apiKeyForbidden: true,
        runtimeInstalled: agyStatus.runtimeInstalled,
        defaultModel: googleDefault,
        configured: agyStatus.authenticated,
        authSource: agyStatus.authSource,
        remoteAllowedByDefault: false,
        durableDelegationAllowed: false,
        interactionMode: "direct-t3-only",
        verifiedModels: googleModels.filter((m) => m.verified).map((m) => m.qualifiedId),
        models: googleModels,
      },
      {
        provider: "deepseek",
        runtime: "deepseek-harness",
        displayName: "DeepSeek Harness",
        authMode: dshCreds.hasAccountToken ? "deepseek-harness-account" : "api-key",
        apiKeyForbidden: false,
        runtimeInstalled: dshSpec.installed,
        envKey: "DEEPSEEK_API_KEY",
        baseUrlEnvKey: "DEEPSEEK_BASE_URL",
        baseUrl: cleanBaseUrl(env.DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_BASE_URL, "DEEPSEEK_BASE_URL"),
        defaultModel: deepseekDefault,
        configured:
          dshCreds.hasAccountToken ||
          dshCreds.hasStoredSecret ||
          deepseekHasEnv ||
          deepseekHasPiAuth,
        authSource: deepseekAuthSource,
        remoteAllowedByDefault: false,
        durableDelegationAllowed: true,
        interactionMode: "durable-worker",
        verifiedModels: deepseekModels.filter((m) => m.verified).map((m) => m.qualifiedId),
        models: deepseekModels,
      },
    ],
  };
}

export function assertLocalProviderConfigured(
  provider: LocalPiProviderId,
  options: { env?: NodeJS.ProcessEnv; authFile?: string; geminiHome?: string; t3UserDataDir?: string; dshHome?: string } = {},
): LocalProviderInspection {
  const summary = inspectLocalModelProviders(options);
  const entry = summary.providers.find((item) => item.provider === provider);
  if (!entry) throw Error(`Unknown local model provider: ${provider}`);
  if (!entry.configured) {
    if (provider === "google") {
      throw Object.assign(
        Error(
          "Google Gemini requires a local Google Antigravity CLI sign-in (Gemini API keys are disabled, and Desktop Antigravity accounts are isolated). Sign in with your CLI Google account via `agy` or T3 Settings > Providers > Antigravity.",
        ),
        { status: 409 },
      );
    }
    throw Object.assign(
      Error(
        "DeepSeek Harness is not authenticated. Sign in through the desktop DeepSeek Harness app (~/.dsh/.credentials.yaml) or set DEEPSEEK_API_KEY.",
      ),
      { status: 409 },
    );
  }
  return entry;
}
