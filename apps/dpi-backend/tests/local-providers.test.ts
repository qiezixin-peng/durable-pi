import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeepSeekBackendProvider,
  parseBackendProviders,
} from "../src/local-providers.js";
import { Store } from "../src/store.js";

test("parseBackendProviders supports deepseek and local while explicitly forbidding Gemini API key mode", () => {
  assert.deepEqual(parseBackendProviders("deepseek"), ["deepseek"]);
  assert.deepEqual(parseBackendProviders("deepseek,openai"), ["deepseek", "openai"]);
  assert.deepEqual(parseBackendProviders("local"), ["deepseek", "openai"]);
  assert.throws(() => parseBackendProviders("google"), /Gemini API key mode is disabled/);
  assert.throws(() => parseBackendProviders("gemini"), /Gemini API key mode is disabled/);
  assert.throws(() => parseBackendProviders("faux,deepseek"), /cannot be combined/);
  assert.throws(() => parseBackendProviders("unknown-provider"), /Unsupported DPI_PROVIDER/);
});

test("deepseek backend provider exposes official models and honors custom base URLs", () => {
  const deepseek = createDeepSeekBackendProvider({
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/",
    DPI_DEEPSEEK_MODELS: "deepseek-custom-1",
  });
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com");
  assert.equal(deepseek.getModels().some((m) => m.id === "deepseek-chat"), true);
  assert.equal(deepseek.getModels().some((m) => m.id === "deepseek-reasoner"), true);
  assert.equal(deepseek.getModels().some((m) => m.id === "deepseek-v4-pro"), true);
  assert.equal(deepseek.getModels().some((m) => m.id === "deepseek-custom-1"), true);
});

test("Store loads deepseek models from auth.json without network probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-backend-local-providers-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      deepseek: { type: "api_key", key: "test-deepseek-key" },
    }),
    "utf8",
  );
  const store = await Store.open({
    dataDir: join(dir, "data"),
    startDirs: [join(dir, "work")],
    name: "win-local",
    provider: "deepseek",
    authFile,
  });
  try {
    const info = store.deviceInfo();
    const deepseekChat = info.models.find((m) => m.provider === "deepseek" && m.id === "deepseek-chat");
    const deepseekReasoner = info.models.find((m) => m.provider === "deepseek" && m.id === "deepseek-reasoner");
    assert.ok(deepseekChat);
    assert.equal(deepseekChat.icon, "deepseek.png");
    assert.ok(deepseekReasoner);
    assert.equal(deepseekReasoner.reasoning, true);

    assert.deepEqual(store.validateModel({ provider: "deepseek", modelId: "deepseek-reasoner" }), {
      provider: "deepseek",
      modelId: "deepseek-reasoner",
    });
    assert.throws(
      () => store.validateModel({ provider: "deepseek", modelId: "does-not-exist" }),
      /Unknown model/,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
