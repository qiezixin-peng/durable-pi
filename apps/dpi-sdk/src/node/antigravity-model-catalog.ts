import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { listAntigravityCliProfileDirs } from "./antigravity-client.js";
import type { LocalProviderModelSpec } from "./local-model-providers.js";
import { isValidModelSegment, parseModelSelection } from "./model-selection.js";
import { parseVerifiedModelsJson } from "./verified-model-catalog.js";

type ProtoFieldValue = number | bigint | Uint8Array;
type ProtoFields = Map<number, ProtoFieldValue[]>;

function decodeProtoFields(bytes: Uint8Array): ProtoFields {
  let offset = 0;
  const result: ProtoFields = new Map();
  const readVarint = (): number | bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid protobuf varint");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    if (typeof tag !== "number") break;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNumber === 0) break;
    let value: ProtoFieldValue;
    if (wireType === 0) {
      value = readVarint();
    } else if (wireType === 1 || wireType === 5 || wireType === 2) {
      const length = wireType === 2 ? readVarint() : wireType === 1 ? 8 : 4;
      if (typeof length !== "number" || length < 0 || length > bytes.length - offset) break;
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wireType !== 2) continue;
    } else {
      break;
    }
    const existing = result.get(fieldNumber) ?? [];
    existing.push(value);
    result.set(fieldNumber, existing);
  }
  return result;
}

function protoBytesAt(fields: ProtoFields, key: number): Uint8Array | undefined {
  const entry = fields.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
}

function protoNested(fields: ProtoFields, key: number): ProtoFields {
  const bytes = protoBytesAt(fields, key);
  return bytes === undefined ? new Map() : decodeProtoFields(bytes);
}

function protoTextAt(fields: ProtoFields, key: number): string {
  const bytes = protoBytesAt(fields, key);
  if (!bytes) return "";
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  } catch {
    return "";
  }
}

function protoNumberAt(fields: ProtoFields, key: number): number {
  const entry = fields.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
}

function normalizeAntigravityModelSlug(rawSlug: string, displayName: string): string {
  const normalizedFromDisplay = displayName
    ? displayName.trim().toLowerCase().replace(/\s*\(([^)]*)\)\s*$/, "-$1").replace(/\s+/g, "-")
    : "";
  const cleanedSlug = rawSlug.trim().toLowerCase();
  if (cleanedSlug && /^gemini-\d/.test(cleanedSlug) && !cleanedSlug.endsWith("-n")) return cleanedSlug;
  if (normalizedFromDisplay && /^gemini-\d/.test(normalizedFromDisplay)) return normalizedFromDisplay;
  if (cleanedSlug.endsWith("-n") && /^gemini-\d/.test(cleanedSlug)) return cleanedSlug.slice(0, -2);
  return cleanedSlug;
}

/** Discover only verified Antigravity CLI/T3 model evidence, never Desktop credentials. */
export function discoverAntigravityModels(
  geminiHome: string,
  env: NodeJS.ProcessEnv = process.env,
  t3UserDataDir?: string,
): LocalProviderModelSpec[] {
  const discovered = parseVerifiedModelsJson(
    "google",
    env.DPI_ANTIGRAVITY_VERIFIED_MODELS_JSON ?? env.DPI_GEMINI_VERIFIED_MODELS_JSON,
  );
  const profileDirs = listAntigravityCliProfileDirs(geminiHome, t3UserDataDir, env);
  for (const profileDir of profileDirs) {
    const probeFile = join(profileDir, "verified-models.json");
    if (existsSync(probeFile)) {
      try {
        for (const [id, spec] of parseVerifiedModelsJson("google", readFileSync(probeFile, "utf8"))) discovered.set(id, spec);
      } catch {}
    }

    const conversationsDir = join(profileDir, "conversations");
    if (!existsSync(conversationsDir)) continue;
    try {
      for (const file of readdirSync(conversationsDir).filter((name) => name.endsWith(".db"))) {
        let db: DatabaseSync | null = null;
        try {
          db = new DatabaseSync(join(conversationsDir, file), { readOnly: true });
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'").all() as Array<{ name?: string }>;
          if (tables.length === 0) continue;
          const rows = db.prepare("SELECT data FROM gen_metadata ORDER BY rowid DESC LIMIT 25").all() as Array<{ data?: Uint8Array | Buffer }>;
          for (const row of rows) {
            if (!row.data) continue;
            const root = decodeProtoFields(row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data));
            const data = protoNested(root, 1);
            const rawSlug = protoTextAt(data, 19);
            const displayName = protoTextAt(data, 21);
            const modelSlug = normalizeAntigravityModelSlug(rawSlug, displayName);
            if (!modelSlug || !/^gemini-\d/.test(modelSlug) || !isValidModelSegment(modelSlug)) continue;

            const usage = protoNested(data, 4);
            const inTokens = protoNumberAt(usage, 2);
            const outTokens = Math.max(protoNumberAt(usage, 3), protoNumberAt(usage, 9) + protoNumberAt(usage, 10));
            const reasoningTokens = protoNumberAt(usage, 9);
            if (inTokens + outTokens <= 0) continue;

            const existing = discovered.get(modelSlug);
            const hasReasoning = reasoningTokens > 0 || existing?.reasoning === "supported";
            discovered.set(modelSlug, {
              id: modelSlug,
              qualifiedId: `google/${modelSlug}`,
              provider: "google",
              runtime: "antigravity",
              name: displayName || existing?.name || modelSlug,
              icon: "gemini.png",
              verified: true,
              verificationSource: "antigravity-session-evidence",
              contextWindow: existing?.contextWindow ?? null,
              maxOutputTokens: existing?.maxOutputTokens ?? null,
              reasoning: hasReasoning ? "supported" : (existing?.reasoning ?? "unknown"),
              inputModalities: existing?.inputModalities?.length ? existing.inputModalities : ["text"],
            });
          }
        } catch {
          // Ignore individual unreadable conversation databases.
        } finally {
          try { db?.close(); } catch {}
        }
      }
    } catch {
      // Ignore unreadable conversations directory.
    }
  }

  const requestedIds = [env.DPI_GEMINI_MODELS, env.DPI_GEMINI_DEFAULT_MODEL]
    .filter(Boolean).join(",").split(",").map((item) => item.trim()).filter(Boolean);
  for (const candidate of requestedIds) {
    try {
      const parsed = parseModelSelection(candidate, "google", env);
      if (parsed.provider !== "google" || discovered.has(parsed.modelId)) continue;
      discovered.set(parsed.modelId, {
        id: parsed.modelId,
        qualifiedId: parsed.qualified,
        provider: "google",
        runtime: "antigravity",
        name: parsed.modelId,
        icon: "gemini.png",
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
