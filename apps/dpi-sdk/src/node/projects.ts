// Hub-local project registry. A project is a strict routing boundary that groups
// agents from sessions on multiple devices. Device tokens remain in NetworkRegistry.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectAutonomyMode, ProjectEvent, ProjectMember, ProjectPermissionProfile, ProjectSummary, ProjectTemplateRole } from "../api.js";
import { isLocalPiModel } from "./local-model-providers.js";
import { dpiHome } from "./registry.js";

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

type ProjectRow = {
  id: string;
  template_id: string | null;
  template_plan_json: string | null;
  name: string;
  description: string;
  autonomy_mode: ProjectAutonomyMode;
  token_limit_24h: number | null;
  max_task_tokens: number | null;
  max_coordination_depth: number | null;
  max_delegated_tasks_per_turn: number | null;
  max_active_tasks: number | null;
  max_concurrent_tasks: number | null;
  created_at: number;
  updated_at: number;
};

type MemberRow = {
  id: string;
  project_id: string;
  device_id: string;
  session_id: string;
  agent_id: string;
  name: string;
  role: string;
  permission_profile: ProjectPermissionProfile;
  executor: "pi" | "codex";
  model: string | null;
  allow_model_fallback: number;
  fallback_models_json: string;
  cwd: string | null;
  t3_environment_id: string | null;
  codex_thread_id: string | null;
  codex_thread_model: string | null;
  codex_thread_runtime: "codex-app-server" | "t3" | "deepseek-harness" | "antigravity" | "pi-cli" | null;
  codex_thread_provider: string | null;
  codex_tools_version: number;
  temporary: number;
  lifecycle_state: "ACTIVE" | "IDLE" | "ARCHIVED";
  parent_member_id: string | null;
  scope_task_id: string | null;
  spawn_request_id: string | null;
  archived_at: number | null;
  created_at: number;
};

type EventRow = {
  id: number;
  project_id: string;
  kind: string;
  from_member_id: string | null;
  to_member_id: string | null;
  detail_json: string;
  created_at: number;
};

const clean = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const result = value.trim();
  if (result.length > max) throw Error(`${label} must be at most ${max} characters`);
  return result;
};

const modelFallbacks = (value: unknown, primary?: string | null) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw Error("Fallback models must be an array of at most five model IDs");
  const result = value.map((item) => clean(item, "Fallback model", 160));
  if (new Set(result).size !== result.length) throw Error("Fallback models must be unique");
  if (primary && result.includes(primary)) throw Error("Primary model cannot also be a fallback model");
  return result;
};

const templatePlan = (value: unknown): ProjectTemplateRole[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw Error("Template plan must be an array of at most 32 roles");
  const result = value.map((item) => {
    if (!item || typeof item !== "object") throw Error("Template plan role must be an object");
    const role = clean((item as { role?: unknown }).role, "Template role", 80).toLowerCase();
    const permissionProfile = (item as { permissionProfile?: unknown }).permissionProfile;
    if (!(["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"] as unknown[]).includes(permissionProfile))
      throw Error("Template role permission profile is invalid");
    return { role, permissionProfile: permissionProfile as ProjectPermissionProfile };
  });
  if (new Set(result.map((item) => item.role)).size !== result.length) throw Error("Template plan roles must be unique");
  return result;
};

