import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCredentialStore } from "../src/credential-store.js";

test("JSON credential store shares Pi auth.json without exposing secrets in metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-auth-"));
  const path = join(dir, "auth.json");
  const store = new JsonCredentialStore(path);
  try {
    const oauth = {
      type: "oauth" as const,
      access: "secret-access",
      refresh: "secret-refresh",
      expires: Date.now() + 60_000,
    };
    await store.modify("openai", async () => oauth);
    assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);
    assert.deepEqual(await store.read("openai"), oauth);
    assert.doesNotMatch(JSON.stringify(await store.list()), /secret/);

    await Promise.all([
      store.modify("openai", async (current) => ({ ...current!, access: "rotated" })),
      store.modify("openrouter", async () => ({ type: "api_key", key: "another-secret" })),
    ]);
    assert.equal((await store.read("openai") as { access: string }).access, "rotated");
    assert.equal(JSON.parse(await readFile(path, "utf8")).openrouter.type, "api_key");
    await store.delete("openrouter");
    assert.equal(await store.read("openrouter"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
