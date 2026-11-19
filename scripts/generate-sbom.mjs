import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lockfiles = [
  "apps/dpi-backend/package-lock.json",
  "apps/dpi-sdk/package-lock.json",
  "apps/dpi-playground/package-lock.json",
];
const manifests = lockfiles.map((lockfile) => lockfile.replace("package-lock.json", "package.json"));
const policy = JSON.parse(readFileSync(resolve(root, "supply-chain-policy.json"), "utf8"));
if (policy.schemaVersion !== 1) throw Error("Unsupported supply-chain policy schema");

const allowedHosts = new Set(policy.registryHosts);
const allowedLicenses = new Set(policy.allowedLicenses);
const allowedInstallScripts = new Set(policy.allowedInstallScripts);
const components = new Map();
const packageFingerprints = new Map();
const usedInstallScripts = new Set();
const configuredInstallScripts = new Set();
const installScriptsByLockfile = new Map();
const lockHashes = [];

for (const [index, relative] of manifests.entries()) {
  const manifest = JSON.parse(readFileSync(resolve(root, relative), "utf8"));
  if (!manifest.allowScripts || typeof manifest.allowScripts !== "object" || Array.isArray(manifest.allowScripts))
    throw Error(`${relative} must define an exact allowScripts map`);
  for (const [identity, enabled] of Object.entries(manifest.allowScripts)) {
    if (enabled !== true) throw Error(`${relative} has a non-enabled install-script policy for ${identity}`);
    if (!/^(@[^/]+\/[^@]+|[^@/]+)@[^@]+$/.test(identity))
      throw Error(`${relative} has an unpinned install-script identity ${identity}`);
    if (!allowedInstallScripts.has(identity))
      throw Error(`${relative} allows install script outside central policy: ${identity}`);
    configuredInstallScripts.add(identity);
  }
  installScriptsByLockfile.set(lockfiles[index], manifest.allowScripts);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageName = (path) => path.split("node_modules/").at(-1);
const purl = (name, version) => {
  const parts = name.startsWith("@") ? name.split("/") : [name];
  return `pkg:npm/${parts.map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
};

for (const relative of lockfiles) {
  const bytes = readFileSync(resolve(root, relative));
  lockHashes.push({ path: relative, sha256: sha256(bytes) });
  const lock = JSON.parse(bytes);
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object")
    throw Error(`${relative} must be an npm lockfileVersion 3 file`);
  const application = lock.packages[""];
  if (!application?.name) throw Error(`${relative} has no root package identity`);
  components.set(`application:${application.name}`, {
    type: "application",
    "bom-ref": `application:${application.name}`,
    name: application.name,
    ...(application.version ? { version: application.version } : {}),
    properties: [{ name: "durable-pi:lockfile", value: relative }],
  });
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/")) continue;
    const name = packageName(path);
    if (!name || !entry.version) {
      if (entry.link) continue;
      throw Error(`${relative}:${path} has no pinned version`);
    }
    const identity = `${name}@${entry.version}`;
    const fingerprint = JSON.stringify({
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      license: entry.license ?? null,
    });
    const priorFingerprint = packageFingerprints.get(identity);
    if (priorFingerprint && priorFingerprint !== fingerprint)
      throw Error(`${identity} has inconsistent source, integrity or license across lockfiles`);
    packageFingerprints.set(identity, fingerprint);
    if (entry.resolved) {
      const url = new URL(entry.resolved);
      if (url.protocol !== "https:" || !allowedHosts.has(url.hostname))
        throw Error(`${identity} resolves from disallowed source ${entry.resolved}`);
      if (typeof entry.integrity !== "string" || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity))
        throw Error(`${identity} has no accepted lockfile integrity`);
      if (typeof entry.license !== "string" || !entry.license)
        throw Error(`${identity} has no declared license`);
    }
    if (entry.license && !allowedLicenses.has(entry.license))
      throw Error(`${identity} uses unapproved license ${entry.license}`);
    if (entry.hasInstallScript) {
      if (!allowedInstallScripts.has(identity)) throw Error(`${identity} has an unapproved install script`);
      if (installScriptsByLockfile.get(relative)?.[identity] !== true)
        throw Error(`${relative} does not enforce the central install-script approval for ${identity}`);
      usedInstallScripts.add(identity);
    }
    const key = `library:${identity}`;
    const existing = components.get(key);
    const sources = new Set(existing?.properties?.find((item) => item.name === "durable-pi:lockfiles")?.value.split(",") ?? []);
    sources.add(relative);
    const hashes = [];
    if (entry.integrity) {
      const [algorithm, encoded] = entry.integrity.split("-", 2);
      hashes.push({ alg: algorithm.toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(encoded, "base64").toString("hex") });
    }
    components.set(key, {
      type: "library",
      "bom-ref": key,
      name,
      version: entry.version,
      purl: purl(name, entry.version),
      ...(hashes.length ? { hashes } : {}),
      ...(entry.license ? { licenses: [{ expression: entry.license }] } : {}),
      properties: [
        { name: "durable-pi:lockfiles", value: [...sources].filter(Boolean).sort().join(",") },
        { name: "durable-pi:development-only", value: String(entry.dev === true) },
        { name: "durable-pi:optional", value: String(entry.optional === true) },
        { name: "durable-pi:install-script", value: String(entry.hasInstallScript === true) },
      ],
    });
  }
}

for (const allowed of allowedInstallScripts)
  if (!usedInstallScripts.has(allowed)) throw Error(`Stale install-script approval: ${allowed}`);
for (const allowed of allowedInstallScripts)
  if (!configuredInstallScripts.has(allowed)) throw Error(`Install-script approval is not enforced by any manifest: ${allowed}`);

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    tools: { components: [{ type: "application", name: "durable-pi-sbom-generator", version: "1" }] },
    component: { type: "application", "bom-ref": "application:durable-pi-platform", name: "durable-pi-platform" },
    properties: lockHashes.sort((a, b) => a.path.localeCompare(b.path)).flatMap((item) => [
      { name: `durable-pi:lockfile:${item.path}:sha256`, value: item.sha256 },
    ]),
  },
  components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
};

const output = resolve(root, "sbom.cdx.json");
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output, components: sbom.components.length, lockfiles: lockHashes.length })}\n`);
