import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectTask, ProjectTaskAttempt, ProjectTaskExecutionReceipt, ProjectTaskLease, ProjectTaskRuntimeBinding, ProjectTaskStatus, UnknownSideEffectResolution } from "../api.js";
import { dpiHome } from "./registry.js";

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  input_json: string;
  status: ProjectTaskStatus;
  priority: number;
  max_attempts: number;
  timeout_ms: number | null;
  attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  fence_epoch: number;
  version: number;
  result_json: string | null;
  error_json: string | null;
  paused_from_status: ProjectTaskStatus | null;
  waiting_device_id: string | null;
  waiting_approval_id: string | null;
  deferred_attempt_count: number;
  created_at: number;
  updated_at: number;
};

type AttemptRow = {
  id: string;
  task_id: string;
  attempt_number: number;
  worker_id: string;
  fence_epoch: number;
  status: ProjectTaskAttempt["status"];
  started_at: number;
  heartbeat_at: number;
  finished_at: number | null;
  runtime_binding_json: string | null;
  result_json: string | null;
  error_json: string | null;
};

type ReceiptRow = {
  task_id: string;
  project_id: string;
  request_sha256: string;
  result_json: string;
  attempt_id: string;
  fence_epoch: number;
  created_at: number;
};

const required = (value: unknown, label: string, max = 160) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const clean = value.trim();
  if (clean.length > max) throw Error(`${label} must be at most ${max} characters`);
  return clean;
};

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = (value: string | null) => (value === null ? undefined : (JSON.parse(value) as unknown));
const targetMemberId = (inputJson: string): string | undefined => {
  const input = JSON.parse(inputJson) as { memberId?: unknown } | null;
  return typeof input?.memberId === "string" && input.memberId ? input.memberId : undefined;
};

type ExecutionMemberRow = {
  executor: "pi" | "codex";
  cwd: string | null;
  t3_environment_id: string | null;
};

const concurrencyLimit = (value: number | undefined, label: string) => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000)
    throw Error(`${label} must be an integer from 1 to 1000`);
  return value;
};

/**
 * Durable hub-level task queue. Claims run under BEGIN IMMEDIATE, and every
 * worker mutation is fenced by worker id + lease epoch + unexpired lease.
 */
