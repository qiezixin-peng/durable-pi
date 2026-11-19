import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectApproval, ProjectApprovalStatus } from "../api.js";
import { dpiHome } from "./registry.js";

type ApprovalRow = {
  id: string;
  project_id: string;
  operation_json: string;
  operation_hash: string;
  requested_by: string;
  status: ProjectApprovalStatus;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  consumed_by: string | null;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
};

const identity = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  if (value.trim().length > 240) throw Error(`${label} must be at most 240 characters`);
  return value.trim();
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
};

export const approvalOperation = (operation: unknown) => {
  let value: string;
  try {
    value = JSON.stringify(canonical(operation ?? null));
  } catch {
    throw Error("Approval operation must be JSON serializable");
  }
  if (value.length > 65_536) throw Error("Approval operation must be at most 65536 bytes");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
};

/** One-use, parameter-bound project approvals. */
export class ProjectApprovalStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = join(dpiHome(), "projects.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_approvals(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        operation_json TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        consumed_by TEXT,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_approvals_scope
        ON project_approvals(project_id,status,expires_at,created_at DESC);`);
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

  private approval(row: ApprovalRow): ProjectApproval {
    return {
      id: row.id,
      projectId: row.project_id,
      operation: JSON.parse(row.operation_json) as unknown,
      operationHash: row.operation_hash,
      requestedBy: row.requested_by,
      status: row.status,
      expiresAt: row.expires_at,
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
      ...(row.consumed_by ? { consumedBy: row.consumed_by } : {}),
      ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private row(projectId: string, id: string) {
    return this.db
      .prepare("SELECT * FROM project_approvals WHERE project_id=? AND id=?")
      .get(projectId, id) as ApprovalRow | undefined;
  }

  private event(projectId: string, kind: string, detail: unknown, now: number) {
    this.db
      .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, kind, JSON.stringify(detail), now);
  }

  private expireDue(projectId: string, now: number) {
    const rows = this.db
      .prepare(
        "SELECT * FROM project_approvals WHERE project_id=? AND status IN ('PENDING','APPROVED') AND expires_at<=?",
      )
      .all(projectId, now) as ApprovalRow[];
    for (const row of rows) {
      this.db
        .prepare("UPDATE project_approvals SET status='EXPIRED',updated_at=? WHERE id=?")
        .run(now, row.id);
      this.event(projectId, "approval.expired", { approvalId: row.id, operationHash: row.operation_hash }, now);
    }
  }

  request(
    projectId: string,
    input: { id?: string; operation: unknown; requestedBy: string; ttlMs?: number },
    now = Date.now(),
  ) {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
      throw Error(`Unknown project: ${projectId}`);
    const requestedBy = identity(input.requestedBy, "requestedBy");
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000)
      throw Error("ttlMs must be an integer from 1000 to 86400000");
    const id = input.id ? identity(input.id, "Approval id") : randomUUID();
    const operation = approvalOperation(input.operation);
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project_approvals(
             id,project_id,operation_json,operation_hash,requested_by,status,expires_at,created_at,updated_at)
           VALUES(?,?,?,?,?,'PENDING',?,?,?)`,
        )
        .run(id, projectId, operation.value, operation.hash, requestedBy, now + ttlMs, now, now);
      this.event(projectId, "approval.requested", { approvalId: id, operationHash: operation.hash, requestedBy }, now);
      return this.approval(this.row(projectId, id)!);
    });
  }

  list(projectId: string, now = Date.now()) {
    return this.transaction(() => {
      this.expireDue(projectId, now);
      return (
        this.db
          .prepare("SELECT * FROM project_approvals WHERE project_id=? ORDER BY created_at DESC,id")
          .all(projectId) as ApprovalRow[]
      ).map((row) => this.approval(row));
    });
  }

  get(projectId: string, id: string, now = Date.now()) {
    return this.transaction(() => {
      this.expireDue(projectId, now);
      const row = this.row(projectId, id);
      return row ? this.approval(row) : undefined;
    });
  }

  decide(
    projectId: string,
    id: string,
    input: { decision: "APPROVED" | "DENIED"; decidedBy: string },
    now = Date.now(),
  ) {
    const decidedBy = identity(input.decidedBy, "decidedBy");
    return this.transaction(() => {
      this.expireDue(projectId, now);
      const row = this.row(projectId, id);
      if (!row) throw Error(`Unknown approval: ${id}`);
      if (row.status !== "PENDING") throw Error(`Approval is ${row.status.toLowerCase()}`);
      this.db
        .prepare(
          "UPDATE project_approvals SET status=?,decided_by=?,decided_at=?,updated_at=? WHERE id=?",
        )
        .run(input.decision, decidedBy, now, now, id);
      this.event(projectId, input.decision === "APPROVED" ? "approval.approved" : "approval.denied", { approvalId: id, operationHash: row.operation_hash, decidedBy }, now);
      return this.approval(this.row(projectId, id)!);
    });
  }

  revoke(projectId: string, id: string, revokedBy: string, now = Date.now()) {
    const actor = identity(revokedBy, "revokedBy");
    return this.transaction(() => {
      this.expireDue(projectId, now);
      const row = this.row(projectId, id);
      if (!row) throw Error(`Unknown approval: ${id}`);
      if (row.status !== "APPROVED") throw Error(`Approval is ${row.status.toLowerCase()}`);
      this.db
        .prepare("UPDATE project_approvals SET status='REVOKED',updated_at=? WHERE id=?")
        .run(now, id);
      this.event(projectId, "approval.revoked", { approvalId: id, operationHash: row.operation_hash, revokedBy: actor }, now);
      return this.approval(this.row(projectId, id)!);
    });
  }

  /** Invalidate an approval abandoned by a superseded task lease. Terminal decisions remain immutable. */
  invalidate(projectId: string, id: string, invalidatedBy: string, reason: string, now = Date.now()) {
    const actor = identity(invalidatedBy, "invalidatedBy");
    const detail = identity(reason, "invalidation reason");
    return this.transaction(() => {
      this.expireDue(projectId, now);
      const row = this.row(projectId, id);
      if (!row) throw Error(`Unknown approval: ${id}`);
      if (!["PENDING", "APPROVED"].includes(row.status)) return this.approval(row);
      this.db
        .prepare("UPDATE project_approvals SET status='EXPIRED',updated_at=? WHERE id=?")
        .run(now, id);
      this.event(projectId, "approval.invalidated", {
        approvalId: id,
        operationHash: row.operation_hash,
        invalidatedBy: actor,
        reason: detail,
      }, now);
      return this.approval(this.row(projectId, id)!);
    });
  }

  consume(projectId: string, id: string, operation: unknown, consumedBy: string, now = Date.now()) {
    const actor = identity(consumedBy, "consumedBy");
    const candidate = approvalOperation(operation);
    return this.transaction(() => {
      this.expireDue(projectId, now);
      const row = this.row(projectId, id);
      if (!row) throw Error(`Unknown approval: ${id}`);
      if (row.status !== "APPROVED") throw Error(`Approval is ${row.status.toLowerCase()}`);
      if (candidate.hash !== row.operation_hash) throw Error("Approval does not match the operation parameters");
      this.db
        .prepare(
          "UPDATE project_approvals SET status='CONSUMED',consumed_by=?,consumed_at=?,updated_at=? WHERE id=?",
        )
        .run(actor, now, now, id);
      this.event(projectId, "approval.consumed", { approvalId: id, operationHash: row.operation_hash, consumedBy: actor }, now);
      return this.approval(this.row(projectId, id)!);
    });
  }

  close() {
    this.db.close();
  }
}
