import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PlatformObservabilitySummary, ProjectTaskStatus } from "../api.js";

const statuses: ProjectTaskStatus[] = [
  "QUEUED", "WAITING_DEPENDENCY", "RUNNING", "RETRYING", "WAITING_DEVICE", "WAITING_APPROVAL",
  "PAUSED", "COMPLETED", "FAILED", "CANCELLED",
];

/** Read-only cross-module operational projection; no business logic writes through this store. */
export class PlatformObservabilityStore {
  readonly db: DatabaseSync;
  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout=3000");
  }

  summary(at = Date.now()): PlatformObservabilitySummary {
    const scalar = (sql: string, field: string, ...params: SQLInputValue[]) =>
      Number((this.db.prepare(sql).get(...params) as Record<string, number> | undefined)?.[field] ?? 0);
    const taskCounts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<ProjectTaskStatus, number>;
    for (const row of this.db.prepare("SELECT status,COUNT(*) AS count FROM project_tasks GROUP BY status").all() as Array<{ status: ProjectTaskStatus; count: number }>)
      if (row.status in taskCounts) taskCounts[row.status] = Number(row.count);
    return {
      at,
      projects: scalar("SELECT COUNT(*) AS count FROM projects", "count"),
      agents: {
        active: scalar("SELECT COUNT(*) AS count FROM project_members WHERE lifecycle_state!='ARCHIVED'", "count"),
        temporary: scalar("SELECT COUNT(*) AS count FROM project_members WHERE temporary=1 AND lifecycle_state!='ARCHIVED'", "count"),
        archived: scalar("SELECT COUNT(*) AS count FROM project_members WHERE lifecycle_state='ARCHIVED'", "count"),
      },
      tasks: taskCounts,
      pendingApprovals: scalar("SELECT COUNT(*) AS count FROM project_approvals WHERE status='PENDING' AND expires_at>?", "count", at),
      artifacts: {
        active: scalar("SELECT COUNT(*) AS count FROM project_artifacts WHERE status='ACTIVE'", "count"),
        expired: scalar("SELECT COUNT(*) AS count FROM project_artifacts WHERE status='EXPIRED'", "count"),
        activeBytes: scalar("SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM project_artifacts WHERE status='ACTIVE'", "bytes"),
      },
      handoffs: scalar("SELECT COUNT(*) AS count FROM project_handoffs WHERE status='READY'", "count"),
      worktrees: {
        active: scalar("SELECT COUNT(*) AS count FROM project_worktrees WHERE state='ACTIVE'", "count"),
        failed: scalar("SELECT COUNT(*) AS count FROM project_worktrees WHERE state='FAILED'", "count"),
      },
      toolCalls: {
        started: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE status='STARTED'", "count"),
        completed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE status='COMPLETED'", "count"),
        failed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE status='FAILED'", "count"),
        testsPassed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE evidence_kind='TEST' AND status='COMPLETED'", "count"),
        testsFailed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE evidence_kind='TEST' AND status='FAILED'", "count"),
        buildsPassed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE evidence_kind='BUILD' AND status='COMPLETED'", "count"),
        buildsFailed: scalar("SELECT COUNT(*) AS count FROM project_tool_calls WHERE evidence_kind='BUILD' AND status='FAILED'", "count"),
      },
      tokenUsage24h: scalar("SELECT COALESCE(SUM(total_tokens),0) AS tokens FROM project_model_usage WHERE updated_at>=?", "tokens", at - 86_400_000),
    };
  }

  close() { this.db.close(); }
}
