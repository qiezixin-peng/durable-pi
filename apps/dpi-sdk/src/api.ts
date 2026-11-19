// The Durable Agent Network wire contract: every JSON body and stream frame between
// dpi-backend and its clients. Types only, so browsers, Node and the TUI share it.
//
// Agent events are pi-durable 1.0.3's `watchEvents()` output passed through verbatim.
// The Wire* event types below copy their JSON shape; apps/dpi-backend/src/contract-check.ts
// fails the build if pi-durable's own types stop fitting them.

import type { JobDef } from "./jobs.js";

export const API_VERSION = 1 as const;

export type DeviceKind = "local" | "ssh" | "exe-dev" | "url";
export type DeviceStatus =
  | "checking"
  | "online"
  | "offline"
  | "unauthorized"
  | "mismatch"
  | "incompatible";
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid"
  | "busy"
  | "conflict"
  | "ambiguous"
  | "unavailable"
  | "internal"
  | "offline";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export type WhenBusy = "followUp" | "steer" | "reject";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

// ---------------------------------------------------------------- device

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  tier: string;
  icon: string;
  contextWindow: number;
  reasoning: boolean;
  cost: { input: number; output: number };
  capabilities: ModelCapabilities;
}

export type ModelCapabilitySupport = "supported" | "unsupported" | "unknown";

/** Provider-neutral facts used for safe model routing. Unknown is never treated as supported. */
export interface ModelCapabilities {
  textInput: ModelCapabilitySupport;
  imageInput: ModelCapabilitySupport;
  toolCalling: ModelCapabilitySupport;
  streaming: ModelCapabilitySupport;
  structuredOutput: ModelCapabilitySupport;
  reasoning: ModelCapabilitySupport;
  contextWindow: number;
  maxOutputTokens: number;
  source: "provider-metadata" | "platform-verified";
}

export interface DeviceInfo {
  uid: string;
  name: string;
  hostname: string;
  platform: string;
  apiVersion: typeof API_VERSION;
  durableVersion: string;
  startedAt: number;
  /** Where new sessions start: the directory browser opens here, relative cwds resolve against the first. */
  startDirs: string[];
  models: ModelInfo[];
  defaultModel: string;
  storage: { dataDir: string; catalogPath: string; appStatePath: string };
  /** The checkout the backend runs from (repo root locally, `code_dir` on deployed devices). */
  codeDir?: string;
  capabilities: Array<"events" | "docs" | "demo" | "jobs">;
  /** Durable jobs any agent on this device can run (`POST .../demo/jobs` or the run_durable_job tool). */
  jobs?: JobDef[];
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string }[];
}

// ---------------------------------------------------------------- sessions and agents

export type AgentKind = "root" | "fork" | "subagent";

/** An agent is a pi-durable conversation; `id` is the conversation id. */
export interface AgentRef {
  id: number;
  name: string;
  /** True when `name` was set by a person rather than derived from the id. */
  named: boolean;
  kind: AgentKind;
  parentId?: number;
  forkedAt?: number;
  ownerAgentId?: number;
  ownerTaskId?: number;
}

export interface AgentStatus {
  busy: boolean;
  background: number;
}

export type AgentSummary = AgentRef & AgentStatus;

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  model: string;
  createdAt: number;
  dbPath: string;
  busy: boolean;
  error?: string;
  agents: AgentSummary[];
  /** Automatic compaction thresholds, shared by every agent of the session. */
  compaction?: CompactionSettings;
}

/**
 * pi-durable's compaction policy. Above `contextWindow - reserveTokens` the next request waits for a summary;
 * `backgroundTokens` below that, a summary starts in the background (0 disables it).
 */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  backgroundTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  backgroundTokens: 32768,
  keepRecentTokens: 2000,
};

/** The playground's default marker positions: a summary starts in the background at 200k tokens, and the next
 * request waits for it at 250k. */
export const DEFAULT_COMPACTION_AT = { auto: 200_000, wait: 250_000 };

