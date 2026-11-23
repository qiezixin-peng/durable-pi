import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectAgentBlueprint, ProjectHandoff, ProjectHandoffGitCheck, ProjectHandoffImportResult, ProjectHandoffValidation } from "../api.js";
import type { ProjectArtifactStore } from "./artifacts.js";
import { dpiHome } from "./registry.js";
import type { ProjectMemoryStore } from "./memories.js";
import type { ProjectRegistry } from "./projects.js";

type HandoffRow = {
  id: string;
  project_id: string;
  status: "READY" | "FAILED";
  directory: string;
  manifest_sha256: string;
  artifact_count: number;
  total_bytes: number;
  request_id: string | null;
  request_hash: string | null;
  created_at: number;
};

type HandoffMemberBlueprint = {
  id: string;
  name: string;
  role: string;
  permissionProfile: "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE";
  executor: "pi" | "codex";
  model: string | null;
  allowModelFallback: boolean;
  fallbackModels: string[];
  cwd: string | null;
  temporary: boolean;
  lifecycleState: "ACTIVE" | "IDLE" | "ARCHIVED";
};

type HandoffManifest = {
  schemaVersion: number;
  handoffProtocol: string;
  minimumRuntimeVersion: string;
  exporterVersion: string;
  id: string;
  project: {
    id: string;
    templateId?: string;
    templatePlan?: Array<{ role: string; permissionProfile: "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE" }>;
    name: string;
    description?: string;
    tokenLimit24h?: number | null;
    maxTaskTokens?: number | null;
    maxCoordinationDepth?: number | null;
    maxDelegatedTasksPerTurn?: number | null;
    maxActiveTasks?: number | null;
    maxConcurrentTasks?: number | null;
    autonomyMode?: "SUPERVISED" | "AUTHORIZED_AUTONOMY" | "RESTRICTED_UNATTENDED";
    members?: HandoffMemberBlueprint[];
  };
  memories: Array<{ key: string; value: unknown; sourceType: string; sourceId?: string | null; expiresAt?: number }>;
  artifacts: Array<{ id: string; name: string; kind: string; mimeType: string; file: string; sizeBytes: number; sha256: string }>;
  sourceCode?: {
    included: boolean;
    note?: string;
    git?: { repositoryName: string; revision: string; branch: string | null };
  };
};

const RUNTIME_VERSION = "0.1.0";
const CURRENT_SCHEMA_VERSION = 2;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const compareVersions = (left: string, right: string) => {
  const a = left.match(VERSION);
  const b = right.match(VERSION);
  if (!a || !b) throw Error("Handoff runtime version is invalid");
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(a[i]) - Number(b[i]);
    if (difference) return Math.sign(difference);
  }
  return 0;
};

const assertManifestCompatibility = (manifest: HandoffManifest) => {
  if (manifest.schemaVersion !== CURRENT_SCHEMA_VERSION || manifest.handoffProtocol !== "1.0")
    throw Error("Unsupported handoff format");
  if (!VERSION.test(manifest.exporterVersion)) throw Error("Handoff exporter version is invalid");
  if (compareVersions(manifest.minimumRuntimeVersion, RUNTIME_VERSION) > 0)
    throw Error(`Handoff requires runtime ${manifest.minimumRuntimeVersion}, current runtime is ${RUNTIME_VERSION}`);
};

const normalizeManifest = (raw: unknown): { manifest: HandoffManifest; sourceSchemaVersion: number } => {
  if (!raw || typeof raw !== "object") throw Error("Invalid handoff metadata");
  const candidate = raw as HandoffManifest;
  const sourceSchemaVersion = candidate.schemaVersion;
  if (!Number.isSafeInteger(sourceSchemaVersion)) throw Error("Handoff schema version is invalid");
  if (sourceSchemaVersion !== 1 && sourceSchemaVersion !== CURRENT_SCHEMA_VERSION)
    throw Error(`Unsupported handoff schema version: ${sourceSchemaVersion}`);
  if (sourceSchemaVersion === CURRENT_SCHEMA_VERSION)
    return { manifest: candidate, sourceSchemaVersion };
  const project = candidate.project && typeof candidate.project === "object" ? candidate.project : undefined;
  const legacyMembers = project && Array.isArray(project.members) ? project.members : undefined;
  const migratedMembers = legacyMembers?.map((member) => {
    const legacy = member as Partial<HandoffMemberBlueprint>;
    return {
      ...legacy,
      permissionProfile: legacy.permissionProfile ?? "ROLE_DEFAULT",
      allowModelFallback: legacy.allowModelFallback ?? false,
      fallbackModels: legacy.fallbackModels ?? [],
      temporary: legacy.temporary ?? false,
      lifecycleState: legacy.lifecycleState ?? "ACTIVE",
    };
  });
  return {
    sourceSchemaVersion,
    manifest: {
      ...candidate,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ...(project ? { project: { ...project, ...(migratedMembers ? { members: migratedMembers } : {}) } } : {}),
    } as HandoffManifest,
  };
};

