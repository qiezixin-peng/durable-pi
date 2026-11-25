import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertLocalProviderConfigured,
  inspectLocalModelProviders,
  isLocalPiModel,
  parseModelSelection,
  parseRoleModelMap,
  resolveLocalRoleModel,
} from "../src/node/local-model-providers.js";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 0), encodeVarint(value)]);
}

function buildAntigravityGenMetadataBlob(params: {
  slug: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}): Buffer {
  const usage = Buffer.concat([
    encodeVarintField(2, params.inputTokens),
    encodeVarintField(3, params.outputTokens),
    encodeVarintField(9, params.reasoningTokens),
  ]);
  const inner = Buffer.concat([
    encodeLengthDelimited(4, usage),
    encodeLengthDelimited(19, Buffer.from(params.slug, "utf8")),
    encodeLengthDelimited(21, Buffer.from(params.displayName, "utf8")),
  ]);
  return encodeLengthDelimited(1, inner);
}

test("parseModelSelection normalizes official Antigravity Gemini and DeepSeek Harness models while leaving Codex untouched", () => {
  assert.deepEqual(parseModelSelection("gpt-5.6-sol"), {
    provider: "codex",
    executor: "codex",
    runtime: "codex-app-server",
    modelId: "gpt-5.6-sol",
    qualified: "gpt-5.6-sol",
    localOnlyByDefault: false,
  });

  assert.deepEqual(parseModelSelection("gemini/gemini-4-neon"), {
    provider: "google",
    executor: "pi",
    runtime: "antigravity",
    modelId: "gemini-4-neon",
    qualified: "google/gemini-4-neon",
    localOnlyByDefault: true,
  });

  assert.deepEqual(parseModelSelection("antigravity/gemini-3.8-flash-high"), {
    provider: "google",
    executor: "pi",
    runtime: "antigravity",
    modelId: "gemini-3.8-flash-high",
    qualified: "google/gemini-3.8-flash-high",
    localOnlyByDefault: true,
  });

  assert.deepEqual(parseModelSelection("deepseek-flash"), {
    provider: "deepseek",
    executor: "pi",
    runtime: "deepseek-harness",
    modelId: "deepseek-flash",
    qualified: "deepseek/deepseek-flash",
    localOnlyByDefault: true,
  });

  assert.deepEqual(
    parseModelSelection(undefined, "deepseek", { DPI_DEEPSEEK_DEFAULT_MODEL: "deepseek-flash" }),
    {
      provider: "deepseek",
      executor: "pi",
      runtime: "deepseek-harness",
      modelId: "deepseek-flash",
      qualified: "deepseek/deepseek-flash",
      localOnlyByDefault: true,
    },
  );

  assert.equal(isLocalPiModel("google/gemini-4-neon"), true);
  assert.equal(isLocalPiModel("deepseek/deepseek-flash"), true);
  assert.equal(isLocalPiModel("gpt-5.6-sol"), false);

  assert.throws(() => parseModelSelection("google/gemini-4-neon", "deepseek"), /does not match/);
  assert.throws(() => parseModelSelection("bad model id"), /invalid/i);
});

