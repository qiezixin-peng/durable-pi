import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("supply-chain policy produces a deterministic CycloneDX SBOM from pinned lockfiles", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const generator = join(root, "scripts", "generate-sbom.mjs");
  const output = join(root, "sbom.cdx.json");
  const policy = JSON.parse(readFileSync(join(root, "supply-chain-policy.json"), "utf8")) as {
    productionAuditMaximum: Record<string, number>;
  };
  assert.deepEqual(policy.productionAuditMaximum, { info: 0, low: 0, moderate: 0, high: 0, critical: 0 });
  const run = () => {
    execFileSync(process.execPath, [generator], { cwd: root, stdio: "ignore" });
    const bytes = readFileSync(output);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const first = run();
  const second = run();
  assert.equal(second.sha256, first.sha256);
  const sbom = JSON.parse(second.bytes.toString("utf8")) as {
    bomFormat: string;
    specVersion: string;
    components: Array<{
      name: string;
      version?: string;
      hashes?: Array<{ alg: string; content: string }>;
      properties?: Array<{ name: string; value: string }>;
    }>;
  };
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.ok(sbom.components.length > 300);
  const scripted = sbom.components
    .filter((component) => component.properties?.some((item) =>
      item.name === "durable-pi:install-script" && item.value === "true"))
    .map((component) => `${component.name}@${component.version}`)
    .sort();
  assert.deepEqual(scripted, ["@google/genai@2.21.0", "esbuild@0.28.2", "fsevents@2.3.3", "protobufjs@7.6.6"]);
  for (const relative of [
    "apps/dpi-backend/package.json",
    "apps/dpi-sdk/package.json",
    "apps/dpi-playground/package.json",
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, relative), "utf8")) as {
      allowScripts: Record<string, boolean>;
    };
    assert.ok(Object.values(manifest.allowScripts).every((enabled) => enabled === true));
    assert.ok(Object.keys(manifest.allowScripts).every((identity) => scripted.includes(identity)));
  }
  for (const component of sbom.components.filter((item) => item.version))
    for (const hash of component.hashes ?? []) assert.match(hash.content, /^[a-f0-9]+$/);
});
