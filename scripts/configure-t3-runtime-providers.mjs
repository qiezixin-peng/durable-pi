#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined) throw Error("Arguments must be --name value pairs");
  args.set(key.slice(2), value);
}

const settingsPath = resolve(args.get("settings") ?? `${homedir()}/.t3/userdata/settings.json`);
const antigravityBinary = args.get("antigravity-binary");
if (!antigravityBinary) throw Error("--antigravity-binary is required");
const resolvedBinary = resolve(antigravityBinary);
if (!existsSync(resolvedBinary)) throw Error(`Antigravity CLI binary or wrapper does not exist: ${resolvedBinary}`);

const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, "utf8"))
  : {};
settings.providerInstances ??= {};

// T3 already supplies its built-in Codex provider. Durable workers reuse it;
// only the Coordinator needs a custom isolated Codex instance.
delete settings.providerInstances.codex_durable_worker;
settings.providerInstances.antigravity = {
  driver: "antigravity",
  displayName: "Antigravity CLI (Gemini)",
  enabled: true,
  config: {
    authMethod: "oauth-personal",
    binaryPath: resolvedBinary,
  },
};

const tempPath = `${settingsPath}.durable-pi-${process.pid}.tmp`;
writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(tempPath, settingsPath);
console.log(JSON.stringify({ settingsPath, workerProvider: "codex", antigravityProvider: "antigravity" }));