export class ProjectTaskStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = join(dpiHome(), "projects.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_tasks(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        timeout_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        fence_epoch INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        error_json TEXT,
        paused_from_status TEXT,
        waiting_device_id TEXT,
        waiting_approval_id TEXT,
        deferred_attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_tasks_claim
        ON project_tasks(project_id,status,available_at,priority DESC,created_at);
      CREATE TABLE IF NOT EXISTS task_attempts(
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        fence_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        finished_at INTEGER,
        runtime_binding_json TEXT,
        result_json TEXT,
        error_json TEXT,
        UNIQUE(task_id,attempt_number));
      CREATE INDEX IF NOT EXISTS task_attempts_task
        ON task_attempts(task_id,attempt_number DESC);
      CREATE TABLE IF NOT EXISTS task_execution_receipts(
        task_id TEXT PRIMARY KEY REFERENCES project_tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        fence_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_execution_receipts_project
        ON task_execution_receipts(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS task_dependencies(
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id,depends_on_task_id),
        CHECK(task_id<>depends_on_task_id));
      CREATE INDEX IF NOT EXISTS task_dependencies_parent
        ON task_dependencies(depends_on_task_id,task_id);`);
    const columns = this.db.prepare("PRAGMA table_info(project_tasks)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "paused_from_status"))
      this.db.exec("ALTER TABLE project_tasks ADD COLUMN paused_from_status TEXT");
    if (!columns.some((column) => column.name === "timeout_ms"))
      this.db.exec("ALTER TABLE project_tasks ADD COLUMN timeout_ms INTEGER");
    if (!columns.some((column) => column.name === "waiting_device_id"))
      this.db.exec("ALTER TABLE project_tasks ADD COLUMN waiting_device_id TEXT");
    if (!columns.some((column) => column.name === "waiting_approval_id"))
      this.db.exec("ALTER TABLE project_tasks ADD COLUMN waiting_approval_id TEXT");
    if (!columns.some((column) => column.name === "deferred_attempt_count"))
      this.db.exec("ALTER TABLE project_tasks ADD COLUMN deferred_attempt_count INTEGER NOT NULL DEFAULT 0");
    const attemptColumns = this.db.prepare("PRAGMA table_info(task_attempts)").all() as { name: string }[];
    if (!attemptColumns.some((column) => column.name === "runtime_binding_json"))
      this.db.exec("ALTER TABLE task_attempts ADD COLUMN runtime_binding_json TEXT");
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

  private task(row: TaskRow): ProjectTask {
    const dependsOn = (
      this.db
        .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id")
        .all(row.id) as { depends_on_task_id: string }[]
    ).map((dependency) => dependency.depends_on_task_id);
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      input: JSON.parse(row.input_json) as unknown,
      dependsOn,
      status: row.status,
      priority: row.priority,
      maxAttempts: row.max_attempts,
      ...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
      attemptCount: row.attempt_count,
      ...(row.deferred_attempt_count ? { deferredAttemptCount: row.deferred_attempt_count } : {}),
      availableAt: row.available_at,
      ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
      ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
      fenceEpoch: row.fence_epoch,
      version: row.version,
      ...(row.result_json !== null ? { result: parse(row.result_json) } : {}),
      ...(row.error_json !== null ? { error: parse(row.error_json) } : {}),
      ...(row.paused_from_status ? { pausedFromStatus: row.paused_from_status } : {}),
      ...(row.waiting_device_id ? { waitingDeviceId: row.waiting_device_id } : {}),
      ...(row.waiting_approval_id ? { waitingApprovalId: row.waiting_approval_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private row(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM project_tasks WHERE id=?").get(id) as TaskRow | undefined;
  }

  private event(projectId: string, kind: string, detail: unknown, at: number) {
    this.db
      .prepare(
        `INSERT INTO project_events(project_id,kind,detail_json,created_at)
         VALUES(?,?,?,?)`,
      )
      .run(projectId, kind, json(detail), at);
  }

  get(id: string): ProjectTask | undefined {
    const row = this.row(id);
    return row ? this.task(row) : undefined;
  }

  list(projectId: string, limit = 100): ProjectTask[] {
    return (
      this.db
        .prepare("SELECT * FROM project_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, Math.max(1, Math.min(500, limit))) as TaskRow[]
    ).map((row) => this.task(row));
  }

  /** Bounded task history addressed to one Agent. This query never returns
   * another member's task and is used by project-scoped worker tools. */
  listForMember(projectId: string, memberId: string, limit = 100): ProjectTask[] {
    const bounded = Math.max(1, Math.min(500, limit));
    return (
      this.db.prepare(
        `SELECT * FROM project_tasks
         WHERE project_id=? AND json_valid(input_json) AND json_extract(input_json,'$.memberId')=?
         ORDER BY created_at DESC LIMIT ?`,
      ).all(projectId, memberId, bounded) as TaskRow[]
    ).map((row) => this.task(row));
  }

  /** Cross-project paused work for runtime monitors. Callers must still inspect the
   * structured pause reason; this intentionally excludes every other task state. */
  paused(limit = 500): ProjectTask[] {
    return (
      this.db
        .prepare("SELECT * FROM project_tasks WHERE status='PAUSED' ORDER BY updated_at ASC LIMIT ?")
        .all(Math.max(1, Math.min(5_000, limit))) as TaskRow[]
    ).map((row) => this.task(row));
  }

  /** Exact count of unfinished work, used for admission control instead of a paginated task list. */
  activeCount(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM project_tasks
         WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
      )
      .get(projectId) as { count: number };
    return row.count;
  }

  /** Exact unfinished-task count for one project member without relying on a paginated list. */
  activeCountForMember(projectId: string, memberId: string): number {
    return (this.db
      .prepare(
        `SELECT input_json FROM project_tasks
         WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
      )
      .all(projectId) as Array<{ input_json: string }>).filter(({ input_json }) => {
        const input = JSON.parse(input_json) as { memberId?: unknown } | null;
        return input?.memberId === memberId;
      }).length;
  }

  /** Every persisted T3 thread used by a project member, including older task
   * threads no longer stored as that member's current execution thread. */
  t3ThreadHistory(projectId: string): Array<{
    memberId: string;
    threadId: string;
    environmentId?: string;
  }> {
    const rows = this.db.prepare(
      `SELECT t.input_json,a.runtime_binding_json
       FROM project_tasks t JOIN task_attempts a ON a.task_id=t.id
       WHERE t.project_id=? AND a.runtime_binding_json IS NOT NULL
       ORDER BY a.started_at,a.id`,
    ).all(projectId) as Array<{ input_json: string; runtime_binding_json: string }>;
    const unique = new Map<string, { memberId: string; threadId: string; environmentId?: string }>();
    for (const row of rows) {
      const memberId = targetMemberId(row.input_json);
      const runtime = JSON.parse(row.runtime_binding_json) as ProjectTaskRuntimeBinding;
      if (!memberId || runtime.kind !== "t3" || !runtime.threadId) continue;
      const candidate = {
        memberId,
        threadId: runtime.threadId,
        ...(runtime.environmentId ? { environmentId: runtime.environmentId } : {}),
      };
      unique.set(`${runtime.environmentId ?? "local"}\0${runtime.threadId}`, candidate);
    }
    return [...unique.values()];
  }

  /** Current per-Agent queue projection for coordination decisions. Task input
   * and results are deliberately excluded; only bounded scheduling metadata is
   * returned. */
  memberWorkloads(projectId: string, taskLimitPerMember = 20) {
    if (!Number.isSafeInteger(taskLimitPerMember) || taskLimitPerMember < 1 || taskLimitPerMember > 100)
      throw Error("taskLimitPerMember must be an integer from 1 to 100");
    const rows = this.db.prepare(
      `SELECT id,title,input_json,status,priority,updated_at FROM project_tasks
       WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')
       ORDER BY priority DESC,created_at,id`,
    ).all(projectId) as Array<Pick<TaskRow, "id" | "title" | "input_json" | "status" | "priority" | "updated_at">>;
    const workloads = new Map<string, {
      activeTaskCount: number;
      statusCounts: Partial<Record<ProjectTaskStatus, number>>;
      tasks: Array<{ id: string; title: string; status: ProjectTaskStatus; priority: number; updatedAt: number }>;
      truncated: boolean;
    }>();
    for (const row of rows) {
      const memberId = targetMemberId(row.input_json);
      if (!memberId) continue;
      const workload = workloads.get(memberId) ?? {
        activeTaskCount: 0,
        statusCounts: {},
        tasks: [],
        truncated: false,
      };
      workload.activeTaskCount += 1;
      workload.statusCounts[row.status] = (workload.statusCounts[row.status] ?? 0) + 1;
      if (workload.tasks.length < taskLimitPerMember)
        workload.tasks.push({
          id: row.id,
          title: row.title,
          status: row.status,
          priority: row.priority,
          updatedAt: row.updated_at,
        });
      else workload.truncated = true;
      workloads.set(memberId, workload);
    }
    return workloads;
  }

  attempts(taskId: string): ProjectTaskAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM task_attempts WHERE task_id=? ORDER BY attempt_number")
        .all(taskId) as AttemptRow[]
    ).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      attemptNumber: row.attempt_number,
      workerId: row.worker_id,
      fenceEpoch: row.fence_epoch,
      status: row.status,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
      ...(row.runtime_binding_json !== null
        ? { runtime: JSON.parse(row.runtime_binding_json) as ProjectTaskRuntimeBinding }
        : {}),
      ...(row.result_json !== null ? { result: parse(row.result_json) } : {}),
      ...(row.error_json !== null ? { error: parse(row.error_json) } : {}),
    }));
  }

  /**
   * Persist the external harness identity before treating its work as owned by
   * this attempt. A live fence may fill missing fields, but can never replace a
   * previously recorded identity.
   */
  bindRuntime(
    id: string,
    workerId: string,
    fenceEpoch: number,
    binding: ProjectTaskRuntimeBinding,
    now = Date.now(),
  ): ProjectTaskRuntimeBinding {
    const clean = (value: unknown, label: string, max = 512) => {
      if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
      const result = value.trim();
      if (result.length > max) throw Error(`${label} must be at most ${max} characters`);
      return result;
    };
    if (!(["t3", "codex-app-server", "pi-durable", "deepseek-harness", "antigravity", "pi-cli"] as unknown[]).includes(binding.kind))
      throw Error("Unknown task runtime kind");
    const incoming: ProjectTaskRuntimeBinding = {
      kind: binding.kind,
      threadId: clean(binding.threadId, "Runtime thread id"),
      ...(binding.runId ? { runId: clean(binding.runId, "Runtime run id") } : {}),
      ...(binding.environmentId ? { environmentId: clean(binding.environmentId, "Runtime environment id") } : {}),
      ...(binding.provider ? { provider: clean(binding.provider, "Runtime provider", 160) } : {}),
      ...(binding.model ? { model: clean(binding.model, "Runtime model", 160) } : {}),
    };
    return this.transaction(() => {
      const task = this.fenced(id, workerId, fenceEpoch, now);
      const attempt = this.db
        .prepare(`SELECT id,runtime_binding_json FROM task_attempts
          WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`)
        .get(id, fenceEpoch) as { id: string; runtime_binding_json: string | null } | undefined;
      if (!attempt) throw Error("Current task attempt is missing");
      const existing = attempt.runtime_binding_json
        ? JSON.parse(attempt.runtime_binding_json) as ProjectTaskRuntimeBinding
        : undefined;
      if (existing) {
        for (const key of ["kind", "threadId", "runId", "environmentId", "provider", "model"] as const) {
          if (existing[key] !== undefined && incoming[key] !== undefined && existing[key] !== incoming[key])
            throw Error(`Task runtime ${key} is already bound to a different value`);
        }
      }
      const merged: ProjectTaskRuntimeBinding = { ...existing, ...incoming };
      this.db.prepare("UPDATE task_attempts SET runtime_binding_json=? WHERE id=?")
        .run(json(merged), attempt.id);
      this.event(task.project_id, existing ? "task.runtime.updated" : "task.runtime.bound", {
        taskId: id,
        attemptId: attempt.id,
        fenceEpoch,
        runtime: merged,
      }, now);
      return merged;
    });
  }

  executionReceipt(taskId: string): ProjectTaskExecutionReceipt | undefined {
    const row = this.db.prepare("SELECT * FROM task_execution_receipts WHERE task_id=?").get(taskId) as ReceiptRow | undefined;
    return row ? {
      taskId: row.task_id,
      projectId: row.project_id,
      requestSha256: row.request_sha256,
      result: JSON.parse(row.result_json) as unknown,
      attemptId: row.attempt_id,
      fenceEpoch: row.fence_epoch,
      createdAt: row.created_at,
    } : undefined;
  }

  recordExecutionReceipt(
    id: string,
    workerId: string,
    fenceEpoch: number,
    requestSha256: string,
    result: unknown,
    now = Date.now(),
  ): ProjectTaskExecutionReceipt {
    if (!/^[a-f0-9]{64}$/.test(requestSha256)) throw Error("Execution receipt request hash must be SHA-256");
    return this.transaction(() => {
      const existing = this.executionReceipt(id);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) throw Error("Execution receipt input hash mismatch");
        return existing;
      }
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const attempt = this.db
        .prepare("SELECT id FROM task_attempts WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL")
        .get(id, fenceEpoch) as { id: string } | undefined;
      if (!attempt) throw Error("Current task attempt is missing");
      this.db.prepare(
        `INSERT INTO task_execution_receipts(
           task_id,project_id,request_sha256,result_json,attempt_id,fence_epoch,created_at)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(id, row.project_id, requestSha256, json(result), attempt.id, fenceEpoch, now);
      this.event(row.project_id, "task.execution_receipt_recorded", {
        taskId: id,
        attemptId: attempt.id,
        fenceEpoch,
        requestSha256,
      }, now);
      return this.executionReceipt(id)!;
    });
  }

  enqueue(
    projectId: string,
    input: {
      id?: string;
      title: string;
      input?: unknown;
      priority?: number;
      maxAttempts?: number;
      timeoutMs?: number;
      dependsOn?: string[];
      availableAt?: number;
    },
    now = Date.now(),
    maxActiveTasks?: number,
  ): ProjectTask {
    if (maxActiveTasks !== undefined &&
        (!Number.isSafeInteger(maxActiveTasks) || maxActiveTasks < 1 || maxActiveTasks > 10_000))
      throw Error("maxActiveTasks must be an integer from 1 to 10000");
    const id = input.id ? required(input.id, "Task id", 128) : randomUUID();
    const title = required(input.title, "Task title", 240);
    const priority = Number.isSafeInteger(input.priority) ? Number(input.priority) : 0;
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw Error("maxAttempts must be an integer from 1 to 20");
    const timeoutMs = input.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000))
      throw Error("timeoutMs must be an integer from 1000 to 86400000");
    if (input.dependsOn !== undefined && !Array.isArray(input.dependsOn)) throw Error("dependsOn must be an array");
    const dependsOn = [...new Set((input.dependsOn ?? []).map((dependency) =>
      required(dependency, "Dependency task id", 128)))].sort();
    if (dependsOn.length > 64) throw Error("dependsOn must contain at most 64 task ids");
    if (dependsOn.includes(id)) throw Error("A task cannot depend on itself");
    const availableAt = input.availableAt ?? now;
    if (!Number.isSafeInteger(availableAt) || availableAt < 0) throw Error("availableAt must be a timestamp");
    return this.transaction(() => {
      const project = this.db.prepare(
        `SELECT p.id, d.project_id AS deleting
         FROM projects p LEFT JOIN project_deletion_locks d ON d.project_id=p.id
         WHERE p.id=?`,
      ).get(projectId) as { id: string; deleting: string | null } | undefined;
      if (!project) throw Error(`Unknown project: ${projectId}`);
      if (project.deleting) throw Object.assign(Error("Project deletion is in progress"), { status: 409 });
      for (const dependency of dependsOn) {
        const parent = this.row(dependency);
        if (!parent || parent.project_id !== projectId)
          throw Error(`Dependency is not in project ${projectId}: ${dependency}`);
        if (parent.status === "FAILED" || parent.status === "CANCELLED")
          throw Error(`Dependency is already ${parent.status.toLowerCase()}: ${dependency}`);
      }
      if (maxActiveTasks !== undefined) {
        const active = this.db.prepare(
          `SELECT COUNT(*) AS count FROM project_tasks
           WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
        ).get(projectId) as { count: number };
        if (active.count >= maxActiveTasks)
          throw Error(`Project active task limit reached (${maxActiveTasks})`);
      }
      const waiting = dependsOn.some((dependency) => this.row(dependency)!.status !== "COMPLETED");
      const status: ProjectTaskStatus = waiting ? "WAITING_DEPENDENCY" : "QUEUED";
      this.db
        .prepare(
          `INSERT INTO project_tasks(
             id,project_id,title,input_json,status,priority,max_attempts,timeout_ms,available_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, projectId, title, json(input.input), status, priority, maxAttempts, timeoutMs ?? null, availableAt, now, now);
      for (const dependency of dependsOn)
        this.db
          .prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)")
          .run(id, dependency);
      this.event(
        projectId,
        waiting ? "task.waiting_dependency" : "task.queued",
        { taskId: id, title, priority, dependsOn },
        now,
      );
      return this.task(this.row(id)!);
    });
  }

  /**
   * Atomically admits a Coordinator-created task. The idempotency lookup,
   * per-turn/project limits and insert share one write transaction so parallel
   * dynamic tool calls cannot both pass a stale count.
   */
  enqueueCoordination(
    projectId: string,
    input: {
      id: string;
      title: string;
      input: unknown;
      priority?: number;
      maxAttempts?: number;
      timeoutMs?: number;
      dependsOn?: string[];
    },
    limits: { coordinatorTaskId: string; maxDelegatedTasksPerTurn: number; maxActiveProjectTasks: number },
    now = Date.now(),
  ): ProjectTask {
    const id = required(input.id, "Task id", 128);
    const title = required(input.title, "Task title", 240);
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority) || priority < -1_000 || priority > 1_000)
      throw Error("priority must be an integer from -1000 to 1000");
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw Error("maxAttempts must be an integer from 1 to 20");
    const timeoutMs = input.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000))
      throw Error("timeoutMs must be an integer from 1000 to 86400000");
    if (input.dependsOn !== undefined && !Array.isArray(input.dependsOn)) throw Error("dependsOn must be an array");
    const dependsOn = [...new Set((input.dependsOn ?? []).map((dependency) =>
      required(dependency, "Dependency task id", 128)))].sort();
    if (dependsOn.length > 64) throw Error("dependsOn must contain at most 64 task ids");
    if (dependsOn.includes(id)) throw Error("A task cannot depend on itself");
    const coordinatorTaskId = required(limits.coordinatorTaskId, "Coordinator task id", 128);
    for (const [label, value] of [
      ["maxDelegatedTasksPerTurn", limits.maxDelegatedTasksPerTurn],
      ["maxActiveProjectTasks", limits.maxActiveProjectTasks],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
        throw Error(`${label} must be an integer from 1 to 10000`);
    }
    return this.transaction(() => {
      const project = this.db.prepare(
        `SELECT p.id, d.project_id AS deleting
         FROM projects p LEFT JOIN project_deletion_locks d ON d.project_id=p.id
         WHERE p.id=?`,
      ).get(projectId) as { id: string; deleting: string | null } | undefined;
      if (!project) throw Error(`Unknown project: ${projectId}`);
      if (project.deleting) throw Object.assign(Error("Project deletion is in progress"), { status: 409 });
      const existing = this.row(id);
      if (existing) {
        const existingTask = this.task(existing);
        if (existing.project_id !== projectId || existing.title !== title || existing.input_json !== json(input.input) ||
            existing.priority !== priority || existing.max_attempts !== maxAttempts ||
            existing.timeout_ms !== (timeoutMs ?? null) ||
            JSON.stringify(existingTask.dependsOn) !== JSON.stringify(dependsOn))
          throw Error("Dynamic tool call id was reused with different send_project_task arguments");
        return existingTask;
      }
      const delegatedThisTurn = (this.db
        .prepare("SELECT input_json FROM project_tasks WHERE project_id=?")
        .all(projectId) as Array<{ input_json: string }>).filter(({ input_json }) => {
          const taskInput = JSON.parse(input_json) as { payload?: Record<string, unknown> } | null;
          return taskInput?.payload?.coordinatorTaskId === coordinatorTaskId;
        }).length;
      if (delegatedThisTurn >= limits.maxDelegatedTasksPerTurn)
        throw Error(`Coordinator task delegation limit reached (${limits.maxDelegatedTasksPerTurn})`);
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM project_tasks
           WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
        )
        .get(projectId) as { count: number };
      if (active.count >= limits.maxActiveProjectTasks)
        throw Error(`Project active task limit reached (${limits.maxActiveProjectTasks})`);
      for (const dependency of dependsOn) {
        const parent = this.row(dependency);
        if (!parent || parent.project_id !== projectId)
          throw Error(`Dependency is not in project ${projectId}: ${dependency}`);
        if (parent.status === "FAILED" || parent.status === "CANCELLED")
          throw Error(`Dependency is already ${parent.status.toLowerCase()}: ${dependency}`);
      }
      const waiting = dependsOn.some((dependency) => this.row(dependency)!.status !== "COMPLETED");
      const status: ProjectTaskStatus = waiting ? "WAITING_DEPENDENCY" : "QUEUED";
      this.db
        .prepare(
          `INSERT INTO project_tasks(
             id,project_id,title,input_json,status,priority,max_attempts,timeout_ms,available_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, projectId, title, json(input.input), status, priority, maxAttempts, timeoutMs ?? null, now, now, now);
      for (const dependency of dependsOn)
        this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)").run(id, dependency);
      this.event(projectId, waiting ? "task.waiting_dependency" : "task.queued", {
        taskId: id, title, priority, maxAttempts, timeoutMs, dependsOn, coordinatorTaskId,
      }, now);
      return this.task(this.row(id)!);
    });
  }

  private releaseDependents(completedTaskId: string, now: number) {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM project_tasks t
         JOIN task_dependencies d ON d.task_id=t.id
         WHERE d.depends_on_task_id=? AND t.status='WAITING_DEPENDENCY'`,
      )
      .all(completedTaskId) as TaskRow[];
    for (const row of rows) {
      const blocked = this.db
        .prepare(
          `SELECT 1 FROM task_dependencies d
           JOIN project_tasks parent ON parent.id=d.depends_on_task_id
           WHERE d.task_id=? AND parent.status<>'COMPLETED' LIMIT 1`,
        )
        .get(row.id);
      if (blocked) continue;
      this.db
        .prepare("UPDATE project_tasks SET status='QUEUED',version=version+1,updated_at=? WHERE id=?")
        .run(now, row.id);
      this.event(row.project_id, "task.dependency_ready", { taskId: row.id, completedTaskId }, now);
    }
  }

  private failDependents(parentTaskId: string, parentStatus: "FAILED" | "CANCELLED", now: number) {
    const pending = [parentTaskId];
    while (pending.length) {
      const failedParentId = pending.shift()!;
      const rows = this.db
        .prepare(
          `SELECT t.* FROM project_tasks t
           JOIN task_dependencies d ON d.task_id=t.id
           WHERE d.depends_on_task_id=? AND t.status IN ('WAITING_DEPENDENCY','QUEUED','RETRYING')`,
        )
        .all(failedParentId) as TaskRow[];
      for (const row of rows) {
        const error = { code: "DEPENDENCY_FAILED", dependencyTaskId: failedParentId, dependencyStatus: parentStatus };
        this.db
          .prepare(
            `UPDATE project_tasks SET status='FAILED',error_json=?,version=version+1,updated_at=?
             WHERE id=?`,
          )
          .run(json(error), now, row.id);
        this.event(row.project_id, "task.dependency_failed", { taskId: row.id, ...error }, now);
        pending.push(row.id);
      }
    }
  }

  private expireExhausted(projectId: string, now: number) {
    const rows = this.db
      .prepare(
        `SELECT * FROM project_tasks
         WHERE project_id=? AND status IN ('RUNNING','WAITING_APPROVAL') AND lease_until<=?
           AND (attempt_count-deferred_attempt_count)>=max_attempts`,
      )
      .all(projectId, now) as TaskRow[];
    for (const row of rows) {
      const attempt = this.db
        .prepare(
          `SELECT runtime_binding_json FROM task_attempts
           WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
        )
        .get(row.id, row.fence_epoch) as { runtime_binding_json: string | null } | undefined;
      const runtime = parse(attempt?.runtime_binding_json ?? null) as {
        kind?: unknown;
        threadId?: unknown;
        runId?: unknown;
      } | undefined;
      if (runtime?.kind === "t3" && typeof runtime.threadId === "string" && typeof runtime.runId === "string") {
        const error = { code: "LEASE_EXPIRED", message: "Lease expired; recover the existing T3 run" };
        this.db
          .prepare(
            `UPDATE project_tasks SET status='RETRYING',lease_owner=NULL,lease_until=NULL,
               deferred_attempt_count=deferred_attempt_count+1,error_json=?,version=version+1,updated_at=?
             WHERE id=? AND fence_epoch=?`,
          )
          .run(json(error), now, row.id, row.fence_epoch);
        this.db
          .prepare(
            `UPDATE task_attempts SET status='EXPIRED',finished_at=?,error_json=?
             WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
          )
          .run(now, json(error), row.id, row.fence_epoch);
        this.event(projectId, "task.runtime_recovery_queued", {
          taskId: row.id,
          fenceEpoch: row.fence_epoch,
          threadId: runtime.threadId,
          runId: runtime.runId,
        }, now);
        continue;
      }
      const error = { code: "LEASE_EXPIRED", message: "Lease expired and the task exhausted its attempts" };
      this.db
        .prepare(
          `UPDATE project_tasks SET status='FAILED',lease_owner=NULL,lease_until=NULL,
             error_json=?,version=version+1,updated_at=? WHERE id=? AND fence_epoch=?`,
        )
        .run(json(error), now, row.id, row.fence_epoch);
      this.db
        .prepare(
          `UPDATE task_attempts SET status='EXPIRED',finished_at=?,error_json=?
           WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
        )
        .run(now, json(error), row.id, row.fence_epoch);
      this.event(projectId, "task.failed", { taskId: row.id, fenceEpoch: row.fence_epoch, error }, now);
    }
  }

  claim(
    projectId: string,
    workerId: string,
    options: {
      leaseMs?: number;
      now?: number;
      maxGlobalRunning?: number;
      maxProjectRunning?: number;
      maxWorkerRunning?: number;
    } = {},
  ): ProjectTaskLease | undefined {
    const worker = required(workerId, "Worker id", 128);
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000)
      throw Error("leaseMs must be an integer from 1000 to 3600000");
    const maxGlobalRunning = concurrencyLimit(options.maxGlobalRunning, "maxGlobalRunning");
    const maxProjectRunning = concurrencyLimit(options.maxProjectRunning, "maxProjectRunning");
    const maxWorkerRunning = concurrencyLimit(options.maxWorkerRunning, "maxWorkerRunning");
    return this.transaction(() => {
      this.expireExhausted(projectId, now);
      const active = (where: string, params: string[]) =>
        Number(
          (
            this.db
              .prepare(`SELECT COUNT(*) AS count FROM project_tasks WHERE status IN ('RUNNING','WAITING_APPROVAL') AND lease_until>? ${where}`)
              .get(now, ...params) as { count: number }
          ).count,
        );
      if (maxGlobalRunning !== undefined && active("", []) >= maxGlobalRunning) return undefined;
      if (maxProjectRunning !== undefined && active("AND project_id=?", [projectId]) >= maxProjectRunning)
        return undefined;
      if (maxWorkerRunning !== undefined && active("AND lease_owner=?", [worker]) >= maxWorkerRunning)
        return undefined;
      const executionResource = (memberId: string) => {
        const member = this.db.prepare(
          "SELECT executor,cwd,t3_environment_id FROM project_members WHERE project_id=? AND id=? AND lifecycle_state!='ARCHIVED'",
        ).get(projectId, memberId) as ExecutionMemberRow | undefined;
        if ((member?.executor === "codex" || member?.executor === "pi") && member.cwd) {
          if (member.t3_environment_id) {
            const targetPath = member.cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
            return `t3-workspace:${member.t3_environment_id}:${targetPath}`;
          }
          const absolute = resolve(member.cwd);
          const workspace = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
          return `workspace:${process.platform === "win32" ? workspace.toLowerCase() : workspace}`;
        }
        return `member:${memberId}`;
      };
      const activeExecutionResources = new Set(
        (this.db.prepare(
          `SELECT input_json FROM project_tasks
           WHERE project_id=? AND status IN ('RUNNING','WAITING_APPROVAL') AND lease_until>?`,
        ).all(projectId, now) as Array<{ input_json: string }>)
          .map(({ input_json }) => targetMemberId(input_json))
          .filter((memberId): memberId is string => Boolean(memberId))
          .map(executionResource),
      );
      const candidates = this.db
        .prepare(
          `SELECT * FROM project_tasks
           WHERE project_id=? AND available_at<=? AND (attempt_count-deferred_attempt_count)<max_attempts
             AND (status IN ('QUEUED','RETRYING') OR (status IN ('RUNNING','WAITING_APPROVAL') AND lease_until<=?))
           ORDER BY priority DESC,created_at,id`,
        )
        .all(projectId, now, now) as TaskRow[];
      const row = candidates.find((candidate) => {
        const memberId = targetMemberId(candidate.input_json);
        return !memberId || !activeExecutionResources.has(executionResource(memberId));
      });
      if (!row) return undefined;

      const supersededApprovalId = row.status === "WAITING_APPROVAL" ? row.waiting_approval_id : null;
      if (row.status === "RUNNING" || row.status === "WAITING_APPROVAL") {
        this.db
          .prepare(
            `UPDATE task_attempts SET status='EXPIRED',finished_at=?,error_json=?
             WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
          )
          .run(now, json({ code: "LEASE_EXPIRED" }), row.id, row.fence_epoch);
      }
      const fenceEpoch = row.fence_epoch + 1;
      const attemptNumber = row.attempt_count + 1;
      const attemptId = randomUUID();
      const leaseUntil = now + leaseMs;
      const changed = this.db
        .prepare(
          `UPDATE project_tasks SET status='RUNNING',attempt_count=?,lease_owner=?,lease_until=?,
             fence_epoch=?,version=version+1,error_json=NULL,waiting_approval_id=NULL,updated_at=?
           WHERE id=? AND version=?`,
        )
        .run(attemptNumber, worker, leaseUntil, fenceEpoch, now, row.id, row.version).changes;
      if (changed !== 1) throw Error("Task changed while it was being claimed");
      this.db
        .prepare(
          `INSERT INTO task_attempts(
             id,task_id,attempt_number,worker_id,fence_epoch,status,started_at,heartbeat_at)
           VALUES(?,?,?,?,?,'RUNNING',?,?)`,
        )
        .run(attemptId, row.id, attemptNumber, worker, fenceEpoch, now, now);
      this.event(projectId, "task.claimed", { taskId: row.id, attemptId, attemptNumber, workerId: worker, fenceEpoch, leaseUntil }, now);
      return {
        ...this.task(this.row(row.id)!),
        status: "RUNNING",
        leaseOwner: worker,
        leaseUntil,
        attemptId,
        attemptNumber,
        ...(supersededApprovalId ? { supersededApprovalId } : {}),
      };
    });
  }

  private fenced(id: string, workerId: string, fenceEpoch: number, now: number) {
    const row = this.db
      .prepare(
        `SELECT * FROM project_tasks WHERE id=? AND status IN ('RUNNING','WAITING_APPROVAL') AND lease_owner=?
         AND fence_epoch=? AND lease_until>?`,
      )
      .get(id, workerId, fenceEpoch, now) as TaskRow | undefined;
    if (!row) throw Error("Stale or expired task lease");
    return row;
  }

  heartbeat(id: string, workerId: string, fenceEpoch: number, leaseMs = 30_000, now = Date.now()) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000)
      throw Error("leaseMs must be an integer from 1000 to 3600000");
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const leaseUntil = now + leaseMs;
      this.db
        .prepare("UPDATE project_tasks SET lease_until=?,version=version+1,updated_at=? WHERE id=?")
        .run(leaseUntil, now, id);
      this.db
        .prepare("UPDATE task_attempts SET heartbeat_at=? WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL")
        .run(now, id, fenceEpoch);
      return { ...this.task(this.row(id)!), leaseUntil, projectId: row.project_id };
    });
  }

  waitForDevice(
    id: string,
    workerId: string,
    fenceEpoch: number,
    deviceId: string,
    deviceStatus: string,
    options: {
      now?: number;
      blockedTask?: { id: string; title: string; input: unknown };
    } = {},
  ) {
    const now = options.now ?? Date.now();
    const device = required(deviceId, "Device id", 64);
    const status = required(deviceStatus, "Device status", 40);
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const error = { code: "DEVICE_UNAVAILABLE", deviceId: device, deviceStatus: status };
      this.db.prepare(
        `UPDATE project_tasks SET status='WAITING_DEVICE',waiting_device_id=?,error_json=?,
           lease_owner=NULL,lease_until=NULL,deferred_attempt_count=deferred_attempt_count+1,
           version=version+1,updated_at=? WHERE id=?`,
      ).run(device, json(error), now, id);
      this.db.prepare(
        `UPDATE task_attempts SET status='WAITING_DEVICE',finished_at=?,error_json=?
         WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
      ).run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, "task.waiting_device", { taskId: id, workerId, fenceEpoch, ...error }, now);
      if (options.blockedTask) {
        const notificationId = required(options.blockedTask.id, "Blocked notification task id", 128);
        const notificationTitle = required(options.blockedTask.title, "Blocked notification task title", 240);
        const existing = this.row(notificationId);
        if (existing) {
          if (existing.project_id !== row.project_id || existing.title !== notificationTitle ||
              existing.input_json !== json(options.blockedTask.input))
            throw Error("Stored blocked notification does not match the immutable waiting task");
        } else {
          this.db
            .prepare(
              `INSERT INTO project_tasks(
                 id,project_id,title,input_json,status,priority,max_attempts,available_at,created_at,updated_at)
               VALUES(?,?,?,?, 'QUEUED',0,3,?,?,?)`,
            )
            .run(notificationId, row.project_id, notificationTitle, json(options.blockedTask.input), now, now, now);
          this.event(row.project_id, "task.queued", {
            taskId: notificationId,
            title: notificationTitle,
            priority: 0,
            dependsOn: [],
            sourceBlockedTaskId: id,
          }, now);
        }
      }
      return this.task(this.row(id)!);
    });
  }

  resumeDevice(deviceId: string, now = Date.now()) {
    const device = required(deviceId, "Device id", 64);
    return this.transaction(() => {
      const rows = this.db.prepare(
        "SELECT * FROM project_tasks WHERE status='WAITING_DEVICE' AND waiting_device_id=? ORDER BY created_at,id",
      ).all(device) as TaskRow[];
      for (const row of rows) {
        this.db.prepare(
          `UPDATE project_tasks SET status='QUEUED',waiting_device_id=NULL,error_json=NULL,available_at=?,
             version=version+1,updated_at=? WHERE id=? AND status='WAITING_DEVICE'`,
        ).run(now, now, row.id);
        this.event(row.project_id, "task.device_resumed", { taskId: row.id, deviceId: device }, now);
      }
      return rows.length;
    });
  }

  waitingDeviceIds() {
    return (this.db.prepare(
      "SELECT DISTINCT waiting_device_id AS id FROM project_tasks WHERE status='WAITING_DEVICE' AND waiting_device_id IS NOT NULL ORDER BY waiting_device_id",
    ).all() as Array<{ id: string }>).map((row) => row.id);
  }

  deferForProvider(
    id: string,
    workerId: string,
    fenceEpoch: number,
    provider: string,
    model: string,
    retryAt: number,
    now = Date.now(),
  ) {
    if (!Number.isSafeInteger(retryAt) || retryAt <= now) throw Error("Provider retryAt must be a future timestamp");
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const error = { code: "PROVIDER_CIRCUIT_OPEN", provider, model, retryAt };
      this.db.prepare(
        `UPDATE project_tasks SET status='RETRYING',available_at=?,error_json=?,
           lease_owner=NULL,lease_until=NULL,deferred_attempt_count=deferred_attempt_count+1,
           version=version+1,updated_at=? WHERE id=?`,
      ).run(retryAt, json(error), now, id);
      this.db.prepare(
        `UPDATE task_attempts SET status='WAITING_PROVIDER',finished_at=?,error_json=?
         WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
      ).run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, "task.waiting_provider", { taskId: id, workerId, fenceEpoch, ...error }, now);
      return this.task(this.row(id)!);
    });
  }

  waitForApproval(
    id: string,
    workerId: string,
    fenceEpoch: number,
    approvalId: string,
    now = Date.now(),
  ) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      this.db
        .prepare("UPDATE project_tasks SET status='WAITING_APPROVAL',waiting_approval_id=?,version=version+1,updated_at=? WHERE id=?")
        .run(approvalId, now, id);
      this.event(row.project_id, "task.waiting_approval", { taskId: id, workerId, fenceEpoch, approvalId }, now);
      return this.task(this.row(id)!);
    });
  }

  resumeFromApproval(id: string, workerId: string, fenceEpoch: number, approvalId: string, now = Date.now()) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      if (row.status !== "WAITING_APPROVAL") throw Error("Task is not waiting for approval");
      if (row.waiting_approval_id !== approvalId) throw Error("Approval does not belong to the current task lease");
      this.db
        .prepare("UPDATE project_tasks SET status='RUNNING',waiting_approval_id=NULL,version=version+1,updated_at=? WHERE id=?")
        .run(now, id);
      this.event(row.project_id, "task.approval_resolved", { taskId: id, workerId, fenceEpoch, approvalId }, now);
      return this.task(this.row(id)!);
    });
  }

  pauseForBudget(
    id: string,
    workerId: string,
    fenceEpoch: number,
    detail: { limit: number; used: number; windowMs: number; scope?: "PROJECT_24H" | "TASK" },
    now = Date.now(),
  ) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const error = { code: "TOKEN_BUDGET_EXCEEDED", ...detail };
      this.db
        .prepare(
          `UPDATE project_tasks SET status='PAUSED',paused_from_status='QUEUED',error_json=?,
           lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=? WHERE id=?`,
        )
        .run(json(error), now, id);
      this.db
        .prepare(
          `UPDATE task_attempts SET status='CANCELLED',finished_at=?,error_json=?
           WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
        )
        .run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, "task.budget_paused", { taskId: id, workerId, fenceEpoch, ...detail }, now);
      return this.task(this.row(id)!);
    });
  }

  pauseForUserInput(
    id: string,
    workerId: string,
    fenceEpoch: number,
    detail: { threadId: string; runId: string; environmentId?: string; message: string },
    now = Date.now(),
  ) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const error = { code: "USER_INPUT_REQUIRED", ...detail };
      this.db.prepare(
        `UPDATE project_tasks SET status='PAUSED',paused_from_status='QUEUED',error_json=?,
           lease_owner=NULL,lease_until=NULL,deferred_attempt_count=deferred_attempt_count+1,
           version=version+1,updated_at=? WHERE id=?`,
      ).run(json(error), now, id);
      this.db.prepare(
        `UPDATE task_attempts SET status='WAITING_USER',finished_at=?,error_json=?
         WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
      ).run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, "task.waiting_user", { taskId: id, workerId, fenceEpoch, ...detail }, now);
      return this.task(this.row(id)!);
    });
  }

  pauseForUnknownSideEffect(
    id: string,
    workerId: string,
    fenceEpoch: number,
    approvalId: string,
    reason = "A superseded approval was already consumed; verify the external effect before resuming",
    now = Date.now(),
  ) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const error = {
        code: "UNKNOWN_SIDE_EFFECT",
        message: reason,
        approvalId,
      };
      this.db.prepare(
        `UPDATE project_tasks SET status='PAUSED',paused_from_status='QUEUED',error_json=?,
           waiting_approval_id=NULL,lease_owner=NULL,lease_until=NULL,
           version=version+1,updated_at=? WHERE id=?`,
      ).run(json(error), now, id);
      this.db.prepare(
        `UPDATE task_attempts SET status='CANCELLED',finished_at=?,error_json=?
         WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
      ).run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, "task.unknown_side_effect", { taskId: id, workerId, fenceEpoch, approvalId }, now);
      return this.task(this.row(id)!);
    });
  }

  complete(id: string, workerId: string, fenceEpoch: number, result: unknown, now = Date.now()) {
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      this.db
        .prepare(
          `UPDATE project_tasks SET status='COMPLETED',result_json=?,lease_owner=NULL,lease_until=NULL,waiting_device_id=NULL,waiting_approval_id=NULL,
           version=version+1,updated_at=? WHERE id=?`,
        )
        .run(json(result), now, id);
      this.db
        .prepare(
          `UPDATE task_attempts SET status='COMPLETED',finished_at=?,result_json=?
           WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
        )
        .run(now, json(result), id, fenceEpoch);
      this.event(row.project_id, "task.completed", { taskId: id, workerId, fenceEpoch, result }, now);
      this.releaseDependents(id, now);
      return this.task(this.row(id)!);
    });
  }

  fail(
    id: string,
    workerId: string,
    fenceEpoch: number,
    error: unknown,
    options: {
      retryDelayMs?: number;
      retryable?: boolean;
      now?: number;
      /** Enqueued atomically only when this attempt makes the source task terminal. */
      finalFailureTask?: { id: string; title: string; input: unknown };
    } = {},
  ) {
    const now = options.now ?? Date.now();
    const retryDelayMs = options.retryDelayMs ?? 0;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw Error("retryDelayMs must be a non-negative integer");
    return this.transaction(() => {
      const row = this.fenced(id, workerId, fenceEpoch, now);
      const retry = options.retryable !== false && (row.attempt_count - row.deferred_attempt_count) < row.max_attempts;
      const status: ProjectTaskStatus = retry ? "RETRYING" : "FAILED";
      const availableAt = retry ? now + retryDelayMs : row.available_at;
      this.db
        .prepare(
          `UPDATE project_tasks SET status=?,available_at=?,error_json=?,lease_owner=NULL,lease_until=NULL,waiting_device_id=NULL,waiting_approval_id=NULL,
           version=version+1,updated_at=? WHERE id=?`,
        )
        .run(status, availableAt, json(error), now, id);
      this.db
        .prepare(
          `UPDATE task_attempts SET status='FAILED',finished_at=?,error_json=?
           WHERE task_id=? AND fence_epoch=? AND finished_at IS NULL`,
        )
        .run(now, json(error), id, fenceEpoch);
      this.event(row.project_id, retry ? "task.retrying" : "task.failed", { taskId: id, workerId, fenceEpoch, error, availableAt }, now);
      if (!retry) {
        this.failDependents(id, "FAILED", now);
        if (options.finalFailureTask) {
          const notificationId = required(options.finalFailureTask.id, "Failure notification task id", 128);
          const notificationTitle = required(options.finalFailureTask.title, "Failure notification task title", 240);
          const existing = this.row(notificationId);
          if (existing) {
            if (existing.project_id !== row.project_id || existing.title !== notificationTitle ||
                existing.input_json !== json(options.finalFailureTask.input))
              throw Error("Stored failure notification does not match the immutable failed task");
          } else {
            this.db
              .prepare(
                `INSERT INTO project_tasks(
                   id,project_id,title,input_json,status,priority,max_attempts,available_at,created_at,updated_at)
                 VALUES(?,?,?,?, 'QUEUED',0,3,?,?,?)`,
              )
              .run(notificationId, row.project_id, notificationTitle, json(options.finalFailureTask.input), now, now, now);
            this.event(row.project_id, "task.queued", {
              taskId: notificationId,
              title: notificationTitle,
              priority: 0,
              dependsOn: [],
              sourceFailedTaskId: id,
            }, now);
          }
        }
      }
      return this.task(this.row(id)!);
    });
  }

  cancel(
    id: string,
    now = Date.now(),
    options: { notifyCoordinator?: boolean; requestedBy?: string; reason?: string } = {},
  ) {
    const requestedBy = options.requestedBy === undefined
      ? undefined
      : required(options.requestedBy, "Cancellation requester", 128);
    const reason = options.reason === undefined ? undefined : required(options.reason, "Cancellation reason", 1_000);
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw Error(`Unknown task: ${id}`);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(row.status)) return this.task(row);
      this.db
        .prepare(
          `UPDATE project_tasks SET status='CANCELLED',lease_owner=NULL,lease_until=NULL,waiting_device_id=NULL,waiting_approval_id=NULL,
           fence_epoch=fence_epoch+1,version=version+1,updated_at=? WHERE id=?`,
        )
        .run(now, id);
      this.db
        .prepare(
          `UPDATE task_attempts SET status='CANCELLED',finished_at=?
           WHERE task_id=? AND finished_at IS NULL`,
        )
        .run(now, id);
      this.event(row.project_id, "task.cancelled", { taskId: id, requestedBy, reason }, now);
      this.failDependents(id, "CANCELLED", now);
      const sourceInput = JSON.parse(row.input_json) as {
        kind?: unknown;
        memberId?: unknown;
        messageId?: unknown;
        correlationId?: unknown;
        payload?: Record<string, unknown>;
      } | null;
      const replyToMemberId = sourceInput?.payload && typeof sourceInput.payload.replyToMemberId === "string"
        ? sourceInput.payload.replyToMemberId
        : undefined;
      const recipient = replyToMemberId
        ? this.db.prepare(
            "SELECT id FROM project_members WHERE project_id=? AND id=? AND lifecycle_state!='ARCHIVED'",
          ).get(row.project_id, replyToMemberId) as { id: string } | undefined
        : undefined;
      if (options.notifyCoordinator !== false && recipient && sourceInput) {
        const effectsMayPersist = row.status === "RUNNING" || row.status === "WAITING_APPROVAL";
        const notificationId = `task-cancelled-${createHash("sha256")
          .update(`${row.project_id}:${id}:${recipient.id}`)
          .digest("hex").slice(0, 48)}`;
        const notificationTitle = `Cancelled: ${row.title}`.slice(0, 240);
        const coordinationDepth = Number.isSafeInteger(sourceInput.payload?.coordinationDepth) &&
          Number(sourceInput.payload?.coordinationDepth) >= 0
          ? Number(sourceInput.payload?.coordinationDepth)
          : 0;
        const coordinationRootTaskId = typeof sourceInput.payload?.coordinationRootTaskId === "string" &&
          sourceInput.payload.coordinationRootTaskId
          ? sourceInput.payload.coordinationRootTaskId
          : id;
        const notificationInput = {
          kind: "agent.message",
          memberId: recipient.id,
          content: `Delegated task "${row.title}" was cancelled. Remove it from the active plan and decide whether any replacement work is required.${effectsMayPersist ? " Cancellation does not roll back effects that completed before the running Agent stopped; inspect the tool audit before retrying." : ""}`,
          messageType: "task_blocked",
          messageId: `task-cancelled:${id}`,
          correlationId: typeof sourceInput.correlationId === "string"
            ? sourceInput.correlationId
            : (typeof sourceInput.messageId === "string" ? sourceInput.messageId : id),
          payload: {
            sourceTaskId: id,
            sourceMemberId: typeof sourceInput.memberId === "string" ? sourceInput.memberId : undefined,
            code: "TASK_CANCELLED",
            effectsMayPersist,
            coordinationDepth,
            coordinationRootTaskId,
          },
          whenBusy: "followUp",
          waitMs: 300_000,
        };
        const existing = this.row(notificationId);
        if (existing) {
          if (existing.project_id !== row.project_id || existing.title !== notificationTitle ||
              existing.input_json !== json(notificationInput))
            throw Error("Stored cancellation notification does not match the immutable cancelled task");
        } else {
          this.db.prepare(
            `INSERT INTO project_tasks(
               id,project_id,title,input_json,status,priority,max_attempts,available_at,created_at,updated_at)
             VALUES(?,?,?,?, 'QUEUED',0,3,?,?,?)`,
          ).run(notificationId, row.project_id, notificationTitle, json(notificationInput), now, now, now);
          this.event(row.project_id, "task.queued", {
            taskId: notificationId,
            title: notificationTitle,
            priority: 0,
            dependsOn: [],
            sourceCancelledTaskId: id,
          }, now);
        }
      }
      return this.task(this.row(id)!);
    });
  }

  pause(id: string, now = Date.now()) {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw Error(`Unknown task: ${id}`);
      if (row.status === "PAUSED") return this.task(row);
      if (row.status === "RUNNING" || row.status === "WAITING_APPROVAL")
        throw Error("Running tasks must be cancelled; live pause is not supported");
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(row.status))
        throw Error(`Cannot pause a ${row.status.toLowerCase()} task`);
      this.db
        .prepare(
          `UPDATE project_tasks SET status='PAUSED',paused_from_status=?,version=version+1,updated_at=?
           WHERE id=?`,
        )
        .run(row.status, now, id);
      this.event(row.project_id, "task.paused", { taskId: id, fromStatus: row.status }, now);
      return this.task(this.row(id)!);
    });
  }

  resume(id: string, now = Date.now()) {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw Error(`Unknown task: ${id}`);
      if (row.status !== "PAUSED") throw Error("Only paused tasks can be resumed");
      const pausedError = parse(row.error_json) as { code?: unknown } | undefined;
      if (pausedError?.code === "UNKNOWN_SIDE_EFFECT")
        throw Error("Unknown side effects require an explicit operator resolution");
      const dependencies = (
        this.db
          .prepare(
            `SELECT parent.id,parent.status FROM task_dependencies d
             JOIN project_tasks parent ON parent.id=d.depends_on_task_id WHERE d.task_id=?`,
          )
          .all(id) as { id: string; status: ProjectTaskStatus }[]
      );
      const failed = dependencies.find((dependency) =>
        ["FAILED", "CANCELLED"].includes(dependency.status),
      );
      if (failed) {
        const error = {
          code: "DEPENDENCY_FAILED",
          dependencyTaskId: failed.id,
          dependencyStatus: failed.status,
        };
        this.db
          .prepare(
            `UPDATE project_tasks SET status='FAILED',error_json=?,paused_from_status=NULL,
             version=version+1,updated_at=? WHERE id=?`,
          )
          .run(json(error), now, id);
        this.event(row.project_id, "task.dependency_failed", { taskId: id, ...error }, now);
      } else if (row.paused_from_status === "WAITING_DEVICE" && row.waiting_device_id) {
        this.db
          .prepare(
            `UPDATE project_tasks SET status='WAITING_DEVICE',paused_from_status=NULL,
             version=version+1,updated_at=? WHERE id=?`,
          )
          .run(now, id);
        this.event(row.project_id, "task.resumed", { taskId: id, status: "WAITING_DEVICE" }, now);
      } else {
        const status: ProjectTaskStatus = dependencies.every(
          (dependency) => dependency.status === "COMPLETED",
        )
          ? "QUEUED"
          : "WAITING_DEPENDENCY";
        this.db
          .prepare(
            `UPDATE project_tasks SET status=?,paused_from_status=NULL,waiting_device_id=NULL,version=version+1,updated_at=?
             WHERE id=?`,
          )
          .run(status, now, id);
        this.event(row.project_id, "task.resumed", { taskId: id, status }, now);
      }
      return this.task(this.row(id)!);
    });
  }

  resolveUnknownSideEffect(
    id: string,
    resolution: UnknownSideEffectResolution,
    actor: string,
    note: string,
    now = Date.now(),
  ) {
    const decidedBy = required(actor, "Resolution actor", 240);
    const explanation = required(note, "Resolution note", 1_000);
    if (resolution !== "RETRY" && resolution !== "MARK_COMPLETED")
      throw Error("Resolution must be RETRY or MARK_COMPLETED");
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw Error(`Unknown task: ${id}`);
      const error = parse(row.error_json) as { code?: unknown; approvalId?: unknown } | undefined;
      if (row.status !== "PAUSED" || error?.code !== "UNKNOWN_SIDE_EFFECT")
        throw Error("Task is not paused for an unknown side effect");
      const approvalId = typeof error.approvalId === "string" ? error.approvalId : undefined;
      if (resolution === "RETRY") {
        this.db.prepare(
          `UPDATE project_tasks SET status='QUEUED',paused_from_status=NULL,error_json=NULL,
             deferred_attempt_count=deferred_attempt_count+1,available_at=?,fence_epoch=fence_epoch+1,
             version=version+1,updated_at=? WHERE id=?`,
        ).run(now, now, id);
      } else {
        const result = {
          kind: "operator_confirmed_side_effect",
          actor: decidedBy,
          note: explanation,
          ...(approvalId ? { approvalId } : {}),
          confirmedAt: now,
        };
        this.db.prepare(
          `UPDATE project_tasks SET status='COMPLETED',paused_from_status=NULL,error_json=NULL,result_json=?,
             fence_epoch=fence_epoch+1,version=version+1,updated_at=? WHERE id=?`,
        ).run(json(result), now, id);
        this.releaseDependents(id, now);
      }
      this.event(row.project_id, "task.unknown_side_effect_resolved", {
        taskId: id,
        resolution,
        actor: decidedBy,
        note: explanation,
        ...(approvalId ? { approvalId } : {}),
      }, now);
      return this.task(this.row(id)!);
    });
  }

  close() {
    this.db.close();
  }
}
