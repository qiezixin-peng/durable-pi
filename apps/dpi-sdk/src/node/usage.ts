import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ProjectModelUsage, ProjectUsageSummary } from "../api.js";

type UsageRow = {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  fence_epoch: number;
  member_id: string;
  provider: string;
  model: string;
  thread_id: string | null;
  turn_id: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  context_window: number | null;
  created_at: number;
  updated_at: number;
};

const tokens = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error(`${name} must be a non-negative integer`);
  return Number(value);
};

export class ProjectUsageStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_model_usage(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        fence_epoch INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        context_window INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id,task_id,fence_epoch));
      CREATE INDEX IF NOT EXISTS project_model_usage_scope
        ON project_model_usage(project_id,created_at DESC);`);
  }

  private usage(row: UsageRow): ProjectModelUsage {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      fenceEpoch: row.fence_epoch,
      memberId: row.member_id,
      provider: row.provider,
      model: row.model,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
      totalTokens: row.total_tokens,
      ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  record(input: {
    projectId: string;
    taskId: string;
    attemptId?: string;
    fenceEpoch: number;
    memberId: string;
    provider: string;
    model: string;
    threadId?: string;
    turnId?: string;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens?: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    contextWindow?: number;
  }, now = Date.now()) {
    const values = {
      inputTokens: tokens(input.inputTokens, "inputTokens"),
      cachedInputTokens: tokens(input.cachedInputTokens, "cachedInputTokens"),
      cacheWriteInputTokens: tokens(input.cacheWriteInputTokens ?? 0, "cacheWriteInputTokens"),
      outputTokens: tokens(input.outputTokens, "outputTokens"),
      reasoningOutputTokens: tokens(input.reasoningOutputTokens, "reasoningOutputTokens"),
      totalTokens: tokens(input.totalTokens, "totalTokens"),
    };
    this.db
      .prepare(
        `INSERT INTO project_model_usage(
           id,project_id,task_id,attempt_id,fence_epoch,member_id,provider,model,thread_id,turn_id,
           input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,
           total_tokens,context_window,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id,task_id,fence_epoch) DO UPDATE SET
           attempt_id=excluded.attempt_id,member_id=excluded.member_id,provider=excluded.provider,
           model=excluded.model,thread_id=excluded.thread_id,turn_id=excluded.turn_id,
           input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,
           cache_write_input_tokens=excluded.cache_write_input_tokens,output_tokens=excluded.output_tokens,
           reasoning_output_tokens=excluded.reasoning_output_tokens,total_tokens=excluded.total_tokens,
           context_window=COALESCE(excluded.context_window,project_model_usage.context_window),
           updated_at=excluded.updated_at`,
      )
      .run(
        randomUUID(), input.projectId, input.taskId, input.attemptId ?? null, input.fenceEpoch,
        input.memberId, input.provider, input.model, input.threadId ?? null, input.turnId ?? null,
        values.inputTokens, values.cachedInputTokens, values.cacheWriteInputTokens, values.outputTokens,
        values.reasoningOutputTokens, values.totalTokens, input.contextWindow ?? null, now, now,
      );
    const row = this.db
      .prepare("SELECT * FROM project_model_usage WHERE project_id=? AND task_id=? AND fence_epoch=?")
      .get(input.projectId, input.taskId, input.fenceEpoch) as UsageRow;
    return this.usage(row);
  }

  list(projectId: string, limit = 100) {
    return (this.db
      .prepare("SELECT * FROM project_model_usage WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?")
      .all(projectId, Math.max(1, Math.min(1_000, limit))) as UsageRow[]).map((row) => this.usage(row));
  }

  summary(projectId: string): ProjectUsageSummary {
    return this.summarySince(projectId);
  }

  /** Conservative runtime evidence for context budgeting; model names alone are not capability proof. */
  observedContextWindow(provider: string, model: string, since = Date.now() - 30 * 24 * 60 * 60_000) {
    if (!provider.trim()) throw Error("provider is required");
    if (!model.trim()) throw Error("model is required");
    if (!Number.isSafeInteger(since) || since < 0) throw Error("since must be a non-negative integer");
    const row = this.db.prepare(
      `SELECT MIN(context_window) AS context_window, COUNT(*) AS samples, MAX(updated_at) AS last_observed_at
       FROM project_model_usage
       WHERE provider=? AND model=? AND context_window IS NOT NULL AND context_window>0 AND updated_at>=?`,
    ).get(provider, model, since) as {
      context_window: number | null;
      samples: number;
      last_observed_at: number | null;
    };
    if (row.context_window === null || row.last_observed_at === null) return undefined;
    return {
      contextWindow: Number(row.context_window),
      samples: Number(row.samples),
      lastObservedAt: Number(row.last_observed_at),
    };
  }

  summaryTask(projectId: string, taskId: string): ProjectUsageSummary {
    if (!taskId) throw Error("taskId is required");
    const row = this.db.prepare(
      `SELECT COUNT(*) AS requests,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens),0) AS cache_write_input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(reasoning_output_tokens),0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens),0) AS total_tokens
       FROM project_model_usage WHERE project_id=? AND task_id=?`,
    ).get(projectId, taskId) as Record<string, number>;
    return {
      projectId,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningOutputTokens: Number(row.reasoning_output_tokens),
      totalTokens: Number(row.total_tokens),
    };
  }

  summarySince(projectId: string, since?: number): ProjectUsageSummary {
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw Error("since must be a non-negative integer");
    const row = this.db.prepare(
      `SELECT COUNT(*) AS requests,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens),0) AS cache_write_input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(reasoning_output_tokens),0) AS reasoning_output_tokens,
        COALESCE(SUM(total_tokens),0) AS total_tokens
       FROM project_model_usage WHERE project_id=?${since === undefined ? "" : " AND created_at>=?"}`,
    ).get(...(since === undefined ? [projectId] : [projectId, since])) as Record<string, number>;
    return {
      projectId,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningOutputTokens: Number(row.reasoning_output_tokens),
      totalTokens: Number(row.total_tokens),
    };
  }

  close() {
    this.db.close();
  }
}