/** Default thresholds for a model window: the positions above, or pi-durable's own margins when the window is smaller. */
export function defaultCompaction(window: number): CompactionSettings {
  if (!(window > 0)) return { ...DEFAULT_COMPACTION };
  const wait = Math.min(DEFAULT_COMPACTION_AT.wait, window - DEFAULT_COMPACTION.reserveTokens);
  const auto = Math.min(DEFAULT_COMPACTION_AT.auto, wait - DEFAULT_COMPACTION.backgroundTokens);
  return { ...DEFAULT_COMPACTION, reserveTokens: window - wait, backgroundTokens: wait - auto };
}

/** False when the thresholds leave a model with this window under 32k tokens before every request waits for a summary. */
export const compactionFits = (window: number, s: CompactionSettings) => window - s.reserveTokens >= 32_768;

/** Context sizes where compaction starts for a model window: `auto` in the background, `wait` blocking. */
export function compactionThresholds(window: number, s: CompactionSettings) {
  const wait = Math.max(0, window - s.reserveTokens);
  return { wait, auto: s.backgroundTokens > 0 ? Math.max(0, wait - s.backgroundTokens) : undefined };
}

export interface DeviceTree {
  uid: string;
  name: string;
  sessions: SessionSummary[];
  at: number;
}

// ---------------------------------------------------------------- projects

/** A project groups agents that may live in sessions on different devices. */
export interface ProjectMember {
  id: string;
  projectId: string;
  deviceId: string;
  sessionId: string;
  agentId: string;
  name: string;
  role: string;
  permissionProfile: ProjectPermissionProfile;
  executor: "pi" | "codex";
  model?: string;
  allowModelFallback: boolean;
  fallbackModels: string[];
  cwd?: string;
  /** T3 linked-environment id. Omitted means this machine. */
  t3EnvironmentId?: string;
  threadId?: string;
  threadModel?: string;
  threadRuntime?: "codex-app-server" | "t3";
  /** Provider instance that owns the persisted thread. A missing value is treated
   * as unknown and must never be reused across a provider boundary. */
  threadProvider?: string;
  codexToolsVersion?: number;
  temporary: boolean;
  lifecycleState: "ACTIVE" | "IDLE" | "ARCHIVED";
  parentMemberId?: string;
  scopeTaskId?: string;
  spawnRequestId?: string;
  archivedAt?: number;
  createdAt: number;
}

export type ProjectPermissionProfile = "ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE";

/** A source-device member description imported for deliberate, local re-binding. */
export interface ProjectAgentBlueprint {
  sourceHandoffId: string;
  sourceProjectId: string;
  id: string;
  name: string;
  role: string;
  permissionProfile: ProjectPermissionProfile;
  executor: "pi" | "codex";
  model: string | null;
  allowModelFallback: boolean;
  fallbackModels: string[];
  cwd: string | null;
  temporary: boolean;
  lifecycleState: "ACTIVE" | "IDLE" | "ARCHIVED";
  bindingState: "UNBOUND" | "BOUND" | "SOURCE_TEMPORARY";
  boundMemberId?: string;
}

export interface ProjectAgentBlueprintBinding {
  blueprint: ProjectAgentBlueprint;
  member: ProjectMember;
}

export interface ProjectWorktree {
  id: string;
  projectId: string;
  label: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseRevision: string;
  state: "PROVISIONING" | "ACTIVE" | "FAILED" | "REMOVED";
  headRevision?: string;
  dirty?: boolean;
  baseIsAncestor?: boolean;
  error?: string;
  createdAt: number;
  checkedAt?: number;
}

export interface ProjectSummary {
  id: string;
  templateId?: string;
  templatePlan: ProjectTemplateRole[];
  name: string;
  description: string;
  autonomyMode: ProjectAutonomyMode;
  tokenLimit24h?: number;
  maxTaskTokens?: number;
  maxCoordinationDepth?: number;
  maxDelegatedTasksPerTurn?: number;
  maxActiveTasks?: number;
  maxConcurrentTasks?: number;
  createdAt: number;
  updatedAt: number;
  members: ProjectMember[];
}