const validatedMemberBlueprints = (value: unknown): HandoffMemberBlueprint[] => {
  const members = value as HandoffMemberBlueprint[];
  if (!Array.isArray(members) || members.length > 1_000) throw Error("Invalid handoff member blueprints");
  const ids = new Set<string>();
  for (const member of members) {
    if (!member || typeof member.id !== "string" || !member.id || ids.has(member.id))
      throw Error("Invalid or duplicate handoff member blueprint");
    ids.add(member.id);
    if (
      typeof member.name !== "string" || !member.name ||
      typeof member.role !== "string" || !member.role ||
      !["ROLE_DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"].includes(member.permissionProfile) ||
      !["pi", "codex"].includes(member.executor) ||
      !(member.model === null || typeof member.model === "string") ||
      typeof member.allowModelFallback !== "boolean" ||
      !Array.isArray(member.fallbackModels) || member.fallbackModels.length > 5 ||
      member.fallbackModels.some((model) => typeof model !== "string" || !model || model === member.model) ||
      new Set(member.fallbackModels).size !== member.fallbackModels.length ||
      !(member.cwd === null || typeof member.cwd === "string") ||
      typeof member.temporary !== "boolean" ||
      !["ACTIVE", "IDLE", "ARCHIVED"].includes(member.lifecycleState)
    ) throw Error(`Invalid handoff member blueprint: ${member.id}`);
    const workspaceManagedPi = member.executor === "pi" && Boolean(member.cwd);
    if (member.executor !== "codex" && !workspaceManagedPi && (member.allowModelFallback || member.fallbackModels.length))
      throw Error(`Invalid handoff model fallback policy: ${member.id}`);
    if (member.allowModelFallback && !member.fallbackModels.length)
      throw Error(`Invalid handoff model fallback policy: ${member.id}`);
  }
  return members;
};

const assertMemberBlueprints = (manifest: HandoffManifest) => {
  if (manifest.project?.members === undefined) return;
  validatedMemberBlueprints(manifest.project.members);
};

const handoffLimit = (value: unknown, label: string, max = 10_000): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw Error(`Invalid handoff ${label}`);
  return Number(value);
};

type GitBaseline = NonNullable<NonNullable<HandoffManifest["sourceCode"]>["git"]>;

function git(workspace: string, args: string[]): string;
function git(workspace: string, args: string[], allowFailure: true): string | undefined;
function git(workspace: string, args: string[], allowFailure = false): string | undefined {
  try {
    return execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    const detail = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw Error(detail ? `Git command failed: ${detail}` : "Git command failed");
  }
}

const inspectGitBaseline = (workspaceInput: string): GitBaseline => {
  const workspace = resolve(workspaceInput);
  if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink() || !statSync(workspace).isDirectory())
    throw Error("Git workspace is missing, unsafe or not a directory");
  const root = resolve(git(workspace, ["rev-parse", "--show-toplevel"]));
  if (root !== workspace) throw Error("Git workspace must be the repository root");
  const revision = git(workspace, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw Error("Git HEAD is invalid or missing");
  if (git(workspace, ["status", "--porcelain=v1", "--untracked-files=normal"]))
    throw Error("Git workspace has uncommitted changes; commit or stash them before creating a Git-aware handoff");
  return {
    repositoryName: basename(root),
    revision,
    branch: git(workspace, ["branch", "--show-current"], true) || null,
  };
};

const assertGitMetadata = (manifest: HandoffManifest) => {
  const baseline = manifest.sourceCode?.git;
  if (baseline === undefined) return;
  if (
    typeof baseline.repositoryName !== "string" || !baseline.repositoryName ||
    !/^[a-f0-9]{40,64}$/.test(baseline.revision) ||
    !(baseline.branch === null || typeof baseline.branch === "string")
  ) throw Error("Invalid Git baseline metadata");
};

