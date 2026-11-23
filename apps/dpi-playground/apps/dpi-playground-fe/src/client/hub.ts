// Commands. Device calls go through the hub proxy (it injects the token, so the browser never
// holds one); status checks and UI state go to the hub itself.
import { DpiClient } from "@sdk/client";
import { DpiError } from "@sdk/errors";
import type {
  ErrorCode,
  NetworkDevice,
  PlatformObservabilitySummary,
  ProjectAgentBlueprint,
  ProjectAgentBlueprintBinding,
  ProjectEvent,
  ProjectHandoff,
  ProjectHandoffGitCheck,
  ProjectHandoffValidation,
  ProjectHandoffImportResult,
  ProjectMember,
  ProjectApproval,
  ProjectArtifact,
  ProjectAutonomyMode,
  ProjectMemory,
  ProjectMemoryRevision,
  ProjectModelUsage,
  ProjectSummary,
  ProjectTask,
  ProjectTaskAttempt,
  ProjectTaskLease,
  ProjectTeamPlan,
  ProjectTemplate,
  ProjectToolCall,
  ProjectUsageSummary,
  ProjectWorktree,
  SendResult,
  WhenBusy,
} from "@sdk/api";

export const deviceClient = (id: string) => new DpiClient(`/api/devices/${encodeURIComponent(id)}`);

export interface T3EnvironmentLink {
  environmentId: string;
  label: string;
  status: string;
  access: string;
}

export interface T3EnvironmentsResult {
  available: boolean;
  linksEnabled: boolean;
  environmentId: string | null;
  links: T3EnvironmentLink[];
  notListed?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => undefined);
  if (!r.ok) {
    const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
    throw new DpiError(
      error?.code ?? "internal",
      error?.message ?? `${r.status} ${r.statusText}`,
      r.status,
    );
  }
  return data as T;
}

