import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProjectMember, ProjectSummary } from "../api.js";
import { memberPermissionWithinTemplate, memberRoleCanWrite, t3RuntimeModeFor } from "../execution-policy.js";
import { durableProjectTeamPlan, durableProjectTemplate } from "../project-templates.js";
import { ProjectArtifactStore } from "./artifacts.js";
import { DEFAULT_CODEX_MODEL } from "./codex-model-catalog.js";
import { DataSourceBindingStore, ReadOnlyDataSourceCatalog } from "./data-sources.js";
import { ProjectHandoffStore } from "./handoffs.js";
import { ProjectMemoryStore } from "./memories.js";
import { ProjectRegistry } from "./projects.js";
import { ProjectRelayStore } from "./relays.js";
import { ProjectReturnStore } from "./returns.js";
import { dpiHome } from "./registry.js";
import { ProjectTaskStore } from "./tasks.js";
import { T3RuntimeGateway } from "./t3-runtime.js";
import { assessWorktreeReadiness, ProjectWorktreeStore } from "./worktrees.js";

type JsonObject = Record<string, unknown>;

export interface DurableProjectContext {
  project: ProjectSummary;
  member: ProjectMember;
}

export interface DurableProjectMcpOptions {
  cwd?: string;
  databasePath?: string;
  projectId?: string;
  memberId?: string;
  dataSourceCatalogPath?: string;
  artifactRoot?: string;
  artifactMaxBytes?: number;
  worktreeRoot?: string;
  handoffRoot?: string;
  handoffInboxRoot?: string;
  relayScriptPath?: string;
  returnScriptPath?: string;
  integrationScriptPath?: string;
  t3RuntimeGateway?: Pick<T3RuntimeGateway, "cancel">;
  /** T3 Coordinator-only mode. The first tools/list atomically applies the
   * conservative no-input bootstrap defaults before exposing project tools. */
  autoInitialize?: boolean;
  /** Treat this cwd as its own T3 project even when it is nested inside an
   * already-managed workspace. Used by the T3 project monitor. */
  exactWorkspaceInitialization?: boolean;
  t3EnvironmentLister?: () => Promise<Array<{
    environmentId: string;
    status?: string;
    label?: string;
    lastReachedAt?: string;
  }>>;
}

const normalizedPath = (value: string) => {
  const path = resolve(value).replaceAll("/", sep).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};

const inside = (path: string, parent: string) => path === parent || path.startsWith(`${parent}${sep}`);

const relativeDataFolder = (source: { root: string; remoteRoot?: string; remotePlatform?: "posix" | "windows" }, value: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000 || value.includes("\0"))
    throw Error("path is invalid");
  const input = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (source.remoteRoot && source.remotePlatform === "windows" && /^[A-Za-z]:\//.test(input)) {
    const root = source.remoteRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    const foldedInput = input.toLowerCase();
    const foldedRoot = root.toLowerCase();
    if (foldedInput !== foldedRoot && !foldedInput.startsWith(`${foldedRoot}/`))
      throw Error("Absolute remote folder is outside the configured device data root");
    return foldedInput === foldedRoot ? "" : input.slice(root.length + 1);
  }
  if (source.remoteRoot && input.startsWith("/")) {
    const root = source.remoteRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    if (input !== root && !input.startsWith(`${root}/`))
      throw Error("Absolute remote folder is outside the configured device data root");
    return input === root ? "" : input.slice(root.length + 1);
  }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    const root = normalizedPath(source.root);
    const target = normalizedPath(value);
    if (!inside(target, root)) throw Error("Absolute folder is outside the configured device data root");
    return target === root ? "" : target.slice(root.length + 1).replaceAll(sep, "/");
  }
  const parts = input.replace(/^\/+/, "").split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw Error("Data folder cannot escape its configured root");
  return parts.join("/");
};

const coordinator = (member: ProjectMember) => member.role.trim().toLowerCase() === "coordinator";

const inferProjectTemplate = (cwd: string) => {
  const has = (...parts: string[]) => existsSync(resolve(cwd, ...parts));
  if (
    has("src-tauri") || has("electron-builder.yml") || has("electron-builder.yaml") ||
    has("capacitor.config.ts") || has("capacitor.config.json") || has("android") || has("ios")
  ) return "cross-platform";
  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile") || has("setup.py")) return "python";
  if (has("package.json") || has("vite.config.ts") || has("vite.config.js") || has("next.config.js") || has("next.config.mjs"))
    return "web";
  if (has("papers") || has("literature") || has("notebooks") || has("research")) return "research";
  return "blank";
};
const publicMember = (member: ProjectMember) => ({
  id: member.id,
  name: member.name,
  role: member.role,
  permissionProfile: member.permissionProfile,
  executor: member.executor,
  model: member.model,
  allowModelFallback: member.allowModelFallback,
  fallbackModels: member.fallbackModels,
  workspace: member.cwd,
  t3EnvironmentId: member.t3EnvironmentId,
  temporary: member.temporary,
  lifecycleState: member.lifecycleState,
  parentMemberId: member.parentMemberId,
  scopeTaskId: member.scopeTaskId,
  createdAt: member.createdAt,
});
const publicProject = (project: ProjectSummary) => ({
  id: project.id,
  name: project.name,
  description: project.description,
  autonomyMode: project.autonomyMode,
  templateId: project.templateId,
  templatePlan: project.templatePlan,
  tokenLimit24h: project.tokenLimit24h,
  maxTaskTokens: project.maxTaskTokens,
  maxCoordinationDepth: project.maxCoordinationDepth,
  maxDelegatedTasksPerTurn: project.maxDelegatedTasksPerTurn,
  maxActiveTasks: project.maxActiveTasks,
  maxConcurrentTasks: project.maxConcurrentTasks,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});
const bundledRelayScript = fileURLToPath(new URL("../../../../windows/relay-project.ps1", import.meta.url));
const bundledReturnScript = fileURLToPath(new URL("../../../../windows/fetch-remote-project.ps1", import.meta.url));
const bundledIntegrationScript = fileURLToPath(new URL("../../../../windows/apply-fast-forward.ps1", import.meta.url));

