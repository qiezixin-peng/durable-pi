import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dpiHome } from "./registry.js";

export interface ProjectRelayReceipt {
  id: string;
  planId?: string;
  projectId: string;
  handoffId: string;
  sourceId: string;
  environmentId: string;
  target: string;
  revision: string;
  branch: string;
  bundleSha256: string;
  targetCreated: boolean;
  status: "READY";
  createdAt: number;
}

export interface ProjectRelayPlan {
  id: string;
  projectId: string;
  requestId: string;
  handoffId: string;
  sourceId: string;
  repository: string;
  projectSlug: string;
  title: string;
  status: "PLANNED" | "READY";
  receiptId?: string;
  createdAt: number;
  updatedAt: number;
}

type RelayRow = {
  id: string; plan_id: string | null; project_id: string; handoff_id: string; source_id: string; environment_id: string;
  target: string; revision: string; branch: string; bundle_sha256: string; target_created: number;
  status: "READY"; created_at: number;
};

type RelayPlanRow = {
  id: string; project_id: string; request_id: string; request_hash: string; handoff_id: string;
  source_id: string; repository: string; project_slug: string; title: string; status: "PLANNED" | "READY";
  receipt_id: string | null; created_at: number; updated_at: number;
};

const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const clean = value.trim();
  if (clean.length > max) throw Error(`${label} must be at most ${max} characters`);
  return clean;
};

export class ProjectRelayStore {
  readonly db: DatabaseSync;

