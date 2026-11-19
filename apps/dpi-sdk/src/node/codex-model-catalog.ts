export type CodexCapabilitySupport = "supported" | "unsupported" | "unknown";

export interface CodexModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  capabilities: {
    textInput: CodexCapabilitySupport;
    imageInput: CodexCapabilitySupport;
    reasoning: CodexCapabilitySupport;
    dynamicTools: CodexCapabilitySupport;
    source: {
      availability: "codex-model-list";
      dynamicTools: "platform-verified" | "unknown";
    };
  };
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];

/**
 * Models for which this platform has executed a real Codex Dynamic Tools turn.
 * Availability from model/list alone is deliberately not treated as capability proof.
 */
export const DEFAULT_DYNAMIC_TOOLS_VERIFIED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-6.1-sol",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
]);

/** Default for new local Codex agents. Remote environments remain device-pinned. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export function normalizeCodexModelList(
  response: unknown,
  dynamicToolsVerifiedModels: ReadonlySet<string> = DEFAULT_DYNAMIC_TOOLS_VERIFIED_MODELS,
): CodexModelCatalogEntry[] {
  const root = object(response);
  const data = Array.isArray(root?.data) ? root.data : [];
  const seen = new Set<string>();
  const entries: CodexModelCatalogEntry[] = [];
  for (const value of data) {
    const item = object(value);
    if (!item) continue;
    const id = [item.id, item.model].find((candidate) => typeof candidate === "string" && candidate.trim());
    if (typeof id !== "string" || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const inputModalities = strings(item.inputModalities);
    const supportedReasoningEfforts = strings(item.supportedReasoningEfforts).length
      ? strings(item.supportedReasoningEfforts)
      : Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts
            .map((effort) => object(effort)?.reasoningEffort)
            .filter((effort): effort is string => typeof effort === "string" && Boolean(effort.trim()))
        : [];
    const dynamicTools = dynamicToolsVerifiedModels.has(id) ? "supported" : "unknown";
    entries.push({
      id,
      model: id,
      displayName: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : id,
      ...(typeof item.description === "string" && item.description.trim()
        ? { description: item.description }
        : {}),
      inputModalities,
      supportedReasoningEfforts,
      ...(typeof item.defaultReasoningEffort === "string"
        ? { defaultReasoningEffort: item.defaultReasoningEffort }
        : {}),
      capabilities: {
        textInput: inputModalities.length === 0 || inputModalities.includes("text") ? "supported" : "unsupported",
        imageInput: inputModalities.includes("image") ? "supported" : inputModalities.length ? "unsupported" : "unknown",
        reasoning: supportedReasoningEfforts.length ? "supported" : "unknown",
        dynamicTools,
        source: {
          availability: "codex-model-list",
          dynamicTools: dynamicTools === "supported" ? "platform-verified" : "unknown",
        },
      },
    });
  }
  return entries;
}

export class CodexModelCatalog {
  private entries: CodexModelCatalogEntry[] = [];
  private loadedAt = 0;
  private loading?: Promise<CodexModelCatalogEntry[]>;

  constructor(
    private readonly loader: () => Promise<unknown>,
    private readonly ttlMs = 60_000,
    private readonly dynamicToolsVerifiedModels: ReadonlySet<string> = DEFAULT_DYNAMIC_TOOLS_VERIFIED_MODELS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw Error("Codex model catalog TTL must be a non-negative integer");
  }

  async list(force = false): Promise<CodexModelCatalogEntry[]> {
    const now = Date.now();
    if (!force && this.loadedAt && now - this.loadedAt < this.ttlMs) return this.entries;
    if (this.loading) return this.loading;
    this.loading = this.loader()
      .then((response) => {
        const entries = normalizeCodexModelList(response, this.dynamicToolsVerifiedModels);
        if (!entries.length) throw Error("Codex returned no usable models");
        this.entries = entries;
        this.loadedAt = Date.now();
        return entries;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  async requireAvailable(id: string): Promise<CodexModelCatalogEntry> {
    const model = id.trim();
    if (!model || model.length > 200) throw Error("Codex model is required and must be at most 200 characters");
    const available = (await this.list()).find((entry) => entry.id === model);
    if (!available)
      throw Object.assign(Error(`Codex model ${model} is not available for the current signed-in account`), { status: 409 });
    return available;
  }
}
