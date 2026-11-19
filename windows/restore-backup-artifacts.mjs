import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [databaseArg, bundleArg, dpiArg, safetyArg] = process.argv.slice(2);
if (!databaseArg || !bundleArg || !dpiArg || !safetyArg)
  throw Error("Usage: restore-backup-artifacts.mjs <database> <bundle-dir> <dpi-dir> <safety-dir>");

const database = resolve(databaseArg);
const bundle = resolve(bundleArg);
const dpi = resolve(dpiArg);
const targetRoot = resolve(dpi, "artifacts");
const safetyRoot = resolve(safetyArg);
if (dirname(targetRoot) !== dpi) throw Error("Artifact target escaped the DPI directory");
if (!safetyRoot.startsWith(`${resolve(dpi, "backups")}${sep}`)) throw Error("Artifact safety directory escaped backups");
if (!existsSync(database) || lstatSync(database).isSymbolicLink() || !statSync(database).isFile())
  throw Error("Restored database is missing or unsafe");

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const db = new DatabaseSync(database);
let retainedRows;
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_artifacts'").get();
  retainedRows = table
    ? db.prepare("SELECT id,project_id,sha256,size_bytes,status FROM project_artifacts WHERE status IN ('ACTIVE','EXPIRED') ORDER BY project_id,id").all()
    : [];
} finally {
  db.close();
}

if (!existsSync(bundle)) {
  if (retainedRows.some((row) => row.status === "ACTIVE"))
    throw Error("Backup has active Artifact metadata but no .sqlite.files bundle");
  process.stdout.write(`${JSON.stringify({ restored: 0, bytes: 0, legacyWithoutArtifacts: true })}\n`);
  process.exit(0);
}
if (lstatSync(bundle).isSymbolicLink() || !statSync(bundle).isDirectory()) throw Error("Artifact backup bundle is unsafe");
const manifestPath = join(bundle, "manifest.json");
if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile())
  throw Error("Artifact backup manifest is missing or unsafe");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (![1, 2, 3].includes(manifest.schemaVersion) || !Array.isArray(manifest.artifacts)) throw Error("Unsupported Artifact backup manifest");
const artifactRows = manifest.schemaVersion === 1
  ? retainedRows.filter((row) => row.status === "ACTIVE")
  : retainedRows;
if (manifest.artifacts.length !== artifactRows.length) throw Error("Artifact manifest count does not match the database snapshot");