export interface ProjectTemplateRole {
  role: string;
  permissionProfile: ProjectPermissionProfile;
}

export interface ProjectTeamPlan {
  templateId?: string | null;
  roles: Array<ProjectTemplateRole & {
    status: "BOUND" | "UNBOUND";
    permissionAligned: boolean;
    members: Array<{
      id: string;
      name: string;
      executor: "pi" | "codex";
      permissionProfile: ProjectPermissionProfile;
      workspace?: string;
    }>;
  }>;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  autonomyMode: ProjectAutonomyMode;
  maxCoordinationDepth: number;
  maxDelegatedTasksPerTurn: number;
  maxActiveTasks: number;
  maxConcurrentTasks: number;
  suggestedRoles: ProjectTemplateRole[];
}

export type ProjectAutonomyMode = "SUPERVISED" | "AUTHORIZED_AUTONOMY" | "RESTRICTED_UNATTENDED";

export interface ProjectEvent {
  id: number;
  projectId: string;
  kind: string;
  fromMemberId?: string;
  toMemberId?: string;
  detail: unknown;
  createdAt: number;
}

export interface ProjectToolCall {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  fenceEpoch: number;
  memberId: string;
  itemId: string;
  type: string;
  status: "STARTED" | "COMPLETED" | "FAILED";
  evidenceKind: "TEST" | "BUILD" | "FILE_CHANGE" | "TOOL";
  request?: unknown;
  result?: unknown;
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
}

