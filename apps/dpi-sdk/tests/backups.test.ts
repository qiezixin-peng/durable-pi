import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteBackupManager } from "../src/node/backups.js";

test("SQLite backups are consistent, checksummed and retention-bounded", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-backup-"));
  const sourcePath = join(root, "projects.sqlite");
  const source = new DatabaseSync(sourcePath);
  try {
    const artifactPath = join(root, "source.artifact");
    const artifactContent = Buffer.from("artifact evidence");
    await writeFile(artifactPath, artifactContent);
    const artifactSha = createHash("sha256").update(artifactContent).digest("hex");
    const expiredArtifactPath = join(root, "expired.artifact");
    const expiredArtifactContent = Buffer.from("retained expired evidence");
    await writeFile(expiredArtifactPath, expiredArtifactContent);
    const expiredArtifactSha = createHash("sha256").update(expiredArtifactContent).digest("hex");
    const dataSourcesPath = join(root, "data-sources.json");
    const dataSources = { version: 1, sources: [{ id: "linux-home", verifiedModels: ["gpt-5.6-sol"] }] };
    await writeFile(dataSourcesPath, `${JSON.stringify(dataSources)}\n`);
    source.exec(`CREATE TABLE facts(value TEXT NOT NULL); INSERT INTO facts VALUES('durable');
      CREATE TABLE project_artifacts(id TEXT,project_id TEXT,name TEXT,sha256 TEXT,size_bytes INTEGER,storage_path TEXT,status TEXT);`);
    source.prepare("INSERT INTO project_artifacts VALUES(?,?,?,?,?,?,'ACTIVE')")
      .run("artifact-1", "alpha", "report.txt", artifactSha, artifactContent.byteLength, artifactPath);
    source.prepare("INSERT INTO project_artifacts VALUES(?,?,?,?,?,?,'EXPIRED')")
      .run("artifact-expired", "alpha", "old-report.txt", expiredArtifactSha, expiredArtifactContent.byteLength, expiredArtifactPath);
    const manager = new SqliteBackupManager(source, sourcePath, join(root, "backups"), 2, [
      { name: "data-sources", path: dataSourcesPath },
    ]);
    await manager.create("one");
    const second = manager.create("two");
    const third = manager.create("three");
    await manager.flush();
    await second;
    const newest = await third;
    assert.equal(manager.list().length, 2);
    assert.match(newest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(newest.artifactCount, 2);
    assert.equal(newest.artifactBytes, artifactContent.byteLength + expiredArtifactContent.byteLength);
    assert.ok(newest.filesPath);
    assert.equal(await readFile(join(newest.filesPath, "alpha", "artifact-1.artifact"), "utf8"), "artifact evidence");
    assert.equal(await readFile(join(newest.filesPath, "alpha", "artifact-expired.artifact"), "utf8"), "retained expired evidence");
    const manifest = JSON.parse(await readFile(join(newest.filesPath, "manifest.json"), "utf8")) as {
      schemaVersion: number;
      configuration: Array<{ name: string; file: string }>;
    };
    assert.equal(manifest.schemaVersion, 3);
    assert.deepEqual(manifest.configuration.map((item) => [item.name, item.file]), [["data-sources", "config/data-sources.json"]]);
    const restoredDpi = join(root, "restored-dpi");
    const restoredDatabase = join(restoredDpi, "projects.sqlite");
    const restoredSafety = join(restoredDpi, "backups", "artifacts-before-restore-test");
    await mkdir(join(restoredDpi, "backups"), { recursive: true });
    await writeFile(join(restoredDpi, "data-sources.json"), '{"version":1,"sources":[],"previous":true}\n');
    await copyFile(newest.path, restoredDatabase);
    const helper = join(import.meta.dirname, "..", "..", "..", "windows", "restore-backup-artifacts.mjs");
    const drillVerifier = join(import.meta.dirname, "..", "..", "..", "windows", "verify-backup-drill.mjs");
    const restore = spawnSync(process.execPath, [helper, restoredDatabase, newest.filesPath, restoredDpi, restoredSafety], { encoding: "utf8" });
    assert.equal(restore.status, 0, restore.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(restoredDpi, "data-sources.json"), "utf8")), dataSources);
    const restoreResult = JSON.parse(restore.stdout) as { configurationSafetyPath: string };
    assert.equal(await readFile(restoreResult.configurationSafetyPath, "utf8"), '{"version":1,"sources":[],"previous":true}\n');
    const restoredMetadata = new DatabaseSync(restoredDatabase, { readOnly: true });
    try {
      const row = restoredMetadata.prepare("SELECT storage_path FROM project_artifacts WHERE id='artifact-1'").get() as { storage_path: string };
      assert.equal(await readFile(row.storage_path, "utf8"), "artifact evidence");
      assert.equal(row.storage_path.startsWith(join(restoredDpi, "artifacts")), true);
      const expired = restoredMetadata.prepare("SELECT storage_path,status FROM project_artifacts WHERE id='artifact-expired'").get() as { storage_path: string; status: string };
      assert.equal(expired.status, "EXPIRED");
      assert.equal(await readFile(expired.storage_path, "utf8"), "retained expired evidence");
      assert.equal(expired.storage_path.startsWith(join(restoredDpi, "artifacts")), true);
    } finally {
      restoredMetadata.close();
    }
    const verifiedDrill = spawnSync(
      process.execPath,
      [drillVerifier, newest.path, restoredDatabase, join(restoredDpi, "artifacts")],
      { encoding: "utf8" },
    );
    assert.equal(verifiedDrill.status, 0, verifiedDrill.stderr);
    assert.equal(JSON.parse(verifiedDrill.stdout).ok, true);

    const legacyDatabase = join(root, "legacy-v1.sqlite");
    const legacyBundle = join(root, "legacy-v1.sqlite.files");
    const legacyDpi = join(root, "legacy-dpi");
    await copyFile(newest.path, legacyDatabase);
    await cp(newest.filesPath, legacyBundle, { recursive: true });
    const legacyManifestPath = join(legacyBundle, "manifest.json");
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8")) as {
      schemaVersion: number;
      artifacts: Array<{ id: string }>;
    };
    legacyManifest.schemaVersion = 1;
    legacyManifest.artifacts = legacyManifest.artifacts.filter((item) => item.id === "artifact-1");
    await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    await rm(join(legacyBundle, "alpha", "artifact-expired.artifact"));
    await mkdir(join(legacyDpi, "backups"), { recursive: true });
    const legacyRestore = spawnSync(
      process.execPath,
      [helper, legacyDatabase, legacyBundle, legacyDpi, join(legacyDpi, "backups", "artifacts-before-restore-test")],
      { encoding: "utf8" },
    );
    assert.equal(legacyRestore.status, 0, legacyRestore.stderr);
    assert.equal(JSON.parse(legacyRestore.stdout).restored, 1, "schema-v1 backups remain ACTIVE-only compatible");

    const logicallyTampered = join(restoredDpi, "tampered.sqlite");
    await copyFile(restoredDatabase, logicallyTampered);
    const tamperedDatabase = new DatabaseSync(logicallyTampered);
    tamperedDatabase.prepare("UPDATE facts SET value='changed after restore'").run();
    tamperedDatabase.close();
    const rejectedLogicalDrill = spawnSync(
      process.execPath,
      [drillVerifier, newest.path, logicallyTampered, join(restoredDpi, "artifacts")],
      { encoding: "utf8" },
    );
    assert.notEqual(rejectedLogicalDrill.status, 0);
    assert.match(rejectedLogicalDrill.stderr, /Restored table differs/);
    const corruptBundle = join(root, "corrupt-bundle");
    await cp(newest.filesPath, corruptBundle, { recursive: true });
    await writeFile(join(corruptBundle, "alpha", "artifact-1.artifact"), "tampered backup");
    const protectedDpi = join(root, "protected-dpi");
    const protectedDatabase = join(protectedDpi, "projects.sqlite");
    const protectedArtifacts = join(protectedDpi, "artifacts");
    await mkdir(join(protectedDpi, "backups"), { recursive: true });
    await mkdir(protectedArtifacts, { recursive: true });
    await writeFile(join(protectedArtifacts, "keep.txt"), "keep existing artifacts");
    await copyFile(newest.path, protectedDatabase);
    const rejected = spawnSync(
      process.execPath,
      [helper, protectedDatabase, corruptBundle, protectedDpi, join(protectedDpi, "backups", "artifacts-before-restore-test")],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /failed verification/);
    assert.equal(await readFile(join(protectedArtifacts, "keep.txt"), "utf8"), "keep existing artifacts");
    const protectedConfiguration = join(protectedDpi, "data-sources.json");
    await writeFile(protectedConfiguration, '{"version":1,"sources":[]}\n');
    const corruptConfigurationBundle = join(root, "corrupt-configuration-bundle");
    await cp(newest.filesPath, corruptConfigurationBundle, { recursive: true });
    await writeFile(join(corruptConfigurationBundle, "config", "data-sources.json"), "tampered configuration");
    const rejectedConfiguration = spawnSync(
      process.execPath,
      [helper, protectedDatabase, corruptConfigurationBundle, protectedDpi, join(protectedDpi, "backups", "artifacts-before-config-restore-test")],
      { encoding: "utf8" },
    );
    assert.notEqual(rejectedConfiguration.status, 0);
    assert.match(rejectedConfiguration.stderr, /configuration failed verification/);
    assert.equal(await readFile(protectedConfiguration, "utf8"), '{"version":1,"sources":[]}\n');
    assert.equal(await readFile(join(protectedArtifacts, "keep.txt"), "utf8"), "keep existing artifacts");
    const restored = new DatabaseSync(newest.path, { readOnly: true });
    try {
      assert.equal((restored.prepare("SELECT value FROM facts").get() as { value: string }).value, "durable");
    } finally {
      restored.close();
    }
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite backups reject a structurally valid snapshot with broken foreign keys", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-backup-fk-"));
  const sourcePath = join(root, "projects.sqlite");
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE parents(id TEXT PRIMARY KEY);
      CREATE TABLE children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parents(id));
      INSERT INTO children VALUES('orphan','missing');`);
    const manager = new SqliteBackupManager(source, sourcePath, join(root, "backups"));
    await assert.rejects(() => manager.create("foreign-key-violation"), /foreign-key check failed/);
    assert.equal(manager.list().length, 0, "a rejected backup must not remain in retention");
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});