const rowMap = new Map(artifactRows.map((row) => [`${row.project_id}\0${row.id}`, row]));
const staging = resolve(dpi, `artifacts.restore-${process.pid}-${randomUUID()}`);
if (dirname(staging) !== dpi || existsSync(staging)) throw Error("Unsafe or existing Artifact staging directory");
mkdirSync(staging, { recursive: false, mode: 0o700 });
let swapped = false;
let preserved = false;
let totalBytes = 0;
let configurationStaging;
let configurationTarget;
let configurationSafety;
let configurationPreserved = false;
let configurationApplied = false;
try {
  const paths = [];
  for (const item of manifest.artifacts) {
    if (!item || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.projectId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(item.id))
      throw Error("Artifact manifest contains an unsafe identity");
    if (typeof item.file !== "string" || item.file !== `${item.projectId}/${item.id}.artifact`)
      throw Error(`Artifact backup path is invalid: ${item.id}`);
    if (typeof item.storageFile !== "string" || basename(item.storageFile) !== item.storageFile || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,240}$/.test(item.storageFile))
      throw Error(`Artifact storage filename is invalid: ${item.id}`);
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0)
      throw Error(`Artifact metadata is invalid: ${item.id}`);
    const row = rowMap.get(`${item.projectId}\0${item.id}`);
    if (!row || row.sha256 !== item.sha256 || row.size_bytes !== item.sizeBytes)
      throw Error(`Artifact manifest does not match database metadata: ${item.id}`);
    if (manifest.schemaVersion >= 2 && item.status !== row.status)
      throw Error(`Artifact manifest status does not match database metadata: ${item.id}`);
    const source = resolve(bundle, item.file);
    if (!source.startsWith(`${bundle}${sep}`) || !existsSync(source) || lstatSync(source).isSymbolicLink() || !statSync(source).isFile())
      throw Error(`Artifact backup file is missing or unsafe: ${item.id}`);
    if (statSync(source).size !== item.sizeBytes || hash(source) !== item.sha256)
      throw Error(`Artifact backup file failed verification: ${item.id}`);
    const projectDirectory = resolve(staging, item.projectId);
    if (dirname(projectDirectory) !== staging) throw Error(`Artifact restore path escaped: ${item.id}`);
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const target = join(projectDirectory, item.storageFile);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    if (statSync(target).size !== item.sizeBytes || hash(target) !== item.sha256)
      throw Error(`Restored Artifact failed verification: ${item.id}`);
    totalBytes += item.sizeBytes;
    paths.push({ id: item.id, projectId: item.projectId, status: row.status, path: resolve(targetRoot, item.projectId, item.storageFile) });
  }

  if (manifest.schemaVersion === 3) {
    if (!Array.isArray(manifest.configuration)) throw Error("Backup configuration manifest is missing");
    if (manifest.configuration.length > 1) throw Error("Backup configuration manifest is too large");
    const config = manifest.configuration[0];
    if (config) {
      if (config.name !== "data-sources" || config.file !== "config/data-sources.json" ||
          !/^[a-f0-9]{64}$/.test(config.sha256) || !Number.isSafeInteger(config.sizeBytes) || config.sizeBytes < 0)
        throw Error("Backup configuration metadata is invalid");
      const source = resolve(bundle, config.file);
      if (!source.startsWith(`${bundle}${sep}`) || !existsSync(source) || lstatSync(source).isSymbolicLink() || !statSync(source).isFile() ||
          statSync(source).size !== config.sizeBytes || hash(source) !== config.sha256)
        throw Error("Backup configuration failed verification");
      const parsed = JSON.parse(readFileSync(source, "utf8"));
      if (parsed.version !== 1 || !Array.isArray(parsed.sources)) throw Error("Backup data-source configuration is invalid");
      configurationTarget = resolve(dpi, "data-sources.json");
      configurationStaging = resolve(dpi, `data-sources.restore-${process.pid}-${randomUUID()}.json`);
      configurationSafety = resolve(dpi, "backups", `data-sources-before-restore-${Date.now()}.json`);
      copyFileSync(source, configurationStaging);
      chmodSync(configurationStaging, 0o600);
    }
  }

  if (existsSync(targetRoot)) {
    if (lstatSync(targetRoot).isSymbolicLink() || !statSync(targetRoot).isDirectory()) throw Error("Current Artifact directory is unsafe");
    if (existsSync(safetyRoot)) throw Error("Artifact safety directory already exists");
    renameSync(targetRoot, safetyRoot);
    preserved = true;
  }
  renameSync(staging, targetRoot);
  swapped = true;

  if (configurationStaging && configurationTarget && configurationSafety) {
    if (existsSync(configurationTarget)) {
      if (lstatSync(configurationTarget).isSymbolicLink() || !statSync(configurationTarget).isFile())
        throw Error("Current data-source configuration is unsafe");
      renameSync(configurationTarget, configurationSafety);
      configurationPreserved = true;
    }
    try {
      renameSync(configurationStaging, configurationTarget);
      configurationApplied = true;
    } catch (error) {
      if (configurationPreserved) renameSync(configurationSafety, configurationTarget);
      throw error;
    }
  }

  const update = new DatabaseSync(database);
  try {
    update.exec("BEGIN IMMEDIATE");
    for (const item of paths) {
      const result = update.prepare("UPDATE project_artifacts SET storage_path=? WHERE id=? AND project_id=? AND status=?")
        .run(item.path, item.id, item.projectId, item.status);
      if (result.changes !== 1) throw Error(`Artifact database path update failed: ${item.id}`);
    }
    update.exec("COMMIT");
  } catch (error) {
    try { update.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    update.close();
  }
  process.stdout.write(`${JSON.stringify({ restored: paths.length, bytes: totalBytes, safetyPath: preserved ? safetyRoot : null, configurationRestored: Boolean(configurationTarget), configurationSafetyPath: configurationSafety && existsSync(configurationSafety) ? configurationSafety : null })}\n`);
} catch (error) {
  if (configurationApplied && configurationTarget && existsSync(configurationTarget) && !lstatSync(configurationTarget).isSymbolicLink())
    rmSync(configurationTarget, { force: true });
  if (configurationPreserved && configurationSafety && configurationTarget && existsSync(configurationSafety))
    renameSync(configurationSafety, configurationTarget);
  if (swapped && existsSync(targetRoot) && !lstatSync(targetRoot).isSymbolicLink()) rmSync(targetRoot, { recursive: true, force: true });
  if (preserved && existsSync(safetyRoot)) renameSync(safetyRoot, targetRoot);
  if (existsSync(staging) && !lstatSync(staging).isSymbolicLink()) rmSync(staging, { recursive: true, force: true });
  if (typeof configurationStaging === "string" && existsSync(configurationStaging) && !lstatSync(configurationStaging).isSymbolicLink()) rmSync(configurationStaging, { force: true });
  throw error;
}
