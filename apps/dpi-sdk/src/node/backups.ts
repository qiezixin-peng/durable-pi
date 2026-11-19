import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export interface SqliteBackupInfo {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  artifactCount: number;
  artifactBytes: number;
  filesPath?: string;
}

export interface BackupConfigurationFile {
  name: "data-sources";
  path: string;
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Consistent SQLite online backups with bounded local retention. */
export class SqliteBackupManager {
  readonly directory: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly source: DatabaseSync,
    sourcePath: string,
    directory = join(dirname(sourcePath), "backups"),
    readonly keep = 14,
    private readonly configurationFiles: readonly BackupConfigurationFile[] = [],
  ) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw Error("Backup directory must not be a symbolic link");
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10_000) throw Error("Backup retention must be 1..10000");
  }

  private info(path: string): SqliteBackupInfo {
    const stat = statSync(path);
    const filesPath = `${path}.files`;
    let artifactCount = 0;
    let artifactBytes = 0;
    if (existsSync(join(filesPath, "manifest.json"))) {
      const manifest = JSON.parse(readFileSync(join(filesPath, "manifest.json"), "utf8")) as { artifacts?: Array<{ sizeBytes?: number }> };
      artifactCount = manifest.artifacts?.length ?? 0;
      artifactBytes = manifest.artifacts?.reduce((sum, item) => sum + Number(item.sizeBytes ?? 0), 0) ?? 0;
    }
    return {
      name: path.slice(this.directory.length + 1),
      path,
      bytes: stat.size,
      sha256: digest(path),
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      artifactCount,
      artifactBytes,
      ...(existsSync(filesPath) ? { filesPath } : {}),
    };
  }

  list() {
    return readdirSync(this.directory)
      .filter((name) => /^projects-[0-9TZ.-]+-[a-z0-9-]+\.sqlite$/.test(name))
      .map((name) => this.info(join(this.directory, name)))
      .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }

  async create(label = "manual") {
    const run = this.queue.then(() => this.createNow(label));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Wait until every backup already submitted to this manager has settled. */
  async flush() {
    await this.queue;
  }

  private async createNow(label: string) {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "manual";
    const stamp = new Date().toISOString().replace(/:/g, "-");
    const name = `projects-${stamp}-${safeLabel}-${randomUUID().slice(0, 8)}.sqlite`;
    const path = join(this.directory, name);
    try {
      await backup(this.source, path);
      chmodSync(path, 0o600);
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        const result = check.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (result?.quick_check !== "ok") throw Error(`Backup integrity check failed: ${result?.quick_check ?? "unknown"}`);
        const foreignKeyErrors = check.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyErrors.length)
          throw Error(`Backup foreign-key check failed with ${foreignKeyErrors.length} violation(s)`);
      } finally {
        check.close();
      }
      this.copyArtifacts(path);
      this.prune();
      return this.info(path);
    } catch (error) {
      if (existsSync(path)) unlinkSync(path);
      const filesPath = `${path}.files`;
      if (existsSync(filesPath) && !lstatSync(filesPath).isSymbolicLink()) rmSync(filesPath, { recursive: true, force: true });
      throw error;
    }
  }

  private copyArtifacts(backupPath: string) {
    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    let rows: Array<{ id: string; project_id: string; name: string; sha256: string; size_bytes: number; storage_path: string; status: "ACTIVE" | "EXPIRED" }> = [];
    try {
      const table = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_artifacts'").get();
      if (table)
        rows = snapshot.prepare("SELECT id,project_id,name,sha256,size_bytes,storage_path,status FROM project_artifacts WHERE status IN ('ACTIVE','EXPIRED') ORDER BY project_id,id").all() as typeof rows;
    } finally {
      snapshot.close();
    }
    const finalDirectory = `${backupPath}.files`;
    const temporary = `${finalDirectory}.tmp-${randomUUID()}`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      const artifacts = rows.map((row) => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.project_id) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(row.id))
          throw Error(`Artifact backup metadata contains an unsafe identity: ${row.id}`);
        const source = resolve(row.storage_path);
        if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !statSync(source).isFile())
          throw Error(`Artifact backup source is missing or unsafe: ${row.id}`);
        const stat = statSync(source);
        if (stat.size !== row.size_bytes || digest(source) !== row.sha256)
          throw Error(`Artifact backup source failed verification: ${row.id}`);
        const projectDirectory = resolve(temporary, row.project_id);
        if (dirname(projectDirectory) !== resolve(temporary)) throw Error(`Artifact backup path escaped: ${row.id}`);
        mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
        const file = `${row.id}.artifact`;
        const target = join(projectDirectory, file);
        copyFileSync(source, target);
        chmodSync(target, 0o600);
        if (digest(target) !== row.sha256) throw Error(`Artifact backup copy failed verification: ${row.id}`);
        return { id: row.id, projectId: row.project_id, name: row.name, status: row.status, file: `${row.project_id}/${file}`, storageFile: basename(source), sha256: row.sha256, sizeBytes: row.size_bytes };
      });
      const configuration = this.configurationFiles.map((item) => {
        if (item.name !== "data-sources") throw Error(`Unsupported backup configuration: ${item.name}`);
        const source = resolve(item.path);
        if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !statSync(source).isFile())
          throw Error(`Backup configuration is missing or unsafe: ${item.name}`);
        const content = readFileSync(source);
        const parsed = JSON.parse(content.toString("utf8")) as { version?: unknown; sources?: unknown };
        if (parsed.version !== 1 || !Array.isArray(parsed.sources))
          throw Error(`Backup configuration is invalid: ${item.name}`);
        const configDirectory = join(temporary, "config");
        mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
        const file = "config/data-sources.json";
        const target = join(temporary, file);
        copyFileSync(source, target);
        chmodSync(target, 0o600);
        return { name: item.name, file, sha256: digest(target), sizeBytes: content.byteLength };
      });
      writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify({ schemaVersion: 3, database: backupPath.slice(this.directory.length + 1), artifacts, configuration }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, finalDirectory);
    } catch (error) {
      if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) rmSync(temporary, { recursive: true, force: true });
      if (existsSync(backupPath)) unlinkSync(backupPath);
      throw error;
    }
  }

  prune() {
    const backups = this.list();
    for (const item of backups)
      for (const suffix of ["-shm", "-wal"]) {
        const sidecar = `${item.path}${suffix}`;
        if (existsSync(sidecar) && dirname(resolve(sidecar)) === this.directory && !lstatSync(sidecar).isSymbolicLink())
          unlinkSync(sidecar);
      }
    for (const item of backups.slice(this.keep)) {
      const target = resolve(item.path);
      if (dirname(target) !== this.directory || !existsSync(target) || lstatSync(target).isSymbolicLink())
        throw Error(`Unsafe backup cleanup target: ${target}`);
      unlinkSync(target);
      const files = `${target}.files`;
      if (existsSync(files)) {
        if (dirname(files) !== this.directory || lstatSync(files).isSymbolicLink()) throw Error(`Unsafe backup artifact cleanup target: ${files}`);
        rmSync(files, { recursive: true, force: true });
      }
    }
  }
}
