import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { dpiHome } from "./registry.js";

export interface ProjectReturnPlan {
  id: string;
  projectId: string;
  requestId: string;
  sourceId: string;
  relayReceiptId: string;
  repository: string;
  projectSlug: string;
  remoteTarget: string;
  status: "PLANNED" | "READY";
  receiptId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectReturnReceipt {
  id: string;
  planId: string;
  projectId: string;
  sourceId: string;
  environmentId: string;
  remoteTarget: string;
  localRef: string;
  revision: string;
  branch: string;
  bundleSha256: string;
  status: "READY";
  createdAt: number;
}

export interface ProjectIntegrationPlan {
  id: string;
  projectId: string;
  requestId: string;
  sourceId: string;
  projectSlug: string;
  returnReceiptId: string;
  repository: string;
  managedRef: string;
  targetBranch: string;
  baseRevision: string;
  remoteRevision: string;
  kind: "REMOTE_FAST_FORWARD" | "WORKTREE_PROMOTION";
  status: "PLANNED" | "APPLIED";
  receiptId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectIntegrationReceipt {
  id: string;
  planId: string;
  projectId: string;
  sourceId: string;
  targetBranch: string;
  previousRevision: string;
  appliedRevision: string;
  status: "APPLIED";
  createdAt: number;
}

type PlanRow = {
  id: string; project_id: string; request_id: string; request_hash: string; source_id: string;
  relay_receipt_id: string; repository: string; project_slug: string; remote_target: string;
  status: "PLANNED" | "READY"; receipt_id: string | null; created_at: number; updated_at: number;
};

type ReceiptRow = {
  id: string; plan_id: string; project_id: string; source_id: string; environment_id: string;
  remote_target: string; local_ref: string; revision: string; branch: string; bundle_sha256: string;
  status: "READY"; created_at: number;
};

type IntegrationPlanRow = {
  id: string; project_id: string; request_id: string; request_hash: string; source_id: string;
  project_slug: string; return_receipt_id: string; repository: string; managed_ref: string;
  target_branch: string; base_revision: string; remote_revision: string; status: "PLANNED" | "APPLIED";
  kind: "REMOTE_FAST_FORWARD" | "WORKTREE_PROMOTION"; receipt_id: string | null; created_at: number; updated_at: number;
};

type IntegrationReceiptRow = {
  id: string; plan_id: string; project_id: string; source_id: string; target_branch: string;
  previous_revision: string; applied_revision: string; status: "APPLIED"; created_at: number;
};

const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const clean = value.trim();
  if (clean.length > max) throw Error(`${label} must be at most ${max} characters`);
  return clean;
};

/** Durable, idempotent remote-to-Windows Git return plans and fetch receipts. */
export class ProjectReturnStore {
  readonly db: DatabaseSync;