  constructor(databasePath = join(dpiHome(), "projects.sqlite")) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_relay_receipts(
        id TEXT PRIMARY KEY,
        plan_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        handoff_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        target TEXT NOT NULL,
        revision TEXT NOT NULL,
        branch TEXT NOT NULL,
        bundle_sha256 TEXT NOT NULL,
        target_created INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id,handoff_id,source_id,target,revision));
      CREATE INDEX IF NOT EXISTS project_relay_receipts_scope
        ON project_relay_receipts(project_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS project_relay_plans(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        handoff_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,request_id));
      CREATE INDEX IF NOT EXISTS project_relay_plans_scope
        ON project_relay_plans(project_id,status,created_at DESC,id);`);
    const receiptColumns = this.db.prepare("PRAGMA table_info(project_relay_receipts)").all() as Array<{ name: string }>;
    if (!receiptColumns.some((column) => column.name === "plan_id"))
      this.db.exec("ALTER TABLE project_relay_receipts ADD COLUMN plan_id TEXT");
  }

  private value(row: RelayRow): ProjectRelayReceipt {
    return {
      id: row.id, projectId: row.project_id, handoffId: row.handoff_id, sourceId: row.source_id,
      environmentId: row.environment_id, target: row.target, revision: row.revision, branch: row.branch,
      bundleSha256: row.bundle_sha256, targetCreated: Boolean(row.target_created), status: row.status,
      createdAt: row.created_at,
      ...(row.plan_id ? { planId: row.plan_id } : {}),
    };
  }

  private planValue(row: RelayPlanRow): ProjectRelayPlan {
    return {
      id: row.id, projectId: row.project_id, requestId: row.request_id, handoffId: row.handoff_id,
      sourceId: row.source_id, repository: row.repository, projectSlug: row.project_slug, title: row.title,
      status: row.status, ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listPlans(projectId: string) {
    return (this.db.prepare(
      "SELECT * FROM project_relay_plans WHERE project_id=? ORDER BY created_at DESC,id",
    ).all(projectId) as RelayPlanRow[]).map((row) => this.planValue(row));
  }

  getPlan(projectId: string, planId: string) {
    const row = this.db.prepare("SELECT * FROM project_relay_plans WHERE project_id=? AND id=?")
      .get(projectId, planId) as RelayPlanRow | undefined;
    return row ? this.planValue(row) : undefined;
  }

  plan(projectIdInput: unknown, input: {
    requestId: unknown; handoffId: unknown; sourceId: unknown; repository: unknown;
    projectSlug: unknown; title: unknown;
  }, createdAt = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const requestId = text(input.requestId, "Request id", 240);
    const handoffId = text(input.handoffId, "Handoff id", 160);
    if (!this.db.prepare("SELECT id FROM project_handoffs WHERE project_id=? AND id=? AND status='READY'").get(projectId, handoffId))
      throw Error(`Unknown READY project handoff: ${handoffId}`);
    const sourceId = text(input.sourceId, "Source id", 64);
    const repository = text(input.repository, "Repository", 2_000);
    const projectSlug = text(input.projectSlug, "Project slug", 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectSlug)) throw Error("Project slug is invalid");
    const title = text(input.title, "Title", 120);
    const requestHash = createHash("sha256").update(JSON.stringify({ handoffId, sourceId, repository, projectSlug, title })).digest("hex");
    const id = `relay-plan-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex").slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_relay_plans WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as RelayPlanRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw Error("request_id was reused with different relay arguments");
        this.db.exec("COMMIT");
        return this.planValue(existing);
      }
      this.db.prepare(
        `INSERT INTO project_relay_plans(
          id,project_id,request_id,request_hash,handoff_id,source_id,repository,project_slug,title,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,'PLANNED',?,?)`,
      ).run(id, projectId, requestId, requestHash, handoffId, sourceId, repository, projectSlug, title, createdAt, createdAt);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "project.relay.planned", JSON.stringify({ planId: id, handoffId, sourceId, projectSlug }), createdAt);
      this.db.exec("COMMIT");
      return this.planValue(this.db.prepare("SELECT * FROM project_relay_plans WHERE id=?").get(id) as RelayPlanRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(projectId: string) {
    return (this.db.prepare(
      "SELECT * FROM project_relay_receipts WHERE project_id=? ORDER BY created_at DESC,id",
    ).all(projectId) as RelayRow[]).map((row) => this.value(row));
  }

  record(projectIdInput: unknown, input: {
    handoffId: unknown; sourceId: unknown; environmentId: unknown; target: unknown; revision: unknown;
    branch: unknown; bundleSha256: unknown; targetCreated: unknown; planId?: unknown;
  }, createdAt = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const handoffId = text(input.handoffId, "Handoff id", 160);
    if (!this.db.prepare("SELECT id FROM project_handoffs WHERE project_id=? AND id=?").get(projectId, handoffId))
      throw Error(`Unknown project handoff: ${handoffId}`);
    const sourceId = text(input.sourceId, "Source id", 64);
    const planId = input.planId === undefined ? undefined : text(input.planId, "Relay plan id", 160);
    const plan = planId
      ? this.db.prepare("SELECT * FROM project_relay_plans WHERE project_id=? AND id=?").get(projectId, planId) as RelayPlanRow | undefined
      : undefined;
    if (planId && !plan) throw Error(`Unknown relay plan: ${planId}`);
    if (plan && (plan.handoff_id !== handoffId || plan.source_id !== sourceId))
      throw Error("Relay receipt does not match its frozen plan");
    const environmentId = text(input.environmentId, "Environment id", 160);
    const target = text(input.target, "Target", 1_000);
    if (!target.startsWith("/") || target.includes("\0") || dirname(target) === target)
      throw Error("Relay target must be an absolute target-system path");
    const revision = text(input.revision, "Revision", 64);
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw Error("Relay revision is invalid");
    const branch = text(input.branch, "Branch", 240);
    const bundleSha256 = text(input.bundleSha256, "Bundle SHA-256", 64);
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw Error("Relay bundle checksum is invalid");
    if (typeof input.targetCreated !== "boolean") throw Error("targetCreated must be a boolean");
    const identity = JSON.stringify({ projectId, handoffId, sourceId, environmentId, target, revision, branch, bundleSha256 });
    const id = `relay-${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`;
    if (plan?.receipt_id && plan.receipt_id !== id)
      throw Error("Relay plan already completed with a different receipt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_relay_receipts WHERE id=?").get(id) as RelayRow | undefined;
      if (existing) {
        if (plan && existing.plan_id && existing.plan_id !== plan.id)
          throw Error("Relay receipt is already attached to a different plan");
        if (plan) {
          if (!existing.plan_id) this.db.prepare("UPDATE project_relay_receipts SET plan_id=? WHERE id=?").run(plan.id, id);
          this.db.prepare(
            "UPDATE project_relay_plans SET status='READY',receipt_id=?,updated_at=? WHERE id=? AND status='PLANNED'",
          ).run(id, createdAt, plan.id);
        }
        this.db.exec("COMMIT");
        return this.value(this.db.prepare("SELECT * FROM project_relay_receipts WHERE id=?").get(id) as RelayRow);
      }
      this.db.prepare(
        `INSERT INTO project_relay_receipts(
          id,plan_id,project_id,handoff_id,source_id,environment_id,target,revision,branch,bundle_sha256,target_created,status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'READY',?)`,
      ).run(id, planId ?? null, projectId, handoffId, sourceId, environmentId, target, revision, branch, bundleSha256,
        input.targetCreated ? 1 : 0, createdAt);
      if (plan) this.db.prepare(
        "UPDATE project_relay_plans SET status='READY',receipt_id=?,updated_at=? WHERE id=? AND status='PLANNED'",
      ).run(id, createdAt, plan.id);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "project.relay.ready", JSON.stringify({
          relayId: id, handoffId, sourceId, environmentId, target, revision, branch, bundleSha256,
          targetCreated: input.targetCreated,
        }), createdAt);
      this.db.exec("COMMIT");
      return this.value(this.db.prepare("SELECT * FROM project_relay_receipts WHERE id=?").get(id) as RelayRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
