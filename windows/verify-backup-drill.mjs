import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [expectedArg, restoredArg, artifactRootArg] = process.argv.slice(2);
if (!expectedArg || !restoredArg || !artifactRootArg)
  throw Error("Usage: verify-backup-drill.mjs <expected-db> <restored-db> <artifact-root>");

const expectedPath = resolve(expectedArg);
const restoredPath = resolve(restoredArg);
const artifactRoot = resolve(artifactRootArg);
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? { $bigint: item.toString() } : item);

const openVerified = (path) => {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
    throw Error(`SQLite file is missing or unsafe: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  const result = db.prepare("PRAGMA quick_check").get();
  if (result?.quick_check !== "ok") {
    db.close();
    throw Error(`SQLite quick_check failed: ${path}`);
  }
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length) {
    db.close();
    throw Error(`SQLite foreign_key_check failed: ${path} has ${foreignKeyErrors.length} violation(s)`);
  }
  return db;
};

const expected = openVerified(expectedPath);
const restored = openVerified(restoredPath);
try {
  const manifestPath = `${expectedPath}.files${sep}manifest.json`;
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const manifestSchema = Number(manifest?.schemaVersion ?? 0);
  const backedStatuses = manifestSchema >= 2 ? new Set(["ACTIVE", "EXPIRED"]) : new Set(["ACTIVE"]);
  const tables = (db) => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  const expectedTables = tables(expected);
  const restoredTables = tables(restored);
  if (canonical(restoredTables) !== canonical(expectedTables)) throw Error("Restored database table set differs from backup");

  let rows = 0;
  for (const table of expectedTables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const normalize = (items) => items.map((row) => {
      if (table === "project_artifacts" && backedStatuses.has(row.status)) return { ...row, storage_path: "<restored-artifact>" };
      return row;
    }).map(canonical).sort();
    const before = normalize(expected.prepare(`SELECT * FROM ${quoted}`).all());
    const after = normalize(restored.prepare(`SELECT * FROM ${quoted}`).all());
    if (canonical(after) !== canonical(before)) throw Error(`Restored table differs from backup: ${table}`);
    rows += before.length;
  }

  const artifacts = restored.prepare(
    `SELECT id,project_id,sha256,size_bytes,storage_path,status FROM project_artifacts
     WHERE status IN (${[...backedStatuses].map(() => "?").join(",")}) ORDER BY project_id,id`,
  ).all(...backedStatuses);
  let artifactBytes = 0;
  for (const item of artifacts) {
    const path = resolve(item.storage_path);
    if (!path.startsWith(`${artifactRoot}${sep}`) || dirname(path) === artifactRoot ||
        !existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
      throw Error(`Restored Artifact path is missing or outside the drill root: ${item.id}`);
    const stat = statSync(path);
    if (stat.size !== item.size_bytes || hashFile(path) !== item.sha256)
      throw Error(`Restored Artifact verification failed: ${item.id}`);
    artifactBytes += stat.size;
  }
  let configurations = 0;
  if (manifestSchema === 3) {
    if (!Array.isArray(manifest.configuration)) throw Error("Backup configuration manifest is missing");
    for (const item of manifest.configuration) {
      if (item.name !== "data-sources" || item.file !== "config/data-sources.json")
        throw Error("Unsupported backup configuration entry");
      const restoredConfiguration = resolve(dirname(artifactRoot), "data-sources.json");
      if (!existsSync(restoredConfiguration) || lstatSync(restoredConfiguration).isSymbolicLink() ||
          !statSync(restoredConfiguration).isFile() || statSync(restoredConfiguration).size !== item.sizeBytes ||
          hashFile(restoredConfiguration) !== item.sha256)
        throw Error("Restored data-source configuration differs from backup");
      configurations += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tables: expectedTables.length,
    rows,
    artifacts: artifacts.length,
    artifactBytes,
    configurations,
    restoredSha256: hashFile(restoredPath),
  })}\n`);
} finally {
  expected.close();
  restored.close();
}