export const hub = {
  t3Environments: () => call<T3EnvironmentsResult>("GET", "/t3/environments"),
  observability: () => call<PlatformObservabilitySummary>("GET", "/observability"),
  handoffInbox: () => call<{ directory: string }>("GET", "/handoffs/inbox"),
  importHandoff: (bundleName: string, targetProjectId?: string) =>
    call<ProjectHandoffImportResult>("POST", "/handoffs/import", { bundleName, targetProjectId }),
  network: () => call<{ configFile?: string; devices: NetworkDevice[] }>("GET", "/network"),
  projects: () => call<{ projects: ProjectSummary[] }>("GET", "/projects"),
  projectTemplates: () => call<{ templates: ProjectTemplate[] }>("GET", "/project-templates"),
  projectTeamPlan: (id: string) =>
    call<ProjectTeamPlan>("GET", `/projects/${encodeURIComponent(id)}/team-plan`),
  backups: () =>
    call<{
      directory: string;
      backups: Array<{ name: string; path: string; bytes: number; sha256: string; createdAt: number; artifactCount: number; artifactBytes: number; filesPath?: string }>;
    }>("GET", "/backups"),
  createBackup: () =>
    call<{ name: string; path: string; bytes: number; sha256: string; createdAt: number; artifactCount: number; artifactBytes: number; filesPath?: string }>("POST", "/backups", {}),
  purgeExpiredArtifacts: (graceDays = 30, limit = 1_000) =>
    call<{ purged: number; bytes: number; missing: number; orphanedTombstones: number }>(
      "POST", "/artifacts/purge-expired", { graceDays, limit },
    ),
  createProject: (body: {
    id?: string; name: string; description?: string; templateId?: string; autonomyMode?: ProjectAutonomyMode; tokenLimit24h?: number; maxTaskTokens?: number;
    maxCoordinationDepth?: number; maxDelegatedTasksPerTurn?: number; maxActiveTasks?: number; maxConcurrentTasks?: number;
  }) =>
    call<ProjectSummary>("POST", "/projects", body),
  updateProject: (id: string, body: {
    name?: string; description?: string; autonomyMode?: ProjectAutonomyMode; tokenLimit24h?: number | null; maxTaskTokens?: number | null;
    maxCoordinationDepth?: number | null; maxDelegatedTasksPerTurn?: number | null; maxActiveTasks?: number | null; maxConcurrentTasks?: number | null;
  }) =>
    call<ProjectSummary>("PATCH", `/projects/${encodeURIComponent(id)}`, body),
  removeProject: (id: string) =>
    call<{ ok: true }>("DELETE", `/projects/${encodeURIComponent(id)}`),
  projectEvents: (id: string) =>
    call<{ events: ProjectEvent[] }>("GET", `/projects/${encodeURIComponent(id)}/events`),
  projectToolCalls: (
    id: string,
    options: { taskId?: string; evidenceKind?: ProjectToolCall["evidenceKind"]; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.taskId) query.set("taskId", options.taskId);
    if (options.evidenceKind) query.set("evidenceKind", options.evidenceKind);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query}` : "";
    return call<{ toolCalls: ProjectToolCall[] }>("GET", `/projects/${encodeURIComponent(id)}/tool-calls${suffix}`);
  },
  projectArtifacts: (id: string, status: "ACTIVE" | "EXPIRED" | "ALL" = "ACTIVE") =>
    call<{ artifacts: ProjectArtifact[] }>(
      "GET",
      `/projects/${encodeURIComponent(id)}/artifacts?status=${status}`,
    ),
  publishProjectArtifact: (
    id: string,
    body: {
      name: string;
      kind?: string;
      mimeType?: string;
      taskId?: string;
      content: string;
      includeInHandoff?: boolean;
    },
  ) => call<ProjectArtifact>("POST", `/projects/${encodeURIComponent(id)}/artifacts`, body),
  scanProjectEnvironment: (id: string, workspace: string, includeInHandoff = true) =>
    call<ProjectArtifact>("POST", `/projects/${encodeURIComponent(id)}/environment-scan`, {
      workspace,
      includeInHandoff,
    }),
  async uploadProjectArtifact(
    id: string,
    file: File,
    options: { kind?: string; taskId?: string; includeInHandoff?: boolean } = {},
  ) {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/artifacts/binary`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-artifact-name": encodeURIComponent(file.name),
        "x-artifact-kind": options.kind ?? "binary",
        ...(options.taskId ? { "x-artifact-task-id": options.taskId } : {}),
        "x-artifact-handoff": String(Boolean(options.includeInHandoff)),
      },
      body: file,
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
      throw new DpiError(error?.code ?? "internal", error?.message ?? `${response.status} ${response.statusText}`, response.status);
    }
    return data as ProjectArtifact;
  },
  expireProjectArtifact: (projectId: string, artifactId: string) =>
    call<ProjectArtifact>(
      "DELETE",
      `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ),
  artifactContentUrl: (projectId: string, artifactId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
  projectUsage: (id: string, limit = 100) =>
    call<{ summary: ProjectUsageSummary; records: ProjectModelUsage[] }>(
      "GET",
      `/projects/${encodeURIComponent(id)}/usage?limit=${encodeURIComponent(limit)}`,
    ),
  projectHandoffs: (id: string) =>
    call<{ handoffs: ProjectHandoff[] }>("GET", `/projects/${encodeURIComponent(id)}/handoffs`),
  createProjectHandoff: (id: string, workspace?: string) =>
    call<ProjectHandoff>("POST", `/projects/${encodeURIComponent(id)}/handoffs`, { workspace }),
  validateProjectHandoff: (projectId: string, handoffId: string) =>
    call<ProjectHandoffValidation>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(handoffId)}/validate`,
      {},
    ),
  checkProjectHandoffGit: (projectId: string, handoffId: string, workspace: string) =>
    call<ProjectHandoffGitCheck>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(handoffId)}/check-git`,
      { workspace },
    ),
  checkImportedGitBaseline: (projectId: string, workspace: string) =>
    call<ProjectHandoffGitCheck>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/imported-git-baseline/check`,
      { workspace },
    ),
  projectMemories: (id: string, status: "ACTIVE" | "EXPIRED" | "ALL" = "ACTIVE", memberId?: string) =>
    call<{ memories: ProjectMemory[] }>(
      "GET",
      `/projects/${encodeURIComponent(id)}/memories?status=${status}${memberId ? `&memberId=${encodeURIComponent(memberId)}` : ""}`,
    ),
  putProjectMemory: (
    id: string,
    body: {
      key: string;
      value: unknown;
      sourceType: string;
      sourceId?: string;
      expectedVersion?: number;
      memberId?: string;
    },
  ) => call<ProjectMemory>("POST", `/projects/${encodeURIComponent(id)}/memories`, body),
  projectMemoryHistory: (projectId: string, memoryId: string) =>
    call<{ revisions: ProjectMemoryRevision[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}/history`,
    ),
  expireProjectMemory: (projectId: string, memoryId: string, expectedVersion?: number) =>
    call<ProjectMemory>(
      "DELETE",
      `/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`,
      { expectedVersion },
    ),
  projectApprovals: (id: string) =>
    call<{ approvals: ProjectApproval[] }>(
      "GET",
      `/projects/${encodeURIComponent(id)}/approvals`,
    ),
  requestProjectApproval: (
    id: string,
    body: { operation: unknown; requestedBy: string; ttlMs?: number },
  ) => call<ProjectApproval>("POST", `/projects/${encodeURIComponent(id)}/approvals`, body),
  decideProjectApproval: (
    projectId: string,
    approvalId: string,
    body: { decision: "APPROVED" | "DENIED"; decidedBy: string },
  ) =>
    call<ProjectApproval>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      body,
    ),
  revokeProjectApproval: (
    projectId: string,
    approvalId: string,
    revokedBy: string,
  ) =>
    call<ProjectApproval>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/revoke`,
      { revokedBy },
    ),
  projectTasks: (id: string, limit = 100) =>
    call<{ tasks: ProjectTask[] }>(
      "GET",
      `/projects/${encodeURIComponent(id)}/tasks?limit=${encodeURIComponent(limit)}`,
    ),
  enqueueProjectTask: (
    id: string,
    body: {
      id?: string;
      title: string;
      input?: unknown;
      priority?: number;
      maxAttempts?: number;
      availableAt?: number;
      dependsOn?: string[];
    },
  ) => call<ProjectTask>("POST", `/projects/${encodeURIComponent(id)}/tasks`, body),
  projectTaskAttempts: (projectId: string, taskId: string) =>
    call<{ attempts: ProjectTaskAttempt[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/attempts`,
    ),
  claimProjectTask: (
    id: string,
    body: {
      workerId: string;
      leaseMs?: number;
      maxGlobalRunning?: number;
      maxProjectRunning?: number;
      maxWorkerRunning?: number;
    },
  ) =>
    call<ProjectTaskLease | undefined>(
      "POST",
      `/projects/${encodeURIComponent(id)}/tasks/claim`,
      body,
    ),
  heartbeatProjectTask: (
    projectId: string,
    taskId: string,
    body: { workerId: string; fenceEpoch: number; leaseMs?: number },
  ) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/heartbeat`,
      body,
    ),
  completeProjectTask: (
    projectId: string,
    taskId: string,
    body: { workerId: string; fenceEpoch: number; result?: unknown },
  ) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/complete`,
      body,
    ),
  failProjectTask: (
    projectId: string,
    taskId: string,
    body: { workerId: string; fenceEpoch: number; error?: unknown; retryDelayMs?: number },
  ) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/fail`,
      body,
    ),
  cancelProjectTask: (projectId: string, taskId: string) =>
    call<{ task: ProjectTask; archivedMember?: ProjectMember; archiveErrors: string[] }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
    ),
  pauseProjectTask: (projectId: string, taskId: string) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/pause`,
      {},
    ),
  resumeProjectTask: (projectId: string, taskId: string) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resume`,
      {},
    ),
  resolveUnknownSideEffect: (
    projectId: string,
    taskId: string,
    body: { resolution: "RETRY" | "MARK_COMPLETED"; actor: string; note: string },
  ) =>
    call<ProjectTask>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resolve-side-effect`,
      body,
    ),
  addProjectMember: (
    id: string,
    body: {
      deviceId: string;
      sessionId: string;
      agentId: string | number;
      name?: string;
      role?: string;
      permissionProfile?: "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE";
      executor?: "pi" | "codex";
      model?: string;
      allowModelFallback?: boolean;
      fallbackModels?: string[];
      cwd?: string;
      t3EnvironmentId?: string;
      temporary?: boolean;
      parentMemberId?: string;
      scopeTaskId?: string;
    },
  ) => call<ProjectMember>("POST", `/projects/${encodeURIComponent(id)}/members`, body),
  projectAgentBlueprints: (projectId: string) =>
    call<{ blueprints: ProjectAgentBlueprint[] }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/agent-blueprints`,
    ),
  bindProjectAgentBlueprint: (
    projectId: string,
    blueprintId: string,
    body: {
      name: string;
      role: string;
      permissionProfile: "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE";
      deviceId?: string;
      sessionId?: string;
      agentId?: string | number;
      model?: string;
      allowModelFallback?: boolean;
      fallbackModels?: string[];
      cwd?: string;
      t3EnvironmentId?: string;
    },
  ) => call<ProjectAgentBlueprintBinding>(
    "POST",
    `/projects/${encodeURIComponent(projectId)}/agent-blueprints/${encodeURIComponent(blueprintId)}/bind`,
    body,
  ),
  projectWorktrees: (projectId: string) =>
    call<{ worktrees: ProjectWorktree[] }>("GET", `/projects/${encodeURIComponent(projectId)}/worktrees`),
  createProjectWorktree: (
    projectId: string,
    body: { repositoryRoot: string; label: string; base?: string; branch?: string },
  ) => call<ProjectWorktree>("POST", `/projects/${encodeURIComponent(projectId)}/worktrees`, body),
  checkProjectWorktree: (projectId: string, worktreeId: string) =>
    call<ProjectWorktree>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/check`,
      {},
    ),
  removeProjectWorktree: (projectId: string, worktreeId: string) =>
    call<ProjectWorktree>(
      "DELETE",
      `/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
    ),
  updateProjectMember: (
    projectId: string,
    memberId: string,
    body: {
      role?: string;
      permissionProfile?: "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE";
      allowModelFallback?: boolean;
      fallbackModels?: string[];
      cwd?: string;
      t3EnvironmentId?: string | null;
    },
  ) => call<ProjectMember>(
    "PATCH",
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`,
    body,
  ),
  codexModels: () => call<{ data?: Array<{
    id: string;
    model: string;
    displayName: string;
    description?: string;
    inputModalities: string[];
    supportedReasoningEfforts: string[];
    defaultReasoningEffort?: string;
    capabilities: {
      textInput: "supported" | "unsupported" | "unknown";
      imageInput: "supported" | "unsupported" | "unknown";
      reasoning: "supported" | "unsupported" | "unknown";
      dynamicTools: "supported" | "unsupported" | "unknown";
    };
  }> }>("GET", "/codex/models"),
  localModels: () => call<{
    t3PiWorkerProviderInstanceId: string;
    t3GeminiWorkerProviderInstanceId?: string;
    roleModelMap: Record<string, string>;
    providers: Array<{
      provider: "google" | "deepseek";
      runtime: "deepseek-harness" | "antigravity";
      displayName: string;
      authMode: "antigravity-oauth" | "deepseek-harness-account" | "api-key";
      apiKeyForbidden: boolean;
      runtimeInstalled: boolean;
      envKey?: string;
      baseUrlEnvKey?: string;
      baseUrl?: string;
      defaultModel: string;
      configured: boolean;
      authSource: "dsh-account" | "dsh-credentials" | "env" | "pi-auth" | "both" | "antigravity-cli-account" | "none";
      remoteAllowedByDefault: false;
      verifiedModels: string[];
      models: Array<{
        id: string;
        qualifiedId: string;
        provider: "google" | "deepseek";
        runtime: "deepseek-harness" | "antigravity";
        name: string;
        icon: string;
        verified: boolean;
        verificationSource: "dsh-session-evidence" | "antigravity-session-evidence" | "runtime-probe" | "unverified";
        contextWindow: number | null;
        maxOutputTokens: number | null;
        reasoning: "supported" | "unsupported" | "unknown";
        inputModalities: string[];
      }>;
    }>;
  }>("GET", "/local-models"),
  removeProjectMember: (id: string, memberId: string) =>
    call<{ ok: true }>(
      "DELETE",
      `/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`,
    ),
  archiveProjectMember: (id: string, memberId: string) =>
    call<{ member: ProjectMember; archiveErrors: string[] }>(
      "POST",
      `/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/archive`,
      {},
    ),
  sendProjectMessage: (
    id: string,
    body: {
      toMemberId: string;
      fromMemberId?: string;
      content: string;
      messageType?: import("@sdk/api").ProjectMessageType;
      correlationId?: string;
      payload?: unknown;
      timeoutMs?: number;
      whenBusy?: WhenBusy;
      waitMs?: number;
    },
  ) => call<SendResult>("POST", `/projects/${encodeURIComponent(id)}/messages`, body),
  /** Probe a device now. Devices themselves are configured in dpi-network.yaml, not here. */
  check: (id: string) =>
    call<NetworkDevice>("POST", `/devices/${encodeURIComponent(id)}/check`, {}),
  async uiGet<T>(key: string): Promise<T | undefined> {
    return ((await call<{ value: T | null }>("GET", `/ui-state/${encodeURIComponent(key)}`))
      .value ?? undefined) as T | undefined;
  },
  uiSet: (key: string, value: unknown) =>
    call<{ ok: true }>("PUT", `/ui-state/${encodeURIComponent(key)}`, { value }),
};

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