const checkGitRevision = (
  projectId: string,
  handoffId: string,
  sourceRevision: string,
  workspaceInput: string,
  checkedAt: number,
): ProjectHandoffGitCheck => {
  const workspace = resolve(workspaceInput);
  if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink() || !statSync(workspace).isDirectory())
    throw Error("Git workspace is missing, unsafe or not a directory");
  const root = resolve(git(workspace, ["rev-parse", "--show-toplevel"]));
  if (root !== workspace) throw Error("Git workspace must be the repository root");
  const targetRevision = git(workspace, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(targetRevision)) throw Error("Target Git HEAD is invalid or missing");
  const targetDirty = Boolean(git(workspace, ["status", "--porcelain=v1", "--untracked-files=normal"]));
  const sourceCommitPresent = git(workspace, ["cat-file", "-e", `${sourceRevision}^{commit}`], true) !== undefined;
  const sourceIsAncestor = sourceCommitPresent && git(workspace, ["merge-base", "--is-ancestor", sourceRevision, targetRevision], true) !== undefined;
  const status: ProjectHandoffGitCheck["status"] = targetDirty
    ? "TARGET_DIRTY"
    : !sourceCommitPresent
      ? "SOURCE_MISSING"
      : sourceRevision === targetRevision
        ? "SAME"
        : sourceIsAncestor
          ? "TARGET_AHEAD"
          : "DIVERGED";
  return {
    handoffId, projectId, sourceRevision, targetRevision, sourceCommitPresent, sourceIsAncestor,
    targetDirty, status, safeToApply: status === "SAME" || status === "TARGET_AHEAD", checkedAt,
  };
};

const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const secretPatterns: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["OpenAI-style API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const assertNoSecrets = (label: string, content: Buffer | string) => {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const chunkBytes = 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes - 256) {
    const text = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes)).toString("utf8");
    for (const [kind, pattern] of secretPatterns)
      if (pattern.test(text)) throw Error(`Handoff blocked: possible ${kind} in ${label}`);
  }
};

export class ProjectHandoffStore {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly inboxRoot: string;

  constructor(
    databasePath: string,
    private readonly projects: ProjectRegistry,
    private readonly memories: ProjectMemoryStore,
    private readonly artifacts: ProjectArtifactStore,
    root = join(dpiHome(), "handoffs"),
    inboxRoot = join(dpiHome(), "handoff-inbox"),
  ) {
    this.root = resolve(root);
    this.inboxRoot = resolve(inboxRoot);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.inboxRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw Error("Handoff root must not be a symbolic link");
    if (lstatSync(this.inboxRoot).isSymbolicLink()) throw Error("Handoff inbox must not be a symbolic link");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_handoffs(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        directory TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        artifact_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_handoffs_scope
        ON project_handoffs(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS handoff_agent_bindings(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_handoff_id TEXT NOT NULL,
        blueprint_id TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES project_members(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,source_handoff_id,blueprint_id));
      CREATE INDEX IF NOT EXISTS handoff_agent_bindings_member
        ON handoff_agent_bindings(member_id);`);
    const handoffColumns = this.db.prepare("PRAGMA table_info(project_handoffs)").all() as Array<{ name: string }>;
    if (!handoffColumns.some((column) => column.name === "request_id"))
      this.db.exec("ALTER TABLE project_handoffs ADD COLUMN request_id TEXT");
    if (!handoffColumns.some((column) => column.name === "request_hash"))
      this.db.exec("ALTER TABLE project_handoffs ADD COLUMN request_hash TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS project_handoffs_request
      ON project_handoffs(project_id,request_id) WHERE request_id IS NOT NULL`);
  }

  private handoff(row: HandoffRow): ProjectHandoff {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      directory: row.directory,
      manifestSha256: row.manifest_sha256,
      artifactCount: row.artifact_count,
      totalBytes: row.total_bytes,
      createdAt: row.created_at,
    };
  }