export interface ProjectArtifact {
  id: string;
  projectId: string;
  taskId?: string;
  name: string;
  kind: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  status: "ACTIVE" | "EXPIRED";
  includeInHandoff: boolean;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectModelUsage {
  id: string;
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
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectUsageSummary {
  projectId: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface PlatformObservabilitySummary {
  at: number;
  projects: number;
  agents: { active: number; temporary: number; archived: number };
  tasks: Record<ProjectTaskStatus, number>;
  pendingApprovals: number;
  artifacts: { active: number; expired: number; activeBytes: number };
  handoffs: number;
  worktrees: { active: number; failed: number };
  toolCalls: {
    started: number;
    completed: number;
    failed: number;
    testsPassed: number;
    testsFailed: number;
    buildsPassed: number;
    buildsFailed: number;
  };
  tokenUsage24h: number;
}

export interface ProjectHandoff {
  id: string;
  projectId: string;
  status: "READY" | "FAILED";
  directory: string;
  manifestSha256: string;
  artifactCount: number;
  totalBytes: number;
  createdAt: number;
}

export interface ProjectHandoffValidation {
  handoffId: string;
  projectId: string;
  valid: boolean;
  schemaVersion: number;
  handoffProtocol: string;
  artifactCount: number;
  verifiedBytes: number;
  manifestSha256: string;
  checkedAt: number;
}

export interface ProjectHandoffGitCheck {
  handoffId: string;
  projectId: string;
  sourceRevision: string;
  targetRevision: string;
  sourceCommitPresent: boolean;
  sourceIsAncestor: boolean;
  targetDirty: boolean;
  status: "SAME" | "TARGET_AHEAD" | "TARGET_DIRTY" | "DIVERGED" | "SOURCE_MISSING";
  safeToApply: boolean;
  checkedAt: number;
}

export interface ProjectHandoffImportResult {
  bundleName: string;
  sourceHandoffId: string;
  project: ProjectSummary;
  memoriesImported: number;
  artifactsImported: number;
  verifiedBytes: number;
  manifestSha256: string;
  importedAt: number;
}

export type ProjectMemoryStatus = "ACTIVE" | "EXPIRED";

export interface ProjectMemory {
  id: string;
  projectId: string;
  key: string;
  value: unknown;
  sourceType: string;
  sourceId?: string;
  memberId?: string;
  status: ProjectMemoryStatus;
  expiresAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMemoryRevision extends ProjectMemory {
  revisionId: number;
}

export type ProjectApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "REVOKED"
  | "EXPIRED"
  | "CONSUMED";

export interface ProjectApproval {
  id: string;
  projectId: string;
  operation: unknown;
  operationHash: string;
  requestedBy: string;
  status: ProjectApprovalStatus;
  expiresAt: number;
  decidedBy?: string;
  decidedAt?: number;
  consumedBy?: string;
  consumedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConfig {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  instructions?: string;
  cwd?: string;
  /** Offer only tools that read: tools that create, update or delete leave the agent's requests. */
  readOnly?: boolean;
}

/** A custom harness extension an agent can turn on or off: `GET / PATCH .../agents/:a/extensions`. */
export interface HarnessExtensionInfo {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  /** For system-prompts: the built-in prompts and which ones this agent renders. */
  prompts?: { id: string; title: string; description: string; enabled: boolean; text: string }[];
}

export interface AgentExtensions {
  extensions: HarnessExtensionInfo[];
  /** Extensions every agent runs, which cannot be turned off here. */
  builtIn: string[];
}

export interface AgentDetail extends AgentSummary {
  sessionId: string;
  config: AgentConfig;
  /**
   * Every tool of the agent's extensions. `parameters` is its JSON Schema, as the model sees it; `writes` marks tools
   * that create, update or delete; `offered` is false for tools the agent's tool filter removes (read only).
   */
  tools: {
    name: string;
    description: string;
    replay: "safe" | "unsafe";
    parameters?: unknown;
    writes: boolean;
    offered: boolean;
  }[];
  extensions: string[];
}

export interface CreateSessionBody {
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface CreateAgentBody {
  from?: number | string;
  name?: string;
}

export interface SendMessageBody {
  content: string;
  whenBusy?: WhenBusy;
  requestId: string;
  waitMs?: number;
}

export type SendResult =
  | { submissionId: number; status: "queued" | "pending" }
  | { submissionId: number; status: "done"; answer: { entryId: number; text: string } }
  | { submissionId: number; status: "unanswered"; reason: string };

export interface ForkBody {
  entryId: number;
  name?: string;
}

export interface Page<T> {
  items: T[];
  next?: string;
}

// ---------------------------------------------------------------- tasks and usage

/** Hub-level project task state. Pi's internal tool tasks remain separate. */
export type ProjectTaskStatus =
  | "QUEUED"
  | "WAITING_DEPENDENCY"
  | "RUNNING"
  | "RETRYING"
  | "WAITING_DEVICE"
  | "WAITING_APPROVAL"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type UnknownSideEffectResolution = "RETRY" | "MARK_COMPLETED";

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  input: unknown;
  dependsOn: string[];
  status: ProjectTaskStatus;
  priority: number;
  maxAttempts: number;
  timeoutMs?: number;
  attemptCount: number;
  /** Attempts deferred by external availability or user input; excluded from maxAttempts. */
  deferredAttemptCount?: number;
  availableAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  fenceEpoch: number;
  version: number;
  result?: unknown;
  error?: unknown;
  pausedFromStatus?: ProjectTaskStatus;
  waitingDeviceId?: string;
  waitingApprovalId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTaskLease extends ProjectTask {
  status: "RUNNING";
  leaseOwner: string;
  leaseUntil: number;
  attemptId: string;
  attemptNumber: number;
  /** Approval left by an expired WAITING_APPROVAL lease; the new worker must resolve it before dispatch. */
  supersededApprovalId?: string;
}

export interface ProjectTaskAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  workerId: string;
  fenceEpoch: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "EXPIRED" | "CANCELLED" | "WAITING_DEVICE" | "WAITING_PROVIDER" | "WAITING_USER";
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
  runtime?: ProjectTaskRuntimeBinding;
  result?: unknown;
  error?: unknown;
}

/** Correlates one fenced attempt with the execution owned by an external harness. */
export interface ProjectTaskRuntimeBinding {
  kind: "t3" | "codex-app-server" | "pi-durable";
  threadId: string;
  runId?: string;
  environmentId?: string;
  provider?: string;
  model?: string;
}

/** Durable proof that an external Agent execution already produced a result. */
export interface ProjectTaskExecutionReceipt {
  taskId: string;
  projectId: string;
  requestSha256: string;
  result: unknown;
  attemptId: string;
  fenceEpoch: number;
  createdAt: number;
}

/** First executable project-task kind: route one durable task to one project member Agent. */
export type ProjectMessageType =
  | "task_assignment"
  | "task_result"
  | "task_failed"
  | "task_blocked"
  | "question"
  | "approval_request"
  | "progress_update"
  | "context_update";

export interface ProjectAgentMessageTaskInput {
  kind: "agent.message";
  memberId: string;
  content: string;
  messageType?: ProjectMessageType;
  messageId?: string;
  /** Authenticated project sender when the task originated as an Agent message. */
  fromMemberId?: string;
  correlationId?: string;
  payload?: unknown;
  whenBusy?: WhenBusy;
  waitMs?: number;
}

export interface ProjectAgentMessageResult {
  type: "task_result";
  messageId: string;
  correlationId: string;
  inReplyTo: string;
  fromMemberId: string;
  taskId: string;
  submissionId: string | number;
  answer: { entryId: number; text: string };
}

export interface TaskNode {
  id: number;
  kind: string;
  conversationId: number;
  owner?: number;
  background: boolean;
  aborting?: boolean;
  state: { status: string; phase?: string; on?: number[]; policy?: string };
  conversations: number[];
  /** What the task is: the tool name of a `pi.tool` task, or the job title of a durable job. */
  label?: string;
  /** For `pi.tool` tasks: the tool call id in the transcript. */
  callId?: string;
}

export interface TaskOutcome {
  id: number;
  kind: string;
  conversationId?: number;
  state: {
    status: string;
    outcome?: { status: string; result?: unknown; error?: { message: string } };
  };
}

// ---------------------------------------------------------------- pi-ai / pi-durable JSON shapes

export interface WireText {
  type: "text";
  text: string;
}
export interface WireThinking {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface WireToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export interface WireImage {
  type: "image";
  data: string;
  mimeType: string;
}
export type WireAssistantBlock = WireText | WireThinking | WireToolCall;

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface WireUserMessage {
  role: "user";
  content: string | readonly (WireText | WireImage)[];
  timestamp?: number;
}
export interface WireAssistantMessage {
  role: "assistant";
  content: readonly WireAssistantBlock[];
  provider: string;
  model: string;
  usage: WireUsage;
  stopReason: string;
  errorMessage?: string;
  timestamp?: number;
}
export interface WireToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: readonly (WireText | WireImage)[];
  isError: boolean;
  details?: unknown;
  timestamp?: number;
}
export interface WireOtherMessage {
  role: string;
}
export type WireMessage =
  | WireUserMessage
  | WireAssistantMessage
  | WireToolResultMessage
  | WireOtherMessage;

export interface WireEntry {
  id: number;
  conversationId: number;
  kind: string;
  model?: readonly WireMessage[];
  data?: unknown;
  head?: number;
  byTaskId?: number;
}

export interface WireToolSlot {
  callId: string;
  name: string;
  taskId?: number;
  status: "pending" | "running" | "done";
  output?: string;
  droppedBytes?: number;
  droppedLines?: number;
  details?: unknown;
  entry?: number;
}

export interface WireCompaction {
  taskId: number;
  reason: string;
  blocking: boolean;
  attempt: number;
  retry?: { at: number; error: string };
}

export interface WireAgentState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  extensions?: unknown;
  tools?: unknown;
  instructions?: string;
  cwd?: string;
}

export interface WireUsageState {
  models: Readonly<Record<string, WireUsage>>;
  tools: Readonly<Record<string, WireUsage>>;
}

export interface WireQueued {
  id: number;
  mode: string;
}

export type WireMessageChange =
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      block: WireAssistantBlock;
    }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      path: readonly (string | number)[];
      delta: string;
    }
  | { type: "block"; contentIndex: number; block: WireAssistantBlock }
  | { type: "message"; message: WireAssistantMessage };

export interface WireSnapshotEvent {
  type: "snapshot";
  entries: readonly WireEntry[];
  run?: { inputs: readonly number[] };
  generation?: {
    attempt: number;
    message?: WireAssistantMessage;
    retry?: { at: number; error: string };
    deferred?: { pollAt: number };
  };
  tools: readonly WireToolSlot[];
  compactions: readonly WireCompaction[];
  inbox: readonly WireQueued[];
  agent: WireAgentState;
  usage: WireUsageState;
}

export type WireAgentEvent =
  | WireSnapshotEvent
  | { type: "run_start" | "run_end"; inputs: readonly number[] }
  | { type: "turn_start" | "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; usage: WireUsage; changes: readonly WireMessageChange[] }
  | { type: "message_end"; entry: WireEntry }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: { trimStart?: number; append?: string } | { set: string };
      details?: unknown;
      diagnostics?: readonly unknown[];
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: WireEntry }
  | { type: "inbox_update"; items: readonly WireQueued[] }
  | { type: "submission"; record: { id: number; status: string } }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: WireEntry }
  | { type: "agent_changed"; agent: WireAgentState }
  | { type: "usage_changed"; usage: WireUsageState }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; taskId: number; reason: string; blocking: boolean }
  | { type: "compaction_end"; taskId: number; reason: string };