  constructor(databasePath = join(dpiHome(), "projects.sqlite")) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_return_plans(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relay_receipt_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        remote_target TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,request_id));
      CREATE INDEX IF NOT EXISTS project_return_plans_scope
        ON project_return_plans(project_id,status,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS project_return_receipts(
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        remote_target TEXT NOT NULL,
        local_ref TEXT NOT NULL,
        revision TEXT NOT NULL,
        branch TEXT NOT NULL,
        bundle_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id,plan_id));
      CREATE INDEX IF NOT EXISTS project_return_receipts_scope
        ON project_return_receipts(project_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS project_integration_plans(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        source_id TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        return_receipt_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        managed_ref TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        remote_revision TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'REMOTE_FAST_FORWARD',
        status TEXT NOT NULL,
        receipt_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,request_id));
      CREATE INDEX IF NOT EXISTS project_integration_plans_scope
        ON project_integration_plans(project_id,status,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS project_integration_receipts(
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        previous_revision TEXT NOT NULL,
        applied_revision TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_integration_receipts_scope
        ON project_integration_receipts(project_id,created_at DESC,id);`);
    const integrationColumns = this.db.prepare("PRAGMA table_info(project_integration_plans)").all() as Array<{ name: string }>;
    if (!integrationColumns.some((column) => column.name === "kind"))
      this.db.exec("ALTER TABLE project_integration_plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'REMOTE_FAST_FORWARD'");
  }

  private planValue(row: PlanRow): ProjectReturnPlan {
    return {
      id: row.id, projectId: row.project_id, requestId: row.request_id, sourceId: row.source_id,
      relayReceiptId: row.relay_receipt_id, repository: row.repository, projectSlug: row.project_slug,
      remoteTarget: row.remote_target, status: row.status,
      ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private receiptValue(row: ReceiptRow): ProjectReturnReceipt {
    return {
      id: row.id, planId: row.plan_id, projectId: row.project_id, sourceId: row.source_id,
      environmentId: row.environment_id, remoteTarget: row.remote_target, localRef: row.local_ref,
      revision: row.revision, branch: row.branch, bundleSha256: row.bundle_sha256,
      status: row.status, createdAt: row.created_at,
    };
  }

  private integrationPlanValue(row: IntegrationPlanRow): ProjectIntegrationPlan {
    return {
      id: row.id, projectId: row.project_id, requestId: row.request_id, sourceId: row.source_id,
      projectSlug: row.project_slug, returnReceiptId: row.return_receipt_id, repository: row.repository,
      managedRef: row.managed_ref, targetBranch: row.target_branch, baseRevision: row.base_revision,
      remoteRevision: row.remote_revision, kind: row.kind, status: row.status,
      ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private integrationReceiptValue(row: IntegrationReceiptRow): ProjectIntegrationReceipt {
    return {
      id: row.id, planId: row.plan_id, projectId: row.project_id, sourceId: row.source_id,
      targetBranch: row.target_branch, previousRevision: row.previous_revision,
      appliedRevision: row.applied_revision, status: row.status, createdAt: row.created_at,
    };
  }

  listPlans(projectId: string) {
    return (this.db.prepare("SELECT * FROM project_return_plans WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as PlanRow[]).map((row) => this.planValue(row));
  }

  listReceipts(projectId: string) {
    return (this.db.prepare("SELECT * FROM project_return_receipts WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as ReceiptRow[]).map((row) => this.receiptValue(row));
  }

  listIntegrationPlans(projectId: string) {
    return (this.db.prepare("SELECT * FROM project_integration_plans WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as IntegrationPlanRow[]).map((row) => this.integrationPlanValue(row));
  }

  listIntegrationReceipts(projectId: string) {
    return (this.db.prepare("SELECT * FROM project_integration_receipts WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as IntegrationReceiptRow[]).map((row) => this.integrationReceiptValue(row));
  }

  getIntegrationPlan(projectId: string, planId: string) {
    const row = this.db.prepare("SELECT * FROM project_integration_plans WHERE project_id=? AND id=?")
      .get(projectId, planId) as IntegrationPlanRow | undefined;
    return row ? this.integrationPlanValue(row) : undefined;
  }

  getPlan(projectId: string, planId: string) {
    const row = this.db.prepare("SELECT * FROM project_return_plans WHERE project_id=? AND id=?")
      .get(projectId, planId) as PlanRow | undefined;
    return row ? this.planValue(row) : undefined;
  }

  plan(projectIdInput: unknown, input: {
    requestId: unknown; sourceId: unknown; relayReceiptId: unknown; repository: unknown; projectSlug: unknown;
  }, now = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const requestId = text(input.requestId, "Request id", 240);
    const sourceId = text(input.sourceId, "Source id", 64);
    const relayReceiptId = text(input.relayReceiptId, "Relay receipt id", 160);
    const relay = this.db.prepare(
      "SELECT source_id,target,status FROM project_relay_receipts WHERE project_id=? AND id=?",
    ).get(projectId, relayReceiptId) as { source_id: string; target: string; status: string } | undefined;
    if (!relay || relay.status !== "READY") throw Error(`Unknown READY relay receipt: ${relayReceiptId}`);
    if (relay.source_id !== sourceId) throw Error("Relay receipt belongs to a different data source");
    const repository = text(input.repository, "Repository", 2_000);
    const projectSlug = text(input.projectSlug, "Project slug", 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectSlug)) throw Error("Project slug is invalid");
    if (!relay.target.endsWith(`/DurablePiProjects/${projectSlug}`))
      throw Error("Relay receipt target does not match the project slug");
    const requestHash = createHash("sha256").update(JSON.stringify({ sourceId, relayReceiptId, repository, projectSlug })).digest("hex");
    const id = `return-plan-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex").slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_return_plans WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as PlanRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw Error("request_id was reused with different return arguments");
        this.db.exec("COMMIT");
        return this.planValue(existing);
      }
      this.db.prepare(
        `INSERT INTO project_return_plans(
          id,project_id,request_id,request_hash,source_id,relay_receipt_id,repository,project_slug,remote_target,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,'PLANNED',?,?)`,
      ).run(id, projectId, requestId, requestHash, sourceId, relayReceiptId, repository, projectSlug, relay.target, now, now);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "project.return.planned", JSON.stringify({ planId: id, sourceId, relayReceiptId, projectSlug }), now);
      this.db.exec("COMMIT");
      return this.planValue(this.db.prepare("SELECT * FROM project_return_plans WHERE id=?").get(id) as PlanRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  record(projectIdInput: unknown, input: {
    planId: unknown; sourceId: unknown; environmentId: unknown; remoteTarget: unknown; localRef: unknown;
    revision: unknown; branch: unknown; bundleSha256: unknown;
  }, now = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    const planId = text(input.planId, "Return plan id", 160);
    const plan = this.db.prepare("SELECT * FROM project_return_plans WHERE project_id=? AND id=?")
      .get(projectId, planId) as PlanRow | undefined;
    if (!plan) throw Error(`Unknown return plan: ${planId}`);
    const sourceId = text(input.sourceId, "Source id", 64);
    const environmentId = text(input.environmentId, "Environment id", 160);
    const remoteTarget = text(input.remoteTarget, "Remote target", 1_000);
    if (sourceId !== plan.source_id || remoteTarget !== plan.remote_target)
      throw Error("Return receipt does not match its frozen plan");
    const localRef = text(input.localRef, "Local ref", 500);
    if (!localRef.startsWith("refs/dpi/remotes/")) throw Error("Return ref is outside the managed namespace");
    const revision = text(input.revision, "Revision", 64);
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw Error("Return revision is invalid");
    const branch = text(input.branch, "Branch", 240);
    const bundleSha256 = text(input.bundleSha256, "Bundle SHA-256", 64);
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw Error("Return bundle checksum is invalid");
    const id = `return-${createHash("sha256").update(JSON.stringify({ planId, localRef, revision, branch })).digest("hex").slice(0, 48)}`;
    if (plan.receipt_id && plan.receipt_id !== id) throw Error("Return plan already completed with a different receipt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_return_receipts WHERE id=?").get(id) as ReceiptRow | undefined;
      if (!existing) {
        this.db.prepare(
          `INSERT INTO project_return_receipts(
            id,plan_id,project_id,source_id,environment_id,remote_target,local_ref,revision,branch,bundle_sha256,status,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,'READY',?)`,
        ).run(id, planId, projectId, sourceId, environmentId, remoteTarget, localRef, revision, branch, bundleSha256, now);
        this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(projectId, "project.return.ready", JSON.stringify({ returnId: id, planId, sourceId, localRef, revision, branch }), now);
      }
      this.db.prepare("UPDATE project_return_plans SET status='READY',receipt_id=?,updated_at=? WHERE id=?")
        .run(id, now, planId);
      this.db.exec("COMMIT");
      return this.receiptValue(this.db.prepare("SELECT * FROM project_return_receipts WHERE id=?").get(id) as ReceiptRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  planFastForward(projectIdInput: unknown, input: {
    requestId: unknown; sourceId: unknown; projectSlug: unknown; returnReceiptId: unknown;
    repository: unknown; managedRef: unknown; targetBranch: unknown; baseRevision: unknown; remoteRevision: unknown;
  }, now = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const requestId = text(input.requestId, "Request id", 240);
    const sourceId = text(input.sourceId, "Source id", 64);
    const projectSlug = text(input.projectSlug, "Project slug", 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectSlug)) throw Error("Project slug is invalid");
    const returnReceiptId = text(input.returnReceiptId, "Return receipt id", 160);
    const receipt = this.db.prepare(
      "SELECT source_id,local_ref,revision,status FROM project_return_receipts WHERE project_id=? AND id=?",
    ).get(projectId, returnReceiptId) as { source_id: string; local_ref: string; revision: string; status: string } | undefined;
    if (!receipt || receipt.status !== "READY") throw Error(`Unknown READY return receipt: ${returnReceiptId}`);
    const repository = text(input.repository, "Repository", 2_000);
    const managedRef = text(input.managedRef, "Managed ref", 500);
    if (!managedRef.startsWith("refs/dpi/remotes/")) throw Error("Managed ref is outside the return namespace");
    const targetBranch = text(input.targetBranch, "Target branch", 240);
    const baseRevision = text(input.baseRevision, "Base revision", 64);
    const remoteRevision = text(input.remoteRevision, "Remote revision", 64);
    if (![baseRevision, remoteRevision].every((revision) => /^[a-f0-9]{40,64}$/.test(revision)))
      throw Error("Integration revisions are invalid");
    if (receipt.source_id !== sourceId || receipt.local_ref !== managedRef || receipt.revision !== remoteRevision)
      throw Error("Integration plan does not match the verified return receipt");
    const requestHash = createHash("sha256").update(JSON.stringify({
      sourceId, projectSlug, returnReceiptId, repository, managedRef, targetBranch, baseRevision, remoteRevision,
    })).digest("hex");
    const id = `integration-plan-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex").slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_integration_plans WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as IntegrationPlanRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw Error("request_id was reused with different integration arguments");
        this.db.exec("COMMIT");
        return this.integrationPlanValue(existing);
      }
      this.db.prepare(
        `INSERT INTO project_integration_plans(
          id,project_id,request_id,request_hash,source_id,project_slug,return_receipt_id,repository,managed_ref,
          target_branch,base_revision,remote_revision,kind,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'REMOTE_FAST_FORWARD','PLANNED',?,?)`,
      ).run(id, projectId, requestId, requestHash, sourceId, projectSlug, returnReceiptId, repository, managedRef,
        targetBranch, baseRevision, remoteRevision, now, now);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "project.integration.planned", JSON.stringify({
          planId: id, sourceId, projectSlug, targetBranch, baseRevision, remoteRevision,
        }), now);
      this.db.exec("COMMIT");
      return this.integrationPlanValue(this.db.prepare("SELECT * FROM project_integration_plans WHERE id=?").get(id) as IntegrationPlanRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  planWorktreePromotion(projectIdInput: unknown, input: {
    requestId: unknown; sourceId: unknown; projectSlug: unknown; returnReceiptId: unknown;
    repository: unknown; managedRef: unknown; targetBranch: unknown; baseRevision: unknown;
    remoteRevision: unknown; requiredReturnRevision: unknown;
  }, now = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const requestId = text(input.requestId, "Request id", 240);
    const sourceId = text(input.sourceId, "Source id", 64);
    const projectSlug = text(input.projectSlug, "Project slug", 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectSlug)) throw Error("Project slug is invalid");
    const returnReceiptId = text(input.returnReceiptId, "Return receipt id", 160);
    const receipt = this.db.prepare(
      "SELECT source_id,revision,status FROM project_return_receipts WHERE project_id=? AND id=?",
    ).get(projectId, returnReceiptId) as { source_id: string; revision: string; status: string } | undefined;
    if (!receipt || receipt.status !== "READY") throw Error(`Unknown READY return receipt: ${returnReceiptId}`);
    const repository = text(input.repository, "Repository", 2_000);
    const managedRef = text(input.managedRef, "Integration branch ref", 500);
    if (!managedRef.startsWith("refs/heads/dpi/integration-")) throw Error("Promotion ref is outside the managed integration namespace");
    const targetBranch = text(input.targetBranch, "Target branch", 240);
    const baseRevision = text(input.baseRevision, "Base revision", 64);
    const remoteRevision = text(input.remoteRevision, "Promotion revision", 64);
    const requiredReturnRevision = text(input.requiredReturnRevision, "Required return revision", 64);
    if (![baseRevision, remoteRevision, requiredReturnRevision].every((revision) => /^[a-f0-9]{40,64}$/.test(revision)))
      throw Error("Promotion revisions are invalid");
    if (receipt.source_id !== sourceId || receipt.revision !== requiredReturnRevision)
      throw Error("Promotion plan does not match the verified return receipt");
    const requestHash = createHash("sha256").update(JSON.stringify({
      sourceId, projectSlug, returnReceiptId, repository, managedRef, targetBranch,
      baseRevision, remoteRevision, requiredReturnRevision,
    })).digest("hex");
    const id = `integration-plan-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex").slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_integration_plans WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as IntegrationPlanRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw Error("request_id was reused with different promotion arguments");
        this.db.exec("COMMIT");
        return this.integrationPlanValue(existing);
      }
      this.db.prepare(
        `INSERT INTO project_integration_plans(
          id,project_id,request_id,request_hash,source_id,project_slug,return_receipt_id,repository,managed_ref,
          target_branch,base_revision,remote_revision,kind,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'WORKTREE_PROMOTION','PLANNED',?,?)`,
      ).run(id, projectId, requestId, requestHash, sourceId, projectSlug, returnReceiptId, repository, managedRef,
        targetBranch, baseRevision, remoteRevision, now, now);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "project.integration.promotion_planned", JSON.stringify({
          planId: id, sourceId, projectSlug, targetBranch, baseRevision, promotionRevision: remoteRevision,
          requiredReturnRevision,
        }), now);
      this.db.exec("COMMIT");
      return this.integrationPlanValue(this.db.prepare("SELECT * FROM project_integration_plans WHERE id=?").get(id) as IntegrationPlanRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordFastForward(projectIdInput: unknown, input: {
    planId: unknown; sourceId: unknown; targetBranch: unknown; previousRevision: unknown; appliedRevision: unknown;
  }, now = Date.now()) {
    const projectId = text(projectIdInput, "Project id", 128);
    const planId = text(input.planId, "Integration plan id", 160);
    const plan = this.db.prepare("SELECT * FROM project_integration_plans WHERE project_id=? AND id=?")
      .get(projectId, planId) as IntegrationPlanRow | undefined;
    if (!plan) throw Error(`Unknown integration plan: ${planId}`);
    const sourceId = text(input.sourceId, "Source id", 64);
    const targetBranch = text(input.targetBranch, "Target branch", 240);
    const previousRevision = text(input.previousRevision, "Previous revision", 64);
    const appliedRevision = text(input.appliedRevision, "Applied revision", 64);
    if (sourceId !== plan.source_id || targetBranch !== plan.target_branch ||
        previousRevision !== plan.base_revision || appliedRevision !== plan.remote_revision)
      throw Error("Integration receipt does not match its frozen plan");
    const id = `integration-${createHash("sha256").update(`${planId}\0${appliedRevision}`).digest("hex").slice(0, 48)}`;
    if (plan.receipt_id && plan.receipt_id !== id) throw Error("Integration plan already has a different receipt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_integration_receipts WHERE id=?")
        .get(id) as IntegrationReceiptRow | undefined;
      if (!existing) {
        this.db.prepare(
          `INSERT INTO project_integration_receipts(
            id,plan_id,project_id,source_id,target_branch,previous_revision,applied_revision,status,created_at)
           VALUES(?,?,?,?,?,?,?,'APPLIED',?)`,
        ).run(id, planId, projectId, sourceId, targetBranch, previousRevision, appliedRevision, now);
        this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(projectId, "project.integration.applied", JSON.stringify({
            receiptId: id, planId, sourceId, targetBranch, previousRevision, appliedRevision,
          }), now);
      }
      this.db.prepare("UPDATE project_integration_plans SET status='APPLIED',receipt_id=?,updated_at=? WHERE id=?")
        .run(id, now, planId);
      this.db.exec("COMMIT");
      return this.integrationReceiptValue(
        this.db.prepare("SELECT * FROM project_integration_receipts WHERE id=?").get(id) as IntegrationReceiptRow,
      );
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }
}
