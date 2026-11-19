import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectMemory, ProjectMemoryRevision, ProjectMemoryStatus } from "../api.js";
import { dpiHome } from "./registry.js";

type MemoryRow = {
  id: string;
  project_id: string;
  key: string;
  value_json: string;
  source_type: string;
  source_id: string | null;
  scope_member_id: string | null;
  status: ProjectMemoryStatus;
  expires_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type RevisionRow = MemoryRow & { revision_id: number };

type MemoryWriteInput = {
  key: string;
  value: unknown;
  sourceType: string;
  sourceId?: string;
  expectedVersion?: number;
  memberId?: string;
  requestId?: string;
  expiresAt?: number;
};

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/;
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const clean = value.trim();
  if (clean.length > max) throw Error(`${label} must be at most ${max} characters`);
  return clean;
};

/** Versioned project facts. Pi transcripts remain in Pi Session storage. */
export class ProjectMemoryStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = join(dpiHome(), "projects.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_memories(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        scope_member_id TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,key));
      CREATE INDEX IF NOT EXISTS project_memories_scope
        ON project_memories(project_id,status,key);
      CREATE TABLE IF NOT EXISTS project_memory_revisions(
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        scope_member_id TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(id,version));
      CREATE TABLE IF NOT EXISTS project_memory_writes(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,request_id));`);
    const memoryColumns = this.db.prepare("PRAGMA table_info(project_memories)").all() as { name: string }[];
    if (!memoryColumns.some((column) => column.name === "scope_member_id"))
      this.db.exec("ALTER TABLE project_memories ADD COLUMN scope_member_id TEXT");
    if (!memoryColumns.some((column) => column.name === "expires_at"))
      this.db.exec("ALTER TABLE project_memories ADD COLUMN expires_at INTEGER");
    const revisionColumns = this.db.prepare("PRAGMA table_info(project_memory_revisions)").all() as { name: string }[];
    if (!revisionColumns.some((column) => column.name === "scope_member_id"))
      this.db.exec("ALTER TABLE project_memory_revisions ADD COLUMN scope_member_id TEXT");
    if (!revisionColumns.some((column) => column.name === "expires_at"))
      this.db.exec("ALTER TABLE project_memory_revisions ADD COLUMN expires_at INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS project_memories_member_scope ON project_memories(project_id,scope_member_id,status,key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS project_memories_expiry ON project_memories(status,expires_at) WHERE expires_at IS NOT NULL");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private memory(row: MemoryRow): ProjectMemory {
    return {
      id: row.id,
      projectId: row.project_id,
      key: row.scope_member_id ? row.key.slice(`private/${row.scope_member_id}/`.length) : row.key,
      value: JSON.parse(row.value_json) as unknown,
      sourceType: row.source_type,
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      ...(row.scope_member_id ? { memberId: row.scope_member_id } : {}),
      status: row.status,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private row(id: string): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM project_memories WHERE id=?").get(id) as MemoryRow | undefined;
  }

  private event(projectId: string, kind: string, detail: unknown, now: number) {
    this.db
      .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, kind, JSON.stringify(detail), now);
  }

  private revision(row: MemoryRow) {
    this.db
      .prepare(
        `INSERT INTO project_memory_revisions(
           id,project_id,key,value_json,source_type,source_id,scope_member_id,status,expires_at,version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.key,
        row.value_json,
        row.source_type,
        row.source_id,
        row.scope_member_id,
        row.status,
        row.expires_at,
        row.version,
        row.created_at,
        row.updated_at,
      );
  }

  get(projectId: string, id: string): ProjectMemory | undefined {
    let row = this.row(id);
    if (row?.project_id === projectId && row.status === "ACTIVE" && row.expires_at !== null && row.expires_at <= Date.now()) {
      this.expireDue(Date.now(), 1_000, projectId);
      row = this.row(id);
    }
    return row?.project_id === projectId ? this.memory(row) : undefined;
  }

  list(projectId: string, status: ProjectMemoryStatus | "ALL" = "ACTIVE"): ProjectMemory[] {
    this.expireDue(Date.now(), 10_000, projectId);
    const rows = (
      status === "ALL"
        ? this.db.prepare("SELECT * FROM project_memories WHERE project_id=? AND scope_member_id IS NULL ORDER BY key").all(projectId)
        : this.db
            .prepare("SELECT * FROM project_memories WHERE project_id=? AND scope_member_id IS NULL AND status=? ORDER BY key")
            .all(projectId, status)
    ) as MemoryRow[];
    return rows.map((row) => this.memory(row));
  }

  visible(projectId: string, memberId: string, status: ProjectMemoryStatus = "ACTIVE", limit?: number) {
    this.expireDue(Date.now(), 10_000, projectId);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000))
      throw Error("Memory limit must be an integer from 1 to 10000");
    const suffix = limit === undefined ? "" : " LIMIT ?";
    return (this.db
      .prepare(`SELECT * FROM project_memories WHERE project_id=? AND status=? AND key NOT LIKE 'system.%' AND (scope_member_id IS NULL OR scope_member_id=?) ORDER BY scope_member_id,key${suffix}`)
      .all(...(limit === undefined ? [projectId, status, memberId] : [projectId, status, memberId, limit])) as MemoryRow[])
      .map((row) => this.memory(row));
  }

  visibleCount(projectId: string, memberId: string, status: ProjectMemoryStatus = "ACTIVE") {
    this.expireDue(Date.now(), 10_000, projectId);
    return Number((this.db.prepare(
      "SELECT COUNT(*) AS count FROM project_memories WHERE project_id=? AND status=? AND key NOT LIKE 'system.%' AND (scope_member_id IS NULL OR scope_member_id=?)",
    ).get(projectId, status, memberId) as { count: number }).count);
  }

  put(projectId: string, input: MemoryWriteInput, now = Date.now()): ProjectMemory {
    if (typeof input.key === "string" && input.key.trim().toLowerCase().startsWith("system."))
      throw Error("The system.* project memory namespace is reserved for the platform");
    return this.write(projectId, input, now);
  }

  putSystem(projectId: string, input: MemoryWriteInput, now = Date.now()): ProjectMemory {
    if (typeof input.key !== "string" || !input.key.trim().toLowerCase().startsWith("system."))
      throw Error("Platform system memory must use the system.* namespace");
    if (input.memberId !== undefined) throw Error("Platform system memory cannot be Agent-private");
    return this.write(projectId, input, now);
  }

  private write(projectId: string, input: MemoryWriteInput, now: number): ProjectMemory {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
      throw Error(`Unknown project: ${projectId}`);
    if (
      input.expectedVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    )
      throw Error("expectedVersion must be a positive integer");
    const publicKey = text(input.key, "Memory key", 160);
    if (!KEY.test(publicKey)) throw Error(`Memory key must match ${KEY}`);
    const memberId = input.memberId === undefined ? null : text(input.memberId, "Member id", 64);
    if (memberId && !this.db.prepare("SELECT id FROM project_members WHERE project_id=? AND id=? AND lifecycle_state!='ARCHIVED'").get(projectId, memberId))
      throw Error(`Active project member not found: ${memberId}`);
    const key = memberId ? `private/${memberId}/${publicKey}` : publicKey;
    const sourceType = text(input.sourceType, "sourceType", 80);
    const sourceId = input.sourceId === undefined ? null : text(input.sourceId, "sourceId", 240);
    const requestId = input.requestId === undefined ? null : text(input.requestId, "requestId", 240);
    const expiresAt = input.expiresAt === undefined ? null : input.expiresAt;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))
      throw Error("Memory expiresAt must be a future integer timestamp");
    let valueJson: string;
    try {
      valueJson = JSON.stringify(input.value ?? null);
    } catch {
      throw Error("Memory value must be JSON serializable");
    }
    const requestSha256 = createHash("sha256")
      .update(
        JSON.stringify({
          key,
          valueJson,
          sourceType,
          sourceId,
          memberId,
          expiresAt,
          expectedVersion: input.expectedVersion ?? null,
        }),
      )
      .digest("hex");
    return this.transaction(() => {
      if (requestId) {
        const prior = this.db
          .prepare("SELECT request_sha256,memory_id FROM project_memory_writes WHERE project_id=? AND request_id=?")
          .get(projectId, requestId) as { request_sha256: string; memory_id: string } | undefined;
        if (prior) {
          if (prior.request_sha256 !== requestSha256)
            throw Error(`Memory request id was reused with different input: ${requestId}`);
          const replay = this.row(prior.memory_id);
          if (!replay || replay.project_id !== projectId) throw Error("Memory request points to missing state");
          return this.memory(replay);
        }
      }
      const current = this.db
        .prepare("SELECT * FROM project_memories WHERE project_id=? AND key=?")
        .get(projectId, key) as MemoryRow | undefined;
      if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion)
        throw Error(`Memory version conflict: expected ${input.expectedVersion}, current ${current?.version ?? 0}`);
      if (current) {
        this.db
          .prepare(
            `UPDATE project_memories SET value_json=?,source_type=?,source_id=?,status='ACTIVE',expires_at=?,
             version=version+1,updated_at=? WHERE id=?`,
          )
          .run(valueJson, sourceType, sourceId, expiresAt, now, current.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO project_memories(
               id,project_id,key,value_json,source_type,source_id,scope_member_id,status,expires_at,version,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,'ACTIVE',?,1,?,?)`,
          )
          .run(randomUUID(), projectId, key, valueJson, sourceType, sourceId, memberId, expiresAt, now, now);
      }
      const row = this.db
        .prepare("SELECT * FROM project_memories WHERE project_id=? AND key=?")
        .get(projectId, key) as MemoryRow;
      this.revision(row);
      this.event(projectId, current ? "memory.updated" : "memory.created", { memoryId: row.id, key: publicKey, memberId, version: row.version }, now);
      if (requestId)
        this.db
          .prepare("INSERT INTO project_memory_writes(project_id,request_id,request_sha256,memory_id,created_at) VALUES(?,?,?,?,?)")
          .run(projectId, requestId, requestSha256, row.id, now);
      return this.memory(row);
    });
  }

  expire(
    projectId: string,
    id: string,
    expectedVersion?: number,
    now = Date.now(),
    detail: { requestedBy?: string; reason?: string } = {},
  ) {
    return this.expireInternal(projectId, id, expectedVersion, now, detail, false);
  }

  expireSystem(
    projectId: string,
    id: string,
    expectedVersion?: number,
    now = Date.now(),
    detail: { requestedBy?: string; reason?: string } = {},
  ) {
    return this.expireInternal(projectId, id, expectedVersion, now, detail, true);
  }

  private expireInternal(
    projectId: string,
    id: string,
    expectedVersion: number | undefined,
    now: number,
    detail: { requestedBy?: string; reason?: string },
    allowSystem: boolean,
  ) {
    const requestedBy = detail.requestedBy === undefined ? undefined : text(detail.requestedBy, "requestedBy", 128);
    const reason = detail.reason === undefined ? undefined : text(detail.reason, "reason", 1_000);
    return this.transaction(() => {
      const row = this.row(id);
      if (!row || row.project_id !== projectId) throw Error(`Unknown memory: ${id}`);
      if (!allowSystem && row.key.toLowerCase().startsWith("system."))
        throw Error("Platform system memory cannot be expired through the ordinary memory API");
      if (expectedVersion !== undefined && row.version !== expectedVersion)
        throw Error(`Memory version conflict: expected ${expectedVersion}, current ${row.version}`);
      if (row.status === "EXPIRED") return this.memory(row);
      this.db
        .prepare(
          "UPDATE project_memories SET status='EXPIRED',version=version+1,updated_at=? WHERE id=?",
        )
        .run(now, id);
      const expired = this.row(id)!;
      this.revision(expired);
      this.event(projectId, "memory.expired", {
        memoryId: id, key: this.memory(expired).key, memberId: expired.scope_member_id,
        version: expired.version, requestedBy, reason,
      }, now);
      return this.memory(expired);
    });
  }

  /** Expire due facts transactionally while retaining their full revision history. */
  expireDue(now = Date.now(), limit = 1_000, projectId?: string) {
    if (!Number.isSafeInteger(now) || now < 0) throw Error("now must be a non-negative integer timestamp");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw Error("limit must be an integer from 1 to 10000");
    const rows = (projectId
      ? this.db.prepare(
          "SELECT * FROM project_memories WHERE project_id=? AND status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,id LIMIT ?",
        ).all(projectId, now, limit)
      : this.db.prepare(
          "SELECT * FROM project_memories WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,id LIMIT ?",
        ).all(now, limit)) as MemoryRow[];
    if (!rows.length) return { expired: 0, remaining: 0 };
    let expired = 0;
    this.transaction(() => {
      for (const row of rows) {
        const changed = this.db.prepare(
          "UPDATE project_memories SET status='EXPIRED',version=version+1,updated_at=? WHERE id=? AND status='ACTIVE'",
        ).run(now, row.id).changes;
        if (!changed) continue;
        const current = this.row(row.id)!;
        this.revision(current);
        this.event(row.project_id, "memory.expired", {
          memoryId: row.id,
          key: this.memory(current).key,
          memberId: row.scope_member_id,
          version: current.version,
          automatic: true,
        }, now);
        expired += 1;
      }
    });
    const remainingRow = (projectId
      ? this.db.prepare(
          "SELECT COUNT(*) AS count FROM project_memories WHERE project_id=? AND status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?",
        ).get(projectId, now)
      : this.db.prepare(
          "SELECT COUNT(*) AS count FROM project_memories WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<=?",
        ).get(now)) as { count: number } | undefined;
    const remaining = Number(remainingRow?.count ?? 0);
    return { expired, remaining };
  }

  history(projectId: string, id: string): ProjectMemoryRevision[] {
    if (!this.get(projectId, id)) throw Error(`Unknown memory: ${id}`);
    return (
      this.db
        .prepare("SELECT * FROM project_memory_revisions WHERE project_id=? AND id=? ORDER BY version")
        .all(projectId, id) as RevisionRow[]
    ).map((row) => ({ ...this.memory(row), revisionId: row.revision_id }));
  }

  close() {
    this.db.close();
  }
}
