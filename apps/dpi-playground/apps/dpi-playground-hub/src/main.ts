// The playground hub: the local registry of devices (~/.dpi/network.sqlite), their live status,
// a REST proxy that injects device tokens, one multiplexed SSE stream per browser tab, and the
// Vue client. It runs no agents; every agent lives in some device's dpi-backend.
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import type { ProjectAgentMessageTaskInput, ProjectMember } from "../../../../dpi-sdk/src/api.js";
import { memberPermissionWithinTemplate, memberRoleCanWrite } from "../../../../dpi-sdk/src/execution-policy.js";
import {
  DURABLE_PROJECT_TEMPLATES,
  durableProjectTeamPlan,
  durableProjectTemplate,
} from "../../../../dpi-sdk/src/project-templates.js";
import { dpiHome, NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import { DataSourceBindingStore, ReadOnlyDataSourceCatalog } from "../../../../dpi-sdk/src/node/data-sources.js";
import { ProjectRegistry } from "../../../../dpi-sdk/src/node/projects.js";
import { ProjectTaskStore } from "../../../../dpi-sdk/src/node/tasks.js";
import { ProjectMemoryStore } from "../../../../dpi-sdk/src/node/memories.js";
import { ProjectApprovalStore } from "../../../../dpi-sdk/src/node/approvals.js";
import { CodexAppServerClient, type CodexAppServerOptions } from "../../../../dpi-sdk/src/node/codex-app-server.js";
import { CodexModelCatalog, DEFAULT_CODEX_MODEL } from "../../../../dpi-sdk/src/node/codex-model-catalog.js";
import {
  DEFAULT_T3_PI_WORKER_PROVIDER_INSTANCE,
  inspectLocalModelProviders,
  isLocalPiModel,
  isWorkspacePiMember,
  parseModelSelection,
} from "../../../../dpi-sdk/src/node/local-model-providers.js";
import {
  isDurableDelegationAllowed,
  PROTECTED_PROVIDER_MESSAGE,
} from "../../../../dpi-sdk/src/node/provider-isolation.js";
import { SqliteBackupManager } from "../../../../dpi-sdk/src/node/backups.js";
import { ProjectArtifactStore } from "../../../../dpi-sdk/src/node/artifacts.js";
import { ProjectUsageStore } from "../../../../dpi-sdk/src/node/usage.js";
import { ProjectHandoffStore } from "../../../../dpi-sdk/src/node/handoffs.js";
import { ProjectRelayStore } from "../../../../dpi-sdk/src/node/relays.js";
import { ProjectReturnStore } from "../../../../dpi-sdk/src/node/returns.js";
import { PlatformObservabilityStore } from "../../../../dpi-sdk/src/node/observability.js";
import { ProviderHealthStore } from "../../../../dpi-sdk/src/node/provider-health.js";
import { assessWorktreeReadiness, ProjectWorktreeStore } from "../../../../dpi-sdk/src/node/worktrees.js";
import { ProjectToolCallStore } from "../../../../dpi-sdk/src/node/tool-calls.js";
import { T3RuntimeGateway } from "../../../../dpi-sdk/src/node/t3-runtime.js";
import { T3CodeClient } from "../../../../dpi-sdk/src/node/t3-code.js";
import { T3McpClient } from "../../../../dpi-sdk/src/node/t3-mcp.js";
import { DeviceMonitor } from "./monitor.js";
import { StreamMux } from "./mux.js";
import { proxy } from "./proxy.js";
import { guard } from "./guard.js";
import { seedFromConfig } from "./seed.js";
import { ProjectAgentTaskWorker, t3CoordinatorRuntimeModeFor, t3RuntimeModeFor } from "./task-worker.js";
import { authenticateRemoteDevice } from "./device-auth.js";
import { T3WaitingTaskMonitor } from "./t3-waiting-monitor.js";
import { T3ProjectMonitor } from "./t3-project-monitor.js";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
const positiveEnv = (key: string): number | undefined => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`${key} must be a positive integer`);
  return value;
};
const intervalEnv = (key: string, fallback: number, minimum: number, maximum = 24 * 60 * 60_000) => {
  const value = positiveEnv(key) ?? fallback;
  if (value < minimum || value > maximum) throw Error(`${key} must be from ${minimum} to ${maximum}`);
  return value;
};
const appDir = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(option("--port", process.env.DPI_HUB_PORT ?? "4781"));
const host = option("--host", process.env.DPI_HUB_HOST ?? "127.0.0.1");
const execFileAsync = promisify(execFile);
const environmentScanner = resolve(appDir, "../../scripts/scan-environment.mjs");

