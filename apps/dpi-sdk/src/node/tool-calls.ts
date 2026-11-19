import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ProjectToolCall } from "../api.js";

type ToolCallRow = {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  fence_epoch: number;
  member_id: string;
  item_id: string;
  type: string;
  status: ProjectToolCall["status"];
  evidence_kind: ProjectToolCall["evidenceKind"];
  request_json: string | null;
  result_json: string | null;
  request_sha256: string | null;
  completion_sha256: string | null;
  exit_code: number | null;
  started_at: number;
  completed_at: number | null;
};

const required = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const result = value.trim();
  if (result.length > max) throw Error(`${label} must be at most ${max} characters`);
  return result;
};

const redactText = (value: string) => value
  .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]")
  .replace(/([?&](?:api[_-]?key|token|access[_-]?token)=)[^&\s]+/gi, "$1[REDACTED]")
  .replace(/\b((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");

const secretField = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client[-_]?secret|cookie|set-cookie)$/i;

const redact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return redactText(value);
  if (depth >= 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([key, item]) => [
    key,
    secretField.test(key) ? "[REDACTED_SECRET_FIELD]" : redact(item, depth + 1),
  ]));
};

const encoded = (value: unknown) => {
  const sanitized = redact(value);
  const json = JSON.stringify(sanitized ?? null);
  if (Buffer.byteLength(json) <= 64 * 1024) return { value: sanitized, json, sha256: createHash("sha256").update(json).digest("hex") };
  const bounded = {
    truncated: true,
    preview: redactText(json.slice(0, 32_000)),
    originalBytes: Buffer.byteLength(json),
    sha256: createHash("sha256").update(json).digest("hex"),
  };
  const boundedJson = JSON.stringify(bounded);
  return { value: bounded, json: boundedJson, sha256: createHash("sha256").update(boundedJson).digest("hex") };
};