const slug = (name: string) => {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "project"}-${randomUUID().slice(0, 8)}`;
};

export class ProjectRegistry {
  readonly db: DatabaseSync;
  readonly path: string;

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private optionalLimit(value: number | undefined, label: string, max = 10_000): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw Error(`${label} must be an integer from 1 to ${max}`);
    return value;
  }

  constructor(path = join(dpiHome(), "projects.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY,
        template_id TEXT,
        template_plan_json TEXT NOT NULL DEFAULT '[]',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        autonomy_mode TEXT NOT NULL DEFAULT 'SUPERVISED',
        token_limit_24h INTEGER,
        max_task_tokens INTEGER,
        max_coordination_depth INTEGER,
        max_delegated_tasks_per_turn INTEGER,
        max_active_tasks INTEGER,
        max_concurrent_tasks INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_members(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        permission_profile TEXT NOT NULL DEFAULT 'ROLE_DEFAULT',
        executor TEXT NOT NULL DEFAULT 'pi',
        model TEXT,
        allow_model_fallback INTEGER NOT NULL DEFAULT 0,
        fallback_models_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        t3_environment_id TEXT,
        codex_thread_id TEXT,
        codex_thread_model TEXT,
        codex_thread_runtime TEXT NOT NULL DEFAULT 'codex-app-server',
        codex_thread_provider TEXT,
        codex_tools_version INTEGER NOT NULL DEFAULT 0,
        temporary INTEGER NOT NULL DEFAULT 0,
        lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
        parent_member_id TEXT,
        scope_task_id TEXT,
        spawn_request_id TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, device_id, session_id, agent_id));
      CREATE TABLE IF NOT EXISTS project_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        from_member_id TEXT,
        to_member_id TEXT,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_events_project_at
        ON project_events(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS project_deletion_locks(
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]');`);
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "autonomy_mode"))
      this.db.exec("ALTER TABLE projects ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'SUPERVISED'");
    if (!columns.some((column) => column.name === "token_limit_24h"))
      this.db.exec("ALTER TABLE projects ADD COLUMN token_limit_24h INTEGER");
    if (!columns.some((column) => column.name === "max_task_tokens"))
      this.db.exec("ALTER TABLE projects ADD COLUMN max_task_tokens INTEGER");
    if (!columns.some((column) => column.name === "max_coordination_depth"))
      this.db.exec("ALTER TABLE projects ADD COLUMN max_coordination_depth INTEGER");
    if (!columns.some((column) => column.name === "max_delegated_tasks_per_turn"))
      this.db.exec("ALTER TABLE projects ADD COLUMN max_delegated_tasks_per_turn INTEGER");
    if (!columns.some((column) => column.name === "max_active_tasks"))
      this.db.exec("ALTER TABLE projects ADD COLUMN max_active_tasks INTEGER");
    if (!columns.some((column) => column.name === "max_concurrent_tasks"))
      this.db.exec("ALTER TABLE projects ADD COLUMN max_concurrent_tasks INTEGER");
    if (!columns.some((column) => column.name === "template_id"))
      this.db.exec("ALTER TABLE projects ADD COLUMN template_id TEXT");
    if (!columns.some((column) => column.name === "template_plan_json"))
      this.db.exec("ALTER TABLE projects ADD COLUMN template_plan_json TEXT NOT NULL DEFAULT '[]'");
    const deletionLockColumns = this.db.prepare("PRAGMA table_info(project_deletion_locks)").all() as { name: string }[];
    if (!deletionLockColumns.some((column) => column.name === "source_ids_json"))
      this.db.exec("ALTER TABLE project_deletion_locks ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]'");
    const memberColumns = this.db.prepare("PRAGMA table_info(project_members)").all() as { name: string }[];
    if (!memberColumns.some((column) => column.name === "executor"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN executor TEXT NOT NULL DEFAULT 'pi'");
    if (!memberColumns.some((column) => column.name === "permission_profile"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'ROLE_DEFAULT'");
    if (!memberColumns.some((column) => column.name === "model"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN model TEXT");
    if (!memberColumns.some((column) => column.name === "allow_model_fallback"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN allow_model_fallback INTEGER NOT NULL DEFAULT 0");
    if (!memberColumns.some((column) => column.name === "fallback_models_json"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN fallback_models_json TEXT NOT NULL DEFAULT '[]'");
    if (!memberColumns.some((column) => column.name === "cwd"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN cwd TEXT");
    if (!memberColumns.some((column) => column.name === "t3_environment_id"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN t3_environment_id TEXT");
    if (!memberColumns.some((column) => column.name === "codex_thread_id"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN codex_thread_id TEXT");
    if (!memberColumns.some((column) => column.name === "codex_thread_model"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN codex_thread_model TEXT");
    if (!memberColumns.some((column) => column.name === "codex_thread_runtime"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN codex_thread_runtime TEXT NOT NULL DEFAULT 'codex-app-server'");
    if (!memberColumns.some((column) => column.name === "codex_thread_provider"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN codex_thread_provider TEXT");
    if (!memberColumns.some((column) => column.name === "codex_tools_version"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN codex_tools_version INTEGER NOT NULL DEFAULT 0");
    if (!memberColumns.some((column) => column.name === "temporary"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0");
    if (!memberColumns.some((column) => column.name === "lifecycle_state"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE'");
    if (!memberColumns.some((column) => column.name === "parent_member_id"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN parent_member_id TEXT");
    if (!memberColumns.some((column) => column.name === "scope_task_id"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN scope_task_id TEXT");
    if (!memberColumns.some((column) => column.name === "archived_at"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN archived_at INTEGER");
    if (!memberColumns.some((column) => column.name === "spawn_request_id"))
      this.db.exec("ALTER TABLE project_members ADD COLUMN spawn_request_id TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS project_members_spawn_request
      ON project_members(project_id,spawn_request_id) WHERE spawn_request_id IS NOT NULL`);
  }

  private member(row: MemberRow): ProjectMember {
    return {
      id: row.id,
      projectId: row.project_id,
      deviceId: row.device_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      name: row.name,
      role: row.role,
      permissionProfile: row.permission_profile ?? "ROLE_DEFAULT",
      executor: row.executor ?? "pi",
      ...(row.model ? { model: row.model } : {}),
      allowModelFallback: Boolean(row.allow_model_fallback),
      fallbackModels: JSON.parse(row.fallback_models_json ?? "[]") as string[],
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.t3_environment_id ? { t3EnvironmentId: row.t3_environment_id } : {}),
      ...(row.codex_thread_id ? { threadId: row.codex_thread_id } : {}),
      ...(row.codex_thread_model ? { threadModel: row.codex_thread_model } : {}),
      ...(row.codex_thread_id ? { threadRuntime: row.codex_thread_runtime ?? "codex-app-server" } : {}),
      ...(row.codex_thread_provider ? { threadProvider: row.codex_thread_provider } : {}),
      ...(row.codex_tools_version ? { codexToolsVersion: row.codex_tools_version } : {}),
      temporary: Boolean(row.temporary),
      lifecycleState: row.lifecycle_state ?? "ACTIVE",
      ...(row.parent_member_id ? { parentMemberId: row.parent_member_id } : {}),
      ...(row.scope_task_id ? { scopeTaskId: row.scope_task_id } : {}),
      ...(row.spawn_request_id ? { spawnRequestId: row.spawn_request_id } : {}),
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      createdAt: row.created_at,
    };
  }

  private project(row: ProjectRow): ProjectSummary {
    return {
      id: row.id,
      ...(row.template_id ? { templateId: row.template_id } : {}),
      templatePlan: JSON.parse(row.template_plan_json ?? "[]") as ProjectTemplateRole[],
      name: row.name,
      description: row.description,
      autonomyMode: row.autonomy_mode,
      ...(row.token_limit_24h === null ? {} : { tokenLimit24h: row.token_limit_24h }),
      ...(row.max_task_tokens === null ? {} : { maxTaskTokens: row.max_task_tokens }),
      ...(row.max_coordination_depth === null ? {} : { maxCoordinationDepth: row.max_coordination_depth }),
      ...(row.max_delegated_tasks_per_turn === null ? {} : { maxDelegatedTasksPerTurn: row.max_delegated_tasks_per_turn }),
      ...(row.max_active_tasks === null ? {} : { maxActiveTasks: row.max_active_tasks }),
      ...(row.max_concurrent_tasks === null ? {} : { maxConcurrentTasks: row.max_concurrent_tasks }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members: this.members(row.id),
    };
  }

  list(): ProjectSummary[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[]).map(
      (row) => this.project(row),
    );
  }

  get(id: string): ProjectSummary | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
    return row ? this.project(row) : undefined;
  }

  create(input: {
    id?: string;
    templateId?: string;
    templatePlan?: ProjectTemplateRole[];
    name: string;
    description?: string;
    autonomyMode?: ProjectAutonomyMode;
    tokenLimit24h?: number;
    maxTaskTokens?: number;
    maxCoordinationDepth?: number;
    maxDelegatedTasksPerTurn?: number;
    maxActiveTasks?: number;
    maxConcurrentTasks?: number;
  }, audit?: { kind: string; detail: unknown }): ProjectSummary {
    const name = clean(input.name, "Project name", 120);
    const id = input.id ? clean(input.id, "Project id", 64) : slug(name);
    if (!PROJECT_ID.test(id)) throw Error(`Project id must match ${PROJECT_ID}`);
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 2000) : "";
    const templateId = input.templateId === undefined ? undefined : clean(input.templateId, "Template id", 64);
    if (templateId && !PROJECT_ID.test(templateId)) throw Error(`Template id must match ${PROJECT_ID}`);
    const plan = templatePlan(input.templatePlan);
    const autonomyMode = input.autonomyMode ?? "SUPERVISED";
    if (!["SUPERVISED", "AUTHORIZED_AUTONOMY", "RESTRICTED_UNATTENDED"].includes(autonomyMode))
      throw Error("Invalid project autonomy mode");
    const tokenLimit24h = input.tokenLimit24h;
    if (tokenLimit24h !== undefined && (!Number.isSafeInteger(tokenLimit24h) || tokenLimit24h < 1))
      throw Error("tokenLimit24h must be a positive integer");
    const maxTaskTokens = this.optionalLimit(input.maxTaskTokens, "maxTaskTokens", Number.MAX_SAFE_INTEGER);
    const maxCoordinationDepth = this.optionalLimit(input.maxCoordinationDepth, "maxCoordinationDepth");
    const maxDelegatedTasksPerTurn = this.optionalLimit(input.maxDelegatedTasksPerTurn, "maxDelegatedTasksPerTurn");
    const maxActiveTasks = this.optionalLimit(input.maxActiveTasks, "maxActiveTasks");
    const maxConcurrentTasks = this.optionalLimit(input.maxConcurrentTasks, "maxConcurrentTasks", 1_000);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO projects(
          id,template_id,template_plan_json,name,description,autonomy_mode,token_limit_24h,max_task_tokens,max_coordination_depth,
          max_delegated_tasks_per_turn,max_active_tasks,max_concurrent_tasks,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, templateId ?? null, JSON.stringify(plan), name, description, autonomyMode, tokenLimit24h ?? null, maxTaskTokens ?? null, maxCoordinationDepth ?? null,
          maxDelegatedTasksPerTurn ?? null, maxActiveTasks ?? null, maxConcurrentTasks ?? null, now, now);
      this.event(id, "project.created", {
        name, templateId, templatePlan: plan, description, autonomyMode, tokenLimit24h, maxTaskTokens,
        maxCoordinationDepth, maxDelegatedTasksPerTurn, maxActiveTasks, maxConcurrentTasks,
      });
      if (audit) this.event(id, audit.kind, audit.detail);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String((error as Error).message).includes("UNIQUE")) throw Error(`Project already exists: ${id}`);
      throw error;
    }
    return this.get(id)!;
  }

  update(id: string, patch: {
    name?: string;
    description?: string;
    autonomyMode?: ProjectAutonomyMode;
    tokenLimit24h?: number | null;
    maxTaskTokens?: number | null;
    maxCoordinationDepth?: number | null;
    maxDelegatedTasksPerTurn?: number | null;
    maxActiveTasks?: number | null;
    maxConcurrentTasks?: number | null;
  }): ProjectSummary {
    const current = this.get(id);
    if (!current) throw Error(`Unknown project: ${id}`);
    const name = patch.name === undefined ? current.name : clean(patch.name, "Project name", 120);
    const description =
      patch.description === undefined ? current.description : String(patch.description).trim().slice(0, 2000);
    const autonomyMode = patch.autonomyMode ?? current.autonomyMode;
    if (!["SUPERVISED", "AUTHORIZED_AUTONOMY", "RESTRICTED_UNATTENDED"].includes(autonomyMode))
      throw Error("Invalid project autonomy mode");
    const tokenLimit24h = patch.tokenLimit24h === undefined ? current.tokenLimit24h : (patch.tokenLimit24h ?? undefined);
    if (tokenLimit24h !== undefined && (!Number.isSafeInteger(tokenLimit24h) || tokenLimit24h < 1))
      throw Error("tokenLimit24h must be a positive integer");
    const maxTaskTokens = patch.maxTaskTokens === undefined
      ? current.maxTaskTokens
      : this.optionalLimit(patch.maxTaskTokens ?? undefined, "maxTaskTokens", Number.MAX_SAFE_INTEGER);
    const maxCoordinationDepth = patch.maxCoordinationDepth === undefined
      ? current.maxCoordinationDepth
      : this.optionalLimit(patch.maxCoordinationDepth ?? undefined, "maxCoordinationDepth");
    const maxDelegatedTasksPerTurn = patch.maxDelegatedTasksPerTurn === undefined
      ? current.maxDelegatedTasksPerTurn
      : this.optionalLimit(patch.maxDelegatedTasksPerTurn ?? undefined, "maxDelegatedTasksPerTurn");
    const maxActiveTasks = patch.maxActiveTasks === undefined
      ? current.maxActiveTasks
      : this.optionalLimit(patch.maxActiveTasks ?? undefined, "maxActiveTasks");
    const maxConcurrentTasks = patch.maxConcurrentTasks === undefined
      ? current.maxConcurrentTasks
      : this.optionalLimit(patch.maxConcurrentTasks ?? undefined, "maxConcurrentTasks", 1_000);
    return this.transaction(() => {
      this.db
        .prepare(`UPDATE projects SET name=?,description=?,autonomy_mode=?,token_limit_24h=?,max_task_tokens=?,
          max_coordination_depth=?,max_delegated_tasks_per_turn=?,max_active_tasks=?,max_concurrent_tasks=?,updated_at=? WHERE id=?`)
        .run(name, description, autonomyMode, tokenLimit24h ?? null, maxTaskTokens ?? null, maxCoordinationDepth ?? null,
          maxDelegatedTasksPerTurn ?? null, maxActiveTasks ?? null, maxConcurrentTasks ?? null, Date.now(), id);
      this.event(id, "project.updated", {
        name, description, autonomyMode, tokenLimit24h, maxTaskTokens,
        maxCoordinationDepth, maxDelegatedTasksPerTurn, maxActiveTasks, maxConcurrentTasks,
      });
      return this.get(id)!;
    });
  }

  remove(id: string) {
    return this.db.prepare("DELETE FROM projects WHERE id=?").run(id).changes > 0;
  }

  /** Fence new task admission before external project resources are purged. */
  beginRemoval(id: string, now = Date.now(), sourceIds: readonly string[] = []) {
    if (!Array.isArray(sourceIds) || sourceIds.length > 100 ||
        sourceIds.some((sourceId) => typeof sourceId !== "string" || !sourceId || sourceId.length > 64) ||
        new Set(sourceIds).size !== sourceIds.length)
      throw Error("Project deletion source IDs must contain at most 100 unique IDs");
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id))
        throw Error(`Unknown project: ${id}`);
      const active = this.db.prepare(
        `SELECT COUNT(*) AS count FROM project_tasks
         WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
      ).get(id) as { count: number };
      if (active.count)
        throw Object.assign(Error(`Project still has ${active.count} active task${active.count === 1 ? "" : "s"}`), { status: 409 });
      const existing = this.db.prepare(
        "SELECT started_at,source_ids_json FROM project_deletion_locks WHERE project_id=?",
      ).get(id) as { started_at: number; source_ids_json: string } | undefined;
      if (existing) return {
        projectId: id,
        startedAt: existing.started_at,
        sourceIds: JSON.parse(existing.source_ids_json) as string[],
        resumed: true,
      };
      const frozenSourceIds = [...sourceIds].sort();
      this.db.prepare(
        "INSERT INTO project_deletion_locks(project_id,started_at,source_ids_json) VALUES(?,?,?)",
      ).run(id, now, JSON.stringify(frozenSourceIds));
      return { projectId: id, startedAt: now, sourceIds: frozenSourceIds, resumed: false };
    });
  }

  cancelRemoval(id: string) {
    return this.db.prepare("DELETE FROM project_deletion_locks WHERE project_id=?").run(id).changes > 0;
  }

  members(projectId: string, includeArchived = false): ProjectMember[] {
    return (
      this.db
        .prepare(`SELECT * FROM project_members WHERE project_id=?${includeArchived ? "" : " AND lifecycle_state!='ARCHIVED'"} ORDER BY created_at,id`)
        .all(projectId) as MemberRow[]
    ).map((row) => this.member(row));
  }

  memberships(deviceId: string, sessionId: string, agentId: string | number) {
    const agent = String(agentId);
    return this.list().flatMap((project) => {
      const self = project.members.find(
        (member) =>
          member.deviceId === deviceId && member.sessionId === sessionId && member.agentId === agent,
      );
      return self ? [{ project, self }] : [];
    });
  }

  getMember(projectId: string, memberId: string, includeArchived = false): ProjectMember | undefined {
    const row = this.db
      .prepare(`SELECT * FROM project_members WHERE project_id=? AND id=?${includeArchived ? "" : " AND lifecycle_state!='ARCHIVED'"}`)
      .get(projectId, memberId) as MemberRow | undefined;
    return row ? this.member(row) : undefined;
  }

  addMember(
    projectId: string,
    input: {
      id?: string;
      deviceId: string;
      sessionId: string;
      agentId: string | number;
      name?: string;
      role?: string;
      permissionProfile?: ProjectPermissionProfile;
      executor?: "pi" | "codex";
      model?: string;
      allowModelFallback?: boolean;
      fallbackModels?: string[];
      cwd?: string;
      t3EnvironmentId?: string;
      temporary?: boolean;
      parentMemberId?: string;
      scopeTaskId?: string;
      spawnRequestId?: string;
    },
  ): ProjectMember {
    if (!this.get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const spawnRequestId = input.spawnRequestId === undefined ? null : clean(input.spawnRequestId, "Spawn request id", 240);
    if (spawnRequestId) {
      const existing = this.db
        .prepare("SELECT * FROM project_members WHERE project_id=? AND spawn_request_id=?")
        .get(projectId, spawnRequestId) as MemberRow | undefined;
      if (existing) return this.member(existing);
    }
    const deviceId = clean(input.deviceId, "Device id", 64);
    const sessionId = clean(input.sessionId, "Session id", 160);
    const agentId = clean(String(input.agentId), "Agent id", 80);
    const name = clean(input.name ?? `${deviceId}:${sessionId}:${agentId}`, "Member name", 120);
    const role = clean(input.role ?? "worker", "Member role", 80);
    const permissionProfile = input.permissionProfile ?? "ROLE_DEFAULT";
    if (!["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"].includes(permissionProfile))
      throw Error("Invalid project member permission profile");
    const executor = input.executor ?? "pi";
    if (executor !== "pi" && executor !== "codex") throw Error("Invalid project member executor");
    const model = input.model === undefined ? null : clean(input.model, "Model", 160);
    const cwd = input.cwd === undefined ? null : clean(input.cwd, "Working directory", 1000);
    const workspaceManagedPi = executor === "pi" && Boolean(cwd) && Boolean(model);
    if (executor === "codex" && isLocalPiModel(model))
      throw Error("Gemini and DeepSeek models require executor='pi' and run locally on this workstation");
    const allowModelFallback = input.allowModelFallback === true;
    const fallbackModels = modelFallbacks(input.fallbackModels, model);
    if (executor !== "codex" && !workspaceManagedPi && (allowModelFallback || fallbackModels.length))
      throw Error("Model fallback is available only for Codex members");
    if (allowModelFallback && !fallbackModels.length)
      throw Error("At least one fallback model is required when automatic fallback is enabled");
    const t3EnvironmentId = input.t3EnvironmentId === undefined ? null : clean(input.t3EnvironmentId, "T3 environment id", 160);
    if (t3EnvironmentId && executor !== "codex" && !workspaceManagedPi)
      throw Error("T3 environment binding is available only for Codex members");
    const parentMemberId = input.parentMemberId === undefined ? null : clean(input.parentMemberId, "Parent member id", 64);
    if (parentMemberId && !this.getMember(projectId, parentMemberId)) throw Error("Parent member is not active in this project");
    const scopeTaskId = input.scopeTaskId === undefined ? null : clean(input.scopeTaskId, "Scope task id", 160);
    const id = input.id ? clean(input.id, "Member id", 64) : randomUUID();
    const now = Date.now();
    try {
      return this.transaction(() => {
        if (spawnRequestId) {
          const existing = this.db
            .prepare("SELECT * FROM project_members WHERE project_id=? AND spawn_request_id=?")
            .get(projectId, spawnRequestId) as MemberRow | undefined;
          if (existing) return this.member(existing);
        }
        this.db
          .prepare(
            `INSERT INTO project_members(id,project_id,device_id,session_id,agent_id,name,role,permission_profile,executor,model,allow_model_fallback,fallback_models_json,cwd,t3_environment_id,temporary,lifecycle_state,parent_member_id,scope_task_id,spawn_request_id,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
          )
          .run(id, projectId, deviceId, sessionId, agentId, name, role, permissionProfile, executor, model,
            allowModelFallback ? 1 : 0, JSON.stringify(fallbackModels), cwd, t3EnvironmentId, input.temporary ? 1 : 0,
            parentMemberId, scopeTaskId, spawnRequestId, now);
        this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now, projectId);
        const member = this.getMember(projectId, id)!;
        this.event(projectId, "member.added", member, undefined, id);
        return member;
      });
    } catch (error) {
      if (spawnRequestId) {
        const existing = this.db
          .prepare("SELECT * FROM project_members WHERE project_id=? AND spawn_request_id=?")
          .get(projectId, spawnRequestId) as MemberRow | undefined;
        if (existing) return this.member(existing);
      }
      if (String((error as Error).message).includes("UNIQUE"))
        throw Error("That agent is already a member of this project");
      throw error;
    }
  }

  removeMember(projectId: string, memberId: string) {
    return this.transaction(() => {
      const result = this.db
        .prepare("DELETE FROM project_members WHERE project_id=? AND id=?")
        .run(projectId, memberId);
      if (result.changes) {
        this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(Date.now(), projectId);
        this.event(projectId, "member.removed", { memberId }, memberId);
      }
      return result.changes > 0;
    });
  }

  updateMember(
    projectId: string,
    memberId: string,
    patch: {
      role?: string;
      model?: string;
      permissionProfile?: ProjectPermissionProfile;
      allowModelFallback?: boolean;
      fallbackModels?: string[];
      t3EnvironmentId?: string | null;
      cwd?: string;
    },
  ) {
    const current = this.getMember(projectId, memberId);
    if (!current) throw Error(`Active project member not found: ${memberId}`);
    const workspaceManagedPi = current.executor === "pi" && Boolean(current.cwd);
    const supportsManagedModel = current.executor === "codex" || workspaceManagedPi;
    const role = patch.role === undefined ? current.role : clean(patch.role, "Member role", 80);
    const model = patch.model === undefined
      ? current.model
      : clean(patch.model, "Member model", 160);
    if (patch.model !== undefined && !supportsManagedModel)
      throw Error("Model updates are available only for Codex members");
    if (patch.model !== undefined && current.executor === "codex" && isLocalPiModel(model))
      throw Error("Gemini and DeepSeek models require executor='pi' and run locally on this workstation");
    const permissionProfile = patch.permissionProfile ?? current.permissionProfile;
    if (!["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"].includes(permissionProfile))
      throw Error("Invalid project member permission profile");
    const allowModelFallback = patch.allowModelFallback ?? current.allowModelFallback;
    const fallbackModels = patch.fallbackModels === undefined
      ? current.fallbackModels
      : modelFallbacks(patch.fallbackModels, model);
    if (!supportsManagedModel && (allowModelFallback || fallbackModels.length))
      throw Error("Model fallback is available only for Codex members");
    if (allowModelFallback && !fallbackModels.length)
      throw Error("At least one fallback model is required when automatic fallback is enabled");
    const t3EnvironmentId = patch.t3EnvironmentId === undefined
      ? current.t3EnvironmentId ?? null
      : patch.t3EnvironmentId === null
        ? null
        : clean(patch.t3EnvironmentId, "T3 environment id", 160);
    if (t3EnvironmentId && !supportsManagedModel)
      throw Error("T3 environment binding is available only for Codex members");
    const cwd = patch.cwd === undefined
      ? current.cwd ?? null
      : clean(patch.cwd, "Member working directory", 500);
    if (patch.cwd !== undefined && !supportsManagedModel)
      throw Error("Working directory updates are available only for Codex members");
    const now = Date.now();
    const workspaceChanged = cwd !== (current.cwd ?? null);
    const modelChanged = model !== current.model;
    const executionIdentityChanged = workspaceChanged || modelChanged;
    return this.transaction(() => {
      this.db.prepare(
        `UPDATE project_members SET role=?,model=?,permission_profile=?,allow_model_fallback=?,fallback_models_json=?,t3_environment_id=?,cwd=?,
           codex_thread_id=CASE WHEN ? THEN NULL ELSE codex_thread_id END,
           codex_tools_version=CASE WHEN ? THEN 0 ELSE codex_tools_version END,
           codex_thread_model=CASE WHEN ? THEN NULL ELSE codex_thread_model END,
           codex_thread_runtime=CASE WHEN ? THEN 'codex-app-server' ELSE codex_thread_runtime END,
           codex_thread_provider=CASE WHEN ? THEN NULL ELSE codex_thread_provider END
         WHERE project_id=? AND id=? AND lifecycle_state!='ARCHIVED'`,
      ).run(role, model ?? null, permissionProfile, allowModelFallback ? 1 : 0, JSON.stringify(fallbackModels), t3EnvironmentId, cwd,
        executionIdentityChanged ? 1 : 0, executionIdentityChanged ? 1 : 0, executionIdentityChanged ? 1 : 0,
        executionIdentityChanged ? 1 : 0, executionIdentityChanged ? 1 : 0, projectId, memberId);
      this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now, projectId);
      this.event(projectId, "member.permissions.updated", {
        memberId,
        from: { role: current.role, model: current.model, permissionProfile: current.permissionProfile, allowModelFallback: current.allowModelFallback, fallbackModels: current.fallbackModels, t3EnvironmentId: current.t3EnvironmentId, cwd: current.cwd },
        to: { role, model, permissionProfile, allowModelFallback, fallbackModels, t3EnvironmentId, cwd },
      }, memberId);
      if (workspaceChanged && current.threadId)
        this.event(projectId, "member.thread.detached", {
          memberId,
          threadId: current.threadId,
          fromWorkspace: current.cwd,
          toWorkspace: cwd,
          reason: "WORKSPACE_CHANGED",
        }, memberId);
      if (modelChanged) {
        this.event(projectId, "member.model.updated", {
          memberId,
          fromModel: current.model,
          toModel: model,
          detachedThreadId: current.threadId,
        }, memberId);
        if (current.threadId)
          this.event(projectId, "member.thread.detached", {
            memberId,
            threadId: current.threadId,
            fromModel: current.threadModel ?? current.model,
            toModel: model,
            reason: "MODEL_CHANGED",
          }, memberId);
      }
      if (allowModelFallback !== current.allowModelFallback ||
          JSON.stringify(fallbackModels) !== JSON.stringify(current.fallbackModels))
        this.event(projectId, "member.model_policy.updated", {
          memberId,
          primaryModel: model,
          from: { allowModelFallback: current.allowModelFallback, fallbackModels: current.fallbackModels },
          to: { allowModelFallback, fallbackModels },
        }, memberId);
      return this.getMember(projectId, memberId)!;
    });
  }

  archiveMember(projectId: string, memberId: string, now = Date.now()) {
    const current = this.getMember(projectId, memberId);
    if (!current) throw Error(`Active project member not found: ${memberId}`);
    if (!current.temporary) throw Error("Only temporary members can be archived; remove permanent members explicitly");
    return this.transaction(() => {
      this.db
        .prepare("UPDATE project_members SET lifecycle_state='ARCHIVED',archived_at=? WHERE project_id=? AND id=? AND lifecycle_state!='ARCHIVED'")
        .run(now, projectId, memberId);
      this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now, projectId);
      this.event(projectId, "member.archived", { memberId, scopeTaskId: current.scopeTaskId }, memberId);
      return this.getMember(projectId, memberId, true)!;
    });
  }

  setMemberThread(
    projectId: string,
    memberId: string,
    threadId: string,
    codexToolsVersion = 0,
    threadModel?: string,
    threadRuntime: "codex-app-server" | "t3" | "deepseek-harness" | "antigravity" | "pi-cli" = "codex-app-server",
    threadProvider = "codex",
  ) {
    const cleanThreadId = clean(threadId, "Codex thread id", 160);
    if (!Number.isSafeInteger(codexToolsVersion) || codexToolsVersion < 0 || codexToolsVersion > 100)
      throw Error("Invalid Codex tools version");
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE project_members SET codex_thread_id=?,codex_tools_version=?,codex_thread_model=?,codex_thread_runtime=?,codex_thread_provider=? WHERE project_id=? AND id=? AND (executor='codex' OR (executor='pi' AND cwd IS NOT NULL))")
        .run(cleanThreadId, codexToolsVersion, threadModel ? clean(threadModel, "Codex thread model", 160) : null, threadRuntime, clean(threadProvider, "Codex thread provider", 64), projectId, memberId);
      if (!result.changes) throw Error(`Codex project member not found: ${memberId}`);
      this.event(projectId, "member.thread.updated", { memberId, threadId: cleanThreadId, codexToolsVersion, threadModel, threadRuntime, threadProvider }, memberId);
      return this.getMember(projectId, memberId)!;
    });
  }

  clearMemberThread(projectId: string, memberId: string, reason = "EXPLICIT_RESET") {
    const current = this.getMember(projectId, memberId);
    const supportsThread = current && (current.executor === "codex" || (current.executor === "pi" && Boolean(current.cwd)));
    if (!supportsThread) throw Error(`Codex project member not found: ${memberId}`);
    if (!current.threadId) return current;
    const cleanReason = clean(reason, "Thread detach reason", 120);
    return this.transaction(() => {
      this.db.prepare(
        `UPDATE project_members SET codex_thread_id=NULL,codex_tools_version=0,codex_thread_model=NULL,
           codex_thread_runtime='codex-app-server',codex_thread_provider=NULL
         WHERE project_id=? AND id=? AND (executor='codex' OR (executor='pi' AND cwd IS NOT NULL)) AND lifecycle_state!='ARCHIVED'`,
      ).run(projectId, memberId);
      this.event(projectId, "member.thread.detached", {
        memberId,
        threadId: current.threadId,
        workspace: current.cwd,
        reason: cleanReason,
      }, memberId);
      return this.getMember(projectId, memberId)!;
    });
  }

  event(
    projectId: string,
    kind: string,
    detail: unknown,
    fromMemberId?: string,
    toMemberId?: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO project_events(project_id,kind,from_member_id,to_member_id,detail_json,created_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(projectId, kind, fromMemberId ?? null, toMemberId ?? null, JSON.stringify(detail ?? null), Date.now());
  }

  events(projectId: string, limit = 100): ProjectEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM project_events WHERE project_id=? ORDER BY id DESC LIMIT ?")
      .all(projectId, Math.max(1, Math.min(500, limit))) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      ...(row.from_member_id ? { fromMemberId: row.from_member_id } : {}),
      ...(row.to_member_id ? { toMemberId: row.to_member_id } : {}),
      detail: JSON.parse(row.detail_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  hasEvent(projectId: string, kind: string) {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM project_events WHERE project_id=? AND kind=? LIMIT 1",
    ).get(projectId, kind));
  }

  close() {
    this.db.close();
  }
}