const configuredCodexMcpServers = () => {
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    return new Set(Array.from(
      config.matchAll(/^\s*\[mcp_servers\.([a-zA-Z0-9_-]+)\]\s*(?:#.*)?$/gm),
      (match) => match[1],
    ));
  } catch {
    return new Set<string>();
  }
};

const codexClientOptions = (): CodexAppServerOptions => {
  const command = process.env.DPI_CODEX_APP_SERVER_COMMAND;
  const rawArgs = process.env.DPI_CODEX_APP_SERVER_ARGS_JSON;
  const disabledMcpServers = (process.env.DPI_CODEX_DISABLED_MCP_SERVERS ?? "anode,durable-pi,rea,reaper")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (disabledMcpServers.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
    throw Error("DPI_CODEX_DISABLED_MCP_SERVERS must contain comma-separated MCP server names");
  // A `-c mcp_servers.<missing>.enabled=false` override creates an incomplete
  // MCP table and Codex rejects the entire config before it can start. Remote
  // devices intentionally have a smaller MCP set, so only override sections
  // that are actually present on this host.
  const configured = configuredCodexMcpServers();
  const configOverrides = Object.fromEntries(
    disabledMcpServers
      .filter((name) => configured.has(name))
      .map((name) => [`mcp_servers.${name}.enabled`, false]),
  );
  if (!command && !rawArgs) return { configOverrides };
  if (!command) throw Error("DPI_CODEX_APP_SERVER_COMMAND is required when custom Codex arguments are configured");
  let args: string[] | undefined;
  if (rawArgs) {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
      throw Error("DPI_CODEX_APP_SERVER_ARGS_JSON must be a JSON array of strings");
    args = parsed;
  }
  return { command, ...(args ? { args } : {}), configOverrides, shell: false };
};
const createCodexClient = (overrides: CodexAppServerOptions = {}) =>
  new CodexAppServerClient({ ...codexClientOptions(), ...overrides });
const codexModels = new CodexModelCatalog(async () => {
  const client = createCodexClient();
  try {
    return await client.models();
  } finally {
    await client.close();
  }
});
const validateCodexModelPolicy = async (
  primary: string,
  role: string,
  allowModelFallback: boolean,
  fallbackModels: unknown,
) => {
  if (!Array.isArray(fallbackModels) || fallbackModels.some((model) => typeof model !== "string"))
    throw Error("fallbackModels must be an array of model IDs");
  if (fallbackModels.length > 5 || new Set(fallbackModels).size !== fallbackModels.length)
    throw Error("fallbackModels must contain at most five unique model IDs");
  if (fallbackModels.includes(primary)) throw Error("Primary model cannot also be a fallback model");
  if (allowModelFallback && !fallbackModels.length)
    throw Error("At least one fallback model is required when automatic fallback is enabled");
  const normalizedFallbacks = (fallbackModels as string[]).map((candidate) => {
    const parsed = parseModelSelection(candidate);
    if (!isDurableDelegationAllowed(parsed.provider))
      throw Object.assign(Error(PROTECTED_PROVIDER_MESSAGE), { status: 409 });
    if (parsed.executor === "pi" && role.toLowerCase() === "coordinator")
      throw Object.assign(
        Error(`Model ${parsed.qualified} cannot be used as a Coordinator fallback`),
        { status: 409 },
      );
    return parsed.executor === "pi" ? parsed.qualified : candidate;
  });
  const codexOnlyModels = [primary, ...normalizedFallbacks.filter((model) => !isLocalPiModel(model))];
  const entries = await Promise.all(codexOnlyModels.map((model) => codexModels.requireAvailable(model)));
  if (role.toLowerCase() === "coordinator") {
    const unverified = entries.find((entry) => entry.capabilities.dynamicTools !== "supported");
    if (unverified)
      throw Object.assign(
        Error(`Codex model ${unverified.id} has not been platform-verified for Coordinator Dynamic Tools`),
        { status: 409 },
      );
  }
  return normalizedFallbacks;
};
const codexWorkspace = (input: unknown, t3EnvironmentId?: string) => {
  const value = String(input ?? "").trim();
  if (!value) throw Error("Codex working directory is required");
  // A linked environment owns its own filesystem. Resolving or stat'ing that path on the
  // Windows control plane would corrupt POSIX paths and reject valid remote workspaces.
  if (t3EnvironmentId) return value;
  const local = resolve(value);
  if (!statSync(local).isDirectory()) throw Error("Codex working directory is not a directory");
  return local;
};

const registry = new NetworkRegistry();
const projects = new ProjectRegistry();
const tasks = new ProjectTaskStore(projects.path);
const memories = new ProjectMemoryStore(projects.path);
const approvals = new ProjectApprovalStore(projects.path);
const backups = new SqliteBackupManager(projects.db, projects.path, undefined, 14, [{
  name: "data-sources",
  path: process.env.DPI_DATA_SOURCE_CATALOG ?? join(dpiHome(), "data-sources.json"),
}]);
const artifacts = new ProjectArtifactStore(projects.path);
const dataSources = new DataSourceBindingStore(
  process.env.DPI_DATA_SOURCE_CATALOG ?? join(dpiHome(), "data-sources.json"),
);
const dataSourceCatalogPath = process.env.DPI_DATA_SOURCE_CATALOG ?? join(dpiHome(), "data-sources.json");
const usage = new ProjectUsageStore(projects.path);
const providerHealth = new ProviderHealthStore(
  projects.path,
  positiveEnv("DPI_PROVIDER_FAILURE_THRESHOLD") ?? 3,
  positiveEnv("DPI_PROVIDER_BASE_OPEN_MS") ?? 30_000,
  positiveEnv("DPI_PROVIDER_PROBE_LEASE_MS") ?? 60_000,
);
const handoffs = new ProjectHandoffStore(projects.path, projects, memories, artifacts);
const relays = new ProjectRelayStore(projects.path);
const returns = new ProjectReturnStore(projects.path);
const worktrees = new ProjectWorktreeStore(projects.path);
const toolCalls = new ProjectToolCallStore(projects.path);
const observability = new PlatformObservabilityStore(projects.path);
const t3RuntimeGateway = process.env.DPI_T3_RUNTIME === "1" ? new T3RuntimeGateway() : undefined;
const taskWorker = new ProjectAgentTaskWorker(tasks, projects, registry, memories, {
  approvals,
  usage,
  providerHealth,
  toolCalls,
  worktrees,
  modelCatalog: codexModels,
  remoteModelVerifier: (projectId, member, model) => {
    let source;
    try {
      source = new ReadOnlyDataSourceCatalog(dataSourceCatalogPath).executionSource(
        projectId,
        member.t3EnvironmentId ?? "",
        member.cwd ?? "",
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (!source.verifiedModels?.includes(model))
      return `model ${model} is not currently verified for target ${source.id}`;
    return undefined;
  },
  codexClientFactory: (options) => createCodexClient(options),
  ...(process.env.DPI_T3_RUNTIME === "1"
    ? {
        useT3Runtime: true,
        t3RuntimeGateway: t3RuntimeGateway!,
        t3WorkerProviderInstanceId: process.env.DPI_T3_WORKER_PROVIDER_INSTANCE ?? "codex",
        t3PiWorkerProviderInstanceId: process.env.DPI_T3_PI_WORKER_PROVIDER_INSTANCE ?? DEFAULT_T3_PI_WORKER_PROVIDER_INSTANCE,
        t3CoordinatorProviderInstanceId: process.env.DPI_T3_COORDINATOR_PROVIDER_INSTANCE ?? "codex_durable_coordinator",
      }
    : {}),
  maxGlobalRunning: positiveEnv("DPI_MAX_GLOBAL_RUNNING"),
  maxProjectRunning: positiveEnv("DPI_MAX_PROJECT_RUNNING"),
  maxWorkerRunning: positiveEnv("DPI_MAX_WORKER_RUNNING"),
  maxCoordinationDepth: positiveEnv("DPI_MAX_COORDINATION_DEPTH"),
  maxDelegatedTasksPerTurn: positiveEnv("DPI_MAX_DELEGATED_TASKS_PER_TURN"),
  maxActiveProjectTasks: positiveEnv("DPI_MAX_ACTIVE_PROJECT_TASKS"),
  maxContextTokens: positiveEnv("DPI_MAX_CONTEXT_TOKENS"),
  fallbackContextTokens: positiveEnv("DPI_FALLBACK_CONTEXT_TOKENS"),
  reservedOutputTokens: positiveEnv("DPI_RESERVED_OUTPUT_TOKENS"),
  reservedToolTokens: positiveEnv("DPI_RESERVED_TOOL_TOKENS"),
});
type T3EnvironmentDiscovery = {
  available: true;
  linksEnabled: boolean;
  server: unknown;
  environmentId: string | null;
  links: Array<{ environmentId: string; label: string; status: string; access: string }>;
  notListed?: string;
};
let t3EnvironmentCache: { at: number; value: T3EnvironmentDiscovery } | undefined;
const t3Environments = async () => {
  if (t3EnvironmentCache && Date.now() - t3EnvironmentCache.at < 5_000) return t3EnvironmentCache.value;
  const client = await T3McpClient.pair(new T3CodeClient(), {
    access: "read-only",
    ttl: "5m",
    label: "Durable Pi environment discovery",
  });
  try {
    const server = await client.initialize();
    const tools = await client.listTools();
    if (!tools.some((tool) => tool.name === "t3_environment_links")) {
      const value: T3EnvironmentDiscovery = { available: true, linksEnabled: false, server, environmentId: null, links: [] };
      t3EnvironmentCache = { at: Date.now(), value };
      return value;
    }
    const links = await client.environmentLinks();
    const value: T3EnvironmentDiscovery = { available: true, linksEnabled: true, server, ...links };
    t3EnvironmentCache = { at: Date.now(), value };
    return value;
  } finally {
    await client.close();
  }
};
const configFile = seedFromConfig(registry, appDir);
const monitor = new DeviceMonitor(registry);
monitor.start();
const mux = new StreamMux(registry, monitor);

const archiveCodexThreads = async (members: ProjectMember[]) => {
  const targets = members.filter((member) => member.executor === "codex" && member.threadId && member.threadRuntime !== "t3");
  if (!targets.length) return [] as string[];
  const client = createCodexClient();
  const errors: string[] = [];
  try {
    for (const member of targets) {
      try {
        await client.archiveThread(member.threadId!);
      } catch (error) {
        errors.push(`${member.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await client.close();
  }
  return errors;
};

const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
if (host !== "127.0.0.1" && host !== "localhost") {
  allowedHosts.add(`${hostname().toLowerCase()}:${port}`);
  allowedHosts.add(
    `${hostname()
      .toLowerCase()
      .replace(/\.local$/, "")}.local:${port}`,
  );
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? [])
      if (a.family === "IPv4") allowedHosts.add(`${a.address}:${port}`);
}

const err = (code: string, message: string) => ({ error: { code, message } });
type Handler = (req: express.Request, res: express.Response) => unknown;
const safe =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const candidate = (e as { status?: number }).status;
      const status = Number.isInteger(candidate) && candidate! >= 400 && candidate! <= 599 ? candidate! : 400;
      if (!res.headersSent)
        res
          .status(status)
          .json(err(status === 404 ? "not_found" : "invalid", (e as Error).message));
    }
  };
const projectTask = (projectId: string, taskId: string) => {
  const task = tasks.get(taskId);
  if (!task || task.projectId !== projectId)
    throw Object.assign(Error(`No task ${taskId} in project ${projectId}`), { status: 404 });
  return task;
};
const ensureMemberHasNoActiveTasks = (projectId: string, memberId: string) => {
  const count = tasks.activeCountForMember(projectId, memberId);
  if (count > 0)
    throw Object.assign(Error(`Project member still has ${count} active task${count === 1 ? "" : "s"}`), { status: 409 });
};
const cleanupOwnedTemporaryWorktree = (projectId: string, member: ProjectMember, remove = true) => {
  if (!member.temporary || !member.spawnRequestId || !member.cwd || member.t3EnvironmentId) return undefined;
  const identity = createHash("sha256").update(`${projectId}\0${member.spawnRequestId}`).digest("hex").slice(0, 32);
  const worktreeId = `temp-${identity}`;
  const record = worktrees.list(projectId, true).find((candidate) => candidate.id === worktreeId);
  if (!record || record.state === "REMOVED") return record;
  const memberPath = resolve(member.cwd).toLowerCase();
  if (resolve(record.path).toLowerCase() !== memberPath)
    throw Object.assign(Error("Temporary agent does not own its derived managed worktree"), { status: 409 });
  const inspected = worktrees.inspect(projectId, worktreeId);
  if (inspected.state !== "ACTIVE" || inspected.dirty)
    throw Object.assign(Error("Temporary agent worktree has uncommitted changes and cannot be removed"), { status: 409 });
  return remove ? worktrees.remove(projectId, worktreeId) : inspected;
};

const app = express();
app.disable("x-powered-by");
const hubToken = process.env.DPI_HUB_TOKEN;
const allowLegacyHubToken = process.env.DPI_ALLOW_LEGACY_HUB_TOKEN === "1";
type AuthenticatedRequest = express.Request & { dpiRemoteDeviceId?: string };
const isLoopback = (address: string | undefined) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const isRemoteCollaborationRoute = (req: express.Request) =>
  (req.method === "GET" && req.path === "/project-memberships") ||
  (req.method === "POST" && /^\/projects\/[^/]+\/messages$/.test(req.path)) ||
  (["GET", "POST"].includes(req.method) && /^\/projects\/[^/]+\/agent-memories$/.test(req.path));
app.use("/api", (req, res, next) => {
  if (isLoopback(req.socket.remoteAddress)) return next();
  const deviceId = req.get("x-dpi-device-id");
  const deviceAuthenticated = authenticateRemoteDevice(registry, deviceId, req.get("authorization"));
  const legacyAuthenticated = allowLegacyHubToken && hubToken && req.headers.authorization === `Bearer ${hubToken}`;
  if (!deviceAuthenticated && !legacyAuthenticated)
    return res.status(401).json(err("unauthorized", "Remote hub access requires a registered device identity"));
  if (!isRemoteCollaborationRoute(req))
    return res.status(403).json(err("forbidden", "Remote device credentials are limited to project collaboration routes"));
  (req as AuthenticatedRequest).dpiRemoteDeviceId = deviceAuthenticated ? deviceId : "legacy";
  next();
});
app.use("/api", guard(allowedHosts), express.json({ limit: "256kb" }));

app.get("/api/network", (_req, res) => res.json({ configFile, devices: monitor.network() }));
app.get("/api/t3/environments", safe(async (_req, res) => res.json(await t3Environments())));
app.get("/api/observability", (_req, res) => res.json(observability.summary()));
app.get("/api/projects", (_req, res) => res.json({ projects: projects.list() }));
app.get(
  "/api/projects/:id/data-sources",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    res.json({ projectId, sources: await dataSources.listAsync(projectId) });
  }),
);
app.put(
  "/api/projects/:id/data-sources",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    if (!Array.isArray(req.body?.sourceIds)) throw Error("sourceIds must be an array");
    const sources = await dataSources.setProjectSourcesAsync(projectId, req.body.sourceIds as unknown[] as string[]);
    projects.event(projectId, "data_sources.bound", {
      sourceIds: sources.filter((source) => source.bound).map((source) => source.id),
    });
    res.json({ projectId, sources });
  }),
);
app.get("/api/project-templates", (_req, res) => res.json({ templates: DURABLE_PROJECT_TEMPLATES }));
app.get(
  "/api/projects/:id/team-plan",
  safe((req, res) => {
    const project = projects.get(String(req.params.id));
    if (!project) throw Object.assign(Error(`No project ${req.params.id}`), { status: 404 });
    const members = projects.members(project.id);
    res.json({
      templateId: project.templateId ?? null,
      roles: project.templatePlan.map((planned) => {
        const matching = members.filter((member) => member.role.toLowerCase() === planned.role.toLowerCase());
        return {
          ...planned,
          status: matching.length ? "BOUND" : "UNBOUND",
          permissionAligned: matching.some((member) => member.permissionProfile === planned.permissionProfile),
          members: matching.map((member) => ({ id: member.id, name: member.name, executor: member.executor, permissionProfile: member.permissionProfile, workspace: member.cwd })),
        };
      }),
    });
  }),
);
app.get("/api/handoffs/inbox", (_req, res) => res.json({ directory: handoffs.inboxRoot }));
app.get(
  "/api/projects/:id/relays",
  safe((req, res) => res.json({ relays: relays.list(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/relays/plans",
  safe((req, res) => res.json({ plans: relays.listPlans(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/relays/plans/:planId",
  safe((req, res) => {
    const plan = relays.getPlan(String(req.params.id), String(req.params.planId));
    if (!plan) throw Object.assign(Error(`No relay plan ${req.params.planId}`), { status: 404 });
    res.json(plan);
  }),
);
app.post(
  "/api/projects/:id/relays/receipt",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const sourceId = String(req.body?.sourceId ?? "");
    const source = dataSources.boundSource(projectId, sourceId);
    if (!source) throw Object.assign(Error(`Data source ${sourceId} is not bound to project ${projectId}`), { status: 403 });
    if (!source.environmentId || source.environmentId !== String(req.body?.environmentId ?? ""))
      throw Object.assign(Error("Relay environment does not match the bound data source"), { status: 409 });
    if (req.body?.planId !== undefined) {
      const plan = relays.getPlan(projectId, String(req.body.planId));
      if (!plan) throw Object.assign(Error(`No relay plan ${req.body.planId}`), { status: 404 });
      const expectedTarget = `${String(source.remoteRoot).replace(/\/$/, "")}/DurablePiProjects/${plan.projectSlug}`;
      if (plan.sourceId !== sourceId || plan.handoffId !== String(req.body?.handoffId ?? "") ||
          expectedTarget !== String(req.body?.target ?? ""))
        throw Object.assign(Error("Relay receipt does not match its frozen plan or target"), { status: 409 });
    }
    res.status(201).json(relays.record(projectId, {
      planId: req.body?.planId,
      handoffId: req.body?.handoffId,
      sourceId,
      environmentId: req.body?.environmentId,
      target: req.body?.target,
      revision: req.body?.revision,
      branch: req.body?.branch,
      bundleSha256: req.body?.bundleSha256,
      targetCreated: req.body?.targetCreated,
    }));
  }),
);
app.get(
  "/api/projects/:id/returns",
  safe((req, res) => res.json({ returns: returns.listReceipts(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/returns/plans",
  safe((req, res) => res.json({ plans: returns.listPlans(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/returns/plans/:planId",
  safe((req, res) => {
    const plan = returns.getPlan(String(req.params.id), String(req.params.planId));
    if (!plan) throw Object.assign(Error(`No return plan ${req.params.planId}`), { status: 404 });
    res.json(plan);
  }),
);
app.post(
  "/api/projects/:id/returns/receipt",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const sourceId = String(req.body?.sourceId ?? "");
    const source = dataSources.boundSource(projectId, sourceId);
    if (!source) throw Object.assign(Error(`Data source ${sourceId} is not bound to project ${projectId}`), { status: 403 });
    if (!source.environmentId || source.environmentId !== String(req.body?.environmentId ?? ""))
      throw Object.assign(Error("Return environment does not match the bound data source"), { status: 409 });
    const plan = returns.getPlan(projectId, String(req.body?.planId ?? ""));
    if (!plan) throw Object.assign(Error(`No return plan ${req.body?.planId}`), { status: 404 });
    const expectedTarget = `${String(source.remoteRoot).replace(/\/$/, "")}/DurablePiProjects/${plan.projectSlug}`;
    if (plan.sourceId !== sourceId || expectedTarget !== String(req.body?.remoteTarget ?? ""))
      throw Object.assign(Error("Return receipt does not match its frozen plan or target"), { status: 409 });
    res.status(201).json(returns.record(projectId, {
      planId: req.body?.planId,
      sourceId,
      environmentId: req.body?.environmentId,
      remoteTarget: req.body?.remoteTarget,
      localRef: req.body?.localRef,
      revision: req.body?.revision,
      branch: req.body?.branch,
      bundleSha256: req.body?.bundleSha256,
    }));
  }),
);
app.get(
  "/api/projects/:id/integrations",
  safe((req, res) => res.json({ integrations: returns.listIntegrationReceipts(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/integrations/plans",
  safe((req, res) => res.json({ plans: returns.listIntegrationPlans(String(req.params.id)) })),
);
app.get(
  "/api/projects/:id/integrations/plans/:planId",
  safe((req, res) => {
    const plan = returns.getIntegrationPlan(String(req.params.id), String(req.params.planId));
    if (!plan) throw Object.assign(Error(`No integration plan ${req.params.planId}`), { status: 404 });
    res.json(plan);
  }),
);
app.post(
  "/api/projects/:id/integrations/receipt",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const sourceId = String(req.body?.sourceId ?? "");
    const source = dataSources.boundSource(projectId, sourceId);
    if (!source) throw Object.assign(Error(`Data source ${sourceId} is not bound to project ${projectId}`), { status: 403 });
    res.status(201).json(returns.recordFastForward(projectId, {
      planId: req.body?.planId,
      sourceId,
      targetBranch: req.body?.targetBranch,
      previousRevision: req.body?.previousRevision,
      appliedRevision: req.body?.appliedRevision,
    }));
  }),
);
app.post(
  "/api/handoffs/import",
  safe((req, res) =>
    res.status(201).json(
      handoffs.importFromInbox(
        String(req.body?.bundleName ?? ""),
        req.body?.targetProjectId === undefined ? undefined : String(req.body.targetProjectId),
      ),
    ),
  ),
);
app.get("/api/backups", (_req, res) => res.json({ directory: backups.directory, backups: backups.list() }));
app.post(
  "/api/artifacts/purge-expired",
  safe((req, res) => {
    const graceDays = Number(req.body?.graceDays ?? 30);
    if (!Number.isSafeInteger(graceDays) || graceDays < 1 || graceDays > 3_650)
      throw Error("graceDays must be an integer from 1 to 3650");
    res.json(artifacts.purgeExpired(Date.now() - graceDays * 86_400_000, Number(req.body?.limit ?? 1_000)));
  }),
);
app.post(
  "/api/backups",
  safe(async (_req, res) => res.status(201).json(await backups.create("manual"))),
);
app.get(
  "/api/projects/:id/agent-blueprints",
  safe((req, res) => res.json({ blueprints: handoffs.agentBlueprints(String(req.params.id)) })),
);
app.post(
  "/api/projects/:id/agent-blueprints/:blueprintId/bind",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const blueprintId = String(req.params.blueprintId);
    const blueprint = handoffs.agentBlueprints(projectId).find((item) => item.id === blueprintId);
    if (!blueprint) throw Object.assign(Error(`Imported Agent blueprint not found: ${blueprintId}`), { status: 404 });
    if (blueprint.bindingState === "SOURCE_TEMPORARY")
      throw Object.assign(Error("Temporary source Agents cannot be rebound from a handoff"), { status: 409 });
    if (blueprint.boundMemberId) {
      const existing = projects.getMember(projectId, blueprint.boundMemberId, true);
      if (!existing) throw Error("Agent blueprint binding points to a missing project member");
      return res.json({ blueprint, member: existing });
    }
    const permissionProfile = String(req.body?.permissionProfile ?? "");
    if (!["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"].includes(permissionProfile))
      throw Error("A target permission profile must be selected explicitly");
    const name = String(req.body?.name ?? blueprint.name);
    const role = String(req.body?.role ?? blueprint.role);
    const stableMemberId = `handoff-${createHash("sha256")
      .update(`${projectId}\0${blueprint.sourceHandoffId}\0${blueprint.id}`)
      .digest("hex")
      .slice(0, 40)}`;
    const spawnRequestId = `handoff:${blueprint.sourceHandoffId}:${blueprint.id}`;
    let member: ProjectMember;
    if (blueprint.executor === "codex") {
      const t3EnvironmentId = String(req.body?.t3EnvironmentId ?? "").trim() || undefined;
      const cwd = codexWorkspace(req.body?.cwd, t3EnvironmentId);
      const model = String(req.body?.model ?? blueprint.model ?? "");
      if (!model) throw Error("A target Codex model is required");
      const allowModelFallback = req.body?.allowModelFallback === true;
      const fallbackModels = await validateCodexModelPolicy(
        model,
        role,
        allowModelFallback,
        req.body?.fallbackModels ?? [],
      );
      member = projects.addMember(projectId, {
        id: stableMemberId,
        deviceId: "local-codex",
        sessionId: "codex-app-server",
        agentId: `codex-${stableMemberId}`,
        name,
        role,
        permissionProfile: permissionProfile as "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE",
        executor: "codex",
        model,
        allowModelFallback,
        fallbackModels,
        cwd,
        t3EnvironmentId,
        temporary: false,
        spawnRequestId,
      });
    } else {
      const deviceId = String(req.body?.deviceId ?? "");
      const device = registry.get(deviceId);
      if (!device) throw Object.assign(Error(`No device ${deviceId}`), { status: 404 });
      if (!device.token) throw Object.assign(Error(`Device ${deviceId} has no token`), { status: 401 });
      const sessionId = String(req.body?.sessionId ?? "");
      const agentId = String(req.body?.agentId ?? "");
      const agent = await new DpiClient(device.url, device.token).agent(sessionId, agentId).get();
      member = projects.addMember(projectId, {
        id: stableMemberId,
        deviceId,
        sessionId,
        agentId: agent.id,
        name: name || agent.name,
        role,
        permissionProfile: permissionProfile as "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE",
        executor: "pi",
        temporary: false,
        spawnRequestId,
      });
    }
    const bound = handoffs.recordAgentBlueprintBinding(
      projectId,
      blueprint.sourceHandoffId,
      blueprint.id,
      member.id,
    );
    res.status(201).json({ blueprint: bound, member });
  }),
);
app.get(
  "/api/project-memberships",
  safe((req, res) => {
    const deviceId = String(req.query.deviceId ?? "");
    const sessionId = String(req.query.sessionId ?? "");
    const agentId = String(req.query.agentId ?? "");
    if (!deviceId || !sessionId || !agentId) throw Error("deviceId, sessionId and agentId are required");
    const authenticatedDevice = (req as AuthenticatedRequest).dpiRemoteDeviceId;
    if (authenticatedDevice && authenticatedDevice !== "legacy" && authenticatedDevice !== deviceId)
      throw Object.assign(Error("Authenticated device does not match requested membership identity"), { status: 403 });
    res.json({ memberships: projects.memberships(deviceId, sessionId, agentId) });
  }),
);
app.post(
  "/api/projects",
  safe((req, res) => {
    const body = req.body ?? {};
    const templateId = String(body.templateId ?? "blank");
    const template = durableProjectTemplate(templateId);
    if (!template) throw Error(`Unknown project template: ${templateId}`);
    const templatePlan = durableProjectTeamPlan(template);
    const project = projects.create({
      ...body,
      templateId: template.id,
      templatePlan,
      autonomyMode: body.autonomyMode ?? template.autonomyMode,
      maxCoordinationDepth: body.maxCoordinationDepth ?? template.maxCoordinationDepth,
      maxDelegatedTasksPerTurn: body.maxDelegatedTasksPerTurn ?? template.maxDelegatedTasksPerTurn,
      maxActiveTasks: body.maxActiveTasks ?? template.maxActiveTasks,
      maxConcurrentTasks: body.maxConcurrentTasks ?? template.maxConcurrentTasks,
    }, {
      kind: "project.template.applied",
      detail: {
        templateId: template.id,
        templateName: template.name,
        suggestedRoles: template.suggestedRoles,
        appliedRoles: templatePlan,
      },
    });
    res.status(201).json(project);
  }),
);
app.get(
  "/api/projects/:id",
  safe((req, res) => {
    const project = projects.get(String(req.params.id));
    if (!project) throw Object.assign(Error(`No project ${req.params.id}`), { status: 404 });
    res.json(project);
  }),
);
app.patch(
  "/api/projects/:id",
  safe((req, res) => res.json(projects.update(String(req.params.id), req.body ?? {}))),
);
app.delete(
  "/api/projects/:id",
  safe(async (req, res) => {
    const id = String(req.params.id);
    const project = projects.get(id);
    if (!project)
      throw Object.assign(Error(`No project ${req.params.id}`), { status: 404 });
    const activeTasks = tasks.activeCount(id);
    if (activeTasks)
      throw Object.assign(Error(`Project still has ${activeTasks} active task${activeTasks === 1 ? "" : "s"}; cancel or finish them before deletion`), { status: 409 });
    const dirtyWorktree = worktrees.list(id, true).find((worktree) =>
      worktree.state === "ACTIVE" && worktree.dirty);
    if (dirtyWorktree)
      throw Object.assign(
        Error(`Managed worktree ${dirtyWorktree.label} has uncommitted changes; commit or remove them before deleting the project`),
        { status: 409 },
      );
    const archiveErrors = await archiveCodexThreads(project.members);
    const tasksAfterArchive = tasks.activeCount(id);
    if (tasksAfterArchive)
      throw Object.assign(Error(`Project received ${tasksAfterArchive} active task${tasksAfterArchive === 1 ? "" : "s"} during deletion; cancel or finish them and retry`), { status: 409 });
    const recoveryBackup = await backups.create(`pre-delete-${id}`);
    const tasksAfterBackup = tasks.activeCount(id);
    if (tasksAfterBackup)
      throw Object.assign(Error(`Project received ${tasksAfterBackup} active task${tasksAfterBackup === 1 ? "" : "s"} while its recovery backup was created; cancel or finish them and retry`), { status: 409 });
    const boundSourceIds = dataSources.boundSourceIds(id);
    const deletion = projects.beginRemoval(id, Date.now(), boundSourceIds);
    const frozenSourceIds = deletion.sourceIds;
    try {
      dataSources.setProjectSources(id, []);
      const purgedWorktrees = worktrees.purgeProject(id);
      const purgedArtifacts = artifacts.purgeProject(id);
      const purgedHandoffs = handoffs.purgeProject(id);
      projects.remove(id);
      res.json({
        ok: true, recoveryBackup, archiveErrors, purgedArtifacts, purgedHandoffs, purgedWorktrees,
        unboundDataSources: frozenSourceIds,
      });
    } catch (error) {
      // Keep a still-existing project usable if a later cleanup stage failed.
      if (projects.get(id)) {
        let rollbackError: unknown;
        try {
          dataSources.setProjectSources(id, frozenSourceIds);
        } catch (candidate) {
          rollbackError = candidate;
        } finally {
          // A failed file-catalog rollback must not leave the project
          // permanently fenced from all future task admission.
          projects.cancelRemoval(id);
        }
        if (rollbackError)
          throw Object.assign(new AggregateError(
            [error, rollbackError],
            "Project deletion failed and its data-source grants could not be fully restored",
          ), { status: 500 });
      }
      throw error;
    }
  }),
);
app.get(
  "/api/projects/:id/worktrees",
  safe((req, res) => res.json({
    worktrees: worktrees.list(String(req.params.id), req.query.inspect !== "false"),
  })),
);
app.post(
  "/api/projects/:id/worktrees",
  safe((req, res) => res.status(201).json(worktrees.create(String(req.params.id), {
    repositoryRoot: String(req.body?.repositoryRoot ?? ""),
    label: String(req.body?.label ?? ""),
    base: req.body?.base === undefined ? undefined : String(req.body.base),
    branch: req.body?.branch === undefined ? undefined : String(req.body.branch),
  }))),
);
app.post(
  "/api/projects/:id/worktrees/:worktreeId/check",
  safe((req, res) => res.json(worktrees.inspect(String(req.params.id), String(req.params.worktreeId)))),
);
app.delete(
  "/api/projects/:id/worktrees/:worktreeId",
  safe((req, res) => res.json(worktrees.remove(String(req.params.id), String(req.params.worktreeId)))),
);
app.get(
  "/api/projects/:id/events",
  safe((req, res) => {
    const id = String(req.params.id);
    if (!projects.get(id)) throw Object.assign(Error(`No project ${id}`), { status: 404 });
    res.json({ events: projects.events(id, Number(req.query.limit ?? 100)) });
  }),
);
app.get(
  "/api/projects/:id/tool-calls",
  safe((req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    const rawKind = req.query.evidenceKind === undefined ? undefined : String(req.query.evidenceKind);
    if (rawKind && !["TEST", "BUILD", "FILE_CHANGE", "TOOL"].includes(rawKind))
      throw Error("Invalid evidence kind");
    res.json({ toolCalls: toolCalls.list(projectId, {
      ...(req.query.taskId === undefined ? {} : { taskId: String(req.query.taskId) }),
      ...(rawKind ? { evidenceKind: rawKind as "TEST" | "BUILD" | "FILE_CHANGE" | "TOOL" } : {}),
      limit: Number(req.query.limit ?? 100),
    }) });
  }),
);
app.get(
  "/api/projects/:id/artifacts",
  safe((req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    const status = String(req.query.status ?? "ACTIVE");
    if (!(["ACTIVE", "EXPIRED", "ALL"] as string[]).includes(status)) throw Error("Invalid artifact status");
    res.json({ artifacts: artifacts.list(projectId, status as "ACTIVE" | "EXPIRED" | "ALL") });
  }),
);
app.get(
  "/api/projects/:id/usage",
  safe((req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    res.json({ summary: usage.summary(projectId), records: usage.list(projectId, Number(req.query.limit ?? 100)) });
  }),
);
app.get(
  "/api/projects/:id/handoffs",
  safe((req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    res.json({ handoffs: handoffs.list(projectId) });
  }),
);
app.post(
  "/api/projects/:id/handoffs",
  safe((req, res) => res.status(201).json(handoffs.create(String(req.params.id), {
    workspace: req.body?.workspace === undefined ? undefined : String(req.body.workspace),
  }))),
);
app.post(
  "/api/projects/:id/handoffs/:handoffId/validate",
  safe((req, res) => res.json(handoffs.validate(String(req.params.id), String(req.params.handoffId)))),
);
app.post(
  "/api/projects/:id/handoffs/:handoffId/check-git",
  safe((req, res) => res.json(handoffs.checkGit(
    String(req.params.id),
    String(req.params.handoffId),
    String(req.body?.workspace ?? ""),
  ))),
);
app.post(
  "/api/projects/:id/imported-git-baseline/check",
  safe((req, res) => res.json(handoffs.checkImportedGit(
    String(req.params.id),
    String(req.body?.workspace ?? ""),
  ))),
);
app.post(
  "/api/projects/:id/artifacts",
  safe((req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") throw Error("Artifact content must be text");
    res.status(201).json(
      artifacts.put(String(req.params.id), {
        name: String(req.body?.name ?? ""),
        kind: req.body?.kind === undefined ? undefined : String(req.body.kind),
        mimeType: req.body?.mimeType === undefined ? "text/plain; charset=utf-8" : String(req.body.mimeType),
        taskId: req.body?.taskId === undefined ? undefined : String(req.body.taskId),
        content,
        includeInHandoff: Boolean(req.body?.includeInHandoff),
        expiresAt: req.body?.expiresAt === undefined ? undefined : Number(req.body.expiresAt),
      }),
    );
  }),
);
app.post(
  "/api/projects/:id/environment-scan",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    if (!projects.get(projectId)) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    const workspace = resolve(String(req.body?.workspace ?? ""));
    if (!String(req.body?.workspace ?? "").trim()) throw Error("Workspace is required");
    if (!statSync(workspace).isDirectory()) throw Error("Workspace is not a directory");
    const { stdout } = await execFileAsync(
      process.execPath,
      [environmentScanner, "--workspace", workspace],
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    let report: { schemaVersion?: unknown; generatedAt?: unknown };
    try {
      report = JSON.parse(stdout) as { schemaVersion?: unknown; generatedAt?: unknown };
    } catch {
      throw Error("Environment scanner returned invalid JSON");
    }
    if (report.schemaVersion !== 1 || typeof report.generatedAt !== "string")
      throw Error("Environment scanner returned an unsupported report");
    const stamp = report.generatedAt.replaceAll(":", "-");
    const artifact = artifacts.put(projectId, {
      name: `environment-${stamp}.json`,
      kind: "environment-report",
      mimeType: "application/json",
      content: `${JSON.stringify(report, null, 2)}\n`,
      includeInHandoff: req.body?.includeInHandoff !== false,
    });
    res.status(201).json(artifact);
  }),
);
app.post(
  "/api/projects/:id/artifacts/binary",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const encodedName = req.header("x-artifact-name");
    if (!encodedName) throw Error("x-artifact-name is required");
    let name: string;
    try { name = decodeURIComponent(encodedName); } catch { throw Error("x-artifact-name is invalid"); }
    const contentLength = req.header("content-length");
    if (contentLength !== undefined) {
      const bytes = Number(contentLength);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("Invalid Content-Length");
      if (bytes > artifacts.maxBytes) throw Object.assign(Error(`Artifact exceeds ${artifacts.maxBytes} bytes`), { status: 413 });
    }
    const artifact = await artifacts.putStream(
      projectId,
      {
        name,
        kind: req.header("x-artifact-kind") ?? "binary",
        mimeType: req.header("content-type") ?? "application/octet-stream",
        taskId: req.header("x-artifact-task-id") ?? undefined,
        includeInHandoff: req.header("x-artifact-handoff") === "true",
        expiresAt: req.header("x-artifact-expires-at") === undefined
          ? undefined
          : Number(req.header("x-artifact-expires-at")),
      },
      req as AsyncIterable<Uint8Array>,
    );
    res.status(201).json(artifact);
  }),
);
app.get(
  "/api/projects/:id/artifacts/:artifactId/content",
  safe((req, res) => {
    const result = artifacts.read(String(req.params.id), String(req.params.artifactId));
    res.setHeader("content-type", result.artifact.mimeType);
    res.setHeader("content-length", result.content.byteLength);
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.artifact.name)}`);
    res.send(result.content);
  }),
);
app.delete(
  "/api/projects/:id/artifacts/:artifactId",
  safe((req, res) => res.json(artifacts.expire(String(req.params.id), String(req.params.artifactId)))),
);
app.get(
  "/api/projects/:id/memories",
  safe((req, res) => {
    const id = String(req.params.id);
    if (!projects.get(id)) throw Object.assign(Error(`No project ${id}`), { status: 404 });
    const status = String(req.query.status ?? "ACTIVE");
    if (!["ACTIVE", "EXPIRED", "ALL"].includes(status)) throw Error("status must be ACTIVE, EXPIRED or ALL");
    const memberId = req.query.memberId === undefined ? undefined : String(req.query.memberId);
    if (memberId) {
      if (status !== "ACTIVE") throw Error("Agent-visible memory currently supports ACTIVE status only");
      if (!projects.getMember(id, memberId)) throw Error(`Active project member not found: ${memberId}`);
      return res.json({ memories: memories.visible(id, memberId) });
    }
    res.json({ memories: memories.list(id, status as "ACTIVE" | "EXPIRED" | "ALL") });
  }),
);
app.post(
  "/api/projects/:id/memories",
  safe((req, res) => res.status(201).json(memories.put(String(req.params.id), req.body ?? {}))),
);
const agentMembership = (
  projectId: string,
  identity: { deviceId?: unknown; sessionId?: unknown; agentId?: unknown },
  authenticatedDevice?: string,
) => {
  const deviceId = String(identity.deviceId ?? "");
  const sessionId = String(identity.sessionId ?? "");
  const agentId = String(identity.agentId ?? "");
  if (!deviceId || !sessionId || !agentId) throw Error("deviceId, sessionId and agentId are required");
  if (authenticatedDevice && authenticatedDevice !== "legacy" && authenticatedDevice !== deviceId)
    throw Object.assign(Error("Authenticated device does not match agent identity"), { status: 403 });
  const membership = projects
    .memberships(deviceId, sessionId, agentId)
    .find((item) => item.project.id === projectId);
  if (!membership)
    throw Object.assign(Error("This agent is not an active member of this project"), { status: 403 });
  return membership;
};
app.get(
  "/api/projects/:id/agent-memories",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const membership = agentMembership(projectId, req.query, (req as AuthenticatedRequest).dpiRemoteDeviceId);
    res.json({ memories: memories.visible(projectId, membership.self.id), self: membership.self });
  }),
);
app.post(
  "/api/projects/:id/agent-memories",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const membership = agentMembership(projectId, req.body ?? {}, (req as AuthenticatedRequest).dpiRemoteDeviceId);
    const scope = String(req.body?.scope ?? "private");
    if (!['private', 'shared'].includes(scope)) throw Error("scope must be private or shared");
    if (scope === "shared" && membership.self.role.toLowerCase() !== "coordinator")
      throw Object.assign(Error("Only a project Coordinator can write shared memory"), { status: 403 });
    res.status(201).json(
      memories.put(projectId, {
        key: req.body?.key,
        value: req.body?.value,
        sourceType: "agent",
        sourceId: membership.self.id,
        ...(scope === "private" ? { memberId: membership.self.id } : {}),
        ...(req.body?.expectedVersion === undefined
          ? {}
          : { expectedVersion: Number(req.body.expectedVersion) }),
        ...(req.body?.requestId === undefined ? {} : { requestId: String(req.body.requestId) }),
        ...(req.body?.expiresAt === undefined ? {} : { expiresAt: Number(req.body.expiresAt) }),
      }),
    );
  }),
);
app.get(
  "/api/projects/:id/memories/:memoryId/history",
  safe((req, res) =>
    res.json({
      revisions: memories.history(String(req.params.id), String(req.params.memoryId)),
    }),
  ),
);
app.delete(
  "/api/projects/:id/memories/:memoryId",
  safe((req, res) =>
    res.json(
      memories.expire(
        String(req.params.id),
        String(req.params.memoryId),
        req.body?.expectedVersion,
      ),
    ),
  ),
);
app.get(
  "/api/projects/:id/approvals",
  safe((req, res) => {
    const id = String(req.params.id);
    if (!projects.get(id)) throw Object.assign(Error(`No project ${id}`), { status: 404 });
    res.json({ approvals: approvals.list(id) });
  }),
);
app.post(
  "/api/projects/:id/approvals",
  safe((req, res) => res.status(201).json(approvals.request(String(req.params.id), req.body ?? {}))),
);
app.post(
  "/api/projects/:id/approvals/:approvalId/decision",
  safe((req, res) =>
    res.json(
      approvals.decide(String(req.params.id), String(req.params.approvalId), req.body ?? {}),
    ),
  ),
);
app.post(
  "/api/projects/:id/approvals/:approvalId/revoke",
  safe((req, res) =>
    res.json(
      approvals.revoke(
        String(req.params.id),
        String(req.params.approvalId),
        req.body?.revokedBy,
      ),
    ),
  ),
);
app.post(
  "/api/projects/:id/approvals/:approvalId/consume",
  safe((req, res) =>
    res.json(
      approvals.consume(
        String(req.params.id),
        String(req.params.approvalId),
        req.body?.operation,
        req.body?.consumedBy,
      ),
    ),
  ),
);
app.get(
  "/api/projects/:id/tasks",
  safe((req, res) => {
    const id = String(req.params.id);
    if (!projects.get(id)) throw Object.assign(Error(`No project ${id}`), { status: 404 });
    res.json({ tasks: tasks.list(id, Number(req.query.limit ?? 100)) });
  }),
);
app.post(
  "/api/projects/:id/tasks",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const project = projects.get(projectId);
    if (!project) throw Object.assign(Error(`No project ${projectId}`), { status: 404 });
    const task = tasks.enqueue(projectId, req.body ?? {}, Date.now(), project.maxActiveTasks ?? 64);
    res.status(201).json(task);
  }),
);
app.get(
  "/api/projects/:id/tasks/:taskId/attempts",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json({ attempts: tasks.attempts(taskId) });
  }),
);
app.post(
  "/api/projects/:id/tasks/claim",
  safe((req, res) => {
    const id = String(req.params.id);
    if (!projects.get(id)) throw Object.assign(Error(`No project ${id}`), { status: 404 });
    const lease = tasks.claim(id, String(req.body?.workerId ?? ""), {
      leaseMs: req.body?.leaseMs,
      maxGlobalRunning: req.body?.maxGlobalRunning,
      maxProjectRunning: req.body?.maxProjectRunning,
      maxWorkerRunning: req.body?.maxWorkerRunning,
    });
    if (!lease) return res.status(204).end();
    res.json(lease);
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/heartbeat",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(
      tasks.heartbeat(
        taskId,
        String(req.body?.workerId ?? ""),
        Number(req.body?.fenceEpoch),
        req.body?.leaseMs,
      ),
    );
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/complete",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(
      tasks.complete(
        taskId,
        String(req.body?.workerId ?? ""),
        Number(req.body?.fenceEpoch),
        req.body?.result,
      ),
    );
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/fail",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(
      tasks.fail(
        taskId,
        String(req.body?.workerId ?? ""),
        Number(req.body?.fenceEpoch),
        req.body?.error,
        { retryDelayMs: req.body?.retryDelayMs },
      ),
    );
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/cancel",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    const before = projectTask(projectId, taskId);
    const cancelled = tasks.cancel(taskId);
    const memberId = before.input && typeof before.input === "object" &&
      typeof (before.input as Record<string, unknown>).memberId === "string"
      ? String((before.input as Record<string, unknown>).memberId)
      : undefined;
    const member = memberId ? projects.getMember(projectId, memberId) : undefined;
    let runtimeCancelError: string | undefined;
    if (t3RuntimeGateway && before.status === "PAUSED") {
      const attempt = tasks.attempts(taskId).findLast((candidate) =>
        candidate.runtime?.kind === "t3" && candidate.runtime.threadId && candidate.runtime.runId
      );
      if (attempt?.runtime?.kind === "t3") {
        const project = projects.get(projectId)!;
        const mode = member
          ? member.role.toLowerCase() === "coordinator"
            ? t3CoordinatorRuntimeModeFor(project.autonomyMode)
            : t3RuntimeModeFor(project.autonomyMode, member.role, member.permissionProfile) ?? "approval-required"
          : "approval-required";
        try {
          await t3RuntimeGateway.cancel({
            threadId: attempt.runtime.threadId!,
            runId: attempt.runtime.runId!,
            runtimeMode: mode,
            environmentId: attempt.runtime.environmentId,
          });
        } catch (error) {
          runtimeCancelError = error instanceof Error ? error.message : String(error);
          projects.event(projectId, "t3.cancel_failed", {
            taskId,
            threadId: attempt.runtime.threadId,
            runId: attempt.runtime.runId,
            error: runtimeCancelError,
          }, memberId);
        }
      }
    }
    let archivedMember: ProjectMember | undefined;
    let archiveErrors: string[] = [];
    if (member?.temporary && !["RUNNING", "WAITING_APPROVAL"].includes(before.status) &&
        tasks.activeCountForMember(projectId, member.id) === 0) {
      cleanupOwnedTemporaryWorktree(projectId, member, false);
      archiveErrors = await archiveCodexThreads([member]);
      cleanupOwnedTemporaryWorktree(projectId, member);
      archivedMember = projects.archiveMember(projectId, member.id);
    }
    res.json({ task: cancelled, ...(archivedMember ? { archivedMember } : {}), archiveErrors, runtimeCancelError });
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/pause",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(tasks.pause(taskId));
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/resume",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(tasks.resume(taskId));
  }),
);
app.post(
  "/api/projects/:id/tasks/:taskId/resolve-side-effect",
  safe((req, res) => {
    const projectId = String(req.params.id);
    const taskId = String(req.params.taskId);
    projectTask(projectId, taskId);
    res.json(
      tasks.resolveUnknownSideEffect(
        taskId,
        String(req.body?.resolution) as "RETRY" | "MARK_COMPLETED",
        String(req.body?.actor ?? "local-user"),
        String(req.body?.note ?? ""),
      ),
    );
  }),
);
app.post(
  "/api/projects/:id/members",
  safe(async (req, res) => {
    const id = String(req.params.id);
    const lifecycleFields = ["temporary", "parentMemberId", "scopeTaskId", "spawnRequestId", "lifecycleState"];
    if (lifecycleFields.some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field)))
      throw Error("Temporary Agent lifecycle fields require the dedicated spawn-temporary endpoint");
    if (req.body?.executor === "pi" && (req.body?.cwd !== undefined || req.body?.provider !== undefined || isLocalPiModel(String(req.body?.model ?? "")))) {
      const t3EnvironmentId = String(req.body?.t3EnvironmentId ?? "").trim() || undefined;
      const cwd = codexWorkspace(req.body?.cwd, t3EnvironmentId);
      const selection = parseModelSelection(
        req.body?.model === undefined ? undefined : String(req.body.model),
        req.body?.provider === undefined ? undefined : String(req.body.provider),
      );
      if (selection.executor !== "pi")
        throw Error("Durable Pi workspace members require a deepseek/* model; Antigravity is direct-T3-only");
      if (!isDurableDelegationAllowed(selection.provider))
        throw Object.assign(Error(PROTECTED_PROVIDER_MESSAGE), { status: 409 });
      if (t3EnvironmentId) {
        const source = new ReadOnlyDataSourceCatalog(dataSourceCatalogPath).executionSource(
          id,
          t3EnvironmentId,
          cwd,
        );
        if (!source.verifiedModels?.includes(selection.qualified))
          throw Object.assign(
            Error(`Model ${selection.qualified} is not verified for remote target ${source.id}`),
            { status: 409 },
          );
      }
      const role = String(req.body?.role ?? "worker");
      if (role.trim().toLowerCase() === "coordinator")
        throw Error("Coordinator role currently requires a Codex member");
      const allowModelFallback = req.body?.allowModelFallback === true;
      const rawFallbacks = Array.isArray(req.body?.fallbackModels) ? req.body.fallbackModels.map(String) : [];
      const fallbackModels = rawFallbacks.map((candidate: string) => {
        const parsed = parseModelSelection(candidate);
        if (parsed.executor !== "pi")
          throw Error(`Durable Pi fallback must use an eligible Provider (for Pi workers: deepseek/*): ${candidate}`);
        if (!isDurableDelegationAllowed(parsed.provider))
          throw Object.assign(Error(PROTECTED_PROVIDER_MESSAGE), { status: 409 });
        return parsed.qualified;
      });
      res.status(201).json(
        projects.addMember(id, {
          deviceId: t3EnvironmentId ? t3EnvironmentId : "local-pi",
          sessionId: t3EnvironmentId ? "t3-code" : "local-pi",
          agentId: `pi-${randomUUID()}`,
          name: req.body?.name || `${selection.provider === "google" ? "Gemini" : "DeepSeek"} · ${selection.modelId}`,
          role,
          permissionProfile: req.body?.permissionProfile,
          executor: "pi",
          model: selection.qualified,
          allowModelFallback,
          fallbackModels,
          cwd,
          ...(t3EnvironmentId ? { t3EnvironmentId } : {}),
        }),
      );
      return;
    }
    if (req.body?.executor === "codex") {
      const t3EnvironmentId = String(req.body?.t3EnvironmentId ?? "").trim() || undefined;
      const cwd = codexWorkspace(req.body?.cwd, t3EnvironmentId);
      const model = String(req.body?.model ?? DEFAULT_CODEX_MODEL);
      const role = String(req.body?.role ?? "worker");
      const allowModelFallback = req.body?.allowModelFallback === true;
      const fallbackModels = await validateCodexModelPolicy(
        model,
        role,
        allowModelFallback,
        req.body?.fallbackModels ?? [],
      );
      res.status(201).json(
        projects.addMember(id, {
          deviceId: "local-codex",
          sessionId: "codex-app-server",
          agentId: `codex-${randomUUID()}`,
          name: req.body?.name || `Codex · ${model}`,
          role,
          permissionProfile: req.body?.permissionProfile,
          executor: "codex",
          model,
          allowModelFallback,
          fallbackModels,
          cwd,
          t3EnvironmentId,
        }),
      );
      return;
    }
    const deviceId = String(req.body?.deviceId ?? "");
    const device = registry.get(deviceId);
    if (!device) throw Object.assign(Error(`No device ${deviceId}`), { status: 404 });
    if (!device.token) throw Object.assign(Error(`Device ${deviceId} has no token`), { status: 401 });
    const sessionId = String(req.body?.sessionId ?? "");
    const agentId = String(req.body?.agentId ?? "");
    const agent = await new DpiClient(device.url, device.token).agent(sessionId, agentId).get();
    res.status(201).json(
      projects.addMember(id, {
        ...req.body,
        deviceId,
        sessionId,
        agentId: agent.id,
        name: req.body?.name || agent.name,
      }),
    );
  }),
);
app.post(
  "/api/projects/:id/members/spawn-temporary",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const requester = projects.getMember(projectId, String(req.body?.requestedByMemberId ?? ""));
    if (!requester || requester.role.toLowerCase() !== "coordinator")
      throw Object.assign(Error("Only an active project coordinator can create temporary agents"), { status: 403 });
    const template = projects.getMember(projectId, String(req.body?.templateMemberId ?? ""));
    if (!template || template.executor !== "codex" || !template.model || !template.cwd || template.t3EnvironmentId)
      throw Error("An active local Codex member is required as the execution template");
    const requestId = String(req.body?.requestId ?? "").trim();
    if (!requestId || requestId.length > 240) throw Error("requestId must contain 1 to 240 characters");
    const role = String(req.body?.role ?? "worker").trim();
    if (role.toLowerCase() === "coordinator")
      throw Error("Temporary agents cannot assume the project Coordinator control role");
    const name = String(req.body?.name ?? `Temporary ${role}`).trim();
    const permissionProfile = String(req.body?.permissionProfile ?? template.permissionProfile) as ProjectMember["permissionProfile"];
    if (!(["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"] as string[]).includes(permissionProfile))
      throw Error("Invalid permissionProfile");
    if (!memberPermissionWithinTemplate(template.role, template.permissionProfile, role, permissionProfile))
      throw Error("Temporary agent permission cannot exceed its template");
    const scopeTaskId = req.body?.scopeTaskId === undefined ? undefined : String(req.body.scopeTaskId).trim();
    const requestedWorkspaceStrategy = String(req.body?.workspaceStrategy ?? "auto");
    if (!(["auto", "shared", "worktree"] as string[]).includes(requestedWorkspaceStrategy))
      throw Error("workspaceStrategy must be auto, shared or worktree");
    const spawnRequestId = `hub:${requester.id}:${requestId}`;
    const existing = projects.members(projectId, true).find((member) => member.spawnRequestId === spawnRequestId);
    if (existing) {
      const isolated = existing.cwd !== template.cwd;
      if (existing.role !== role || existing.name !== name || existing.permissionProfile !== permissionProfile ||
          existing.model !== template.model || existing.scopeTaskId !== scopeTaskId ||
          existing.allowModelFallback !== template.allowModelFallback ||
          JSON.stringify(existing.fallbackModels) !== JSON.stringify(template.fallbackModels))
        throw Error("requestId was reused with different temporary-agent arguments");
      if (requestedWorkspaceStrategy !== "auto" && (requestedWorkspaceStrategy === "worktree") !== isolated)
        throw Error("requestId was reused with a different workspace strategy");
      return res.json(existing);
    }
    if (projects.members(projectId).filter((member) => member.temporary).length >= 8)
      throw Error("The project already has eight active temporary agents");
    await codexModels.requireAvailable(template.model);
    const readiness = !memberRoleCanWrite(role, permissionProfile)
      ? { eligible: false as const, reason: "READ_ONLY_ROLE" as const }
      : assessWorktreeReadiness(template.cwd);
    const workspaceStrategy = requestedWorkspaceStrategy === "auto"
      ? (readiness.eligible ? "worktree" : "shared")
      : requestedWorkspaceStrategy;
    if (workspaceStrategy === "worktree" && !readiness.eligible)
      throw Error(`Temporary agent worktree is unavailable: ${readiness.reason}`);
    const identity = createHash("sha256").update(`${projectId}\0${spawnRequestId}`).digest("hex").slice(0, 32);
    let cwd = template.cwd;
    let managedWorktree: ReturnType<ProjectWorktreeStore["create"]> | undefined;
    let worktreeExisted = false;
    if (workspaceStrategy === "worktree") {
      const worktreeId = `temp-${identity}`;
      worktreeExisted = worktrees.list(projectId, true).some((candidate) => candidate.id === worktreeId);
      managedWorktree = worktrees.create(projectId, {
        id: worktreeId,
        repositoryRoot: template.cwd,
        label: `${role} Temporary Agent`,
        branch: `dpi/temp-${identity}`,
      });
      cwd = managedWorktree.path;
    }
    let created: ProjectMember;
    try {
      created = projects.addMember(projectId, {
        deviceId: "local-codex",
        sessionId: "codex-app-server",
        agentId: `codex-${randomUUID()}`,
        name,
        role,
        permissionProfile,
        executor: "codex",
        model: template.model,
        allowModelFallback: template.allowModelFallback,
        fallbackModels: template.fallbackModels,
        cwd,
        temporary: true,
        parentMemberId: requester.id,
        scopeTaskId,
        spawnRequestId,
      });
    } catch (error) {
      if (managedWorktree && !worktreeExisted) {
        try { worktrees.remove(projectId, managedWorktree.id); } catch {}
      }
      throw error;
    }
    projects.event(projectId, "member.temporary_materialized", {
      memberId: created.id,
      templateMemberId: template.id,
      requestedWorkspaceStrategy,
      workspaceStrategy,
      ...(!readiness.eligible ? { automaticWorktreeDecision: readiness.reason } : {}),
      ...(managedWorktree ? { worktreeId: managedWorktree.id, branch: managedWorktree.branch } : {}),
    }, requester.id, created.id);
    res.status(201).json(created);
  }),
);
app.patch(
  "/api/projects/:id/members/:memberId",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const memberId = String(req.params.memberId);
    const current = projects.getMember(projectId, memberId);
    if (!current) throw Object.assign(Error("Active project member not found"), { status: 404 });
    const workspacePi = isWorkspacePiMember(current);
    let requestedModel = req.body?.model === undefined ? current.model ?? DEFAULT_CODEX_MODEL : String(req.body.model);
    let requestedFallbackModels = req.body?.fallbackModels;
    if (workspacePi) {
      if (req.body?.model !== undefined) {
        const parsed = parseModelSelection(requestedModel, req.body?.provider === undefined ? undefined : String(req.body.provider));
        if (parsed.executor !== "pi")
          throw Error("Durable Pi workspace members require a deepseek/* model; Antigravity is direct-T3-only");
        if (!isDurableDelegationAllowed(parsed.provider))
          throw Object.assign(Error(PROTECTED_PROVIDER_MESSAGE), { status: 409 });
        requestedModel = parsed.qualified;
      }
      if (Array.isArray(req.body?.fallbackModels)) {
        requestedFallbackModels = req.body.fallbackModels.map((candidate: unknown) => {
          const parsed = parseModelSelection(String(candidate));
          if (parsed.executor !== "pi")
            throw Error(`Durable Pi fallback must use an eligible Provider (for Pi workers: deepseek/*): ${String(candidate)}`);
          if (!isDurableDelegationAllowed(parsed.provider))
            throw Object.assign(Error(PROTECTED_PROVIDER_MESSAGE), { status: 409 });
          return parsed.qualified;
        });
      }
      if (req.body?.role !== undefined && String(req.body.role).trim().toLowerCase() === "coordinator")
        throw Error("Coordinator role currently requires a Codex member");
    } else if (current.executor === "codex" &&
        (req.body?.model !== undefined || req.body?.role !== undefined || req.body?.allowModelFallback !== undefined || req.body?.fallbackModels !== undefined)) {
      await validateCodexModelPolicy(
        requestedModel,
        String(req.body?.role ?? current.role),
        req.body?.allowModelFallback === undefined ? current.allowModelFallback : req.body.allowModelFallback === true,
        req.body?.fallbackModels ?? current.fallbackModels,
      );
    }
    const environmentPatch = req.body?.t3EnvironmentId === undefined
      ? undefined
      : req.body.t3EnvironmentId === null || req.body.t3EnvironmentId === ""
        ? null
        : String(req.body.t3EnvironmentId).trim();
    const targetEnvironmentId = environmentPatch === undefined
      ? current.t3EnvironmentId
      : environmentPatch || undefined;
    const cwd = (current.executor === "codex" || workspacePi) &&
      (req.body?.cwd !== undefined || environmentPatch !== undefined)
      ? codexWorkspace(req.body?.cwd ?? current.cwd, targetEnvironmentId)
      : undefined;
    res.json(projects.updateMember(projectId, memberId, {
      role: req.body?.role === undefined ? undefined : String(req.body.role),
      model: req.body?.model === undefined ? undefined : requestedModel,
      permissionProfile: req.body?.permissionProfile,
      allowModelFallback: req.body?.allowModelFallback === undefined ? undefined : req.body.allowModelFallback === true,
      fallbackModels: requestedFallbackModels,
      t3EnvironmentId: environmentPatch,
      cwd,
    }));
  }),
);
app.post(
  "/api/projects/:id/members/:memberId/archive-temporary",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const requester = projects.getMember(projectId, String(req.body?.requestedByMemberId ?? ""));
    const member = projects.getMember(projectId, String(req.params.memberId));
    if (!requester || !member) throw Object.assign(Error("Active project member not found"), { status: 404 });
    if (requester.role.toLowerCase() !== "coordinator" && member.parentMemberId !== requester.id)
      throw Object.assign(Error("Only the parent or a project coordinator can archive this temporary agent"), { status: 403 });
    ensureMemberHasNoActiveTasks(projectId, member.id);
    cleanupOwnedTemporaryWorktree(projectId, member, false);
    const archiveErrors = await archiveCodexThreads([member]);
    cleanupOwnedTemporaryWorktree(projectId, member);
    res.json({ member: projects.archiveMember(projectId, member.id), archiveErrors });
  }),
);
app.get(
  "/api/codex/models",
  safe(async (_req, res) => {
    res.json({ data: await codexModels.list() });
  }),
);
app.get(
  "/api/local-models",
  safe(async (_req, res) => {
    res.json(inspectLocalModelProviders());
  }),
);
app.get("/api/provider-health", (_req, res) => res.json({ providers: providerHealth.list() }));
app.delete(
  "/api/projects/:id/members/:memberId",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const memberId = String(req.params.memberId);
    const member = projects.getMember(projectId, memberId);
    if (!member)
      throw Object.assign(Error("Project member not found"), { status: 404 });
    ensureMemberHasNoActiveTasks(projectId, member.id);
    cleanupOwnedTemporaryWorktree(projectId, member, false);
    const archiveErrors = await archiveCodexThreads([member]);
    cleanupOwnedTemporaryWorktree(projectId, member);
    projects.removeMember(projectId, memberId);
    res.json({ ok: true, archiveErrors });
  }),
);
app.post(
  "/api/projects/:id/members/:memberId/archive",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const memberId = String(req.params.memberId);
    const member = projects.getMember(projectId, memberId);
    if (!member) throw Object.assign(Error("Active project member not found"), { status: 404 });
    ensureMemberHasNoActiveTasks(projectId, member.id);
    cleanupOwnedTemporaryWorktree(projectId, member, false);
    const archiveErrors = await archiveCodexThreads([member]);
    cleanupOwnedTemporaryWorktree(projectId, member);
    res.json({ member: projects.archiveMember(projectId, memberId), archiveErrors });
  }),
);
app.post(
  "/api/projects/:id/messages",
  safe(async (req, res) => {
    const projectId = String(req.params.id);
    const target = projects.getMember(projectId, String(req.body?.toMemberId ?? ""));
    if (!target) throw Object.assign(Error("Target is not a member of this project"), { status: 404 });
    const fromMemberId = req.body?.fromMemberId ? String(req.body.fromMemberId) : undefined;
    const sender = fromMemberId ? projects.getMember(projectId, fromMemberId) : undefined;
    if (fromMemberId && !sender)
      throw Object.assign(Error("Sender is not a member of this project"), { status: 404 });
    const authenticatedDevice = (req as AuthenticatedRequest).dpiRemoteDeviceId;
    if (authenticatedDevice && authenticatedDevice !== "legacy" && sender?.deviceId !== authenticatedDevice)
      throw Object.assign(Error("Authenticated device does not match the sending project member"), { status: 403 });
    const content = String(req.body?.content ?? "").trim();
    if (!content) throw Error("Message content is required");
    if (content.length > 100_000) throw Error("Message content is too large");
    const requestId = String(req.body?.requestId ?? randomUUID()).trim();
    if (!requestId || requestId.length > 240) throw Error("requestId must contain 1 to 240 characters");
    const messageType = String(req.body?.messageType ?? "task_assignment");
    const messageTypes = new Set(["task_assignment", "task_result", "task_failed", "task_blocked", "question", "approval_request", "progress_update", "context_update"]);
    if (!messageTypes.has(messageType)) throw Error("Unsupported project message type");
    const correlationId = req.body?.correlationId === undefined ? undefined : String(req.body.correlationId);
    if (correlationId !== undefined && (!correlationId || correlationId.length > 240)) throw Error("Invalid correlation id");
    const payload = req.body?.payload;
    if (payload !== undefined && JSON.stringify(payload).length > 50_000) throw Error("Message payload is too large");
    const whenBusy = String(req.body?.whenBusy ?? "followUp");
    if (!(["followUp", "steer", "reject"] as string[]).includes(whenBusy))
      throw Error("whenBusy must be followUp, steer or reject");
    const timeoutMs = req.body?.timeoutMs === undefined ? undefined : Number(req.body.timeoutMs);
    const title = content.length > 80 ? `${content.slice(0, 77)}…` : content;
    const messageInput = {
      kind: "agent.message" as const,
      memberId: target.id,
      content,
      messageType: messageType as ProjectAgentMessageTaskInput["messageType"],
      messageId: requestId,
      ...(fromMemberId ? { fromMemberId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(payload === undefined ? {} : { payload }),
      whenBusy: whenBusy as ProjectAgentMessageTaskInput["whenBusy"],
      waitMs: 300_000,
    };
    const taskId = `message-${createHash("sha256").update(`${projectId}\0${requestId}`).digest("hex")}`;
    let task = tasks.get(taskId);
    if (task && task.projectId !== projectId) throw Error("Message task id collision");
    if (task && (task.title !== title || JSON.stringify(task.input) !== JSON.stringify(messageInput) ||
        task.timeoutMs !== timeoutMs))
      throw Object.assign(Error("requestId was reused with different project-message arguments"), { status: 409 });
    if (!task) {
      task = tasks.enqueue(projectId, {
        id: taskId,
        title,
        input: messageInput,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }, Date.now(), projects.get(projectId)?.maxActiveTasks ?? 64);
      projects.event(
        projectId,
        messageType === "task_blocked" ? "message.blocked" : `message.${messageType}`,
        { requestId, taskId, messageType, correlationId, preview: content.slice(0, 240) },
        fromMemberId,
        target.id,
      );
    }
    const waitMs = req.body?.waitMs === undefined ? 300_000 : Number(req.body.waitMs);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 300_000)
      throw Error("waitMs must be an integer from 0 to 300000");
    if (waitMs === 0) return res.status(202).json({ status: "queued", taskId });

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const current = tasks.get(taskId)!;
      if (current.status === "COMPLETED") {
        const result = current.result as { submissionId?: string; answer?: unknown; message?: unknown } | undefined;
        return res.json({ status: "done", taskId, submissionId: result?.submissionId, answer: result?.answer, message: result?.message });
      }
      if (current.status === "FAILED") {
        const input = current.input as { messageId?: string; correlationId?: string; memberId?: string };
        return res.status(502).json({
          status: "failed",
          taskId,
          message: {
            type: "task_failed",
            messageId: `failed:${taskId}:${current.attemptCount}`,
            correlationId: input.correlationId ?? input.messageId ?? taskId,
            inReplyTo: input.messageId ?? taskId,
            fromMemberId: input.memberId,
            taskId,
            attemptCount: current.attemptCount,
            fenceEpoch: current.fenceEpoch,
            error: current.error,
          },
        });
      }
      if (current.status === "CANCELLED")
        return res.status(409).json({ status: "cancelled", taskId });
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    res.status(202).json({ status: "queued", taskId });
  }),
);
app.post(
  "/api/devices",
  safe(async (req, res) => {
    const id = String(req.body?.id ?? "");
    const token = String(req.body?.token ?? "");
    const row = registry.upsert({
      id,
      name: String(req.body?.name ?? id),
      kind: "url",
      url: String(req.body?.url ?? ""),
      token,
      source: "ui",
    });
    monitor.check(id);
    const live = await monitor.settled(id);
    res.status(201).json({ id: row.id, name: row.name, url: row.url, status: live?.status ?? "checking" });
  }),
);
app.delete(
  "/api/devices/:id",
  safe((req, res) => {
    const id = String(req.params.id);
    const row = registry.get(id);
    if (!row) throw Object.assign(Error(`No device ${id}`), { status: 404 });
    if (row.source === "config") throw Error(`${id} comes from dpi-network.yaml; edit that file instead`);
    registry.remove(id);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/devices/:id/check",
  safe(async (req, res) => {
    const id = String(req.params.id);
    if (!registry.get(id)) throw Object.assign(Error(`No device ${id}`), { status: 404 });
    monitor.check(id);
    res.json(await monitor.settled(id));
  }),
);
app.get("/api/ui-state/:key", (req, res) =>
  res.json({ value: registry.uiGet(String(req.params.key)) ?? null }),
);
app.put(
  "/api/ui-state/:key",
  safe((req, res) => {
    registry.uiSet(String(req.params.key), req.body?.value ?? null);
    res.json({ ok: true });
  }),
);
app.get("/api/stream", (req, res) => mux.open(req, res));
app.put(
  "/api/stream/:streamId",
  safe((req, res) => res.json(mux.subscribe(String(req.params.streamId), req.body?.subs))),
);
app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor));
app.use("/api", (_req, res) => res.status(404).json(err("not_found", "API route not found")));

const server = createServer(app);
let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (args.includes("--dev")) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: resolve(appDir, "apps/dpi-playground-fe/vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve(appDir, "apps/dpi-playground-fe/dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(appDir, "apps/dpi-playground-fe/dist/index.html")),
  );
}