test("role model map stays empty by default, rejects coordinator overrides, and maps local roles cleanly", () => {
  assert.deepEqual(parseRoleModelMap(undefined, {}), {});
  assert.throws(
    () => parseRoleModelMap(JSON.stringify({ coordinator: "deepseek/deepseek-flash" })),
    /cannot override the coordinator/,
  );

  const env = {
    DPI_ROLE_MODEL_MAP_JSON: JSON.stringify({
      reviewer: "deepseek-flash",
      researcher: "antigravity/gemini-4-neon",
    }),
  };
  assert.deepEqual(parseRoleModelMap(undefined, env), {
    reviewer: "deepseek/deepseek-flash",
    researcher: "google/gemini-4-neon",
  });

  const mapped = resolveLocalRoleModel({
    role: "reviewer",
    fallbackModel: "gpt-5.6-sol",
    env,
  });
  assert.equal(mapped.executor, "pi");
  assert.equal(mapped.runtime, "deepseek-harness");
  assert.equal(mapped.qualified, "deepseek/deepseek-flash");

  const unmapped = resolveLocalRoleModel({
    role: "coder",
    fallbackModel: "gpt-5.6-sol",
    env,
  });
  assert.equal(unmapped.executor, "codex");
  assert.equal(unmapped.runtime, "codex-app-server");
  assert.equal(unmapped.qualified, "gpt-5.6-sol");

  const explicit = resolveLocalRoleModel({
    role: "coder",
    explicitProvider: "google",
    explicitModel: "gemini-3.8-flash-high",
    fallbackModel: "gpt-5.6-sol",
    env,
  });
  assert.equal(explicit.executor, "pi");
  assert.equal(explicit.runtime, "antigravity");
  assert.equal(explicit.qualified, "google/gemini-3.8-flash-high");
});