/** A queued submission with its content, read from the conversation's `pi.inbox` document. */
export interface InboxItem {
  id: number;
  mode: "steer" | "followUp" | "write";
  content?: string;
}

// ---------------------------------------------------------------- stream frames

export interface StreamScope {
  kind: "device" | "session" | "agent";
  sessionId?: string;
  agentId?: number;
}

export interface Activity {
  type: "agent.started" | "agent.finished";
  sessionId: string;
  agentId: number;
  at: number;
  preview?: string;
}

export interface UsageTotals {
  models: Record<string, WireUsage>;
  tools: Record<string, WireUsage>;
}

/** The public view of a registry device (the token never leaves the hub or TUI process). */
export interface NetworkDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  url: string;
  source: "config" | "ui";
  hasToken: boolean;
  status: DeviceStatus;
  error?: string;
  lastSeenAt?: number;
  info?: DeviceInfo;
  tree?: DeviceTree;
}

export type Frame =
  | { type: "hello"; apiVersion: typeof API_VERSION; serverTime: number; scope: StreamScope }
  | { type: "fault"; error: { code: ErrorCode; message: string } }
  // device scope
  | { type: "tree"; tree: DeviceTree }
  | { type: "activity"; items: Activity[] }
  // session scope
  | { type: "session"; agents: AgentSummary[]; tasks: TaskNode[]; usage: UsageTotals }
  | { type: "agents"; agents: AgentSummary[] }
  | { type: "tasks"; tasks: TaskNode[] }
  | { type: "usage"; usage: UsageTotals }
  // agent scope
  | { type: "snapshot"; snapshot: WireSnapshotEvent; inbox: InboxItem[] }
  | { type: "batch"; events: readonly WireAgentEvent[] }
  | { type: "inbox"; items: InboxItem[] }
  // any scope that asked for documents
  | { type: "doc"; kind: string; value: unknown; revision?: number }
  // hub mux only
  | { type: "network"; devices: NetworkDevice[] }
  | { type: "disconnected"; reason: string };

/** One frame of the hub's multiplexed browser stream. */
export interface MuxFrame {
  sub: string;
  frame: Frame | { type: "stream"; streamId: string };
}