server.listen(port, host, () => {
  console.log(`Durable Pi hub: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(
    `registry: ${registry.path}${configFile ? `  config: ${configFile}` : "  (no dpi-network.yaml)"}`,
  );
  console.log(
    `devices: ${
      registry
        .list()
        .map((d) => d.id)
        .join(", ") || "none"
    }`,
  );
  if (host !== "127.0.0.1" && host !== "localhost")
    console.warn(
      `NOTICE: the hub is listening on ${host}. Remote requests require a registered device ID/token and are limited to project collaboration routes.`,
    );
});
const newestBackup = backups.list()[0];
if (!newestBackup || Date.now() - newestBackup.createdAt > 6 * 60 * 60_000)
  void backups.create("startup").catch((error) => console.error("Startup backup failed", error));
const configuredBackupInterval = Number(process.env.DPI_BACKUP_INTERVAL_MS ?? 6 * 60 * 60_000);
const backupIntervalMs = Number.isSafeInteger(configuredBackupInterval) &&
    configuredBackupInterval >= 60_000 && configuredBackupInterval <= 7 * 24 * 60 * 60_000
  ? configuredBackupInterval
  : 6 * 60 * 60_000;
const backupTimer = setInterval(() => {
  void backups.create("scheduled").catch((error) => console.error("Scheduled backup failed", error));
}, backupIntervalMs);
backupTimer.unref?.();
const configuredArtifactExpiryInterval = Number(process.env.DPI_ARTIFACT_EXPIRY_INTERVAL_MS ?? 60_000);
const artifactExpiryIntervalMs = Number.isSafeInteger(configuredArtifactExpiryInterval) &&
    configuredArtifactExpiryInterval >= 10_000 && configuredArtifactExpiryInterval <= 24 * 60 * 60_000
  ? configuredArtifactExpiryInterval
  : 60_000;
const expireArtifacts = () => {
  try {
    let result = artifacts.expireDue();
    while (result.remaining > 0) result = artifacts.expireDue();
  } catch (error) {
    console.error("Artifact expiry failed", error);
  }
};
expireArtifacts();
const artifactExpiryTimer = setInterval(expireArtifacts, artifactExpiryIntervalMs);
artifactExpiryTimer.unref?.();
const configuredMemoryExpiryInterval = Number(process.env.DPI_MEMORY_EXPIRY_INTERVAL_MS ?? 60_000);
const memoryExpiryIntervalMs = Number.isSafeInteger(configuredMemoryExpiryInterval) &&
    configuredMemoryExpiryInterval >= 10_000 && configuredMemoryExpiryInterval <= 24 * 60 * 60_000
  ? configuredMemoryExpiryInterval
  : 60_000;
const expireMemories = () => {
  try {
    let result = memories.expireDue();
    while (result.remaining > 0) result = memories.expireDue();
  } catch (error) {
    console.error("Memory expiry failed", error);
  }
};
expireMemories();
const memoryExpiryTimer = setInterval(expireMemories, memoryExpiryIntervalMs);
memoryExpiryTimer.unref?.();
if (process.env.DPI_TASK_WORKER !== "0") taskWorker.start();
const t3WaitingTaskMonitor = t3RuntimeGateway
  ? new T3WaitingTaskMonitor(tasks, projects, t3RuntimeGateway)
  : undefined;
let checkingT3WaitingTasks = false;
const t3WaitingTaskTimer = t3WaitingTaskMonitor
  ? setInterval(() => {
      if (checkingT3WaitingTasks) return;
      checkingT3WaitingTasks = true;
      void t3WaitingTaskMonitor.runOnce()
        .then((result) => {
          if (result.errors > 0)
            console.warn(`T3 waiting-task monitor could not inspect ${result.errors} task(s)`);
        })
        .catch((error) => console.warn("T3 waiting-task monitor failed", error))
        .finally(() => { checkingT3WaitingTasks = false; });
    }, intervalEnv("DPI_T3_WAITING_INTERVAL_MS", 10_000, 5_000))
  : undefined;
t3WaitingTaskTimer?.unref?.();
const t3ProjectMonitor = process.env.DPI_T3_PROJECT_MONITOR === "0"
  ? undefined
  : new T3ProjectMonitor({ dataSourceCatalogPath });
let checkingT3Projects = false;
const checkT3Projects = () => {
  if (!t3ProjectMonitor || checkingT3Projects) return;
  checkingT3Projects = true;
  void t3ProjectMonitor.runOnce()
    .then((result) => {
      if (result.errors > 0)
        console.warn(`T3 project monitor could not initialize ${result.errors} project(s)`);
    })
    .catch((error) => console.warn("T3 project monitor failed", error))
    .finally(() => { checkingT3Projects = false; });
};
checkT3Projects();
const t3ProjectTimer = t3ProjectMonitor
  ? setInterval(checkT3Projects, intervalEnv("DPI_T3_PROJECT_INTERVAL_MS", 30_000, 5_000))
  : undefined;
t3ProjectTimer?.unref?.();
let checkingT3Environments = false;
const t3EnvironmentMonitor = process.env.DPI_T3_RUNTIME === "1"
  ? setInterval(() => {
      if (checkingT3Environments) return;
      const waiting = new Set(tasks.waitingDeviceIds());
      const configured = new Set(projects.list().flatMap((project) =>
        project.members.flatMap((member) => member.t3EnvironmentId ? [member.t3EnvironmentId] : []),
      ));
      if (![...waiting].some((id) => configured.has(id))) return;
      checkingT3Environments = true;
      void t3Environments()
        .then((result) => {
          for (const link of result.links)
            if (waiting.has(link.environmentId) && link.status.toLowerCase() === "reachable")
              tasks.resumeDevice(link.environmentId);
        })
        .catch(() => undefined)
        .finally(() => { checkingT3Environments = false; });
    }, intervalEnv("DPI_T3_ENVIRONMENT_INTERVAL_MS", 10_000, 5_000))
  : undefined;
t3EnvironmentMonitor?.unref?.();

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  clearInterval(backupTimer);
  clearInterval(artifactExpiryTimer);
  clearInterval(memoryExpiryTimer);
  if (t3EnvironmentMonitor) clearInterval(t3EnvironmentMonitor);
  if (t3WaitingTaskTimer) clearInterval(t3WaitingTaskTimer);
  if (t3ProjectTimer) clearInterval(t3ProjectTimer);
  monitor.stop();
  await taskWorker.stop();
  await backups.flush();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  approvals.close();
  artifacts.close();
  usage.close();
  providerHealth.close();
  handoffs.close();
  relays.close();
  returns.close();
  worktrees.close();
  toolCalls.close();
  observability.close();
  memories.close();
  tasks.close();
  projects.close();
  registry.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