const evidenceKind = (item: Record<string, unknown>): ProjectToolCall["evidenceKind"] => {
  if (item.type === "fileChange") return "FILE_CHANGE";
  if (item.type !== "commandExecution" || typeof item.command !== "string") return "TOOL";
  const command = item.command.toLowerCase();
  if (/(^|\s|&&|;)(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(pytest|vitest|jest|ctest)\b|\b(cargo|go|dotnet|swift)\s+test\b|\bmvn\s+test\b|\bgradle\w*\s+test\b|\bxcodebuild\b.*\btest\b/.test(command))
    return "TEST";
  if (/(^|\s|&&|;)(npm|pnpm|yarn)\s+(run\s+)?build\b|\b(cargo|go|dotnet|swift)\s+build\b|\bcmake\s+--build\b|\bmvn\s+package\b/.test(command))
    return "BUILD";
  return "TOOL";
};

export class ProjectToolCallStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_tool_calls(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
        fence_epoch INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_kind TEXT NOT NULL,
        request_json TEXT,
        result_json TEXT,
        request_sha256 TEXT,
        completion_sha256 TEXT,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(attempt_id,item_id));
      CREATE INDEX IF NOT EXISTS project_tool_calls_scope
        ON project_tool_calls(project_id,task_id,started_at DESC);
      CREATE INDEX IF NOT EXISTS project_tool_calls_evidence
        ON project_tool_calls(project_id,evidence_kind,status,started_at DESC);`);
  }

  private toolCall(row: ToolCallRow): ProjectToolCall {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      fenceEpoch: row.fence_epoch,
      memberId: row.member_id,
      itemId: row.item_id,
      type: row.type,
      status: row.status,
      evidenceKind: row.evidence_kind,
      ...(row.request_json ? { request: JSON.parse(row.request_json) as unknown } : {}),
      ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      startedAt: row.started_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  }

  private assertFence(projectId: string, taskId: string, attemptId: string, fenceEpoch: number) {
    const owner = this.db.prepare(
      `SELECT t.project_id,t.fence_epoch AS task_fence,a.fence_epoch AS attempt_fence,a.status
       FROM task_attempts a JOIN project_tasks t ON t.id=a.task_id
       WHERE a.id=? AND a.task_id=?`,
    ).get(attemptId, taskId) as {
      project_id: string; task_fence: number; attempt_fence: number; status: string;
    } | undefined;
    if (!owner || owner.project_id !== projectId) throw Error("Tool call references an unknown task attempt");
    if (owner.task_fence !== fenceEpoch || owner.attempt_fence !== fenceEpoch || owner.status !== "RUNNING")
      throw Error("Stale task fence cannot write tool-call evidence");
  }

  record(input: {
    projectId: string;
    taskId: string;
    attemptId: string;
    fenceEpoch: number;
    memberId: string;
    event: "started" | "completed";
    item: Record<string, unknown>;
    at?: number;
  }): ProjectToolCall {
    const projectId = required(input.projectId, "Project id", 64);
    const taskId = required(input.taskId, "Task id", 160);
    const attemptId = required(input.attemptId, "Attempt id", 200);
    const memberId = required(input.memberId, "Member id", 64);
    const itemId = required(input.item.id, "Tool item id", 240);
    const type = required(input.item.type, "Tool item type", 80);
    if (!Number.isSafeInteger(input.fenceEpoch) || input.fenceEpoch < 1) throw Error("Fence epoch must be a positive integer");
    const payload = encoded(input.item);
    const at = input.at ?? Date.now();
    const kind = evidenceKind(input.item);
    const rawExitCode = input.item.exitCode;
    const exitCode = Number.isSafeInteger(rawExitCode) ? Number(rawExitCode) : null;
    const completedStatus: ProjectToolCall["status"] =
      input.event === "started" ? "STARTED" :
        (String(input.item.status ?? "").toLowerCase().includes("fail") || (exitCode !== null && exitCode !== 0)) ? "FAILED" : "COMPLETED";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM project_tool_calls WHERE attempt_id=? AND item_id=?")
        .get(attemptId, itemId) as ToolCallRow | undefined;
      // An exact transport replay is read-only and remains safe after the
      // attempt reaches a terminal state. Any mutation still needs a live fence.
      if (input.event === "started") {
        if (existing) {
          if (existing.request_sha256 !== payload.sha256) throw Error("Tool item start was replayed with different data");
          this.db.exec("COMMIT");
          return this.toolCall(existing);
        }
        this.assertFence(projectId, taskId, attemptId, input.fenceEpoch);
        const id = randomUUID();
        this.db.prepare(
          `INSERT INTO project_tool_calls(
             id,project_id,task_id,attempt_id,fence_epoch,member_id,item_id,type,status,evidence_kind,
             request_json,result_json,request_sha256,completion_sha256,exit_code,started_at,completed_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,?,NULL)`,
        ).run(id, projectId, taskId, attemptId, input.fenceEpoch, memberId, itemId, type, "STARTED", kind, payload.json, payload.sha256, at);
      } else if (existing?.completion_sha256) {
        if (existing.completion_sha256 !== payload.sha256) throw Error("Tool item completion was replayed with different data");
        this.db.exec("COMMIT");
        return this.toolCall(existing);
      } else if (existing) {
        this.assertFence(projectId, taskId, attemptId, input.fenceEpoch);
        this.db.prepare(
          `UPDATE project_tool_calls SET status=?,evidence_kind=?,result_json=?,completion_sha256=?,exit_code=?,completed_at=?
           WHERE id=?`,
        ).run(completedStatus, kind, payload.json, payload.sha256, exitCode, at, existing.id);
      } else {
        this.assertFence(projectId, taskId, attemptId, input.fenceEpoch);
        const id = randomUUID();
        this.db.prepare(
          `INSERT INTO project_tool_calls(
             id,project_id,task_id,attempt_id,fence_epoch,member_id,item_id,type,status,evidence_kind,
             request_json,result_json,request_sha256,completion_sha256,exit_code,started_at,completed_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?,?,?,?)`,
        ).run(id, projectId, taskId, attemptId, input.fenceEpoch, memberId, itemId, type, completedStatus, kind, payload.json, payload.sha256, exitCode, at, at);
      }
      const row = this.db.prepare("SELECT * FROM project_tool_calls WHERE attempt_id=? AND item_id=?")
        .get(attemptId, itemId) as ToolCallRow;
      const record = this.toolCall(row);
      this.db.prepare(
        "INSERT INTO project_events(project_id,kind,from_member_id,to_member_id,detail_json,created_at) VALUES(?,?,?,?,?,?)",
      ).run(projectId, input.event === "started" ? "codex.item.started" : "codex.item.completed", memberId, memberId, JSON.stringify({
        toolCallId: record.id,
        taskId,
        attemptId,
        fenceEpoch: input.fenceEpoch,
        memberId,
        itemId,
        type,
        status: record.status,
        evidenceKind: record.evidenceKind,
        exitCode: record.exitCode,
        item: payload.value,
      }), at);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(projectId: string, options: { taskId?: string; evidenceKind?: ProjectToolCall["evidenceKind"]; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const clauses = ["project_id=?"];
    const values: Array<string | number> = [projectId];
    if (options.taskId) { clauses.push("task_id=?"); values.push(options.taskId); }
    if (options.evidenceKind) { clauses.push("evidence_kind=?"); values.push(options.evidenceKind); }
    values.push(limit);
    return (this.db.prepare(
      `SELECT * FROM project_tool_calls WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC,id LIMIT ?`,
    ).all(...values) as ToolCallRow[]).map((row) => this.toolCall(row));
  }

  close() { this.db.close(); }
}
