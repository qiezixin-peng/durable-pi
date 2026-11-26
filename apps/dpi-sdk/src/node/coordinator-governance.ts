import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ROUTINE_OPERATION_KINDS = [
  "read_search", "planning", "safe_workspace_edit", "managed_worktree",
  "build_test_lint", "artifact_write", "local_git_commit",
] as const;
export const HIGH_RISK_OPERATION_KINDS = [
  "destructive_delete", "outside_root_write", "credential_access",
  "risky_dependency_install", "publish_push_deploy", "irreversible_external_effect",
  "material_product_ambiguity",
] as const;
export type GovernanceOperationKind =
  | typeof ROUTINE_OPERATION_KINDS[number]
  | typeof HIGH_RISK_OPERATION_KINDS[number];

export interface CoordinatorWorkIntent {
  workKind: "question" | "inspection" | "edit" | "implementation" | "research";
  workstreamCount: number;
  estimatedFiles: number;
  independentVerification: boolean;
  remoteDataRequested: boolean;
  operations: Array<{ kind: GovernanceOperationKind; parameters?: unknown }>;
}

const exactApprovalParameters = (kind: GovernanceOperationKind, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`High-risk operation ${kind} requires a non-empty parameter object`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol" ||
          typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item)))
        throw Error("parameters must contain only finite JSON values");
      return item;
    });
  } catch (error) {
    throw Error(`High-risk operation ${kind} requires deterministic JSON parameters: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === "{}")
    throw Error(`High-risk operation ${kind} requires a non-empty parameter object`);
  if (serialized.length > 65_536)
    throw Error(`High-risk operation ${kind} parameters exceed 65536 bytes`);
  return JSON.parse(serialized) as Record<string, unknown>;
};

export const classifyCoordinatorWork = (intent: CoordinatorWorkIntent) => {
  const hasHighRiskOperation = intent.operations.some((operation) =>
    (HIGH_RISK_OPERATION_KINDS as readonly string[]).includes(operation.kind));
  const substantive = intent.workstreamCount >= 2 || intent.independentVerification ||
    intent.estimatedFiles >= 2 || hasHighRiskOperation;
  const classification = substantive ? "SUBSTANTIVE" : "DIRECT";
  const agents: string[] = [];
  if (substantive && ["edit", "implementation"].includes(intent.workKind)) agents.push("coder");
  if (substantive && intent.workKind === "research" && agents.length === 0) agents.push("researcher");
  if (substantive && intent.independentVerification)
    agents.push(["edit", "implementation"].includes(intent.workKind) ? "tester" : "reviewer");
  const verificationScope = intent.independentVerification ? "independent" :
    substantive && ["edit", "implementation"].includes(intent.workKind) ? "focused" : "none";
  const operations = intent.operations.map((operation) => {
    const highRisk = (HIGH_RISK_OPERATION_KINDS as readonly string[]).includes(operation.kind);
    const approvalBinding = highRisk ? exactApprovalParameters(operation.kind, operation.parameters) : undefined;
    return {
      ...operation,
      approvalRequired: highRisk,
      approvalBinding,
    };
  });
  return {
    classification,
    reasonCode: substantive ? "SUBSTANTIVE_SCOPE" : "BOUNDED_DIRECT_WORK",
    bypassReason: substantive ? undefined :
      `direct:${intent.workKind};workstreams=${intent.workstreamCount};files=${intent.estimatedFiles};verification=${verificationScope}`,
    agentRoles: agents,
    remoteDataNeeded: intent.remoteDataRequested,
    verificationScope,
    operations,
  } as const;
};

type CoordinationRow = {
  id: string; project_id: string; request_id: string; coordinator_member_id: string;
  title: string; classification: "SUBSTANTIVE" | "DIRECT"; plan_json: string;
  bypass_reason: string | null; status: string; created_at: number; updated_at: number;
};

export class CoordinatorGovernanceStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS coordinator_work_records(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        coordinator_member_id TEXT NOT NULL,
        title TEXT NOT NULL,
        classification TEXT NOT NULL CHECK(classification IN ('SUBSTANTIVE','DIRECT')),
        plan_json TEXT NOT NULL,
        bypass_reason TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,coordinator_member_id,request_id));
      CREATE INDEX IF NOT EXISTS coordinator_work_records_project
        ON coordinator_work_records(project_id,created_at DESC);`);
  }

  private value(row: CoordinationRow) {
    return { id: row.id, projectId: row.project_id, requestId: row.request_id,
      coordinatorMemberId: row.coordinator_member_id, title: row.title,
      classification: row.classification, plan: JSON.parse(row.plan_json) as unknown,
      ...(row.bypass_reason ? { bypassReason: row.bypass_reason } : {}), status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private immediate<T>(operation: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  route(projectId: string, memberId: string, requestId: string, title: string, intent: CoordinatorWorkIntent, now = Date.now()) {
    const plan = classifyCoordinatorWork(intent);
    const planJson = JSON.stringify(plan);
    return this.immediate(() => {
      const existing = this.db.prepare(
        "SELECT * FROM coordinator_work_records WHERE project_id=? AND coordinator_member_id=? AND request_id=?",
      ).get(projectId, memberId, requestId) as CoordinationRow | undefined;
      if (existing) {
        if (existing.title !== title || existing.plan_json !== planJson)
          throw Error("request_id was reused with different coordinator work parameters");
        return this.value(existing);
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO coordinator_work_records(
        id,project_id,request_id,coordinator_member_id,title,classification,plan_json,bypass_reason,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, requestId, memberId, title, plan.classification,
          planJson, plan.bypassReason ?? null, plan.classification === "SUBSTANTIVE" ? "PLANNED" : "BYPASSED", now, now);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, plan.classification === "SUBSTANTIVE" ? "coordination.planned" : "coordination.bypassed",
          JSON.stringify({ coordinationId: id, requestId, classification: plan.classification,
            status: plan.classification === "SUBSTANTIVE" ? "PLANNED" : "BYPASSED",
            ...(plan.bypassReason ? { bypassReason: plan.bypassReason } : {}) }), now);
      return this.get(projectId, id)!;
    });
  }

  get(projectId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM coordinator_work_records WHERE project_id=? AND id=?")
      .get(projectId, id) as CoordinationRow | undefined;
    return row ? this.value(row) : undefined;
  }

  list(projectId: string, limit = 50) {
    return (this.db.prepare("SELECT * FROM coordinator_work_records WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?")
      .all(projectId, limit) as CoordinationRow[]).map((row) => this.value(row));
  }

  markDelegated(projectId: string, id: string, now = Date.now()) {
    const record = this.get(projectId, id);
    if (!record) throw Error("Delegation requires an authoritative Durable coordination record");
    if (record.classification !== "SUBSTANTIVE") throw Error("Direct-work bypass records cannot authorize multi-Agent delegation");
    this.db.prepare("UPDATE coordinator_work_records SET status='DELEGATED',updated_at=? WHERE project_id=? AND id=?")
      .run(now, projectId, id);
    return this.get(projectId, id)!;
  }

  close() { this.db.close(); }
}