export function resolveDurableProjectContext(
  projects: readonly ProjectSummary[],
  input: Pick<DurableProjectMcpOptions, "cwd" | "projectId" | "memberId">,
): DurableProjectContext {
  const explicitProject = input.projectId
    ? projects.find((project) => project.id === input.projectId)
    : undefined;
  if (input.projectId && !explicitProject) throw Error(`Unknown Durable Pi project: ${input.projectId}`);

  if (input.memberId) {
    if (!explicitProject) throw Error("DPI_MEMBER_ID requires DPI_PROJECT_ID");
    const member = explicitProject.members.find((candidate) => candidate.id === input.memberId);
    if (!member) throw Error(`Active Durable Pi member not found: ${input.memberId}`);
    return { project: explicitProject, member };
  }

  if (explicitProject) {
    const coordinators = explicitProject.members.filter(coordinator);
    if (coordinators.length === 1) return { project: explicitProject, member: coordinators[0]! };
    if (explicitProject.members.length === 1) return { project: explicitProject, member: explicitProject.members[0]! };
    throw Error(`Project ${explicitProject.id} has no unique Coordinator; set DPI_MEMBER_ID`);
  }

  const cwd = normalizedPath(input.cwd ?? process.cwd());
  const matches = projects.flatMap((project) =>
    project.members.flatMap((member) => {
      if (!member.cwd) return [];
      const root = normalizedPath(member.cwd);
      return inside(cwd, root) ? [{ project, member, root }] : [];
    }),
  );
  if (!matches.length)
    throw Error(`No Durable Pi project member owns the current working directory: ${input.cwd ?? process.cwd()}`);

  const longest = Math.max(...matches.map((match) => match.root.length));
  const nearest = matches.filter((match) => match.root.length === longest);
  const preferred = nearest.filter((match) => coordinator(match.member));
  const candidates = preferred.length ? preferred : nearest;
  if (candidates.length !== 1) {
    const identities = candidates.map(({ project, member }) => `${project.id}/${member.id}`).join(", ");
    throw Error(`Working directory matches multiple Durable Pi members (${identities}); set DPI_PROJECT_ID and DPI_MEMBER_ID`);
  }
  return candidates[0]!;
}

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} must be an object`);
  return value as JsonObject;
};

const boundedLimit = (value: unknown, fallback: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    throw Error(`limit must be an integer from 1 to ${maximum}`);
  return value as number;
};

const requiredText = (value: unknown, label: string, maximum: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const clean = value.trim();
  if (clean.length > maximum) throw Error(`${label} must be at most ${maximum} characters`);
  return clean;
};

const optionalInteger = (value: unknown, label: string, minimum: number, maximum: number) => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
};

const boundedValue = (value: unknown, maximum = 4_000): unknown => {
  if (value === undefined) return undefined;
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  if (encoded === undefined || encoded.length <= maximum) return value;
  return {
    truncated: true,
    preview: encoded.slice(0, maximum),
    sha256: createHash("sha256").update(encoded).digest("hex"),
    originalLength: encoded.length,
  };
};

const gitResult = (workspace: string, args: string[], accepted = [0]) => {
  const result = spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  if (!accepted.includes(status))
    throw Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return { status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const toolResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const toolError = (error: unknown) => ({
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});

const BOOTSTRAP_TOOL = {
  name: "initialize_durable_project",
  description:
    "MANDATORY first action for the first substantive user request in an unmanaged T3 workspace: call this automatically with {} before answering, without asking the user to initialize or choose routine settings. It idempotently registers only the current workspace, infers its template, uses SUPERVISED mode, and binds every configured read-only device data source. Explicit fields remain available for advanced overrides.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      request_id: { type: "string", minLength: 1, maxLength: 240 },
      name: { type: "string", minLength: 1, maxLength: 120 },
      template_id: { type: "string", enum: ["auto", "blank", "web", "python", "research", "cross-platform"], default: "auto" },
      autonomy_mode: {
        type: "string",
        enum: ["SUPERVISED", "AUTHORIZED_AUTONOMY", "RESTRICTED_UNATTENDED"],
        default: "SUPERVISED",
      },
      coordinator_model: { type: "string", minLength: 1, maxLength: 160, default: DEFAULT_CODEX_MODEL },
      data_source_ids: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 64 },
        maxItems: 100,
      },
    },
    additionalProperties: false,
  },
} as const;

const DATA_SOURCE_OPTIONS_TOOL = {
  name: "list_durable_data_source_options",
  description:
    "List the data-source IDs that may be selected while initializing this T3 workspace. This omits physical roots and every other project's bindings.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const PROJECT_TOOLS = [
  {
    name: "get_durable_project",
    description: "Read this T3 thread's Durable Pi project policy and caller identity.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_durable_agents",
    description: "List active Agents in this Durable Pi project, including roles, executors, isolated workspaces and bounded real-time task workloads.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_execution_targets",
    description: "Coordinator-only: list remote T3 execution targets bound to this project, their verified models and current T3 link reachability when available. This never contacts the target filesystem.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_durable_data_folders",
    description: "Coordinator-only: list device connectors bound to this project and the exact read-only folders currently authorized on each device.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bind_durable_data_folder",
    description: "Coordinator-only: idempotently authorize one exact read-only folder inside a project-bound device source. Accepts a source-relative path or an absolute path inside that source root; it never grants the rest of the device.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        path: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["request_id", "source_id", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_tasks",
    description: "List bounded scheduler metadata. Coordinators see the project; other Agents see only tasks addressed to themselves. Task inputs are never returned.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_memories",
    description: "List a bounded view of active shared project memory and private memory belonging to this Agent only. Large values are replaced by previews and hashes.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_artifacts",
    description: "List active file artifacts isolated to this Durable Pi project.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_handoffs",
    description: "Coordinator-only: list recent validated-transfer candidates created for this Durable Pi project.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_relays",
    description: "Coordinator-only: list persisted READY receipts for project copies relayed to target devices.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_relay_plans",
    description: "Coordinator-only: list frozen project-copy plans and whether each has produced a verified READY receipt.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_durable_returns",
    description: "Coordinator-only: list frozen remote-return plans and verified Git refs fetched back into this Windows project.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_durable_return",
    description:
      "Coordinator-only, non-destructive: compare one verified remote-return ref with the current Windows HEAD, list bounded file changes, and predict merge conflicts without changing the worktree or current branch.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        max_files: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      required: ["source_id", "project_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_durable_handoff",
    description:
      "Coordinator-only: idempotently create and validate a versioned project handoff. Source code remains in Git; include_git_baseline requires a clean Git root.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        include_git_baseline: { type: "boolean", default: false },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_durable_relay",
    description:
      "Coordinator-only: freeze an exact clean-Git project copy to one bound remote device and return the exact PowerShell invocation. Running that invocation remains subject to T3's native command approval.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        handoff_id: { type: "string", minLength: 1, maxLength: 160 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        title: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["request_id", "handoff_id", "source_id", "project_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_durable_return",
    description:
      "Coordinator-only: freeze a safe Git fetch from one previously relayed remote project. The returned command fetches into refs/dpi/remotes without checking out or merging and remains subject to T3 command approval.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      },
      required: ["request_id", "source_id", "project_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_durable_fast_forward",
    description:
      "Coordinator-only: freeze a one-use fast-forward of the current clean Windows branch to a verified remote-return revision. Diverged, dirty, detached or already-equal states are rejected; execution remains subject to T3 command approval.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      },
      required: ["request_id", "source_id", "project_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_durable_integration_agent",
    description:
      "Coordinator-only: for a verified divergent remote return, idempotently create an isolated managed Git worktree and temporary write-capable Resolver Agent. This never merges into the main checkout.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        template_member_id: { type: "string", minLength: 1, maxLength: 64 },
        role: { type: "string", minLength: 1, maxLength: 80, default: "integration-resolver" },
        name: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["request_id", "source_id", "project_slug", "template_member_id"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_durable_integration_promotion",
    description:
      "Coordinator-only: after a temporary Resolver has committed a reviewed divergent integration in its managed worktree, freeze an exact fast-forward promotion back to the unchanged clean Windows branch. Execution remains subject to T3 command approval.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        integration_member_id: { type: "string", minLength: 1, maxLength: 64 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      },
      required: ["request_id", "integration_member_id", "source_id", "project_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "finalize_durable_integration_agent",
    description:
      "Coordinator-only: after a WORKTREE_PROMOTION receipt is APPLIED, remove the clean managed Resolver worktree and archive its temporary Agent while retaining the integration branch and audit history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        integration_member_id: { type: "string", minLength: 1, maxLength: 64 },
        plan_id: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["integration_member_id", "plan_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stage_data_artifact",
    description:
      "Coordinator-only: copy one exact file from a project-bound read-only device data source into the project Artifact Store with size and SHA-256 verification.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        path: { type: "string", minLength: 1, maxLength: 2000 },
        kind: { type: "string", minLength: 1, maxLength: 80, default: "binary" },
        mime_type: { type: "string", minLength: 1, maxLength: 160, default: "application/octet-stream" },
        include_in_handoff: { type: "boolean", default: false },
        retention_days: { type: "integer", minimum: 1, maximum: 3650 },
      },
      required: ["request_id", "source_id", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "remember_durable_fact",
    description:
      "Create or update durable memory with optimistic concurrency and an idempotency key. Non-Coordinators may write only their own private memory.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        key: { type: "string", minLength: 1, maxLength: 160 },
        value: {},
        visibility: { type: "string", enum: ["private", "shared"], default: "private" },
        expected_version: { type: "integer", minimum: 1 },
        expires_at: { type: "integer", minimum: 1 },
      },
      required: ["request_id", "key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_durable_task",
    description:
      "Coordinator-only: idempotently queue a durable task for another active Agent. Project concurrency, dependency and retry limits are enforced by the scheduler.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        coordination_id: { type: "string", minLength: 1, maxLength: 128 },
        target_member_id: { type: "string", minLength: 1, maxLength: 64 },
        content: { type: "string", minLength: 1, maxLength: 100000 },
        title: { type: "string", minLength: 1, maxLength: 240 },
        priority: { type: "integer", minimum: -1000, maximum: 1000 },
        max_attempts: { type: "integer", minimum: 1, maximum: 20 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 86400000 },
        depends_on_task_ids: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 128 },
          maxItems: 64,
        },
      },
      required: ["request_id", "coordination_id", "target_member_id", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_durable_agent",
    description:
      "Coordinator-only: idempotently activate one pre-authorized role from this project's team plan. By default, writable roles get an isolated worktree when the project is a clean committed Git root; otherwise the scheduler safely serializes their shared workspace.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        role: { type: "string", minLength: 1, maxLength: 80 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        workspace_strategy: { type: "string", enum: ["auto", "shared", "worktree"], default: "auto" },
      },
      required: ["request_id", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "materialize_durable_remote_agent",
    description:
      "Coordinator-only: bind a previously relayed and T3-registered target workspace to one planned permission profile. The target must exist under the selected device's managed DurablePiProjects directory, and its model must be selected explicitly from that device's verified capabilities.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        source_id: { type: "string", minLength: 1, maxLength: 64 },
        project_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        template_role: { type: "string", minLength: 1, maxLength: 80 },
        role: { type: "string", minLength: 1, maxLength: 80 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        model: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["request_id", "source_id", "project_slug", "template_role", "role", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "isolate_durable_agent_workspace",
    description:
      "Coordinator-only: move one idle local planned write Agent from the shared clean Git root into its own managed worktree. Existing isolated Agents are returned idempotently.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        member_id: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["request_id", "member_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_durable_agent",
    description:
      "Coordinator-only: idempotently create a temporary Agent from an active Codex template without increasing its permission profile. Writable local Agents use an isolated clean Git worktree by default when possible.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 240 },
        template_member_id: { type: "string", minLength: 1, maxLength: 64 },
        role: { type: "string", minLength: 1, maxLength: 80 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        permission_profile: {
          type: "string",
          enum: ["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
        },
        scope_task_id: { type: "string", minLength: 1, maxLength: 160 },
        workspace_strategy: { type: "string", enum: ["auto", "shared", "worktree"], default: "auto" },
      },
      required: ["request_id", "template_member_id", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_durable_agent",
    description:
      "Coordinator-only: archive one of this Coordinator's idle temporary Agents while preserving its history.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { member_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["member_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_durable_task",
    description:
      "Coordinator-only: cancel an unfinished task delegated by this Coordinator. Effects already completed by a running Agent are not rolled back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1, maxLength: 128 },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["task_id", "reason"],
      additionalProperties: false,
    },
  },
] as const;

const NON_COORDINATOR_PROJECT_TOOLS = new Set([
  "get_durable_project",
  "list_durable_agents",
  "list_durable_tasks",
  "list_durable_memories",
  "list_durable_artifacts",
  "remember_durable_fact",
]);

/** Project-scoped MCP facade used by T3 threads. Every mutation is bounded, idempotent and role checked. */
export class DurableProjectMcpServer {
  private readonly projects: ProjectRegistry;
  private readonly tasks: ProjectTaskStore;
  private readonly memories: ProjectMemoryStore;
  private readonly artifacts: ProjectArtifactStore;
  private readonly dataSourceCatalogPath: string;
  private handoffs?: ProjectHandoffStore;
  private relays?: ProjectRelayStore;
  private returns?: ProjectReturnStore;

  constructor(private readonly options: DurableProjectMcpOptions = {}) {
    const databasePath = options.databasePath ?? `${dpiHome()}${sep}projects.sqlite`;
    this.projects = new ProjectRegistry(databasePath);
    this.tasks = new ProjectTaskStore(databasePath);
    this.memories = new ProjectMemoryStore(databasePath);
    this.artifacts = new ProjectArtifactStore(databasePath, options.artifactRoot, options.artifactMaxBytes);
    this.dataSourceCatalogPath = options.dataSourceCatalogPath ?? `${dpiHome()}${sep}data-sources.json`;
  }

  private resolveContext() {
    // The Hub and other MCP processes may update this project while this server
    // remains alive. Resolve from the current projection on every tool call so
    // membership, policy and template-plan changes are never authorized from a
    // stale process-local snapshot.
    return resolveDurableProjectContext(this.projects.list(), this.options);
  }

  private handoffStore() {
    return this.handoffs ??= new ProjectHandoffStore(
      this.projects.path,
      this.projects,
      this.memories,
      this.artifacts,
      this.options.handoffRoot,
      this.options.handoffInboxRoot,
    );
  }

  private relayStore() {
    return this.relays ??= new ProjectRelayStore(this.projects.path);
  }

  private returnStore() {
    return this.returns ??= new ProjectReturnStore(this.projects.path);
  }

  private currentContext() {
    try {
      return this.resolveContext();
    } catch {
      return undefined;
    }
  }

  async handle(message: unknown): Promise<JsonObject | undefined> {
    const request = object(message, "MCP request");
    if (request.jsonrpc !== "2.0") throw Error("Unsupported JSON-RPC version");
    if (request.id === undefined) return undefined;
    const id = request.id;
    try {
      switch (request.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "durable-pi-project", version: "0.1.0" },
            },
          };
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          {
            let context = this.currentContext();
            if (context && this.options.exactWorkspaceInitialization &&
                normalizedPath(context.member.cwd ?? "") !== normalizedPath(this.options.cwd ?? process.cwd()))
              context = undefined;
            if (!context && this.options.autoInitialize) {
              const initialized = await this.initializeProject({});
              if (!("isError" in initialized && initialized.isError === true)) context = this.currentContext();
            }
            const tools = !context
              ? [DATA_SOURCE_OPTIONS_TOOL, BOOTSTRAP_TOOL]
              : coordinator(context.member)
                ? [...PROJECT_TOOLS]
                : PROJECT_TOOLS.filter((tool) => NON_COORDINATOR_PROJECT_TOOLS.has(tool.name));
          return {
            jsonrpc: "2.0",
            id,
              result: { tools },
          };
          }
        case "tools/call": {
          const params = object(request.params, "tools/call params");
          const name = typeof params.name === "string" ? params.name : "";
          const args = params.arguments === undefined ? {} : object(params.arguments, "tool arguments");
          const context = this.currentContext();
          if (name === DATA_SOURCE_OPTIONS_TOOL.name) {
            if (context) return { jsonrpc: "2.0", id, result: toolError("Data-source onboarding options are unavailable after project initialization") };
            return { jsonrpc: "2.0", id, result: this.listDataSourceOptions() };
          }
          if (name === BOOTSTRAP_TOOL.name)
            return { jsonrpc: "2.0", id, result: await this.initializeProject(args) };
          return { jsonrpc: "2.0", id, result: await this.callTool(name, args) };
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(request.method)}` } };
      }
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private listDataSourceOptions() {
    try {
      const sources = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath).sources.map((source) => ({
        id: source.id,
        label: source.label,
        device: source.device,
        readOnly: source.readOnly,
        remote: Boolean(source.environmentId || source.sshHost),
        ...(source.verifiedModels ? { verifiedModels: source.verifiedModels } : {}),
      }));
      return toolResult({ sources });
    } catch (error) {
      return toolError(error);
    }
  }

  private async initializeProject(args: JsonObject) {
    try {
      const cwd = resolve(this.options.cwd ?? process.cwd());
      const stat = lstatSync(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Current T3 workspace must be a real directory");
      const workspaceHash = createHash("sha256").update(normalizedPath(cwd)).digest("hex").slice(0, 20);
      const requestId = args.request_id === undefined
        ? `automatic-t3-initialization-${workspaceHash}`
        : requiredText(args.request_id, "request_id", 240);
      const name = args.name === undefined
        ? requiredText(basename(cwd), "workspace directory name", 120)
        : requiredText(args.name, "name", 120);
      const requestedTemplateId = args.template_id === undefined ? "auto" : requiredText(args.template_id, "template_id", 32);
      const templateId = requestedTemplateId === "auto" ? inferProjectTemplate(cwd) : requestedTemplateId;
      const template = durableProjectTemplate(templateId);
      if (!template) throw Error("Unknown project template");
      const autonomyMode = args.autonomy_mode === undefined
        ? "SUPERVISED"
        : requiredText(args.autonomy_mode, "autonomy_mode", 32);
      if (!["SUPERVISED", "AUTHORIZED_AUTONOMY", "RESTRICTED_UNATTENDED"].includes(autonomyMode))
        throw Error("Invalid autonomy_mode");
      const deviceDefaultModel = process.env.DPI_COORDINATOR_MODEL?.trim() || DEFAULT_CODEX_MODEL;
      const model = args.coordinator_model === undefined
        ? deviceDefaultModel
        : requiredText(args.coordinator_model, "coordinator_model", 160);
      if (args.data_source_ids !== undefined &&
          (!Array.isArray(args.data_source_ids) || args.data_source_ids.length > 100 ||
           args.data_source_ids.some((id) => typeof id !== "string")))
        throw Error("data_source_ids must be an array of at most 100 data-source IDs");
      const availableSourceIds = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath).sources.map((source) => source.id);
      const sourceIds = (args.data_source_ids === undefined ? availableSourceIds : args.data_source_ids) as string[];
      if (new Set(sourceIds).size !== sourceIds.length) throw Error("data_source_ids must be unique");
      if (sourceIds.length) {
        const available = new Set(availableSourceIds);
        const unknown = sourceIds.find((id) => !available.has(id));
        if (unknown) throw Error(`Unknown data source: ${unknown}`);
      }

      try {
        const existing = this.resolveContext();
        if (this.options.exactWorkspaceInitialization && normalizedPath(existing.member.cwd ?? "") !== normalizedPath(cwd))
          throw Error(`No Durable Pi project member owns the exact current working directory: ${cwd}`);
        const startedFromT3 = this.projects.hasEvent(existing.project.id, "project.initialized_from_t3");
        const completed = this.projects.hasEvent(existing.project.id, "project.initialization_completed");
        const boundSources = new DataSourceBindingStore(this.dataSourceCatalogPath)
          .boundSourceIds(existing.project.id);
        if (startedFromT3 && !completed && coordinator(existing.member)) {
          this.projects.event(existing.project.id, "project.initialization_completed", {
            requestId,
            workspace: existing.member.cwd,
            boundSources,
            recovered: true,
          }, existing.member.id, existing.member.id);
        }
        return toolResult({
          created: false,
          project: publicProject(existing.project),
          caller: publicMember(existing.member),
          boundSources,
          ...(startedFromT3 && !completed ? { recovered: coordinator(existing.member) } : {}),
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("No Durable Pi project member owns")) throw error;
      }

      const projectId = `t3-${workspaceHash}`;
      const memberId = `coordinator-${workspaceHash}`;
      let project = this.projects.get(projectId);
      let created = false;
      if (!project) {
        project = this.projects.create({
          id: projectId,
          templateId,
          templatePlan: durableProjectTeamPlan(template),
          name,
          description: template.description,
          autonomyMode: autonomyMode as "SUPERVISED" | "AUTHORIZED_AUTONOMY" | "RESTRICTED_UNATTENDED",
          maxCoordinationDepth: template.maxCoordinationDepth,
          maxDelegatedTasksPerTurn: template.maxDelegatedTasksPerTurn,
          maxActiveTasks: template.maxActiveTasks,
          maxConcurrentTasks: template.maxConcurrentTasks,
        }, {
          kind: "project.initialized_from_t3",
          detail: { requestId, workspace: cwd, templateId, autonomyMode, model },
        });
        created = true;
      }
      const bindingStore = new DataSourceBindingStore(this.dataSourceCatalogPath);
      const previousSourceIds = bindingStore.boundSourceIds(projectId);
      let memberCreated = false;
      try {
        let boundSources: string[] = [];
        if (sourceIds.length) {
          const sources = await bindingStore.setProjectSourcesAsync(projectId, sourceIds);
          boundSources = sources.filter((source) => source.bound).map((source) => source.id);
          const reboundCatalog = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          for (const sourceId of sourceIds) {
            const source = reboundCatalog.sources.find((candidate) => candidate.id === sourceId)!;
            if (!Object.prototype.hasOwnProperty.call(source.projectPaths ?? {}, projectId))
              bindingStore.setProjectFolders(projectId, sourceId, []);
          }
        }
        // Bind external grants before creating the member that makes this
        // workspace "managed". If the catalog update fails, onboarding remains
        // available and an identical retry can finish instead of being trapped
        // behind a half-created Coordinator identity.
        let member = this.projects.getMember(projectId, memberId);
        if (!member) {
          member = this.projects.addMember(projectId, {
            id: memberId,
            deviceId: "local-t3",
            sessionId: "t3-code",
            agentId: `coordinator-${workspaceHash}`,
            name: "Coordinator",
            role: "coordinator",
            permissionProfile: "READ_ONLY",
            executor: "codex",
            model,
            cwd,
          });
          memberCreated = true;
        } else if (normalizedPath(member.cwd ?? "") !== normalizedPath(cwd) || !coordinator(member)) {
          throw Error(`Deterministic workspace identity ${projectId} is already owned by an incompatible member`);
        }
        project = this.projects.get(projectId)!;
        this.projects.event(projectId, "project.initialization_completed", {
          requestId, workspace: cwd, boundSources,
        }, member.id, member.id);
        return toolResult({
          created,
          project: publicProject(project),
          coordinator: publicMember(member),
          boundSources,
        });
      } catch (error) {
        if (created || memberCreated || sourceIds.length > 0) {
          try {
            bindingStore.setProjectSources(projectId, previousSourceIds);
            if (created) this.projects.remove(projectId);
            else if (memberCreated) this.projects.removeMember(projectId, memberId);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Project initialization failed and its partial state could not be fully rolled back",
            );
          }
        }
        throw error;
      }
    } catch (error) {
      return toolError(error);
    }
  }

  private async callTool(name: string, args: JsonObject) {
    try {
      const { project, member } = this.resolveContext();
      switch (name) {
        case "get_durable_project":
          return toolResult({
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              autonomyMode: project.autonomyMode,
              templateId: project.templateId,
              tokenLimit24h: project.tokenLimit24h,
              maxTaskTokens: project.maxTaskTokens,
              maxCoordinationDepth: project.maxCoordinationDepth,
              maxDelegatedTasksPerTurn: project.maxDelegatedTasksPerTurn,
              maxActiveTasks: project.maxActiveTasks,
              maxConcurrentTasks: project.maxConcurrentTasks,
            },
            caller: publicMember(member),
          });
        case "list_durable_agents": {
          const limit = boundedLimit(args.limit, 100, 200);
          const workloads = this.tasks.memberWorkloads(project.id);
          const visibleAgents = project.members.slice(0, limit);
          return toolResult({
            projectId: project.id,
            callerMemberId: member.id,
            total: project.members.length,
            returned: visibleAgents.length,
            truncated: project.members.length > visibleAgents.length,
            agents: visibleAgents.map((agent) => {
              const workload = workloads.get(agent.id) ?? {
                activeTaskCount: 0,
                statusCounts: {},
                tasks: [],
                truncated: false,
              };
              const statuses = workload.statusCounts;
              const workState = (statuses.RUNNING || statuses.WAITING_APPROVAL)
                ? "BUSY"
                : (statuses.WAITING_DEVICE || statuses.PAUSED)
                  ? "WAITING"
                  : workload.activeTaskCount
                    ? "QUEUED"
                    : "IDLE";
              const scopeTask = agent.scopeTaskId ? this.tasks.get(agent.scopeTaskId) : undefined;
              const cleanupPending = Boolean(
                agent.temporary && scopeTask && ["COMPLETED", "FAILED", "CANCELLED"].includes(scopeTask.status) &&
                workload.activeTaskCount === 0,
              );
              return {
                ...publicMember(agent),
                workState,
                workload,
                ...(scopeTask ? { scopeTaskStatus: scopeTask.status } : {}),
                ...(cleanupPending ? { cleanupPending: true } : {}),
              };
            }),
          });
        }
        case "list_durable_execution_targets": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect remote execution targets");
          let live = new Map<string, { status?: string; label?: string; lastReachedAt?: string }>();
          let liveStatusError: string | undefined;
          if (this.options.t3EnvironmentLister) {
            try {
              live = new Map((await this.options.t3EnvironmentLister()).map((item) => [item.environmentId, item]));
            } catch (error) {
              liveStatusError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            }
          }
          const targets = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath).sources
            .filter((source) => source.projectIds?.includes(project.id) && source.environmentId && source.sshHost && source.remoteRoot)
            .map((source) => {
              const current = live.get(source.environmentId!);
              return {
                sourceId: source.id,
                label: source.label,
                device: source.device,
                environmentId: source.environmentId,
                verifiedModels: source.verifiedModels ?? [],
                status: current?.status ?? "unknown",
                ...(current?.lastReachedAt ? { lastReachedAt: current.lastReachedAt } : {}),
              };
            });
          return toolResult({
            projectId: project.id,
            targets,
            liveStatusAvailable: Boolean(this.options.t3EnvironmentLister) && !liveStatusError,
            ...(liveStatusError ? { liveStatusError } : {}),
          });
        }
        case "list_durable_data_folders": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect data-folder grants");
          const sources = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath).list(project.id);
          return toolResult({
            projectId: project.id,
            sources: sources.map((source) => ({
              sourceId: source.id,
              label: source.label,
              device: source.device,
              folders: "folders" in source ? source.folders : [""],
              reachable: source.reachable,
              error: source.error,
            })),
          });
        }
        case "bind_durable_data_folder": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may authorize data folders");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const inputPath = requiredText(args.path, "path", 2_000);
          const catalog = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          const source = catalog.sources.find((candidate) =>
            candidate.id === sourceId && candidate.projectIds?.includes(project.id));
          if (!source) throw Error(`Data source ${sourceId} is not bound to this project`);
          const folder = relativeDataFolder(source, inputPath);
          if (!folder) throw Error("The whole device data root cannot be authorized; choose a specific folder");
          // Validate that the exact folder exists and is a directory before persisting the grant.
          catalog.listDirectory(sourceId, folder, 1);
          const bindingStore = new DataSourceBindingStore(this.dataSourceCatalogPath);
          const before = bindingStore.boundFolders(project.id, sourceId);
          const folders = bindingStore.grantProjectFolder(project.id, sourceId, folder);
          const replayed = before.length === folders.length && before.every((value, index) => value === folders[index]);
          this.projects.event(project.id, "data_folder.authorized", {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            sourceId,
            path: folder,
            replayed,
          }, member.id, member.id);
          return toolResult({ projectId: project.id, sourceId, folder, folders, replayed, readOnly: true });
        }
        case "list_durable_tasks": {
          const limit = boundedLimit(args.limit, 50, 100);
          const visible = coordinator(member)
            ? this.tasks.list(project.id, limit)
            : this.tasks.listForMember(project.id, member.id, limit);
          return toolResult({
            projectId: project.id,
            callerMemberId: member.id,
            scope: coordinator(member) ? "project" : "assigned",
            tasks: visible.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              priority: task.priority,
              attemptCount: task.attemptCount,
              maxAttempts: task.maxAttempts,
              timeoutMs: task.timeoutMs,
              dependsOn: task.dependsOn,
              availableAt: task.availableAt,
              waitingDeviceId: task.waitingDeviceId,
              waitingApprovalId: task.waitingApprovalId,
              result: boundedValue(task.result),
              error: boundedValue(task.error),
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            })),
          });
        }
        case "list_durable_memories": {
          const limit = boundedLimit(args.limit, 100, 200);
          const total = this.memories.visibleCount(project.id, member.id);
          const visible = this.memories.visible(project.id, member.id, "ACTIVE", limit);
          const maxResultChars = 50_000;
          let resultChars = 0;
          const memories: Array<Record<string, unknown>> = [];
          for (const memory of visible) {
            const item = {
              id: memory.id,
              key: memory.key,
              value: boundedValue(memory.value, 8_000),
              sourceType: memory.sourceType,
              sourceId: memory.sourceId,
              visibility: memory.memberId ? "private" : "shared",
              status: memory.status,
              expiresAt: memory.expiresAt,
              version: memory.version,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
            };
            const itemChars = JSON.stringify(item).length;
            if (resultChars + itemChars > maxResultChars) break;
            memories.push(item);
            resultChars += itemChars;
          }
          return toolResult({
            projectId: project.id,
            callerMemberId: member.id,
            total,
            returned: memories.length,
            truncated: total > memories.length,
            truncatedBySize: visible.length > memories.length,
            resultChars,
            maxResultChars,
            memories,
          });
        }
        case "list_durable_artifacts": {
          const limit = boundedLimit(args.limit, 100, 200);
          const total = this.artifacts.count(project.id);
          const visible = this.artifacts.list(project.id, "ACTIVE", limit);
          return toolResult({
            projectId: project.id,
            total,
            returned: visible.length,
            truncated: total > visible.length,
            artifacts: visible,
          });
        }
        case "list_durable_handoffs": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect project handoffs");
          const limit = boundedLimit(args.limit, 20, 100);
          const all = this.handoffStore().list(project.id);
          return toolResult({
            projectId: project.id,
            total: all.length,
            returned: Math.min(all.length, limit),
            truncated: all.length > limit,
            handoffs: all.slice(0, limit),
          });
        }
        case "list_durable_relays": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect project relays");
          const limit = boundedLimit(args.limit, 20, 100);
          const all = this.relayStore().list(project.id);
          return toolResult({
            projectId: project.id,
            total: all.length,
            returned: Math.min(all.length, limit),
            truncated: all.length > limit,
            relays: all.slice(0, limit),
          });
        }
        case "list_durable_relay_plans": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect relay plans");
          const limit = boundedLimit(args.limit, 20, 100);
          const all = this.relayStore().listPlans(project.id);
          return toolResult({
            projectId: project.id,
            total: all.length,
            returned: Math.min(all.length, limit),
            truncated: all.length > limit,
            plans: all.slice(0, limit),
          });
        }
        case "list_durable_returns": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect project returns");
          const limit = boundedLimit(args.limit, 20, 100);
          const plans = this.returnStore().listPlans(project.id);
          const receipts = this.returnStore().listReceipts(project.id);
          const integrationPlans = this.returnStore().listIntegrationPlans(project.id);
          const integrationReceipts = this.returnStore().listIntegrationReceipts(project.id);
          return toolResult({
            projectId: project.id,
            plans: plans.slice(0, limit),
            receipts: receipts.slice(0, limit),
            totalPlans: plans.length,
            totalReceipts: receipts.length,
            integrationPlans: integrationPlans.slice(0, limit),
            integrationReceipts: integrationReceipts.slice(0, limit),
            totalIntegrationPlans: integrationPlans.length,
            totalIntegrationReceipts: integrationReceipts.length,
            truncated: plans.length > limit || receipts.length > limit ||
              integrationPlans.length > limit || integrationReceipts.length > limit,
          });
        }
        case "inspect_durable_return": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may inspect remote returns");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const maxFiles = boundedLimit(args.max_files, 200, 500);
          const receipt = this.returnStore().listReceipts(project.id).find((candidate) =>
            candidate.sourceId === sourceId && candidate.remoteTarget.endsWith(`/DurablePiProjects/${slug}`)
          );
          if (!receipt) throw Error("No READY remote-return receipt matches this source and project slug");
          const root = gitResult(member.cwd, ["rev-parse", "--show-toplevel"]).stdout;
          if (normalizedPath(root) !== normalizedPath(member.cwd)) throw Error("Coordinator workspace must be the Git top-level directory");
          const currentRevision = gitResult(member.cwd, ["rev-parse", "HEAD"]).stdout;
          const currentBranch = gitResult(member.cwd, ["branch", "--show-current"]).stdout || null;
          const managedRef = `refs/dpi/remotes/${sourceId}/${slug}`;
          const remoteRevision = gitResult(member.cwd, ["rev-parse", "--verify", managedRef]).stdout;
          if (remoteRevision !== receipt.revision) throw Error("Managed return ref no longer matches its verified receipt");
          const dirty = Boolean(gitResult(member.cwd, ["status", "--porcelain"]).stdout);
          let relationship: "SAME" | "REMOTE_AHEAD" | "LOCAL_AHEAD" | "DIVERGED";
          if (currentRevision === remoteRevision) relationship = "SAME";
          else if (gitResult(member.cwd, ["merge-base", "--is-ancestor", currentRevision, remoteRevision], [0, 1]).status === 0)
            relationship = "REMOTE_AHEAD";
          else if (gitResult(member.cwd, ["merge-base", "--is-ancestor", remoteRevision, currentRevision], [0, 1]).status === 0)
            relationship = "LOCAL_AHEAD";
          else relationship = "DIVERGED";
          const rawChanges = gitResult(member.cwd, ["diff", "--name-status", "--find-renames", currentRevision, remoteRevision]).stdout;
          const allChanges = rawChanges ? rawChanges.split(/\r?\n/).map((line) => {
            const [status, ...paths] = line.split("\t");
            return { status, paths };
          }) : [];
          let hasConflicts = false;
          let mergePreview: string[] = [];
          if (relationship === "DIVERGED") {
            const merge = gitResult(member.cwd, ["merge-tree", "--write-tree", "--name-only", currentRevision, remoteRevision], [0, 1]);
            hasConflicts = merge.status === 1;
            mergePreview = `${merge.stdout}\n${merge.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(0, 100);
          }
          return toolResult({
            projectId: project.id,
            sourceId,
            projectSlug: slug,
            managedRef,
            receiptId: receipt.id,
            currentRevision,
            currentBranch,
            remoteRevision,
            remoteBranch: receipt.branch,
            relationship,
            dirty,
            hasConflicts,
            safeToFastForward: relationship === "REMOTE_AHEAD" && !dirty,
            mergeCandidate: relationship === "DIVERGED" && !dirty && !hasConflicts,
            totalChanges: allChanges.length,
            returnedChanges: Math.min(allChanges.length, maxFiles),
            truncated: allChanges.length > maxFiles,
            changes: allChanges.slice(0, maxFiles),
            mergePreview,
          });
        }
        case "create_durable_handoff": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may create handoffs");
          const requestId = requiredText(args.request_id, "request_id", 240);
          if (args.include_git_baseline !== undefined && typeof args.include_git_baseline !== "boolean")
            throw Error("include_git_baseline must be a boolean");
          const includeGitBaseline = args.include_git_baseline === true;
          if (includeGitBaseline && !member.cwd) throw Error("The Coordinator has no Git workspace");
          const store = this.handoffStore();
          const handoff = store.create(project.id, {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            ...(includeGitBaseline ? { workspace: member.cwd } : {}),
          });
          const validation = store.validate(project.id, handoff.id);
          return toolResult({ handoff, validation, includesGitBaseline: includeGitBaseline });
        }
        case "plan_durable_relay": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may plan relays");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const handoffId = requiredText(args.handoff_id, "handoff_id", 160);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const title = args.title === undefined ? project.name : requiredText(args.title, "title", 120);
          const catalog = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          const source = catalog.sources.find((candidate) =>
            candidate.id === sourceId && candidate.projectIds?.includes(project.id)
          );
          if (!source) throw Error(`Data source ${sourceId} is not bound to this project`);
          if (!source.environmentId || !source.sshHost || !source.remoteRoot)
            throw Error(`Data source ${sourceId} is not a remote T3 execution target`);
          const check = this.handoffStore().checkGit(project.id, handoffId, member.cwd);
          if (!check.safeToApply || check.status !== "SAME")
            throw Error("Handoff Git baseline does not match the clean Coordinator workspace");
          const script = this.options.relayScriptPath ?? process.env.DPI_RELAY_SCRIPT ?? bundledRelayScript;
          if (!script || !isAbsolute(script)) throw Error("DPI_RELAY_SCRIPT must identify the installed relay script");
          const scriptStat = lstatSync(script);
          if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw Error("Relay script must be a real file");
          const plan = this.relayStore().plan(project.id, {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            handoffId,
            sourceId,
            repository: member.cwd,
            projectSlug: slug,
            title,
          });
          const argv = [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-PlanId", plan.id,
            "-ProjectId", project.id,
            "-HandoffId", handoffId,
            "-SourceId", sourceId,
            "-Repository", member.cwd,
            "-ProjectSlug", slug,
            "-Title", title,
          ];
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          const commandLine = `& ${quote("powershell.exe")} ${argv.map(quote).join(" ")}`;
          return toolResult({
            plan,
            git: check,
            execution: {
              executable: "powershell.exe",
              arguments: argv,
              commandLine,
              requiresT3CommandApproval: true,
            },
          });
        }
        case "plan_durable_return": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may plan remote returns");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const catalog = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          const source = catalog.sources.find((candidate) =>
            candidate.id === sourceId && candidate.projectIds?.includes(project.id)
          );
          if (!source) throw Error(`Data source ${sourceId} is not bound to this project`);
          if (!source.environmentId || !source.sshHost || !source.remoteRoot)
            throw Error(`Data source ${sourceId} is not a remote T3 execution target`);
          const target = `${source.remoteRoot.replace(/\/$/, "")}/DurablePiProjects/${slug}`;
          const relay = this.relayStore().list(project.id).find((candidate) =>
            candidate.sourceId === sourceId && candidate.target === target && candidate.status === "READY"
          );
          if (!relay) throw Error("A matching READY Relay Receipt is required before fetching remote changes");
          const script = this.options.returnScriptPath ?? process.env.DPI_RETURN_SCRIPT ?? bundledReturnScript;
          if (!isAbsolute(script)) throw Error("Return script path must be absolute");
          const scriptStat = lstatSync(script);
          if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw Error("Return script must be a real file");
          const plan = this.returnStore().plan(project.id, {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            sourceId,
            relayReceiptId: relay.id,
            repository: member.cwd,
            projectSlug: slug,
          });
          const argv = [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-PlanId", plan.id,
            "-ProjectId", project.id,
            "-SourceId", sourceId,
            "-Repository", member.cwd,
            "-ProjectSlug", slug,
          ];
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          return toolResult({
            plan,
            relayReceipt: relay,
            execution: {
              executable: "powershell.exe",
              arguments: argv,
              commandLine: `& ${quote("powershell.exe")} ${argv.map(quote).join(" ")}`,
              requiresT3CommandApproval: true,
              effect: "Fetches one verified remote branch into a managed Git ref; does not checkout or merge",
            },
          });
        }
        case "plan_durable_fast_forward": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may plan fast-forward integration");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const receipt = this.returnStore().listReceipts(project.id).find((candidate) =>
            candidate.sourceId === sourceId && candidate.remoteTarget.endsWith(`/DurablePiProjects/${slug}`)
          );
          if (!receipt) throw Error("No READY remote-return receipt matches this source and project slug");
          const root = gitResult(member.cwd, ["rev-parse", "--show-toplevel"]).stdout;
          if (normalizedPath(root) !== normalizedPath(member.cwd)) throw Error("Coordinator workspace must be the Git top-level directory");
          if (gitResult(member.cwd, ["status", "--porcelain"]).stdout)
            throw Error("Windows worktree must be clean before planning integration");
          const targetBranch = gitResult(member.cwd, ["branch", "--show-current"]).stdout;
          if (!targetBranch) throw Error("Windows repository must be on a named branch");
          const baseRevision = gitResult(member.cwd, ["rev-parse", "HEAD"]).stdout;
          const managedRef = `refs/dpi/remotes/${sourceId}/${slug}`;
          const remoteRevision = gitResult(member.cwd, ["rev-parse", "--verify", managedRef]).stdout;
          if (remoteRevision !== receipt.revision) throw Error("Managed return ref no longer matches its verified receipt");
          if (baseRevision === remoteRevision) throw Error("Windows HEAD already equals the verified remote revision");
          if (gitResult(member.cwd, ["merge-base", "--is-ancestor", baseRevision, remoteRevision], [0, 1]).status !== 0)
            throw Error("Verified remote revision is not a fast-forward of Windows HEAD; inspect and resolve divergence explicitly");
          const script = this.options.integrationScriptPath ?? process.env.DPI_INTEGRATION_SCRIPT ?? bundledIntegrationScript;
          if (!isAbsolute(script)) throw Error("Integration script path must be absolute");
          const scriptStat = lstatSync(script);
          if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw Error("Integration script must be a real file");
          const plan = this.returnStore().planFastForward(project.id, {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            sourceId,
            projectSlug: slug,
            returnReceiptId: receipt.id,
            repository: member.cwd,
            managedRef,
            targetBranch,
            baseRevision,
            remoteRevision,
          });
          const argv = [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-PlanId", plan.id,
            "-ProjectId", project.id,
            "-SourceId", sourceId,
            "-Repository", member.cwd,
          ];
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          return toolResult({
            plan,
            execution: {
              executable: "powershell.exe",
              arguments: argv,
              commandLine: `& ${quote("powershell.exe")} ${argv.map(quote).join(" ")}`,
              requiresT3CommandApproval: true,
              effect: `Fast-forward ${targetBranch} from ${baseRevision} to ${remoteRevision}`,
            },
          });
        }
        case "prepare_durable_integration_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may prepare integration Agents");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const templateId = requiredText(args.template_member_id, "template_member_id", 64);
          const template = this.projects.getMember(project.id, templateId);
          if (!template || template.lifecycleState === "ARCHIVED" || template.executor !== "codex" || !template.model)
            throw Error("An active model-bound Codex template is required");
          if (template.permissionProfile !== "WORKSPACE_WRITE")
            throw Error("Integration Resolver requires a WORKSPACE_WRITE template");
          const receipt = this.returnStore().listReceipts(project.id).find((candidate) =>
            candidate.sourceId === sourceId && candidate.remoteTarget.endsWith(`/DurablePiProjects/${slug}`)
          );
          if (!receipt) throw Error("No READY remote-return receipt matches this source and project slug");
          const root = gitResult(member.cwd, ["rev-parse", "--show-toplevel"]).stdout;
          if (normalizedPath(root) !== normalizedPath(member.cwd)) throw Error("Coordinator workspace must be the Git top-level directory");
          if (gitResult(member.cwd, ["status", "--porcelain"]).stdout)
            throw Error("Windows worktree must be clean before preparing divergent integration");
          const baseRevision = gitResult(member.cwd, ["rev-parse", "HEAD"]).stdout;
          const managedRef = `refs/dpi/remotes/${sourceId}/${slug}`;
          const remoteRevision = gitResult(member.cwd, ["rev-parse", "--verify", managedRef]).stdout;
          if (remoteRevision !== receipt.revision) throw Error("Managed return ref no longer matches its verified receipt");
          const localAncestor = gitResult(member.cwd, ["merge-base", "--is-ancestor", baseRevision, remoteRevision], [0, 1]).status === 0;
          const remoteAncestor = gitResult(member.cwd, ["merge-base", "--is-ancestor", remoteRevision, baseRevision], [0, 1]).status === 0;
          if (baseRevision === remoteRevision || localAncestor || remoteAncestor)
            throw Error("Integration Resolver is only created for genuinely divergent histories");
          const identity = createHash("sha256")
            .update(`${project.id}\0${sourceId}\0${slug}\0${baseRevision}\0${remoteRevision}`)
            .digest("hex")
            .slice(0, 32);
          const spawnRequestId = `integration:${sourceId}:${slug}:${remoteRevision}`;
          const role = args.role === undefined ? "integration-resolver" : requiredText(args.role, "role", 80).toLowerCase();
          if (role === "coordinator") throw Error("Integration Agent cannot assume the Coordinator role");
          const name = args.name === undefined ? `${sourceId} Integration Resolver` : requiredText(args.name, "name", 120);
          const existing = this.projects.members(project.id, true).find((candidate) => candidate.spawnRequestId === spawnRequestId);
          if (existing) {
            if (existing.role !== role || existing.name !== name || existing.permissionProfile !== "WORKSPACE_WRITE" ||
                existing.model !== template.model)
              throw Error("Integration Agent already exists with incompatible arguments");
            return toolResult({ agent: existing, replayed: true, sourceId, projectSlug: slug, managedRef, remoteRevision });
          }
          if (this.projects.members(project.id).filter((candidate) => candidate.temporary).length >= 8)
            throw Error("The project already has eight active temporary Agents");
          const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
          let worktree: ReturnType<ProjectWorktreeStore["create"]>;
          try {
            worktree = worktrees.create(project.id, {
              id: `integration-${identity}`,
              repositoryRoot: member.cwd,
              label: `${sourceId} ${slug} integration`,
              base: baseRevision,
              branch: `dpi/integration-${identity}`,
            });
          } finally {
            worktrees.close();
          }
          const agent = this.projects.addMember(project.id, {
            id: `integration-${identity}`,
            deviceId: "local-t3",
            sessionId: "t3-code",
            agentId: `integration-${identity}`,
            name,
            role,
            permissionProfile: "WORKSPACE_WRITE",
            executor: "codex",
            model: template.model,
            cwd: worktree.path,
            temporary: true,
            parentMemberId: member.id,
            spawnRequestId,
          });
          this.projects.event(project.id, "member.integration_resolver_prepared", {
            requestId, memberId: agent.id, worktreeId: worktree.id, sourceId, projectSlug: slug,
            managedRef, baseRevision, remoteRevision,
          }, member.id, agent.id);
          return toolResult({
            agent,
            worktree,
            replayed: false,
            sourceId,
            projectSlug: slug,
            managedRef,
            remoteRevision,
            suggestedTask: {
              title: `Resolve ${sourceId} integration for ${slug}`,
              content: [
                `Work only in ${worktree.path}.`,
                `Review and merge ${managedRef} (${remoteRevision}) into branch ${worktree.branch}.`,
                "Resolve conflicts deliberately, run relevant tests, and commit the integration result.",
                "Do not modify, checkout, reset, rebase, or merge the main Windows worktree.",
              ].join(" "),
            },
          });
        }
        case "plan_durable_integration_promotion": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may plan integration promotion");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const integrationMemberId = requiredText(args.integration_member_id, "integration_member_id", 64);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const receipt = this.returnStore().listReceipts(project.id).find((candidate) =>
            candidate.sourceId === sourceId && candidate.remoteTarget.endsWith(`/DurablePiProjects/${slug}`)
          );
          if (!receipt) throw Error("No READY remote-return receipt matches this source and project slug");
          const integrationMember = this.projects.getMember(project.id, integrationMemberId, true);
          const expectedSpawnRequestId = `integration:${sourceId}:${slug}:${receipt.revision}`;
          if (!integrationMember || !integrationMember.temporary ||
              integrationMember.parentMemberId !== member.id || integrationMember.permissionProfile !== "WORKSPACE_WRITE" ||
              integrationMember.executor !== "codex" || !integrationMember.cwd ||
              integrationMember.spawnRequestId !== expectedSpawnRequestId)
            throw Error("The selected member is not the managed Resolver for this verified return");
          const root = gitResult(member.cwd, ["rev-parse", "--show-toplevel"]).stdout;
          if (normalizedPath(root) !== normalizedPath(member.cwd)) throw Error("Coordinator workspace must be the Git top-level directory");
          if (gitResult(member.cwd, ["status", "--porcelain"]).stdout)
            throw Error("Windows worktree must be clean before planning integration promotion");
          const targetBranch = gitResult(member.cwd, ["branch", "--show-current"]).stdout;
          if (!targetBranch) throw Error("Windows repository must be on a named branch");
          const baseRevision = gitResult(member.cwd, ["rev-parse", "HEAD"]).stdout;
          const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
          let worktree: ReturnType<ProjectWorktreeStore["inspect"]> | undefined;
          try {
            const record = worktrees.list(project.id).find((candidate) =>
              normalizedPath(candidate.path) === normalizedPath(integrationMember.cwd!)
            );
            if (record) worktree = worktrees.inspect(project.id, record.id);
          } finally {
            worktrees.close();
          }
          if (!worktree || worktree.state !== "ACTIVE" ||
              normalizedPath(worktree.repositoryRoot) !== normalizedPath(member.cwd))
            throw Error("Resolver member is not bound to an active managed worktree for this repository");
          if (worktree.dirty) throw Error("Resolver worktree must be clean with all integration changes committed");
          if (worktree.baseRevision !== baseRevision)
            throw Error("Windows HEAD changed after the Resolver worktree was created; re-inspect before promotion");
          const promotionRevision = worktree.headRevision;
          if (!promotionRevision || promotionRevision === baseRevision)
            throw Error("Resolver worktree has no committed integration result to promote");
          if (!worktree.baseIsAncestor ||
              gitResult(member.cwd, ["merge-base", "--is-ancestor", baseRevision, promotionRevision], [0, 1]).status !== 0)
            throw Error("Resolver result is not a fast-forward of the frozen Windows base");
          if (gitResult(member.cwd, ["merge-base", "--is-ancestor", receipt.revision, promotionRevision], [0, 1]).status !== 0)
            throw Error("Resolver result does not contain the verified remote-return revision");
          const managedRef = `refs/heads/${worktree.branch}`;
          if (!managedRef.startsWith("refs/heads/dpi/integration-"))
            throw Error("Resolver branch is outside the managed integration namespace");
          if (gitResult(member.cwd, ["rev-parse", "--verify", managedRef]).stdout !== promotionRevision)
            throw Error("Managed integration branch no longer matches the Resolver worktree HEAD");
          const script = this.options.integrationScriptPath ?? process.env.DPI_INTEGRATION_SCRIPT ?? bundledIntegrationScript;
          if (!isAbsolute(script)) throw Error("Integration script path must be absolute");
          const scriptStat = lstatSync(script);
          if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw Error("Integration script must be a real file");
          const plan = this.returnStore().planWorktreePromotion(project.id, {
            requestId: `t3-mcp:${member.id}:${requestId}`,
            sourceId,
            projectSlug: slug,
            returnReceiptId: receipt.id,
            repository: member.cwd,
            managedRef,
            targetBranch,
            baseRevision,
            remoteRevision: promotionRevision,
            requiredReturnRevision: receipt.revision,
          });
          const argv = [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-PlanId", plan.id,
            "-ProjectId", project.id,
            "-SourceId", sourceId,
            "-Repository", member.cwd,
          ];
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          return toolResult({
            plan,
            resolver: { memberId: integrationMember.id, worktreeId: worktree.id, branch: worktree.branch },
            verifiedReturnRevision: receipt.revision,
            execution: {
              executable: "powershell.exe",
              arguments: argv,
              commandLine: `& ${quote("powershell.exe")} ${argv.map(quote).join(" ")}`,
              requiresT3CommandApproval: true,
              effect: `Fast-forward ${targetBranch} from ${baseRevision} to reviewed integration ${promotionRevision}`,
            },
          });
        }
        case "finalize_durable_integration_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may finalize integration Agents");
          if (!member.cwd) throw Error("The Coordinator has no Git workspace");
          const integrationMemberId = requiredText(args.integration_member_id, "integration_member_id", 64);
          const planId = requiredText(args.plan_id, "plan_id", 160);
          const plan = this.returnStore().getIntegrationPlan(project.id, planId);
          if (!plan || plan.kind !== "WORKTREE_PROMOTION" || plan.status !== "APPLIED" || !plan.receiptId)
            throw Error("An APPLIED WORKTREE_PROMOTION plan is required before Resolver cleanup");
          if (normalizedPath(plan.repository) !== normalizedPath(member.cwd))
            throw Error("Integration plan belongs to a different repository");
          const returnReceipt = this.returnStore().listReceipts(project.id).find((candidate) => candidate.id === plan.returnReceiptId);
          if (!returnReceipt) throw Error("The promotion plan's verified return receipt is missing");
          const integrationMember = this.projects.getMember(project.id, integrationMemberId, true);
          const expectedSpawnRequestId = `integration:${plan.sourceId}:${plan.projectSlug}:${returnReceipt.revision}`;
          if (!integrationMember || !integrationMember.temporary || integrationMember.parentMemberId !== member.id ||
              integrationMember.permissionProfile !== "WORKSPACE_WRITE" || integrationMember.executor !== "codex" ||
              !integrationMember.cwd || integrationMember.spawnRequestId !== expectedSpawnRequestId)
            throw Error("The selected member is not the managed Resolver for this applied promotion");
          if (this.tasks.activeCountForMember(project.id, integrationMemberId) !== 0)
            throw Error("Resolver cleanup is blocked while the member still has active Durable tasks");
          const root = gitResult(member.cwd, ["rev-parse", "--show-toplevel"]).stdout;
          if (normalizedPath(root) !== normalizedPath(member.cwd)) throw Error("Coordinator workspace must be the Git top-level directory");
          if (gitResult(member.cwd, ["status", "--porcelain"]).stdout)
            throw Error("Windows worktree must be clean before Resolver cleanup");
          if (gitResult(member.cwd, ["branch", "--show-current"]).stdout !== plan.targetBranch)
            throw Error("Windows repository is no longer on the promoted target branch");
          if (gitResult(member.cwd, ["rev-parse", "HEAD"]).stdout !== plan.remoteRevision)
            throw Error("Windows HEAD no longer equals the applied promotion revision");
          const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
          let removed: ReturnType<ProjectWorktreeStore["remove"]>;
          let replayed = false;
          try {
            const record = worktrees.list(project.id).find((candidate) =>
              normalizedPath(candidate.path) === normalizedPath(integrationMember.cwd!)
            );
            if (!record || plan.managedRef !== `refs/heads/${record.branch}` || record.baseRevision !== plan.baseRevision)
              throw Error("Applied promotion does not match the Resolver's managed worktree");
            if (gitResult(member.cwd, ["rev-parse", "--verify", plan.managedRef]).stdout !== plan.remoteRevision)
              throw Error("Retained integration branch no longer matches the applied revision");
            replayed = record.state === "REMOVED";
            if (!replayed) {
              const inspected = worktrees.inspect(project.id, record.id);
              if (inspected.state !== "ACTIVE" || inspected.dirty || inspected.headRevision !== plan.remoteRevision)
                throw Error("Resolver worktree is not clean at the applied promotion revision");
            }
            removed = worktrees.remove(project.id, record.id);
          } finally {
            worktrees.close();
          }
          const latestMember = this.projects.getMember(project.id, integrationMemberId, true)!;
          const archived = latestMember.lifecycleState === "ARCHIVED"
            ? latestMember
            : this.projects.archiveMember(project.id, integrationMemberId);
          if (!replayed) this.projects.event(project.id, "member.integration_resolver_finalized", {
            memberId: integrationMemberId, planId, worktreeId: removed.id, retainedBranch: removed.branch,
            appliedRevision: plan.remoteRevision,
          }, member.id, integrationMemberId);
          return toolResult({ agent: archived, worktree: removed, plan, replayed });
        }
        case "stage_data_artifact": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may stage data artifacts");
          let dataSources: ReadOnlyDataSourceCatalog;
          try {
            dataSources = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          } catch {
            throw Error("No valid data-source catalog is configured");
          }
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const path = requiredText(args.path, "path", 2_000);
          const kind = args.kind === undefined ? "binary" : requiredText(args.kind, "kind", 80);
          const mimeType = args.mime_type === undefined
            ? "application/octet-stream"
            : requiredText(args.mime_type, "mime_type", 160);
          if (args.include_in_handoff !== undefined && typeof args.include_in_handoff !== "boolean")
            throw Error("include_in_handoff must be a boolean");
          const includeInHandoff = args.include_in_handoff === true;
          const retentionDays = optionalInteger(args.retention_days, "retention_days", 1, 3_650);
          const source = dataSources.openBinary(sourceId, path, project.id);
          if (source.sizeBytes > this.artifacts.maxBytes)
            throw Error(`Source file exceeds the Artifact Store limit of ${this.artifacts.maxBytes} bytes`);
          const sourceHash = createHash("sha256").update(`${sourceId}\0${path}`).digest("hex").slice(0, 12);
          const safeName = `${sourceId}-${sourceHash}-${source.name}`.slice(0, 240);
          const artifactId = `data-${createHash("sha256")
            .update(`${project.id}:${member.id}:${requestId}`)
            .digest("hex")
            .slice(0, 48)}`;
          const existing = this.artifacts.get(project.id, artifactId);
          if (existing) {
            const expectedExpiry = retentionDays === undefined
              ? undefined
              : existing.createdAt + retentionDays * 86_400_000;
            if (existing.name !== safeName || existing.kind !== kind || existing.mimeType !== mimeType ||
                existing.includeInHandoff !== includeInHandoff || existing.expiresAt !== expectedExpiry)
              throw Error("request_id was reused with different stage_data_artifact arguments");
            return toolResult({ artifact: existing, replayed: true, source: { sourceId, path } });
          }
          const now = Date.now();
          const artifact = await this.artifacts.putStream(project.id, {
            id: artifactId,
            name: safeName,
            kind,
            mimeType,
            includeInHandoff,
            ...(retentionDays === undefined ? {} : { expiresAt: now + retentionDays * 86_400_000 }),
          }, source.content, now);
          if (artifact.sizeBytes !== source.sizeBytes) {
            this.artifacts.expire(project.id, artifact.id);
            throw Error("Source file changed size while it was being staged; the incomplete artifact was expired");
          }
          return toolResult({ artifact, replayed: false, source: { sourceId, path } });
        }
        case "remember_durable_fact": {
          const requestId = requiredText(args.request_id, "request_id", 240);
          const key = requiredText(args.key, "key", 160);
          const visibility = args.visibility ?? "private";
          if (visibility !== "private" && visibility !== "shared")
            throw Error("visibility must be private or shared");
          if (visibility === "shared" && !coordinator(member))
            throw Error("Only the project Coordinator may write shared project memory");
          let encoded: string;
          try {
            encoded = JSON.stringify(args.value);
          } catch {
            throw Error("value must be JSON serializable");
          }
          if (encoded === undefined || encoded.length > 100_000)
            throw Error("value must serialize to at most 100000 characters");
          const expectedVersion = optionalInteger(args.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER);
          const expiresAt = optionalInteger(args.expires_at, "expires_at", 1, Number.MAX_SAFE_INTEGER);
          return toolResult(this.memories.put(project.id, {
            key,
            value: args.value,
            sourceType: "t3-mcp",
            sourceId: `${member.id}:${requestId}`,
            requestId: `t3-mcp:${member.id}:${requestId}`,
            ...(visibility === "private" ? { memberId: member.id } : {}),
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }));
        }
        case "delegate_durable_task": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may delegate durable tasks");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const coordinationId = requiredText(args.coordination_id, "coordination_id", 128);
          const targetId = requiredText(args.target_member_id, "target_member_id", 64);
          const target = project.members.find((candidate) => candidate.id === targetId && candidate.lifecycleState !== "ARCHIVED");
          if (!target) throw Error("Target member is not active in this project");
          if (target.id === member.id) throw Error("Coordinator cannot delegate a durable task to itself");
          const content = requiredText(args.content, "content", 100_000);
          const title = args.title === undefined ? content.slice(0, 240) : requiredText(args.title, "title", 240);
          const priority = optionalInteger(args.priority, "priority", -1_000, 1_000);
          const maxAttempts = optionalInteger(args.max_attempts, "max_attempts", 1, 20);
          const timeoutMs = optionalInteger(args.timeout_ms, "timeout_ms", 1_000, 86_400_000);
          if (args.depends_on_task_ids !== undefined &&
              (!Array.isArray(args.depends_on_task_ids) ||
               !args.depends_on_task_ids.every((dependency) => typeof dependency === "string")))
            throw Error("depends_on_task_ids must be an array of task IDs");
          const dependsOn = args.depends_on_task_ids as string[] | undefined;
          const id = `t3-mcp-${createHash("sha256")
            .update(`${project.id}:${member.id}:${requestId}`)
            .digest("hex")
            .slice(0, 48)}`;
          const taskInput = {
            kind: "agent.message",
            memberId: target.id,
            content,
            messageType: "task_assignment",
            messageId: requestId,
            correlationId: coordinationId,
            payload: {
              replyToMemberId: member.id,
              coordinatorTaskId: coordinationId,
              coordinationDepth: 1,
              coordinationRootTaskId: coordinationId,
              source: "t3-mcp",
            },
            whenBusy: "followUp",
            waitMs: 300_000,
          };
          return toolResult(this.tasks.enqueueCoordination(
            project.id,
            {
              id,
              title,
              input: taskInput,
              ...(priority === undefined ? {} : { priority }),
              ...(maxAttempts === undefined ? {} : { maxAttempts }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(dependsOn === undefined ? {} : { dependsOn }),
            },
            {
              coordinatorTaskId: coordinationId,
              maxDelegatedTasksPerTurn: project.maxDelegatedTasksPerTurn ?? 8,
              maxActiveProjectTasks: project.maxActiveTasks ?? 64,
            },
          ));
        }
        case "materialize_durable_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may materialize planned Agents");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const role = requiredText(args.role, "role", 80).toLowerCase();
          const requestedWorkspaceStrategy = args.workspace_strategy === undefined
            ? "auto"
            : requiredText(args.workspace_strategy, "workspace_strategy", 32);
          if (!["auto", "shared", "worktree"].includes(requestedWorkspaceStrategy))
            throw Error("workspace_strategy must be auto, shared or worktree");
          if (role === "coordinator") throw Error("The Coordinator is already materialized");
          const planned = project.templatePlan.find((item) => item.role.trim().toLowerCase() === role);
          if (!planned) throw Error(`Role ${role} is not pre-authorized by this project's team plan`);
          const existing = project.members.find((candidate) => candidate.role.trim().toLowerCase() === role);
          if (existing) {
            if (existing.permissionProfile !== planned.permissionProfile)
              throw Error(`Existing ${role} Agent does not match the planned permission profile`);
            const isolated = normalizedPath(existing.cwd ?? "") !== normalizedPath(member.cwd ?? "");
            if (requestedWorkspaceStrategy !== "auto" && (requestedWorkspaceStrategy === "worktree") !== isolated)
              throw Error(`Role ${role} is already materialized with ${isolated ? "worktree" : "shared"} workspace strategy`);
            return toolResult({
              agent: existing,
              replayed: true,
              planned,
              requestedWorkspaceStrategy,
              workspaceStrategy: isolated ? "worktree" : "shared",
            });
          }
          if (!member.cwd) throw Error("The Coordinator has no workspace to assign to a planned Agent");
          if (member.executor !== "codex" || !member.model)
            throw Error("Self-service team materialization currently requires a model-bound Codex Coordinator");
          const name = args.name === undefined
            ? role.replace(/(^|[-_\s]+)(\p{L})/gu, (_match, _prefix, letter: string) => letter.toUpperCase())
            : requiredText(args.name, "name", 120);
          const identity = createHash("sha256").update(`${project.id}\0${role}`).digest("hex").slice(0, 32);
          const readiness = planned.permissionProfile === "READ_ONLY"
            ? { eligible: false as const, reason: "READ_ONLY_ROLE" as const }
            : assessWorktreeReadiness(member.cwd);
          const workspaceStrategy = requestedWorkspaceStrategy === "auto"
            ? (readiness.eligible ? "worktree" : "shared")
            : requestedWorkspaceStrategy;
          let assignedCwd = member.cwd;
          let worktree: ReturnType<ProjectWorktreeStore["create"]> | undefined;
          if (workspaceStrategy === "worktree") {
            if (planned.permissionProfile === "READ_ONLY")
              throw Error("Read-only planned roles do not need a writable Git worktree");
            const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
            try {
              worktree = worktrees.create(project.id, {
                repositoryRoot: member.cwd,
                label: `${role} Agent`,
                branch: `dpi/team-${identity}`,
              });
              assignedCwd = worktree.path;
            } finally {
              worktrees.close();
            }
          }
          const agent = this.projects.addMember(project.id, {
            id: `planned-${identity}`,
            deviceId: "local-t3",
            sessionId: "t3-code",
            agentId: `planned-${identity}`,
            name,
            role,
            permissionProfile: planned.permissionProfile,
            executor: "codex",
            model: member.model,
            cwd: assignedCwd,
            parentMemberId: member.id,
            spawnRequestId: `team-plan:${role}`,
          });
          this.projects.event(project.id, "member.materialized_from_team_plan", {
            requestId,
            role,
            memberId: agent.id,
            permissionProfile: agent.permissionProfile,
            requestedWorkspaceStrategy,
            workspaceStrategy,
            ...(!readiness.eligible ? { automaticWorktreeDecision: readiness.reason } : {}),
            ...(worktree ? { worktreeId: worktree.id, branch: worktree.branch } : {}),
          }, member.id, agent.id);
          return toolResult({
            agent,
            replayed: false,
            planned,
            requestedWorkspaceStrategy,
            workspaceStrategy,
            ...(!readiness.eligible ? { automaticWorktreeDecision: readiness.reason } : {}),
            ...(worktree ? { worktree } : {}),
          });
        }
        case "materialize_durable_remote_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may materialize remote Agents");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const sourceId = requiredText(args.source_id, "source_id", 64);
          const slug = requiredText(args.project_slug, "project_slug", 64);
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw Error("Invalid project_slug");
          const templateRole = requiredText(args.template_role, "template_role", 80).toLowerCase();
          const role = requiredText(args.role, "role", 80).toLowerCase();
          if (role === "coordinator") throw Error("Remote Agents cannot assume the Coordinator role");
          const planned = project.templatePlan.find((item) => item.role.trim().toLowerCase() === templateRole);
          if (!planned || templateRole === "coordinator")
            throw Error(`Template role ${templateRole} is not pre-authorized for remote execution`);
          const catalog = new ReadOnlyDataSourceCatalog(this.dataSourceCatalogPath);
          const source = catalog.sources.find((candidate) =>
            candidate.id === sourceId && candidate.projectIds?.includes(project.id)
          );
          if (!source) throw Error(`Data source ${sourceId} is not bound to this project`);
          if (!source.environmentId || !source.sshHost || !source.remoteRoot)
            throw Error(`Data source ${sourceId} is not a remote T3 execution target`);
          const model = requiredText(args.model, "model", 160);
          if (!source.verifiedModels?.includes(model))
            throw Error(`Model ${model} is not verified for data source ${sourceId}`);
          const relativeTarget = `DurablePiProjects/${slug}`;
          const directory = catalog.listDirectory(sourceId, relativeTarget, 100, project.id);
          if (!directory.entries.some((entry) => entry.name === ".git" && entry.kind === "directory"))
            throw Error("Relayed target is not a Git repository");
          const cwd = `${source.remoteRoot.replace(/\/$/, "")}/${relativeTarget}`;
          const name = args.name === undefined
            ? `${source.label} ${role}`
            : requiredText(args.name, "name", 120);
          const spawnRequestId = `remote-plan:${sourceId}:${role}`;
          const existing = this.projects.members(project.id, true)
            .find((candidate) => candidate.spawnRequestId === spawnRequestId);
          if (existing) {
            if (existing.role !== role || existing.name !== name || existing.permissionProfile !== planned.permissionProfile ||
                existing.model !== model || existing.cwd !== cwd || existing.t3EnvironmentId !== source.environmentId)
              throw Error("Remote planned Agent is already materialized with different arguments");
            return toolResult({ agent: existing, replayed: true, sourceId, projectSlug: slug, planned });
          }
          if (member.executor !== "codex")
            throw Error("Remote team materialization requires a model-bound Codex Coordinator");
          const identity = createHash("sha256")
            .update(`${project.id}\0${sourceId}\0${role}`)
            .digest("hex")
            .slice(0, 32);
          const agent = this.projects.addMember(project.id, {
            id: `remote-${identity}`,
            deviceId: sourceId,
            sessionId: "t3-code",
            agentId: `remote-${identity}`,
            name,
            role,
            permissionProfile: planned.permissionProfile,
            executor: "codex",
            model,
            cwd,
            t3EnvironmentId: source.environmentId,
            parentMemberId: member.id,
            spawnRequestId,
          });
          this.projects.event(project.id, "member.materialized_on_remote_target", {
            requestId,
            sourceId,
            projectSlug: slug,
            memberId: agent.id,
            environmentId: source.environmentId,
            cwd,
          }, member.id, agent.id);
          return toolResult({ agent, replayed: false, sourceId, projectSlug: slug, planned });
        }
        case "isolate_durable_agent_workspace": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may isolate planned Agent workspaces");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const memberId = requiredText(args.member_id, "member_id", 64);
          const target = this.projects.getMember(project.id, memberId);
          if (!target || target.temporary || target.executor !== "codex" || target.t3EnvironmentId ||
              target.parentMemberId !== member.id || !target.cwd)
            throw Error("Only an active local planned Codex Agent owned by this Coordinator can be isolated");
          const planned = project.templatePlan.find((item) =>
            item.role.trim().toLowerCase() === target.role.trim().toLowerCase());
          if (!planned || planned.permissionProfile !== target.permissionProfile || planned.permissionProfile === "READ_ONLY")
            throw Error("Agent is not a write-capable member of the frozen team plan");
          const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
          try {
            if (normalizedPath(target.cwd) !== normalizedPath(member.cwd ?? "")) {
              const existing = worktrees.list(project.id, true).find((candidate) =>
                candidate.state === "ACTIVE" && normalizedPath(candidate.path) === normalizedPath(target.cwd!));
              if (!existing) throw Error("Agent workspace differs from the Coordinator but is not an active managed worktree");
              return toolResult({ agent: target, worktree: existing, replayed: true });
            }
            if (!member.cwd) throw Error("Coordinator has no workspace to isolate");
            const activeTasks = this.tasks.activeCountForMember(project.id, target.id);
            if (activeTasks) throw Error(`Agent still has ${activeTasks} active task${activeTasks === 1 ? "" : "s"}`);
            const readiness = assessWorktreeReadiness(member.cwd);
            if (!readiness.eligible)
              throw Error(`Coordinator workspace is not ready for isolation: ${readiness.reason}`);
            const identity = createHash("sha256").update(`${project.id}\0${target.role.trim().toLowerCase()}`).digest("hex").slice(0, 32);
            const worktree = worktrees.create(project.id, {
              id: `planned-${identity}`,
              repositoryRoot: member.cwd,
              label: `${target.role} Agent`,
              branch: `dpi/team-${identity}`,
            });
            if (worktree.state !== "ACTIVE") throw Error(`Managed worktree is not active: ${worktree.state}`);
            const updated = this.projects.updateMember(project.id, target.id, { cwd: worktree.path });
            this.projects.event(project.id, "member.workspace.isolated", {
              requestId, memberId: target.id, worktreeId: worktree.id, branch: worktree.branch,
              from: member.cwd, to: worktree.path,
            }, member.id, target.id);
            return toolResult({ agent: updated, worktree, replayed: false });
          } finally {
            worktrees.close();
          }
        }
        case "create_durable_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may create temporary Agents");
          const requestId = requiredText(args.request_id, "request_id", 240);
          const templateId = requiredText(args.template_member_id, "template_member_id", 64);
          const template = this.projects.getMember(project.id, templateId);
          if (!template || template.executor !== "codex" || !template.model || !template.cwd)
            throw Error("An active Codex template with a model and workspace is required");
          const role = requiredText(args.role, "role", 80);
          if (coordinator({ ...template, role })) throw Error("Temporary Agents cannot assume the Coordinator role");
          const name = args.name === undefined ? `Temporary ${role}` : requiredText(args.name, "name", 120);
          const permissionProfile = args.permission_profile === undefined
            ? template.permissionProfile
            : requiredText(args.permission_profile, "permission_profile", 32);
          if (!["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"].includes(permissionProfile))
            throw Error("Invalid permission_profile");
          if (!memberPermissionWithinTemplate(
            template.role,
            template.permissionProfile,
            role,
            permissionProfile as "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE",
          ))
            throw Error("Temporary Agent permission cannot exceed its template");
          const scopeTaskId = args.scope_task_id === undefined
            ? undefined
            : requiredText(args.scope_task_id, "scope_task_id", 160);
          const requestedWorkspaceStrategy = args.workspace_strategy === undefined
            ? "auto"
            : requiredText(args.workspace_strategy, "workspace_strategy", 32);
          if (!["auto", "shared", "worktree"].includes(requestedWorkspaceStrategy))
            throw Error("workspace_strategy must be auto, shared or worktree");
          const spawnRequestId = `t3-mcp:${member.id}:${requestId}`;
          const existing = this.projects.members(project.id, true)
            .find((candidate) => candidate.spawnRequestId === spawnRequestId);
          if (existing) {
            const isolated = normalizedPath(existing.cwd ?? "") !== normalizedPath(template.cwd);
            if (existing.role !== role || existing.name !== name ||
                existing.permissionProfile !== permissionProfile || existing.model !== template.model ||
                existing.t3EnvironmentId !== template.t3EnvironmentId ||
                existing.scopeTaskId !== scopeTaskId)
              throw Error("request_id was reused with different create_durable_agent arguments");
            if (requestedWorkspaceStrategy !== "auto" && (requestedWorkspaceStrategy === "worktree") !== isolated)
              throw Error("request_id was reused with a different workspace strategy");
            return toolResult(existing);
          }
          if (this.projects.members(project.id).filter((candidate) => candidate.temporary).length >= 8)
            throw Error("The project already has eight active temporary Agents");
          const requestedCanWrite = memberRoleCanWrite(
            role,
            permissionProfile as "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE",
          );
          const readiness = !requestedCanWrite || template.t3EnvironmentId
            ? { eligible: false as const, reason: !requestedCanWrite ? "READ_ONLY_ROLE" : "REMOTE_WORKSPACE" }
            : assessWorktreeReadiness(template.cwd);
          const workspaceStrategy = requestedWorkspaceStrategy === "auto"
            ? (readiness.eligible ? "worktree" : "shared")
            : requestedWorkspaceStrategy;
          if (workspaceStrategy === "worktree" && !readiness.eligible)
            throw Error(`Temporary Agent worktree is unavailable: ${readiness.reason}`);
          const identity = createHash("sha256").update(`${project.id}\0${spawnRequestId}`).digest("hex").slice(0, 32);
          let assignedCwd = template.cwd;
          let worktree: ReturnType<ProjectWorktreeStore["create"]> | undefined;
          let worktreeExisted = false;
          if (workspaceStrategy === "worktree") {
            const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
            try {
              worktreeExisted = worktrees.list(project.id).some((candidate) => candidate.id === `temp-${identity}`);
              worktree = worktrees.create(project.id, {
                id: `temp-${identity}`,
                repositoryRoot: template.cwd,
                label: `${role} Temporary Agent`,
                branch: `dpi/temp-${identity}`,
              });
              assignedCwd = worktree.path;
            } finally {
              worktrees.close();
            }
          }
          let agent: ProjectMember;
          try {
            agent = this.projects.addMember(project.id, {
              deviceId: template.deviceId,
              sessionId: "t3-code",
              agentId: `t3-${randomUUID()}`,
              name,
              role,
              permissionProfile: permissionProfile as "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE",
              executor: "codex",
              model: template.model,
              cwd: assignedCwd,
              ...(template.t3EnvironmentId ? { t3EnvironmentId: template.t3EnvironmentId } : {}),
              temporary: true,
              allowModelFallback: template.allowModelFallback,
              fallbackModels: template.fallbackModels,
              parentMemberId: member.id,
              ...(scopeTaskId ? { scopeTaskId } : {}),
              spawnRequestId,
            });
          } catch (error) {
            if (worktree && !worktreeExisted) {
              const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
              try { worktrees.remove(project.id, worktree.id); } catch {}
              finally { worktrees.close(); }
            }
            throw error;
          }
          this.projects.event(project.id, "member.temporary_materialized", {
            requestId,
            memberId: agent.id,
            templateMemberId: template.id,
            requestedWorkspaceStrategy,
            workspaceStrategy,
            ...(!readiness.eligible ? { automaticWorktreeDecision: readiness.reason } : {}),
            ...(worktree ? { worktreeId: worktree.id, branch: worktree.branch } : {}),
          }, member.id, agent.id);
          return toolResult(agent);
        }
        case "archive_durable_agent": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may archive temporary Agents");
          const memberId = requiredText(args.member_id, "member_id", 64);
          const target = this.projects.getMember(project.id, memberId);
          if (!target || !target.temporary || target.parentMemberId !== member.id)
            throw Error("Coordinator may archive only its own active temporary Agents");
          const activeTasks = this.tasks.activeCountForMember(project.id, target.id);
          if (activeTasks) throw Error(`Temporary Agent still has ${activeTasks} active task${activeTasks === 1 ? "" : "s"}`);
          if (target.spawnRequestId && target.cwd) {
            const identity = createHash("sha256").update(`${project.id}\0${target.spawnRequestId}`).digest("hex").slice(0, 32);
            const worktreeId = `temp-${identity}`;
            const worktrees = new ProjectWorktreeStore(this.projects.path, this.options.worktreeRoot);
            try {
              const owned = worktrees.list(project.id).find((item) => item.id === worktreeId && item.state === "ACTIVE");
              if (owned) {
                if (normalizedPath(owned.path) !== normalizedPath(target.cwd))
                  throw Error("Temporary Agent worktree ownership does not match its workspace");
                worktrees.remove(project.id, worktreeId);
              }
            } finally {
              worktrees.close();
            }
          }
          return toolResult(this.projects.archiveMember(project.id, target.id));
        }
        case "cancel_durable_task": {
          if (!coordinator(member)) throw Error("Only the project Coordinator may cancel durable tasks");
          const taskId = requiredText(args.task_id, "task_id", 128);
          const reason = requiredText(args.reason, "reason", 1_000);
          const task = this.tasks.get(taskId);
          if (!task || task.projectId !== project.id) throw Error("Task is not in the current project");
          const input = task.input && typeof task.input === "object" && !Array.isArray(task.input)
            ? task.input as JsonObject
            : {};
          const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
            ? input.payload as JsonObject
            : {};
          if (payload.replyToMemberId !== member.id)
            throw Error("Coordinator may cancel only tasks that it delegated");
          const attempt = task.status === "PAUSED"
            ? this.tasks.attempts(taskId).findLast((candidate) =>
                candidate.runtime?.kind === "t3" && candidate.runtime.threadId && candidate.runtime.runId)
            : undefined;
          const cancelled = this.tasks.cancel(taskId, Date.now(), {
            notifyCoordinator: false,
            requestedBy: member.id,
            reason,
          });
          if (attempt?.runtime?.kind !== "t3") return toolResult(cancelled);
          const targetMemberId = typeof input.memberId === "string" ? input.memberId : undefined;
          const targetMember = targetMemberId ? this.projects.getMember(project.id, targetMemberId, true) : undefined;
          const runtimeMode = targetMember
            ? t3RuntimeModeFor(project.autonomyMode, targetMember.role, targetMember.permissionProfile) ?? "approval-required"
            : "approval-required";
          try {
            await (this.options.t3RuntimeGateway ?? new T3RuntimeGateway()).cancel({
              threadId: attempt.runtime.threadId!,
              runId: attempt.runtime.runId!,
              runtimeMode,
              environmentId: attempt.runtime.environmentId,
            });
            this.projects.event(project.id, "t3.cancelled", {
              taskId, threadId: attempt.runtime.threadId, runId: attempt.runtime.runId, source: "project-mcp",
            }, member.id, targetMemberId);
            return toolResult({ ...cancelled, runtimeCancellation: { status: "INTERRUPTED" } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.projects.event(project.id, "t3.cancel_failed", {
              taskId, threadId: attempt.runtime.threadId, runId: attempt.runtime.runId,
              source: "project-mcp", error: message.slice(0, 2_000),
            }, member.id, targetMemberId);
            return toolResult({ ...cancelled, runtimeCancellation: { status: "FAILED", error: message.slice(0, 500) } });
          }
        }
        default:
          return toolError(`Unknown Durable Pi tool: ${name}`);
      }
    } catch (error) {
      return toolError(error);
    }
  }

  close() {
    this.returns?.close();
    this.relays?.close();
    this.handoffs?.close();
    this.artifacts.close();
    this.memories.close();
    this.tasks.close();
    this.projects.close();
  }
}