  list(projectId: string) {
    return (this.db
      .prepare("SELECT * FROM project_handoffs WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as HandoffRow[]).map((row) => this.handoff(row));
  }

  agentBlueprints(projectId: string): ProjectAgentBlueprint[] {
    if (!this.projects.get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const memory = this.memories.list(projectId).find((item) => item.key === "system.handoff.agent_blueprints");
    if (!memory) return [];
    if (!memory.sourceId) throw Error("Imported Agent blueprints are missing their source handoff identity");
    const value = memory.value as { sourceProjectId?: unknown; members?: unknown } | null;
    if (!value || typeof value.sourceProjectId !== "string" || !value.sourceProjectId)
      throw Error("Imported Agent blueprint metadata is invalid");
    const members = validatedMemberBlueprints(value.members);
    const bindings = this.db
      .prepare("SELECT source_handoff_id,blueprint_id,member_id FROM handoff_agent_bindings WHERE project_id=?")
      .all(projectId) as Array<{ source_handoff_id: string; blueprint_id: string; member_id: string }>;
    const byBlueprint = new Map(
      bindings
        .filter((binding) => binding.source_handoff_id === memory.sourceId)
        .map((binding) => [binding.blueprint_id, binding.member_id]),
    );
    return members.map((member) => {
      const boundMemberId = byBlueprint.get(member.id);
      return {
        sourceHandoffId: memory.sourceId!,
        sourceProjectId: value.sourceProjectId as string,
        ...member,
        bindingState: member.temporary ? "SOURCE_TEMPORARY" : boundMemberId ? "BOUND" : "UNBOUND",
        ...(boundMemberId ? { boundMemberId } : {}),
      };
    });
  }

  recordAgentBlueprintBinding(
    projectId: string,
    sourceHandoffId: string,
    blueprintId: string,
    memberId: string,
    createdAt = Date.now(),
  ): ProjectAgentBlueprint {
    const blueprint = this.agentBlueprints(projectId).find(
      (item) => item.sourceHandoffId === sourceHandoffId && item.id === blueprintId,
    );
    if (!blueprint) throw Error(`Unknown imported Agent blueprint: ${blueprintId}`);
    if (blueprint.temporary) throw Error("Temporary source Agents cannot be rebound from a handoff");
    const member = this.projects.getMember(projectId, memberId, true);
    if (!member) throw Error(`Unknown bound project member: ${memberId}`);
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO handoff_agent_bindings(
         project_id,source_handoff_id,blueprint_id,member_id,created_at)
       VALUES(?,?,?,?,?)`,
    ).run(projectId, sourceHandoffId, blueprintId, memberId, createdAt);
    const binding = this.db.prepare(
      `SELECT member_id FROM handoff_agent_bindings
       WHERE project_id=? AND source_handoff_id=? AND blueprint_id=?`,
    ).get(projectId, sourceHandoffId, blueprintId) as { member_id: string } | undefined;
    if (!binding || binding.member_id !== memberId)
      throw Error("Agent blueprint was already bound to a different project member");
    if (inserted.changes) {
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "handoff.agent_blueprint.bound", JSON.stringify({
          sourceHandoffId, blueprintId, memberId, sourcePermissionProfile: blueprint.permissionProfile,
          targetPermissionProfile: member.permissionProfile,
        }), createdAt);
    }
    return this.agentBlueprints(projectId).find((item) => item.id === blueprintId)!;
  }

  validate(projectId: string, handoffId: string, checkedAt = Date.now()): ProjectHandoffValidation {
    const row = this.db
      .prepare("SELECT * FROM project_handoffs WHERE project_id=? AND id=?")
      .get(projectId, handoffId) as HandoffRow | undefined;
    if (!row) throw Error(`Unknown handoff: ${handoffId}`);
    const directory = resolve(row.directory);
    const projectRoot = resolve(this.root, projectId);
    if (dirname(projectRoot) !== this.root || dirname(directory) !== projectRoot)
      throw Error("Handoff directory escaped the project root");
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory())
      throw Error("Handoff directory is missing or unsafe");
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw Error("Handoff manifest is missing or unsafe");
    const manifestStat = statSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 2 * 1024 * 1024) throw Error("Handoff manifest is invalid or too large");
    const manifestContent = readFileSync(manifestPath);
    const manifestSha256 = sha256(manifestContent);
    if (manifestSha256 !== row.manifest_sha256) throw Error("Handoff manifest checksum mismatch");
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestContent.toString("utf8"));
    } catch {
      throw Error("Handoff manifest is not valid JSON");
    }
    const { manifest, sourceSchemaVersion } = normalizeManifest(rawManifest);
    assertManifestCompatibility(manifest);
    if (manifest.id !== handoffId || manifest.project?.id !== projectId) throw Error("Handoff identity mismatch");
    assertGitMetadata(manifest);
    assertMemberBlueprints(manifest);
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 10_000) throw Error("Invalid artifact manifest");
    let verifiedBytes = manifestContent.byteLength;
    const seen = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact.id !== "string" || seen.has(artifact.id)) throw Error("Invalid or duplicate artifact ID");
      seen.add(artifact.id);
      if (typeof artifact.file !== "string" || !artifact.file.startsWith("artifacts/") || artifact.file.includes("\\"))
        throw Error(`Unsafe artifact path: ${artifact.file}`);
      if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !isSha256(artifact.sha256))
        throw Error(`Invalid artifact metadata: ${artifact.id}`);
      const file = resolve(directory, artifact.file);
      const artifactRoot = resolve(directory, "artifacts");
      if (dirname(file) !== artifactRoot || !existsSync(file) || lstatSync(file).isSymbolicLink())
        throw Error(`Artifact is missing or unsafe: ${artifact.id}`);
      const fileStat = statSync(file);
      if (!fileStat.isFile() || fileStat.size !== artifact.sizeBytes) throw Error(`Artifact size mismatch: ${artifact.id}`);
      const content = readFileSync(file);
      if (sha256(content) !== artifact.sha256) throw Error(`Artifact checksum mismatch: ${artifact.id}`);
      verifiedBytes += content.byteLength;
    }
    if (manifest.artifacts.length !== row.artifact_count) throw Error("Artifact count mismatch");
    const result: ProjectHandoffValidation = {
      handoffId,
      projectId,
      valid: true,
      schemaVersion: sourceSchemaVersion,
      handoffProtocol: manifest.handoffProtocol,
      artifactCount: manifest.artifacts.length,
      verifiedBytes,
      manifestSha256,
      checkedAt,
    };
    this.db
      .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, "handoff.validated", JSON.stringify(result), checkedAt);
    return result;
  }

  importFromInbox(bundleName: string, targetProjectId?: string, importedAt = Date.now()): ProjectHandoffImportResult {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(bundleName)) throw Error("Invalid inbox bundle name");
    const directory = resolve(this.inboxRoot, bundleName);
    if (dirname(directory) !== this.inboxRoot || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory())
      throw Error("Inbox bundle is missing or unsafe");
    const manifestPath = join(directory, "manifest.json");
    const checksumPath = join(directory, "manifest.sha256");
    if (!existsSync(manifestPath) || !existsSync(checksumPath) || lstatSync(manifestPath).isSymbolicLink() || lstatSync(checksumPath).isSymbolicLink())
      throw Error("Inbox manifest or checksum is missing or unsafe");
    const manifestStat = statSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 2 * 1024 * 1024) throw Error("Inbox manifest is invalid or too large");
    const manifestContent = readFileSync(manifestPath);
    const manifestSha256 = sha256(manifestContent);
    const declaredChecksum = readFileSync(checksumPath, "utf8").trim().match(/^([a-f0-9]{64})\s+manifest\.json$/)?.[1];
    if (!declaredChecksum || declaredChecksum !== manifestSha256) throw Error("Inbox manifest checksum mismatch");
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestContent.toString("utf8"));
    } catch {
      throw Error("Inbox manifest is not valid JSON");
    }
    const { manifest, sourceSchemaVersion } = normalizeManifest(rawManifest);
    assertManifestCompatibility(manifest);
    assertGitMetadata(manifest);
    assertMemberBlueprints(manifest);
    if (typeof manifest.id !== "string" || !manifest.project || !Array.isArray(manifest.memories) || manifest.memories.length > 10_000)
      throw Error("Invalid handoff metadata");
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 10_000) throw Error("Invalid artifact manifest");
    const artifactRoot = resolve(directory, "artifacts");
    const verified = new Map<string, Buffer>();
    let verifiedBytes = manifestContent.byteLength;
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact.id !== "string" || verified.has(artifact.id)) throw Error("Invalid or duplicate artifact ID");
      if (typeof artifact.file !== "string" || !artifact.file.startsWith("artifacts/") || artifact.file.includes("\\"))
        throw Error(`Unsafe artifact path: ${artifact.file}`);
      if (typeof artifact.name !== "string" || typeof artifact.kind !== "string" || typeof artifact.mimeType !== "string")
        throw Error(`Invalid artifact metadata: ${artifact.id}`);
      if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !isSha256(artifact.sha256))
        throw Error(`Invalid artifact metadata: ${artifact.id}`);
      const file = resolve(directory, artifact.file);
      if (dirname(file) !== artifactRoot || !existsSync(file) || lstatSync(file).isSymbolicLink()) throw Error(`Artifact is missing or unsafe: ${artifact.id}`);
      const fileStat = statSync(file);
      if (!fileStat.isFile() || fileStat.size !== artifact.sizeBytes) throw Error(`Artifact size mismatch: ${artifact.id}`);
      const content = readFileSync(file);
      if (sha256(content) !== artifact.sha256) throw Error(`Artifact checksum mismatch: ${artifact.id}`);
      verifiedBytes += content.byteLength;
      if (verifiedBytes > 512 * 1024 * 1024) throw Error("Inbox bundle exceeds the 512 MiB import limit");
      verified.set(artifact.id, content);
    }
    const projectId = targetProjectId ?? manifest.project.id;
    const tokenLimit24h = handoffLimit(manifest.project.tokenLimit24h, "tokenLimit24h", Number.MAX_SAFE_INTEGER);
    const maxTaskTokens = handoffLimit(manifest.project.maxTaskTokens, "maxTaskTokens", Number.MAX_SAFE_INTEGER);
    const maxCoordinationDepth = handoffLimit(manifest.project.maxCoordinationDepth, "maxCoordinationDepth");
    const maxDelegatedTasksPerTurn = handoffLimit(manifest.project.maxDelegatedTasksPerTurn, "maxDelegatedTasksPerTurn");
    const maxActiveTasks = handoffLimit(manifest.project.maxActiveTasks, "maxActiveTasks");
    const maxConcurrentTasks = handoffLimit(manifest.project.maxConcurrentTasks, "maxConcurrentTasks", 1_000);
    let created = false;
    try {
      const project = this.projects.create({
        id: projectId,
        templateId: manifest.project.templateId,
        templatePlan: manifest.project.templatePlan,
        name: manifest.project.name,
        description: `${manifest.project.description ?? ""}\n\nImported from handoff ${manifest.id}.`.trim(),
        autonomyMode: "SUPERVISED",
        tokenLimit24h,
        maxTaskTokens,
        maxCoordinationDepth,
        maxDelegatedTasksPerTurn,
        maxActiveTasks,
        maxConcurrentTasks,
      });
      created = true;
      let memoriesImported = 0;
      for (const memory of manifest.memories) {
        if (!memory || typeof memory.key !== "string" || typeof memory.sourceType !== "string") throw Error("Invalid memory metadata");
        if (memory.expiresAt !== undefined && (!Number.isSafeInteger(memory.expiresAt) || memory.expiresAt < 1))
          throw Error("Invalid memory expiry metadata");
        if (memory.expiresAt !== undefined && memory.expiresAt <= importedAt) continue;
        this.memories.put(projectId, {
          key: memory.key,
          value: memory.value,
          sourceType: `handoff:${memory.sourceType}`.slice(0, 80),
          sourceId: manifest.id,
          ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
        }, importedAt);
        memoriesImported += 1;
      }
      if (manifest.sourceCode?.git) {
        this.memories.putSystem(projectId, {
          key: "system.handoff.git_baseline",
          value: manifest.sourceCode.git,
          sourceType: "handoff:git",
          sourceId: manifest.id,
        }, importedAt);
      }
      if (manifest.project.members?.length) {
        this.memories.putSystem(projectId, {
          key: "system.handoff.agent_blueprints",
          value: {
            sourceProjectId: manifest.project.id,
            sourceAutonomyMode: manifest.project.autonomyMode ?? null,
            members: manifest.project.members,
            bindingRequired: true,
          },
          sourceType: "handoff:agent-blueprints",
          sourceId: manifest.id,
        }, importedAt);
      }
      if (sourceSchemaVersion !== CURRENT_SCHEMA_VERSION) {
        this.memories.putSystem(projectId, {
          key: "system.handoff.schema_migration",
          value: {
            sourceSchemaVersion,
            targetSchemaVersion: CURRENT_SCHEMA_VERSION,
            handoffProtocol: manifest.handoffProtocol,
          },
          sourceType: "handoff:schema-migration",
          sourceId: manifest.id,
        }, importedAt);
      }
      for (const artifact of manifest.artifacts) {
        const artifactId = this.artifacts.db.prepare("SELECT id FROM project_artifacts WHERE id=?").get(artifact.id)
          ? randomUUID()
          : artifact.id;
        this.artifacts.put(projectId, {
          id: artifactId,
          name: artifact.name,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          content: verified.get(artifact.id)!,
          includeInHandoff: true,
        }, importedAt);
      }
      this.db
        .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "handoff.imported", JSON.stringify({ bundleName, sourceHandoffId: manifest.id, manifestSha256, sourceSchemaVersion, normalizedSchemaVersion: CURRENT_SCHEMA_VERSION, memoriesImported, memoriesSkippedExpired: manifest.memories.length - memoriesImported, artifactsImported: manifest.artifacts.length, memberBlueprintsImported: manifest.project.members?.length ?? 0, agentsCreated: 0, verifiedBytes }), importedAt);
      return { bundleName, sourceHandoffId: manifest.id, project: this.projects.get(projectId) ?? project, memoriesImported, artifactsImported: manifest.artifacts.length, verifiedBytes, manifestSha256, importedAt };
    } catch (error) {
      if (created) {
        this.artifacts.purgeProject(projectId);
        this.projects.remove(projectId);
      }
      throw error;
    }
  }

  checkGit(projectId: string, handoffId: string, workspaceInput: string, checkedAt = Date.now()): ProjectHandoffGitCheck {
    this.validate(projectId, handoffId, checkedAt);
    const row = this.db.prepare("SELECT * FROM project_handoffs WHERE project_id=? AND id=?").get(projectId, handoffId) as HandoffRow;
    const { manifest } = normalizeManifest(JSON.parse(readFileSync(join(row.directory, "manifest.json"), "utf8")));
    const sourceRevision = manifest.sourceCode?.git?.revision;
    if (!sourceRevision) throw Error("Handoff does not contain a Git baseline");
    const result = checkGitRevision(projectId, handoffId, sourceRevision, workspaceInput, checkedAt);
    this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, "handoff.git_checked", JSON.stringify(result), checkedAt);
    return result;
  }

  checkImportedGit(projectId: string, workspaceInput: string, checkedAt = Date.now()): ProjectHandoffGitCheck {
    if (!this.projects.get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const memory = this.memories.list(projectId).find((item) => item.key === "system.handoff.git_baseline");
    const baseline = memory?.value as Partial<GitBaseline> | undefined;
    if (!baseline || !/^[a-f0-9]{40,64}$/.test(baseline.revision ?? "") || !memory?.sourceId)
      throw Error("Project does not contain an imported Git baseline");
    const result = checkGitRevision(projectId, memory.sourceId, baseline.revision!, workspaceInput, checkedAt);
    this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, "handoff.imported_git_checked", JSON.stringify(result), checkedAt);
    return result;
  }

  create(projectId: string, optionsOrNow: { workspace?: string; requestId?: string } | number = {}, nowInput?: number) {
    const options = typeof optionsOrNow === "number" ? {} : optionsOrNow;
    const now = typeof optionsOrNow === "number" ? optionsOrNow : (nowInput ?? Date.now());
    const project = this.projects.get(projectId);
    if (!project) throw Error(`Unknown project: ${projectId}`);
    const requestId = options.requestId?.trim();
    if (requestId !== undefined && (!requestId || requestId.length > 240))
      throw Error("Handoff requestId must contain 1 to 240 characters");
    const requestHash = requestId
      ? sha256(JSON.stringify({ workspace: options.workspace?.trim() ? resolve(options.workspace.trim()) : null }))
      : undefined;
    if (requestId) {
      const existing = this.db.prepare(
        "SELECT * FROM project_handoffs WHERE project_id=? AND request_id=?",
      ).get(projectId, requestId) as HandoffRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw Error("Handoff requestId was reused with different arguments");
        return this.handoff(existing);
      }
    }
    const gitBaseline = options.workspace?.trim() ? inspectGitBaseline(options.workspace.trim()) : undefined;
    const id = `${new Date(now).toISOString().replace(/:/g, "-")}-${randomUUID().slice(0, 8)}`;
    const projectRoot = resolve(this.root, projectId);
    if (dirname(projectRoot) !== this.root) throw Error("Handoff project directory escaped the root");
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(projectRoot).isSymbolicLink()) throw Error("Handoff project directory must not be a symbolic link");
    const finalDirectory = join(projectRoot, id);
    const temporary = `${finalDirectory}.tmp`;
    mkdirSync(join(temporary, "artifacts"), { recursive: true, mode: 0o700 });
    try {
      const selected = this.artifacts.list(projectId).filter((artifact) => artifact.includeInHandoff);
      const artifactManifest = selected.map((artifact) => {
        const { content } = this.artifacts.read(projectId, artifact.id);
        assertNoSecrets(`artifact ${artifact.name}`, content);
        const file = join("artifacts", `${artifact.id}-${artifact.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`);
        const target = join(temporary, file);
        writeFileSync(target, content, { mode: 0o600, flag: "wx" });
        chmodSync(target, 0o600);
        return {
          id: artifact.id,
          name: artifact.name,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          file: file.replace(/\\/g, "/"),
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
        };
      });
      const activeMemberBlueprints: HandoffMemberBlueprint[] = project.members.map((member) => ({
        id: member.id,
        name: member.name,
        role: member.role,
        permissionProfile: member.permissionProfile,
        executor: member.executor,
        model: member.model ?? null,
        allowModelFallback: member.allowModelFallback,
        fallbackModels: member.fallbackModels,
        cwd: member.cwd ?? null,
        temporary: member.temporary,
        lifecycleState: member.lifecycleState,
      }));
      const activeIds = new Set(activeMemberBlueprints.map((member) => member.id));
      const carriedBlueprints: HandoffMemberBlueprint[] = this.agentBlueprints(projectId)
        .filter((blueprint) => blueprint.bindingState !== "BOUND" && !activeIds.has(blueprint.id))
        .map(({ sourceHandoffId: _sourceHandoffId, sourceProjectId: _sourceProjectId, bindingState: _bindingState, boundMemberId: _boundMemberId, ...member }) => member);
      const manifest = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        handoffProtocol: "1.0",
        minimumRuntimeVersion: RUNTIME_VERSION,
        exporterVersion: RUNTIME_VERSION,
        id,
        createdAt: now,
        project: {
          id: project.id,
          ...(project.templateId ? { templateId: project.templateId } : {}),
          templatePlan: project.templatePlan,
          name: project.name,
          description: project.description,
          autonomyMode: project.autonomyMode,
          tokenLimit24h: project.tokenLimit24h ?? null,
          maxTaskTokens: project.maxTaskTokens ?? null,
          maxCoordinationDepth: project.maxCoordinationDepth ?? null,
          maxDelegatedTasksPerTurn: project.maxDelegatedTasksPerTurn ?? null,
          maxActiveTasks: project.maxActiveTasks ?? null,
          maxConcurrentTasks: project.maxConcurrentTasks ?? null,
          members: [...activeMemberBlueprints, ...carriedBlueprints],
        },
        memories: this.memories.list(projectId).filter((memory) => !memory.key.toLowerCase().startsWith("system.")).map((memory) => ({
          key: memory.key,
          value: memory.value,
          sourceType: memory.sourceType,
          sourceId: memory.sourceId ?? null,
          ...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
          version: memory.version,
          updatedAt: memory.updatedAt,
        })),
        artifacts: artifactManifest,
        sourceCode: {
          included: false,
          note: "Source code is transferred through Git or an explicit filesystem copy, not embedded by default.",
          ...(gitBaseline ? { git: gitBaseline } : {}),
        },
      };
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      assertNoSecrets("manifest or project memory", manifestText);
      const manifestSha256 = sha256(manifestText);
      writeFileSync(join(temporary, "manifest.json"), manifestText, { mode: 0o600, flag: "wx" });
      writeFileSync(join(temporary, "manifest.sha256"), `${manifestSha256}  manifest.json\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, finalDirectory);
      const totalBytes = Buffer.byteLength(manifestText) + artifactManifest.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO project_handoffs(
               id,project_id,status,directory,manifest_sha256,artifact_count,total_bytes,request_id,request_hash,created_at)
             VALUES(?,?,'READY',?,?,?,?,?,?,?)`,
          )
          .run(id, projectId, finalDirectory, manifestSha256, artifactManifest.length, totalBytes,
            requestId ?? null, requestHash ?? null, now);
        this.db
          .prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(projectId, "handoff.created", JSON.stringify({ handoffId: id, manifestSha256, artifactCount: artifactManifest.length, totalBytes }), now);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const row = this.db.prepare("SELECT * FROM project_handoffs WHERE id=?").get(id) as HandoffRow;
      return this.handoff(row);
    } catch (error) {
      for (const candidate of [temporary, finalDirectory]) {
        const target = resolve(candidate);
        if (existsSync(target) && dirname(target) === projectRoot && !lstatSync(target).isSymbolicLink())
          rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
  }

  purgeProject(projectId: string) {
    const projectRoot = resolve(this.root, projectId);
    if (dirname(projectRoot) !== this.root) throw Error("Handoff project directory escaped the root");
    const count = Number(
      (this.db.prepare("SELECT COUNT(*) AS count FROM project_handoffs WHERE project_id=?").get(projectId) as { count: number }).count,
    );
    if (existsSync(projectRoot)) {
      if (lstatSync(projectRoot).isSymbolicLink()) throw Error("Handoff project directory must not be a symbolic link");
      rmSync(projectRoot, { recursive: true, force: true });
    }
    this.db.prepare("DELETE FROM project_handoffs WHERE project_id=?").run(projectId);
    return count;
  }

  close() {
    this.db.close();
  }
}