test("inspectLocalModelProviders discovers real Antigravity and DeepSeek Harness session evidence and avoids fabricating unverified capabilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-local-providers-"));
  const authFile = join(dir, "auth.json");
  const geminiHome = join(dir, ".gemini");
  const dshHome = join(dir, ".dsh");
  const dshSessions = join(dshHome, "storages", "session_projcache", "sessions");
  mkdirSync(dshSessions, { recursive: true });

  try {
    writeFileSync(
      join(dshHome, ".credentials.yaml"),
      [
        "version: 1",
        "records:",
        "  - kind: deepseek-account",
        "    payload:",
        "      token: secret-dsh-desktop-token",
        "      issuer: https://chat.deepseek.com",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(dshSessions, "session-verified-1.json"),
      JSON.stringify({
        version: 7,
        record: {
          rows: {
            turnOutline: {
              val: {
                turns: [{ turn: 1, prompt: "hi", response: "ok" }],
              },
            },
            modelSelection: {
              val: {
                lastUsed: {
                  provider: "deepseek-account",
                  model: "deepseek-flash",
                  reasoningEffort: "high",
                },
              },
            },
            contextPressure: {
              val: {
                contextWindow: 1048576,
              },
            },
          },
        },
      }),
      "utf8",
    );

    // Even if GEMINI_API_KEY is present in env AND Desktop Antigravity has conversations,
    // CLI/T3 Antigravity MUST remain unconfigured without its own CLI sign-in
    const desktopConvDir = join(geminiHome, "antigravity", "conversations");
    mkdirSync(desktopConvDir, { recursive: true });
    writeFileSync(
      join(geminiHome, "antigravity", "antigravity_state.pbtxt"),
      "agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED\n",
      "utf8",
    );
    const t3UserDataDir = join(dir, ".t3", "userdata");
    const withoutAgy = inspectLocalModelProviders({
      env: { GEMINI_API_KEY: "forbidden-gemini-key" },
      authFile,
      geminiHome,
      t3UserDataDir,
      dshHome,
    });
    const googleBefore = withoutAgy.providers.find((item) => item.provider === "google")!;
    assert.equal(googleBefore.configured, false);
    assert.equal(googleBefore.runtime, "antigravity");
    assert.equal(googleBefore.authMode, "antigravity-oauth");
    assert.equal(googleBefore.apiKeyForbidden, true);
    assert.equal(googleBefore.authSource, "none");
    assert.throws(
      () =>
        assertLocalProviderConfigured("google", {
          env: { GEMINI_API_KEY: "forbidden-gemini-key" },
          authFile,
          geminiHome,
          t3UserDataDir,
          dshHome,
        }),
      /Google Antigravity CLI sign-in/,
    );

    // Populate real Antigravity CLI OAuth & conversation SQLite evidence under ~/.gemini/antigravity-cli
    const agyConvDir = join(geminiHome, "antigravity-cli", "conversations");
    mkdirSync(agyConvDir, { recursive: true });
    writeFileSync(
      join(geminiHome, "antigravity-cli", "acp_token.json"),
      JSON.stringify({ refresh_token: "secret-cli-oauth-token" }),
      "utf8",
    );
    const db = new DatabaseSync(join(agyConvDir, "0ca23bd6-45dc-400b-a40e-26fbd061f791.db"));
    db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(
      0,
      buildAntigravityGenMetadataBlob({
        slug: "gemini-4-neon",
        displayName: "Gemini 4 Neon (High)",
        inputTokens: 12000,
        outputTokens: 300,
        reasoningTokens: 120,
      }),
    );
    db.close();

    const summary = inspectLocalModelProviders({
      env: {
        DPI_GEMINI_MODELS: "gemini-unverified-custom",
        DPI_DEEPSEEK_MODELS: "deepseek-unverified-custom",
      },
      authFile,
      geminiHome,
      t3UserDataDir,
      dshHome,
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("secret-dsh-desktop-token"), false);
    assert.equal(serialized.includes("secret-cli-oauth-token"), false);

    const google = summary.providers.find((item) => item.provider === "google")!;
    const deepseek = summary.providers.find((item) => item.provider === "deepseek")!;
    assert.equal(google.configured, true);
    assert.equal(google.runtime, "antigravity");
    assert.equal(google.authMode, "antigravity-oauth");
    assert.equal(google.apiKeyForbidden, true);
    assert.equal(google.authSource, "antigravity-cli-account");
    assert.equal(google.remoteAllowedByDefault, false);
    assert.equal(google.durableDelegationAllowed, false);
    assert.equal(google.interactionMode, "direct-t3-only");
    assert.deepEqual(google.verifiedModels, ["google/gemini-4-neon"]);

    const verifiedNeon = google.models.find((m) => m.id === "gemini-4-neon")!;
    assert.equal(verifiedNeon.verified, true);
    assert.equal(verifiedNeon.verificationSource, "antigravity-session-evidence");
    assert.equal(verifiedNeon.name, "Gemini 4 Neon (High)");
    assert.equal(verifiedNeon.contextWindow, null);
    assert.equal(verifiedNeon.maxOutputTokens, null);
    assert.equal(verifiedNeon.reasoning, "supported");

    const unverifiedGemini = google.models.find((m) => m.id === "gemini-unverified-custom")!;
    assert.equal(unverifiedGemini.verified, false);
    assert.equal(unverifiedGemini.verificationSource, "unverified");
    assert.equal(unverifiedGemini.contextWindow, null);
    assert.equal(unverifiedGemini.maxOutputTokens, null);
    assert.equal(unverifiedGemini.reasoning, "unknown");

    assert.equal(deepseek.configured, true);
    assert.equal(deepseek.runtime, "deepseek-harness");
    assert.equal(deepseek.authMode, "deepseek-harness-account");
    assert.equal(deepseek.authSource, "dsh-account");
    assert.equal(deepseek.durableDelegationAllowed, true);
    assert.equal(deepseek.interactionMode, "durable-worker");
    assert.deepEqual(deepseek.verifiedModels, ["deepseek/deepseek-flash"]);

    const verifiedFlash = deepseek.models.find((m) => m.id === "deepseek-flash")!;
    assert.equal(verifiedFlash.verified, true);
    assert.equal(verifiedFlash.verificationSource, "dsh-session-evidence");
    assert.equal(verifiedFlash.contextWindow, 1048576);
    assert.equal(verifiedFlash.maxOutputTokens, null);
    assert.equal(verifiedFlash.reasoning, "supported");

    const unverifiedCustom = deepseek.models.find((m) => m.id === "deepseek-unverified-custom")!;
    assert.equal(unverifiedCustom.verified, false);
    assert.equal(unverifiedCustom.contextWindow, null);
    assert.equal(unverifiedCustom.maxOutputTokens, null);
    assert.equal(unverifiedCustom.reasoning, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
