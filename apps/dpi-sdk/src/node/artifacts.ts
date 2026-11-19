import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectArtifact } from "../api.js";
import { dpiHome } from "./registry.js";

type ArtifactRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  name: string;
  kind: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  storage_path: string;
  status: "ACTIVE" | "EXPIRED";
  include_in_handoff: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const result = value.trim();
  if (result.length > max) throw Error(`${label} must be at most ${max} characters`);
  return result;
};

/** Project-scoped filesystem artifacts; SQLite stores metadata, never file bodies. */
export class ProjectArtifactStore {
  readonly db: DatabaseSync;
  readonly root: string;

  constructor(
    databasePath = join(dpiHome(), "projects.sqlite"),
    root = join(dpiHome(), "artifacts"),
    readonly maxBytes = 100 * 1024 * 1024,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw Error("Artifact root must not be a symbolic link");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error("Artifact maxBytes must be a positive integer");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_artifacts(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        include_in_handoff INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_artifacts_scope
        ON project_artifacts(project_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS project_artifacts_task ON project_artifacts(project_id,task_id);`);
  }

  private artifact(row: ArtifactRow): ProjectArtifact {
    return {
      id: row.id,
      projectId: row.project_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      name: row.name,
      kind: row.kind,
      mimeType: row.mime_type,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      status: row.status,
      includeInHandoff: Boolean(row.include_in_handoff),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private row(projectId: string, id: string) {
    return this.db
      .prepare("SELECT * FROM project_artifacts WHERE project_id=? AND id=?")
      .get(projectId, id) as ArtifactRow | undefined;
  }

  private projectDirectory(projectId: string) {
    const project = text(projectId, "Project id", 64);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project)) throw Error("Invalid project id");
    const directory = resolve(this.root, project);
    if (dirname(directory) !== this.root) throw Error("Artifact project directory escaped the root");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw Error("Artifact project directory must not be a symbolic link");
    return directory;
  }

  put(
    projectId: string,
    input: {
      id?: string;
      taskId?: string;
      name: string;
      kind?: string;
      mimeType?: string;
      content: string | Uint8Array;
      includeInHandoff?: boolean;
      expiresAt?: number;
    },
    now = Date.now(),
  ) {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
      throw Error(`Unknown project: ${projectId}`);
    const id = input.id ? text(input.id, "Artifact id", 160) : randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)) throw Error("Invalid artifact id");
    const name = basename(text(input.name, "Artifact name", 240));
    const kind = text(input.kind ?? "document", "Artifact kind", 80);
    const mimeType = text(input.mimeType ?? "application/octet-stream", "Artifact MIME type", 160);
    const taskId = input.taskId ? text(input.taskId, "Task id", 160) : null;
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now))
      throw Error("Artifact expiresAt must be a future integer timestamp");
    const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    if (bytes.byteLength > this.maxBytes) throw Error(`Artifact exceeds ${this.maxBytes} bytes`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = this.projectDirectory(projectId);
    const storagePath = join(directory, `${id}-${sha256.slice(0, 16)}.artifact`);
    const temporary = `${storagePath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, storagePath);
    chmodSync(storagePath, 0o600);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(
          `INSERT INTO project_artifacts(
             id,project_id,task_id,name,kind,mime_type,sha256,size_bytes,storage_path,status,
             include_in_handoff,expires_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
        )
        .run(
          id,
          projectId,
          taskId,
          name,
          kind,
          mimeType,
          sha256,
          bytes.byteLength,
          storagePath,
          input.includeInHandoff ? 1 : 0,
          input.expiresAt ?? null,
          now,
          now,
        );
      this.db
        .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "artifact.published", JSON.stringify({ artifactId: id, taskId, name, kind, sha256, sizeBytes: bytes.byteLength }), now);
      this.db.exec("COMMIT");
      return this.artifact(this.row(projectId, id)!);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may have failed before it began.
      }
      try {
        if (existsSync(storagePath)) {
          const target = resolve(storagePath);
          if (dirname(target) === directory && !lstatSync(target).isSymbolicLink())
            // A failed metadata transaction must not leave an unreferenced file.
            unlinkSync(target);
        }
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  async putStream(
    projectId: string,
    input: {
      id?: string;
      taskId?: string;
      name: string;
      kind?: string;
      mimeType?: string;
      includeInHandoff?: boolean;
      expiresAt?: number;
    },
    source: AsyncIterable<Uint8Array>,
    now = Date.now(),
  ) {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const id = input.id ? text(input.id, "Artifact id", 160) : randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)) throw Error("Invalid artifact id");
    const name = basename(text(input.name, "Artifact name", 240));
    const kind = text(input.kind ?? "binary", "Artifact kind", 80);
    const mimeType = text(input.mimeType ?? "application/octet-stream", "Artifact MIME type", 160);
    const taskId = input.taskId ? text(input.taskId, "Task id", 160) : null;
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now))
      throw Error("Artifact expiresAt must be a future integer timestamp");
    const directory = this.projectDirectory(projectId);
    const temporary = join(directory, `.upload-${id}-${randomUUID()}`);
    let handle: number | undefined;
    let storagePath: string | undefined;
    let sizeBytes = 0;
    const hash = createHash("sha256");
    try {
      handle = openSync(temporary, "wx", 0o600);
      for await (const value of source) {
        const chunk = Buffer.from(value);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.maxBytes) throw Error(`Artifact exceeds ${this.maxBytes} bytes`);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += writeSync(handle, chunk, offset);
      }
      closeSync(handle);
      handle = undefined;
      const sha256 = hash.digest("hex");
      storagePath = join(directory, `${id}-${sha256.slice(0, 16)}.artifact`);
      renameSync(temporary, storagePath);
      chmodSync(storagePath, 0o600);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(
          `INSERT INTO project_artifacts(
             id,project_id,task_id,name,kind,mime_type,sha256,size_bytes,storage_path,status,
             include_in_handoff,expires_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
        ).run(id, projectId, taskId, name, kind, mimeType, sha256, sizeBytes, storagePath, input.includeInHandoff ? 1 : 0, input.expiresAt ?? null, now, now);
        this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(projectId, "artifact.published", JSON.stringify({ artifactId: id, taskId, name, kind, sha256, sizeBytes, streamed: true }), now);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return this.artifact(this.row(projectId, id)!);
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      for (const candidate of [temporary, storagePath])
        if (candidate && existsSync(candidate) && dirname(resolve(candidate)) === directory && !lstatSync(candidate).isSymbolicLink()) unlinkSync(candidate);
      throw error;
    }
  }

  list(projectId: string, status: "ACTIVE" | "EXPIRED" | "ALL" = "ACTIVE", limit?: number) {
    const bounded = limit === undefined ? undefined : Math.max(1, Math.min(1_000, limit));
    const rows = (
      status === "ALL"
        ? bounded === undefined
          ? this.db.prepare("SELECT * FROM project_artifacts WHERE project_id=? ORDER BY created_at DESC,id").all(projectId)
          : this.db.prepare("SELECT * FROM project_artifacts WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?").all(projectId, bounded)
        : this.db
            .prepare(`SELECT * FROM project_artifacts WHERE project_id=? AND status=? ORDER BY created_at DESC,id${bounded === undefined ? "" : " LIMIT ?"}`)
            .all(...(bounded === undefined ? [projectId, status] : [projectId, status, bounded]))
    ) as ArtifactRow[];
    return rows.map((row) => this.artifact(row));
  }

  count(projectId: string, status: "ACTIVE" | "EXPIRED" | "ALL" = "ACTIVE") {
    const row = (status === "ALL"
      ? this.db.prepare("SELECT COUNT(*) AS count FROM project_artifacts WHERE project_id=?").get(projectId)
      : this.db.prepare("SELECT COUNT(*) AS count FROM project_artifacts WHERE project_id=? AND status=?").get(projectId, status)
    ) as { count: number };
    return row.count;
  }

  get(projectId: string, id: string) {
    const row = this.row(projectId, id);
    return row ? this.artifact(row) : undefined;
  }

  read(projectId: string, id: string) {
    const row = this.row(projectId, id);
    if (!row || row.status !== "ACTIVE") throw Error(`Active artifact not found: ${id}`);
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.expire(projectId, id);
      throw Error(`Active artifact not found: ${id}`);
    }
    const directory = this.projectDirectory(projectId);
    const target = resolve(row.storage_path);
    if (dirname(target) !== directory || !existsSync(target) || lstatSync(target).isSymbolicLink())
      throw Error("Artifact storage path is invalid");
    const stat = statSync(target);
    if (stat.size !== row.size_bytes) throw Error("Artifact size does not match metadata");
    const content = readFileSync(target);
    if (createHash("sha256").update(content).digest("hex") !== row.sha256)
      throw Error("Artifact checksum does not match metadata");
    return { artifact: this.artifact(row), content };
  }

  expire(projectId: string, id: string, now = Date.now()) {
    const row = this.row(projectId, id);
    if (!row) throw Error(`Unknown artifact: ${id}`);
    if (row.status === "EXPIRED") return this.artifact(row);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE project_artifacts SET status='EXPIRED',updated_at=? WHERE id=?").run(now, id);
      this.db
        .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "artifact.expired", JSON.stringify({ artifactId: id, sha256: row.sha256 }), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.artifact(this.row(projectId, id)!);
  }

  /** Marks due artifacts expired without deleting their files. Purging remains a separate retention action. */
  expireDue(now = Date.now(), limit = 1_000) {
    if (!Number.isSafeInteger(now) || now < 0) throw Error("now must be a non-negative integer timestamp");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw Error("limit must be an integer from 1 to 10000");
    const rows = this.db.prepare(
      `SELECT * FROM project_artifacts
       WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?
       ORDER BY expires_at,id LIMIT ?`,
    ).all(now, limit) as ArtifactRow[];
    if (!rows.length) return { expired: 0, remaining: 0 };
    let expired = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const changed = this.db.prepare(
          "UPDATE project_artifacts SET status='EXPIRED',updated_at=? WHERE id=? AND project_id=? AND status='ACTIVE'",
        ).run(now, row.id, row.project_id).changes;
        if (!changed) continue;
        this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(row.project_id, "artifact.expired", JSON.stringify({ artifactId: row.id, sha256: row.sha256, automatic: true }), now);
        expired += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const remaining = Number((this.db.prepare(
      "SELECT COUNT(*) AS count FROM project_artifacts WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?",
    ).get(now) as { count: number }).count);
    return { expired, remaining };
  }

  purgeExpired(updatedBefore: number, limit = 1_000, now = Date.now()) {
    if (!Number.isSafeInteger(updatedBefore) || updatedBefore < 0 || updatedBefore > now)
      throw Error("updatedBefore must be a timestamp no later than now");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw Error("limit must be an integer from 1 to 10000");
    const rows = this.db
      .prepare("SELECT * FROM project_artifacts WHERE status='EXPIRED' AND updated_at<=? ORDER BY updated_at,id LIMIT ?")
      .all(updatedBefore, limit) as ArtifactRow[];
    const staged: Array<{ row: ArtifactRow; original: string; tombstone?: string }> = [];
    let bytes = 0;
    let missing = 0;
    try {
      for (const row of rows) {
        const directory = resolve(this.root, row.project_id);
        if (dirname(directory) !== this.root || (existsSync(directory) && lstatSync(directory).isSymbolicLink()))
          throw Error(`Expired Artifact project path is unsafe: ${row.id}`);
        const original = resolve(row.storage_path);
        if (dirname(original) !== directory) throw Error(`Expired Artifact escaped its project directory: ${row.id}`);
        if (!existsSync(original)) {
          missing += 1;
          staged.push({ row, original });
          continue;
        }
        if (lstatSync(original).isSymbolicLink() || !statSync(original).isFile()) throw Error(`Expired Artifact path is unsafe: ${row.id}`);
        const content = readFileSync(original);
        if (content.byteLength !== row.size_bytes || createHash("sha256").update(content).digest("hex") !== row.sha256)
          throw Error(`Expired Artifact failed verification: ${row.id}`);
        const tombstone = `${original}.purge-${randomUUID()}`;
        renameSync(original, tombstone);
        bytes += content.byteLength;
        staged.push({ row, original, tombstone });
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of staged) {
          this.db.prepare("DELETE FROM project_artifacts WHERE id=? AND project_id=? AND status='EXPIRED'").run(item.row.id, item.row.project_id);
          this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
            .run(item.row.project_id, "artifact.purged", JSON.stringify({ artifactId: item.row.id, sha256: item.row.sha256, sizeBytes: item.row.size_bytes, missing: !item.tombstone }), now);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      for (const item of staged.reverse())
        if (item.tombstone && existsSync(item.tombstone) && !existsSync(item.original)) renameSync(item.tombstone, item.original);
      throw error;
    }
    let orphanedTombstones = 0;
    for (const item of staged) {
      if (!item.tombstone) continue;
      try { unlinkSync(item.tombstone); } catch { orphanedTombstones += 1; }
    }
    return { purged: staged.length, bytes, missing, orphanedTombstones };
  }

  purgeProject(projectId: string) {
    const directory = this.projectDirectory(projectId);
    const rows = this.db
      .prepare("SELECT * FROM project_artifacts WHERE project_id=?")
      .all(projectId) as ArtifactRow[];
    for (const row of rows) {
      const target = resolve(row.storage_path);
      if (dirname(target) !== directory) throw Error(`Artifact escaped its project directory: ${row.id}`);
      if (existsSync(target)) {
        if (lstatSync(target).isSymbolicLink()) throw Error(`Artifact is a symbolic link: ${row.id}`);
        unlinkSync(target);
      }
    }
    this.db.prepare("DELETE FROM project_artifacts WHERE project_id=?").run(projectId);
    if (existsSync(directory)) rmdirSync(directory);
    return rows.length;
  }

  close() {
    this.db.close();
  }
}
