<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Brain, FolderKanban, Plus, RefreshCw, Send, ShieldCheck, Trash2, UserPlus, X } from "lucide-vue-next";
import type { PlatformObservabilitySummary, ProjectAgentBlueprint, ProjectApproval, ProjectArtifact, ProjectAutonomyMode, ProjectEvent, ProjectHandoff, ProjectMember, ProjectMemory, ProjectSummary, ProjectTask, ProjectTeamPlan, ProjectTemplate, ProjectToolCall, ProjectUsageSummary, ProjectWorktree } from "@sdk/api";
import { hub, message, type T3EnvironmentsResult, type T3EnvironmentLink } from "../client/hub";
import { network, notify, select, selected } from "../client/store";

const emit = defineEmits<{ close: [] }>();
const projects = ref<ProjectSummary[]>([]);
const activeId = ref("");
const loading = ref(false);
const error = ref("");
const creating = ref(false);
const name = ref("");
const description = ref("");
const projectTemplates = ref<ProjectTemplate[]>([]);
const projectTemplateId = ref("blank");
const teamPlan = ref<ProjectTeamPlan>();
const role = ref("worker");
const targetId = ref("");
const task = ref("");
const sending = ref(false);
const tasks = ref<ProjectTask[]>([]);
const tasksLoading = ref(false);
const memories = ref<ProjectMemory[]>([]);
const memoryKey = ref("");
const memoryValue = ref("");
const memoryVersion = ref<number>();
const memoryScopeMemberId = ref("");
const savingMemory = ref(false);
const approvals = ref<ProjectApproval[]>([]);
const events = ref<ProjectEvent[]>([]);
const toolCalls = ref<ProjectToolCall[]>([]);
const toolEvidenceKind = ref<"" | ProjectToolCall["evidenceKind"]>("");
const artifacts = ref<ProjectArtifact[]>([]);
const artifactName = ref("");
const artifactContent = ref("");
const artifactHandoff = ref(false);
const publishingArtifact = ref(false);
const environmentWorkspace = ref("");
const scanningEnvironment = ref(false);
const binaryFile = ref<File>();
const binaryHandoff = ref(false);
const uploadingBinary = ref(false);
const usageSummary = ref<ProjectUsageSummary>();
const handoffs = ref<ProjectHandoff[]>([]);
const handoffWorkspace = ref("");
const creatingHandoff = ref(false);
const validatingHandoff = ref("");
const checkingHandoff = ref("");
const checkingImportedBaseline = ref(false);
type CodexModelOption = {
  id: string;
  displayName: string;
  inputModalities: string[];
  capabilities: {
    textInput: "supported" | "unsupported" | "unknown";
    imageInput: "supported" | "unsupported" | "unknown";
    reasoning: "supported" | "unsupported" | "unknown";
    dynamicTools: "supported" | "unsupported" | "unknown";
  };
};
const codexModels = ref<CodexModelOption[]>([]);
const codexModel = ref("gpt-5.6-sol");
const codexCwd = ref("D:\\三喜\\Agent项目");
const addingCodex = ref(false);
const codexTemporary = ref(true);
const codexAllowFallback = ref(false);
const codexFallbackModels = ref<string[]>([]);
const codexPermissionProfile = ref<"ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE">("ROLE_DEFAULT");
const codexEnvironmentId = ref("");
const bindingEnvironmentId = ref("");
const t3Environments = ref<T3EnvironmentsResult>();
const t3EnvironmentError = ref("");
const backupItems = ref<Array<{ name: string; path: string; bytes: number; sha256: string; createdAt: number; artifactCount: number; artifactBytes: number; filesPath?: string }>>([]);
const backupDirectory = ref("");
const backingUp = ref(false);
const platformSummary = ref<PlatformObservabilitySummary>();
const purgingArtifacts = ref(false);
const handoffInbox = ref("");
const inboxBundleName = ref("");
const importProjectId = ref("");
const importingHandoff = ref(false);
const sideEffectDialog = ref<HTMLDialogElement>();
const sideEffectTask = ref<ProjectTask>();
const sideEffectNote = ref("");
const resolvingSideEffect = ref(false);
const savingMemberPermission = ref("");
const agentBlueprints = ref<ProjectAgentBlueprint[]>([]);
const bindingBlueprintId = ref("");
const bindingName = ref("");
const bindingRole = ref("");
const bindingPermissionProfile = ref<"ROLE_DEFAULT" | "READ_ONLY" | "WORKSPACE_WRITE">("READ_ONLY");
const bindingCwd = ref("");
const bindingModel = ref("");
const bindingAllowFallback = ref(false);
const bindingFallbackModels = ref<string[]>([]);
const bindingBlueprint = ref(false);
const bindingStatusMessage = ref("");
const worktrees = ref<ProjectWorktree[]>([]);
const worktreeRepositoryRoot = ref("");
const worktreeLabel = ref("");
const worktreeBase = ref("HEAD");
const worktreeBranch = ref("");
const creatingWorktree = ref(false);
const checkingWorktree = ref("");
const worktreeStatusMessage = ref("");
const selectedCodexModel = computed(() => codexModels.value.find((model) => model.id === codexModel.value));
const codexModelHelp = computed(() => {
  const model = selectedCodexModel.value;
  if (!model) return "Loading the models available to the current Codex login.";
  const modalities = model.inputModalities.length ? model.inputModalities.join(" + ") : "modalities not reported";
  if (model.capabilities.dynamicTools === "supported")
    return `${modalities}; Coordinator Dynamic Tools verified by this platform.`;
  return `${modalities}; Coordinator Dynamic Tools are unverified, so choose a non-Coordinator role.`;
});
const fallbackModelOptions = computed(() => codexModels.value.filter((model) => model.id !== codexModel.value));
const remoteEnvironments = computed(() => t3Environments.value?.links ?? []);
const environmentReachable = (environment: T3EnvironmentLink) =>
  ["reachable", "online", "connected"].includes(environment.status.toLowerCase());
const t3EnvironmentHelp = computed(() => {
  if (t3EnvironmentError.value) return `Remote environments unavailable: ${t3EnvironmentError.value} Local execution remains available.`;
  if (!t3Environments.value) return "Checking T3 linked environments. Local execution remains available.";
  if (!t3Environments.value.linksEnabled) return "T3 Linked Environments is not enabled, so Agents currently run on this computer.";
  const reachable = remoteEnvironments.value.filter(environmentReachable).length;
  return `${reachable} remote environment${reachable === 1 ? "" : "s"} currently reachable. Offline environments cannot be selected.`;
});
const environmentName = (environmentId?: string) => {
  if (!environmentId) return "This computer";
  const environment = remoteEnvironments.value.find((item) => item.environmentId === environmentId);
  return environment ? environment.label : `Unavailable environment · ${environmentId}`;
};
const fallbackModelEligible = (model: CodexModelOption) =>
  role.value.toLowerCase() !== "coordinator" || model.capabilities.dynamicTools === "supported";
watch([codexModel, role], () => {
  codexFallbackModels.value = codexFallbackModels.value.filter((id) => {
    const model = codexModels.value.find((item) => item.id === id);
    return model && model.id !== codexModel.value && fallbackModelEligible(model);
  });
});
const selectedAgentBlueprint = computed(() =>
  agentBlueprints.value.find((blueprint) => blueprint.id === bindingBlueprintId.value),
);
const bindingFallbackOptions = computed(() => codexModels.value.filter((model) => model.id !== bindingModel.value));
const bindingFallbackEligible = (model: CodexModelOption) =>
  bindingRole.value.toLowerCase() !== "coordinator" || model.capabilities.dynamicTools === "supported";
const initializeBlueprintBinding = (blueprint?: ProjectAgentBlueprint) => {
  bindingStatusMessage.value = "";
  bindingName.value = blueprint?.name ?? "";
  bindingRole.value = blueprint?.role ?? "worker";
  bindingPermissionProfile.value = "READ_ONLY";
  bindingCwd.value = blueprint?.cwd ?? "";
  bindingModel.value = blueprint?.model && codexModels.value.some((model) => model.id === blueprint.model)
    ? blueprint.model
    : (codexModels.value[0]?.id ?? "");
  bindingFallbackModels.value = (blueprint?.fallbackModels ?? []).filter(
    (id) => id !== bindingModel.value && codexModels.value.some((model) => model.id === id),
  );
  bindingAllowFallback.value = Boolean(blueprint?.allowModelFallback && bindingFallbackModels.value.length);
  bindingEnvironmentId.value = "";
};
watch(bindingBlueprintId, () => initializeBlueprintBinding(selectedAgentBlueprint.value));
watch([bindingModel, bindingRole], () => {
  bindingFallbackModels.value = bindingFallbackModels.value.filter((id) => {
    const model = codexModels.value.find((item) => item.id === id);
    return model && model.id !== bindingModel.value && bindingFallbackEligible(model);
  });
  if (!bindingFallbackModels.value.length) bindingAllowFallback.value = false;
});

const active = computed(() => projects.value.find((project) => project.id === activeId.value));
const currentMember = computed(() => {
  const target = selected.value;
  if (!target) return;
  return active.value?.members.find(
    (member) =>
      member.deviceId === target.deviceId &&
      member.sessionId === target.sessionId &&
      String(member.agentId) === String(target.agentId),
  );
});
const currentAgentName = computed(() => {
  const target = selected.value;
  if (!target) return "";
  const session = network.devices.value
    .find((device) => device.id === target.deviceId)
    ?.tree?.sessions.find((item) => item.id === target.sessionId);
  const agent = session?.agents.find((item) => item.id === target.agentId);
  return agent?.name || `${target.deviceId}:${target.sessionId}:${target.agentId}`;
});

async function load(prefer?: string) {
  loading.value = true;
  error.value = "";
  try {
    projects.value = (await hub.projects()).projects;
    const wanted = prefer ?? activeId.value;
    activeId.value = projects.value.some((project) => project.id === wanted)
      ? wanted
      : (projects.value[0]?.id ?? "");
    if (!active.value?.members.some((member) => member.id === targetId.value))
      targetId.value = active.value?.members[0]?.id ?? "";
    if (!active.value?.members.some((member) => member.id === memoryScopeMemberId.value))
      memoryScopeMemberId.value = "";
    if (!environmentWorkspace.value)
      environmentWorkspace.value = active.value?.members.find((member) => member.cwd)?.cwd ?? "";
    await Promise.all([loadTasks(), loadMemories(), loadApprovals(), loadEvents(), loadToolCalls(), loadArtifacts(), loadUsage(), loadHandoffs(), loadAgentBlueprints(), loadWorktrees(), loadTeamPlan()]);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    loading.value = false;
  }
}

async function loadProjectTemplates() {
  projectTemplates.value = (await hub.projectTemplates()).templates;
  if (!projectTemplates.value.some((item) => item.id === projectTemplateId.value))
    projectTemplateId.value = projectTemplates.value[0]?.id ?? "blank";
}

async function loadTeamPlan() {
  if (!activeId.value) {
    teamPlan.value = undefined;
    return;
  }
  teamPlan.value = await hub.projectTeamPlan(activeId.value);
}

async function loadAgentBlueprints() {
  if (!activeId.value) {
    agentBlueprints.value = [];
    bindingBlueprintId.value = "";
    return;
  }
  agentBlueprints.value = (await hub.projectAgentBlueprints(activeId.value)).blueprints;
  if (!agentBlueprints.value.some((blueprint) => blueprint.id === bindingBlueprintId.value)) {
    bindingBlueprintId.value = agentBlueprints.value.find((blueprint) => blueprint.bindingState === "UNBOUND")?.id
      ?? agentBlueprints.value[0]?.id
      ?? "";
  } else {
    initializeBlueprintBinding(selectedAgentBlueprint.value);
  }
}

async function loadWorktrees() {
  if (!activeId.value) {
    worktrees.value = [];
    return;
  }
  worktrees.value = (await hub.projectWorktrees(activeId.value)).worktrees;
}

async function loadTasks() {
  if (!activeId.value) {
    tasks.value = [];
    return;
  }
  tasksLoading.value = true;
  try {
    tasks.value = (await hub.projectTasks(activeId.value, 50)).tasks;
  } catch (cause) {
    error.value = message(cause);
  } finally {
    tasksLoading.value = false;
  }
}

async function loadMemories() {
  if (!activeId.value) {
    memories.value = [];
    return;
  }
  memories.value = (await hub.projectMemories(activeId.value, "ACTIVE", memoryScopeMemberId.value || undefined)).memories;
}

async function loadApprovals() {
  if (!activeId.value) {
    approvals.value = [];
    return;
  }
  approvals.value = (await hub.projectApprovals(activeId.value)).approvals;
}

async function loadEvents() {
  if (!activeId.value) {
    events.value = [];
    return;
  }
  events.value = (await hub.projectEvents(activeId.value)).events.slice(0, 30);
}

async function loadToolCalls() {
  if (!activeId.value) {
    toolCalls.value = [];
    return;
  }
  toolCalls.value = (await hub.projectToolCalls(activeId.value, {
    ...(toolEvidenceKind.value ? { evidenceKind: toolEvidenceKind.value } : {}),
    limit: 50,
  })).toolCalls;
}

async function loadArtifacts() {
  if (!activeId.value) {
    artifacts.value = [];
    return;
  }
  artifacts.value = (await hub.projectArtifacts(activeId.value)).artifacts;
}

async function loadUsage() {
  if (!activeId.value) {
    usageSummary.value = undefined;
    return;
  }
  usageSummary.value = (await hub.projectUsage(activeId.value, 20)).summary;
}

async function loadHandoffs() {
  if (!activeId.value) {
    handoffs.value = [];
    return;
  }
  handoffs.value = (await hub.projectHandoffs(activeId.value)).handoffs;
}

async function createHandoff() {
  if (!active.value) return;
  creatingHandoff.value = true;
  error.value = "";
  try {
    await hub.createProjectHandoff(active.value.id, handoffWorkspace.value.trim() || undefined);
    await Promise.all([loadHandoffs(), loadEvents()]);
    notify("Versioned handoff bundle created and checksummed.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    creatingHandoff.value = false;
  }
}

async function checkHandoffGit(item: ProjectHandoff) {
  if (!active.value || !handoffWorkspace.value.trim()) return;
  checkingHandoff.value = item.id;
  error.value = "";
  try {
    const result = await hub.checkProjectHandoffGit(active.value.id, item.id, handoffWorkspace.value.trim());
    await loadEvents();
    notify(result.safeToApply
      ? `Git baseline is safe: ${result.status}.`
      : `Git baseline requires attention: ${result.status}.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    checkingHandoff.value = "";
  }
}

async function checkImportedGitBaseline() {
  if (!active.value || !handoffWorkspace.value.trim()) return;
  checkingImportedBaseline.value = true;
  error.value = "";
  try {
    const result = await hub.checkImportedGitBaseline(active.value.id, handoffWorkspace.value.trim());
    await loadEvents();
    notify(result.safeToApply
      ? `Imported Git baseline is safe: ${result.status}.`
      : `Imported Git baseline requires attention: ${result.status}.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    checkingImportedBaseline.value = false;
  }
}

async function validateHandoff(item: ProjectHandoff) {
  if (!active.value) return;
  validatingHandoff.value = item.id;
  error.value = "";
  try {
    const result = await hub.validateProjectHandoff(active.value.id, item.id);
    await loadEvents();
    notify(`Handoff verified: ${result.artifactCount} artifact(s), ${result.verifiedBytes} bytes.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    validatingHandoff.value = "";
  }
}

async function publishArtifact() {
  if (!active.value || !artifactName.value.trim() || !artifactContent.value) return;
  publishingArtifact.value = true;
  error.value = "";
  try {
    await hub.publishProjectArtifact(active.value.id, {
      name: artifactName.value.trim(),
      kind: "document",
      mimeType: "text/plain; charset=utf-8",
      content: artifactContent.value,
      includeInHandoff: artifactHandoff.value,
    });
    artifactName.value = "";
    artifactContent.value = "";
    artifactHandoff.value = false;
    await Promise.all([loadArtifacts(), loadEvents()]);
    notify("Project artifact published with checksum verification.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    publishingArtifact.value = false;
  }
}

async function scanEnvironment() {
  if (!active.value || !environmentWorkspace.value.trim()) return;
  scanningEnvironment.value = true;
  error.value = "";
  try {
    await hub.scanProjectEnvironment(active.value.id, environmentWorkspace.value.trim());
    await Promise.all([loadArtifacts(), loadEvents()]);
    notify("Environment report created and included in future handoff packages.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    scanningEnvironment.value = false;
  }
}

function selectBinaryFile(event: Event) {
  binaryFile.value = (event.target as HTMLInputElement).files?.[0];
}

async function uploadBinaryArtifact() {
  if (!active.value || !binaryFile.value) return;
  uploadingBinary.value = true;
  error.value = "";
  try {
    await hub.uploadProjectArtifact(active.value.id, binaryFile.value, {
      kind: "binary",
      includeInHandoff: binaryHandoff.value,
    });
    binaryFile.value = undefined;
    binaryHandoff.value = false;
    await Promise.all([loadArtifacts(), loadEvents()]);
    notify("Binary artifact streamed, checksummed and published.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    uploadingBinary.value = false;
  }
}

async function expireArtifact(item: ProjectArtifact) {
  if (!active.value) return;
  error.value = "";
  try {
    await hub.expireProjectArtifact(active.value.id, item.id);
    await Promise.all([loadArtifacts(), loadEvents()]);
  } catch (cause) {
    error.value = message(cause);
  }
}

async function loadBackups() {
  const result = await hub.backups();
  backupItems.value = result.backups;
  backupDirectory.value = result.directory;
}

async function loadObservability() {
  platformSummary.value = await hub.observability();
}

async function createBackup() {
  backingUp.value = true;
  error.value = "";
  try {
    await hub.createBackup();
    await loadBackups();
    notify("Consistent SQLite backup created and verified.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    backingUp.value = false;
  }
}

async function purgeExpiredArtifacts() {
  purgingArtifacts.value = true;
  error.value = "";
  try {
    const result = await hub.purgeExpiredArtifacts(30);
    notify(`Purged ${result.purged} expired artifact(s), ${result.bytes} bytes.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    purgingArtifacts.value = false;
  }
}

async function loadHandoffInbox() {
  handoffInbox.value = (await hub.handoffInbox()).directory;
}

async function importHandoff() {
  if (!inboxBundleName.value.trim()) return;
  importingHandoff.value = true;
  error.value = "";
  try {
    const result = await hub.importHandoff(inboxBundleName.value.trim(), importProjectId.value.trim() || undefined);
    inboxBundleName.value = "";
    importProjectId.value = "";
    await load(result.project.id);
    notify(`Handoff imported into ${result.project.name} in supervised mode.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    importingHandoff.value = false;
  }
}

async function selectProject(id: string) {
  activeId.value = id;
  targetId.value = active.value?.members[0]?.id ?? "";
  memoryScopeMemberId.value = "";
  environmentWorkspace.value = active.value?.members.find((member) => member.cwd)?.cwd ?? "";
  clearMemoryForm();
  await Promise.all([loadTasks(), loadMemories(), loadApprovals(), loadEvents(), loadToolCalls(), loadArtifacts(), loadUsage(), loadHandoffs()]);
}

function memoryText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function eventText(value: unknown) {
  const text = memoryText(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n[display truncated]` : text;
}

function taskError(value: unknown) {
  if (!value || typeof value !== "object") return value ? String(value) : "";
  const error = value as { code?: unknown; message?: unknown };
  return [error.code, error.message].filter(Boolean).join(": ") || JSON.stringify(value);
}

function clearMemoryForm() {
  memoryKey.value = "";
  memoryValue.value = "";
  memoryVersion.value = undefined;
}

async function changeMemoryScope() {
  clearMemoryForm();
  await loadMemories();
}

function editMemory(item: ProjectMemory) {
  memoryScopeMemberId.value = item.memberId ?? "";
  memoryKey.value = item.key;
  memoryValue.value = memoryText(item.value);
  memoryVersion.value = item.version;
}

async function saveMemory() {
  if (!active.value || !memoryKey.value.trim() || !memoryValue.value.trim()) return;
  savingMemory.value = true;
  error.value = "";
  try {
    let value: unknown = memoryValue.value;
    try {
      value = JSON.parse(memoryValue.value);
    } catch {
      // Plain text is a valid project fact too.
    }
    await hub.putProjectMemory(active.value.id, {
      key: memoryKey.value.trim(),
      value,
      sourceType: "user",
      ...(memoryScopeMemberId.value ? { memberId: memoryScopeMemberId.value } : {}),
      ...(memoryVersion.value === undefined ? {} : { expectedVersion: memoryVersion.value }),
    });
    clearMemoryForm();
    await loadMemories();
    notify("Project memory saved and will be included in new tasks.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    savingMemory.value = false;
  }
}

async function expireMemory(item: ProjectMemory) {
  if (!active.value) return;
  error.value = "";
  try {
    await hub.expireProjectMemory(active.value.id, item.id, item.version);
    if (memoryKey.value === item.key) clearMemoryForm();
    await loadMemories();
  } catch (cause) {
    error.value = message(cause);
  }
}

async function approvalAction(item: ProjectApproval, action: "APPROVED" | "DENIED" | "REVOKED") {
  if (!active.value) return;
  error.value = "";
  try {
    if (action === "REVOKED")
      await hub.revokeProjectApproval(active.value.id, item.id, "user:local");
    else
      await hub.decideProjectApproval(active.value.id, item.id, {
        decision: action,
        decidedBy: "user:local",
      });
    await loadApprovals();
  } catch (cause) {
    error.value = message(cause);
  }
}

async function createProject() {
  if (!name.value.trim()) return;
  creating.value = true;
  error.value = "";
  try {
    const project = await hub.createProject({ name: name.value, description: description.value, templateId: projectTemplateId.value });
    name.value = "";
    description.value = "";
    await load(project.id);
    notify(`Project “${project.name}” created.`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    creating.value = false;
  }
}

async function setAutonomyMode(mode: string) {
  if (!active.value) return;
  if (!["SUPERVISED", "AUTHORIZED_AUTONOMY", "RESTRICTED_UNATTENDED"].includes(mode)) return;
  error.value = "";
  try {
    await hub.updateProject(active.value.id, { autonomyMode: mode as ProjectAutonomyMode });
    await load(active.value.id);
    notify("Project autonomy mode updated. Existing safety policies remain in force.");
  } catch (cause) {
    error.value = message(cause);
  }
}

async function setTokenLimit(value: string) {
  if (!active.value) return;
  const trimmed = value.trim();
  const limit = trimmed ? Number(trimmed) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    error.value = "Rolling 24h token limit must be a positive integer.";
    return;
  }
  error.value = "";
  try {
    await hub.updateProject(active.value.id, { tokenLimit24h: limit });
    await load(active.value.id);
    notify(limit === null ? "Project token budget removed." : "Project rolling token budget updated.");
  } catch (cause) {
    error.value = message(cause);
  }
}

async function setTaskTokenLimit(value: string) {
  if (!active.value) return;
  const trimmed = value.trim();
  const limit = trimmed ? Number(trimmed) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    error.value = "Per-task token limit must be a positive integer.";
    return;
  }
  error.value = "";
  try {
    await hub.updateProject(active.value.id, { maxTaskTokens: limit });
    await load(active.value.id);
    notify(limit === null ? "Per-task token limit removed." : "Per-task token limit updated.");
  } catch (cause) {
    error.value = message(cause);
  }
}

type CoordinationLimitKey = "maxCoordinationDepth" | "maxDelegatedTasksPerTurn" | "maxActiveTasks" | "maxConcurrentTasks";

async function setCoordinationLimit(key: CoordinationLimitKey, value: string, label: string, max = 10_000) {
  if (!active.value) return;
  const trimmed = value.trim();
  const limit = trimmed ? Number(trimmed) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > max)) {
    error.value = `${label} must be an integer from 1 to ${max}.`;
    return;
  }
  error.value = "";
  try {
    await hub.updateProject(active.value.id, { [key]: limit });
    await load(active.value.id);
    notify(limit === null ? `${label} restored to the platform default.` : `${label} updated.`);
  } catch (cause) {
    error.value = message(cause);
  }
}

async function addCurrent() {
  const target = selected.value;
  if (!target || !active.value) return;
  error.value = "";
  try {
    await hub.addProjectMember(active.value.id, {
      deviceId: target.deviceId,
      sessionId: target.sessionId,
      agentId: target.agentId,
      name: currentAgentName.value,
      role: role.value,
    });
    await load(active.value.id);
    notify("Agent added to the project boundary.");
  } catch (cause) {
    error.value = message(cause);
  }
}

async function loadCodexModels() {
  try {
    const result = await hub.codexModels();
    codexModels.value = result.data ?? [];
    if (!codexModels.value.some((model) => model.id === codexModel.value) && codexModels.value[0])
      codexModel.value = codexModels.value[0].id;
    codexFallbackModels.value = codexFallbackModels.value.filter(
      (id) => id !== codexModel.value && codexModels.value.some((model) => model.id === id),
    );
    if (selectedAgentBlueprint.value) initializeBlueprintBinding(selectedAgentBlueprint.value);
  } catch (cause) {
    error.value = message(cause);
  }
}

async function loadT3Environments() {
  t3EnvironmentError.value = "";
  try {
    t3Environments.value = await hub.t3Environments();
  } catch (cause) {
    t3Environments.value = undefined;
    t3EnvironmentError.value = message(cause);
  }
}

async function addLocalCodex() {
  if (!active.value || !codexCwd.value.trim()) return;
  if (!selectedCodexModel.value) {
    error.value = "Select a model available to the current Codex login.";
    return;
  }
  if (role.value.toLowerCase() === "coordinator" && selectedCodexModel.value.capabilities.dynamicTools !== "supported") {
    error.value = `${selectedCodexModel.value.displayName} has not been verified for Coordinator Dynamic Tools.`;
    return;
  }
  const selectedFallbacks = new Set(codexFallbackModels.value);
  const eligibleFallbacks = fallbackModelOptions.value
    .filter((model) => selectedFallbacks.has(model.id) && fallbackModelEligible(model))
    .map((model) => model.id);
  if (codexAllowFallback.value && !eligibleFallbacks.length) {
    error.value = "Select at least one eligible fallback model, or disable automatic fallback.";
    return;
  }
  addingCodex.value = true;
  error.value = "";
  try {
    await hub.addProjectMember(active.value.id, {
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "new",
      executor: "codex",
      model: codexModel.value,
      allowModelFallback: codexAllowFallback.value,
      fallbackModels: eligibleFallbacks,
      cwd: codexCwd.value.trim(),
      ...(codexEnvironmentId.value ? { t3EnvironmentId: codexEnvironmentId.value } : {}),
      role: role.value,
      name: `Codex · ${role.value}`,
      temporary: codexTemporary.value,
      permissionProfile: codexPermissionProfile.value,
    });
    await load(active.value.id);
    notify("Local Codex agent added using the current signed-in account.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    addingCodex.value = false;
  }
}

async function bindImportedAgentBlueprint() {
  const project = active.value;
  const blueprint = selectedAgentBlueprint.value;
  if (!project || !blueprint || blueprint.bindingState !== "UNBOUND") return;
  if (!bindingName.value.trim() || !bindingRole.value.trim()) {
    error.value = "A target Agent name and role are required.";
    return;
  }
  const target = selected.value;
  const body: Parameters<typeof hub.bindProjectAgentBlueprint>[2] = {
    name: bindingName.value.trim(),
    role: bindingRole.value.trim(),
    permissionProfile: bindingPermissionProfile.value,
  };
  if (blueprint.executor === "codex") {
    const model = codexModels.value.find((item) => item.id === bindingModel.value);
    if (!model || !bindingCwd.value.trim()) {
      error.value = "Select an available target model and working directory.";
      return;
    }
    if (bindingRole.value.toLowerCase() === "coordinator" && model.capabilities.dynamicTools !== "supported") {
      error.value = `${model.displayName} has not been verified for Coordinator Dynamic Tools.`;
      return;
    }
    const requestedFallbacks = new Set(bindingFallbackModels.value);
    const fallbackModels = bindingFallbackOptions.value
      .filter((item) => requestedFallbacks.has(item.id) && bindingFallbackEligible(item))
      .map((item) => item.id);
    if (bindingAllowFallback.value && !fallbackModels.length) {
      error.value = "Select at least one eligible fallback model, or disable automatic fallback.";
      return;
    }
    Object.assign(body, {
      model: model.id,
      cwd: bindingCwd.value.trim(),
      allowModelFallback: bindingAllowFallback.value,
      fallbackModels,
      ...(bindingEnvironmentId.value ? { t3EnvironmentId: bindingEnvironmentId.value } : {}),
    });
  } else {
    if (!target) {
      error.value = "Select a target Pi Agent from the network tree before binding this blueprint.";
      return;
    }
    Object.assign(body, {
      deviceId: target.deviceId,
      sessionId: target.sessionId,
      agentId: target.agentId,
    });
  }
  bindingBlueprint.value = true;
  bindingStatusMessage.value = "";
  error.value = "";
  try {
    const result = await hub.bindProjectAgentBlueprint(project.id, blueprint.id, body);
    await load(project.id);
    bindingStatusMessage.value = `${blueprint.name} is now bound to ${result.member.name} with ${result.member.permissionProfile}.`;
    notify("Imported Agent blueprint bound to this device.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    bindingBlueprint.value = false;
  }
}

async function createManagedWorktree() {
  if (!active.value) return;
  creatingWorktree.value = true;
  worktreeStatusMessage.value = "";
  error.value = "";
  try {
    const created = await hub.createProjectWorktree(active.value.id, {
      repositoryRoot: worktreeRepositoryRoot.value.trim(),
      label: worktreeLabel.value.trim(),
      ...(worktreeBase.value.trim() ? { base: worktreeBase.value.trim() } : {}),
      ...(worktreeBranch.value.trim() ? { branch: worktreeBranch.value.trim() } : {}),
    });
    await loadWorktrees();
    worktreeLabel.value = "";
    worktreeBranch.value = "";
    codexCwd.value = created.path;
    bindingCwd.value = created.path;
    worktreeStatusMessage.value = `${created.label} is ready. Its path is selected for the next Local Codex Agent.`;
    notify("Managed Git worktree created on an isolated branch.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    creatingWorktree.value = false;
  }
}

async function checkManagedWorktree(worktree: ProjectWorktree) {
  if (!active.value) return;
  checkingWorktree.value = worktree.id;
  error.value = "";
  try {
    const checked = await hub.checkProjectWorktree(active.value.id, worktree.id);
    await loadWorktrees();
    worktreeStatusMessage.value = checked.dirty
      ? `${checked.label} has uncommitted changes.`
      : `${checked.label} is clean at ${checked.headRevision?.slice(0, 12)}.`;
  } catch (cause) {
    error.value = message(cause);
  } finally {
    checkingWorktree.value = "";
  }
}

function useManagedWorktree(worktree: ProjectWorktree) {
  if (worktree.state !== "ACTIVE") return;
  codexCwd.value = worktree.path;
  bindingCwd.value = worktree.path;
  worktreeStatusMessage.value = `${worktree.label} is selected for new or rebound Local Codex Agents.`;
}

async function removeMember(member: ProjectMember) {
  if (!active.value) return;
  error.value = "";
  try {
    if (member.temporary) await hub.archiveProjectMember(active.value.id, member.id);
    else await hub.removeProjectMember(active.value.id, member.id);
    await load(active.value.id);
  } catch (cause) {
    error.value = message(cause);
  }
}

function openMember(member: ProjectMember) {
  if (member.executor === "codex") return;
  select({ deviceId: member.deviceId, sessionId: member.sessionId, agentId: Number(member.agentId) });
  emit("close");
}

async function sendTask() {
  if (!active.value || !targetId.value || !task.value.trim()) return;
  sending.value = true;
  error.value = "";
  try {
    const content = task.value.trim();
    const queued = await hub.enqueueProjectTask(active.value.id, {
      title: content.length > 80 ? `${content.slice(0, 77)}…` : content,
      input: {
        kind: "agent.message",
        memberId: targetId.value,
        content,
        whenBusy: "followUp",
        waitMs: 300_000,
      },
    });
    task.value = "";
    await loadTasks();
    notify(`Project task queued: ${queued.id}`);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    sending.value = false;
  }
}

async function taskAction(item: ProjectTask, action: "pause" | "resume" | "cancel") {
  if (!active.value) return;
  error.value = "";
  try {
    if (action === "pause") await hub.pauseProjectTask(active.value.id, item.id);
    else if (action === "resume") await hub.resumeProjectTask(active.value.id, item.id);
    else await hub.cancelProjectTask(active.value.id, item.id);
    await loadTasks();
  } catch (cause) {
    error.value = message(cause);
  }
}

async function saveMemberPermission(member: ProjectMember) {
  if (!active.value) return;
  savingMemberPermission.value = member.id;
  error.value = "";
  try {
    await hub.updateProjectMember(active.value.id, member.id, {
      permissionProfile: member.permissionProfile,
      cwd: member.cwd,
      t3EnvironmentId: member.t3EnvironmentId || null,
    });
    await load(active.value.id);
    notify(`Permission saved for ${member.name}.`);
  } catch (cause) {
    error.value = message(cause);
    await load(active.value.id).catch(() => undefined);
  } finally {
    savingMemberPermission.value = "";
  }
}

function isUnknownSideEffect(item: ProjectTask) {
  return item.status === "PAUSED" && (item.error as { code?: unknown } | undefined)?.code === "UNKNOWN_SIDE_EFFECT";
}

function openSideEffectResolution(item: ProjectTask) {
  sideEffectTask.value = item;
  sideEffectNote.value = "";
  sideEffectDialog.value?.showModal();
}

async function resolveSideEffect(resolution: "RETRY" | "MARK_COMPLETED") {
  if (!active.value || !sideEffectTask.value || !sideEffectNote.value.trim()) return;
  resolvingSideEffect.value = true;
  error.value = "";
  try {
    await hub.resolveUnknownSideEffect(active.value.id, sideEffectTask.value.id, {
      resolution,
      actor: "local-user",
      note: sideEffectNote.value.trim(),
    });
    sideEffectDialog.value?.close();
    await loadTasks();
    notify(resolution === "RETRY" ? "Task explicitly cleared for retry." : "External effect confirmed and task completed.");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    resolvingSideEffect.value = false;
  }
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void loadProjectTemplates();
  void load();
  void loadCodexModels();
  void loadT3Environments();
  void loadBackups();
  void loadObservability();
  void loadHandoffInbox();
  refreshTimer = setInterval(() => void Promise.all([loadTasks(), loadApprovals(), loadEvents(), loadToolCalls(), loadUsage(), loadTeamPlan(), loadObservability()]), 2_000);
});
onBeforeUnmount(() => clearInterval(refreshTimer));
</script>

<template>
  <div class="modal-backdrop project-backdrop" @click.self="emit('close')">
    <section class="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
      <header>
        <div>
          <span class="eyebrow">CROSS-DEVICE WORKSPACE</span>
          <h2 id="project-title"><FolderKanban :size="19" /> Projects</h2>
        </div>
        <button class="icon-button" aria-label="Close projects" @click="emit('close')"><X :size="18" /></button>
      </header>

      <p v-if="error" class="project-error" role="alert">{{ error }}</p>
      <div class="project-layout">
        <aside class="project-list">
          <div class="project-list-head">
            <strong>Project boundaries</strong>
            <button class="icon-button" title="Refresh" @click="load()"><RefreshCw :size="16" /></button>
          </div>
          <button
            v-for="project in projects"
            :key="project.id"
            class="project-row"
            :class="{ active: project.id === activeId }"
            @click="selectProject(project.id)"
          >
            <strong>{{ project.name }}</strong>
            <span>{{ project.members.length }} agents</span>
          </button>
          <p v-if="!projects.length && !loading" class="hint">No projects yet.</p>
          <section v-if="platformSummary" class="platform-summary">
            <strong>Platform status</strong>
            <span>{{ platformSummary.projects }} projects · {{ platformSummary.agents.active }} active agents ({{ platformSummary.agents.temporary }} temporary)</span>
            <span>{{ platformSummary.tasks.RUNNING }} running · {{ platformSummary.tasks.FAILED }} failed · {{ platformSummary.pendingApprovals }} approvals</span>
            <span>{{ platformSummary.artifacts.active }} artifacts / {{ Math.ceil(platformSummary.artifacts.activeBytes / 1024) }} KB · {{ platformSummary.worktrees.active }} worktrees ({{ platformSummary.worktrees.failed }} failed)</span>
            <span>{{ platformSummary.tokenUsage24h.toLocaleString() }} tokens/24h</span>
          </section>
          <section class="backup-panel">
            <strong>Platform backups</strong>
            <small v-if="backupItems[0]">Latest: {{ new Date(backupItems[0].createdAt).toLocaleString() }} · DB {{ Math.ceil(backupItems[0].bytes / 1024) }} KB · {{ backupItems[0].artifactCount }} artifacts / {{ Math.ceil(backupItems[0].artifactBytes / 1024) }} KB</small>
            <small v-else>No backup created yet.</small>
            <button class="secondary small" :disabled="backingUp" @click="createBackup">{{ backingUp ? "Backing up…" : "Back up now" }}</button>
            <button class="secondary small" :disabled="purgingArtifacts" @click="purgeExpiredArtifacts">{{ purgingArtifacts ? "Purging…" : "Purge expired (30d)" }}</button>
            <code v-if="backupDirectory" :title="backupDirectory">{{ backupDirectory }}</code>
          </section>
          <form class="handoff-import" @submit.prevent="importHandoff">
            <strong>Import handoff</strong>
            <small>Copy one bundle directory into this guarded inbox, then enter its folder name.</small>
            <code v-if="handoffInbox" :title="handoffInbox">{{ handoffInbox }}</code>
            <input v-model="inboxBundleName" maxlength="160" placeholder="Inbox folder name" />
            <input v-model="importProjectId" maxlength="64" placeholder="New project ID (optional)" />
            <button class="secondary small" :disabled="importingHandoff || !inboxBundleName.trim()">{{ importingHandoff ? "Importing…" : "Verify and import" }}</button>
          </form>
          <form class="project-create" aria-labelledby="new-project-title" @submit.prevent="createProject">
            <strong id="new-project-title">New project</strong>
            <label for="new-project-name">Project name
              <input id="new-project-name" v-model="name" name="name" maxlength="120" required />
            </label>
            <label for="new-project-template">Project template
              <select id="new-project-template" v-model="projectTemplateId" name="templateId" aria-describedby="new-project-template-help" required>
                <option v-for="template in projectTemplates" :key="template.id" :value="template.id">{{ template.name }}</option>
              </select>
            </label>
            <small id="new-project-template-help">{{ projectTemplates.find((item) => item.id === projectTemplateId)?.description || "Conservative project defaults." }}</small>
            <small v-if="projectTemplates.find((item) => item.id === projectTemplateId)?.suggestedRoles.length">
              Suggested team: {{ projectTemplates.find((item) => item.id === projectTemplateId)?.suggestedRoles.map((item) => item.role).join(", ") }}. Agents are provisioned only after choosing their model and isolated workspace.
            </small>
            <label for="new-project-description">Purpose and boundaries
              <textarea id="new-project-description" v-model="description" name="description" rows="2" maxlength="2000" />
            </label>
            <button type="submit" class="primary small" :disabled="creating"><Plus :size="16" />{{ creating ? "Creating…" : "Create project" }}</button>
          </form>
        </aside>

        <div v-if="active" class="project-detail">
          <div class="project-heading">
            <div><h3>{{ active.name }}</h3><p>{{ active.description || "No description" }}</p></div>
            <div class="project-mode">
              <code>{{ active.id }}</code>
              <select :value="active.autonomyMode" aria-label="Project autonomy mode" @change="setAutonomyMode(($event.target as HTMLSelectElement).value)">
                <option value="SUPERVISED">Supervised</option>
                <option value="AUTHORIZED_AUTONOMY">Authorized autonomy</option>
                <option value="RESTRICTED_UNATTENDED">Restricted unattended</option>
              </select>
              <label class="budget-field">24h token limit<input :value="active.tokenLimit24h ?? ''" type="number" min="1" step="1" placeholder="Unlimited" @change="setTokenLimit(($event.target as HTMLInputElement).value)" /></label>
              <label class="budget-field">Per-task token limit<input :value="active.maxTaskTokens ?? ''" name="maxTaskTokens" type="number" min="1" step="1" placeholder="Unlimited" @change="setTaskTokenLimit(($event.target as HTMLInputElement).value)" /></label>
              <label class="budget-field">Coordination depth<input :value="active.maxCoordinationDepth ?? ''" name="maxCoordinationDepth" type="number" min="1" max="10000" step="1" placeholder="Platform default (8)" @change="setCoordinationLimit('maxCoordinationDepth', ($event.target as HTMLInputElement).value, 'Coordination depth')" /></label>
              <label class="budget-field">Tasks per Coordinator turn<input :value="active.maxDelegatedTasksPerTurn ?? ''" name="maxDelegatedTasksPerTurn" type="number" min="1" max="10000" step="1" placeholder="Platform default (12)" @change="setCoordinationLimit('maxDelegatedTasksPerTurn', ($event.target as HTMLInputElement).value, 'Tasks per Coordinator turn')" /></label>
              <label class="budget-field">Active project tasks<input :value="active.maxActiveTasks ?? ''" name="maxActiveTasks" type="number" min="1" max="10000" step="1" placeholder="Platform default (64)" @change="setCoordinationLimit('maxActiveTasks', ($event.target as HTMLInputElement).value, 'Active project tasks')" /></label>
              <label class="budget-field">Concurrent project tasks<input :value="active.maxConcurrentTasks ?? ''" name="maxConcurrentTasks" type="number" min="1" max="1000" step="1" placeholder="Platform default (2)" @change="setCoordinationLimit('maxConcurrentTasks', ($event.target as HTMLInputElement).value, 'Concurrent project tasks', 1000)" /></label>
              <small>Mode never bypasses mandatory tool policy.</small>
            </div>
          </div>

          <section class="project-section">
            <div class="project-section-title"><strong>Managed Git worktrees</strong><span>Give parallel Codex Agents separate branches and directories. The platform never removes a dirty worktree.</span></div>
            <div class="worktree-list">
              <article v-for="worktree in worktrees" :key="worktree.id" class="worktree-card">
                <div>
                  <strong>{{ worktree.label }}</strong>
                  <span>{{ worktree.state }} · {{ worktree.branch }}</span>
                  <code>{{ worktree.path }}</code>
                  <small v-if="worktree.state === 'ACTIVE'">{{ worktree.dirty ? 'Uncommitted changes' : 'Clean' }} · {{ worktree.baseIsAncestor === false ? 'base is not an ancestor' : `HEAD ${worktree.headRevision?.slice(0, 12) ?? 'unknown'}` }}</small>
                  <small v-if="worktree.error">{{ worktree.error }}</small>
                </div>
                <div class="worktree-actions">
                  <button type="button" class="secondary small" :disabled="worktree.state !== 'ACTIVE'" @click="useManagedWorktree(worktree)">Use for Codex</button>
                  <button type="button" class="secondary small" :disabled="checkingWorktree === worktree.id || worktree.state !== 'ACTIVE'" @click="checkManagedWorktree(worktree)">{{ checkingWorktree === worktree.id ? 'Checking…' : 'Check' }}</button>
                </div>
              </article>
              <p v-if="!worktrees.length" class="hint">No managed worktrees yet.</p>
            </div>
            <form class="worktree-create" aria-labelledby="worktree-create-title" @submit.prevent="createManagedWorktree">
              <strong id="worktree-create-title">Create isolated worktree</strong>
              <label for="worktree-repository">Repository root
                <input id="worktree-repository" v-model="worktreeRepositoryRoot" name="repositoryRoot" aria-describedby="worktree-repository-help" autocapitalize="none" autocorrect="off" spellcheck="false" required />
                <small id="worktree-repository-help">Must be the Git top-level directory. The new checkout is placed under the platform-managed worktree directory.</small>
              </label>
              <div class="worktree-fields">
                <label for="worktree-label">Label<input id="worktree-label" v-model="worktreeLabel" name="label" maxlength="120" required /></label>
                <label for="worktree-base">Base revision<input id="worktree-base" v-model="worktreeBase" name="base" maxlength="240" autocapitalize="none" autocorrect="off" spellcheck="false" required /></label>
                <label for="worktree-branch">Branch override (optional)<input id="worktree-branch" v-model="worktreeBranch" name="branch" maxlength="240" aria-describedby="worktree-branch-help" autocapitalize="none" autocorrect="off" spellcheck="false" /></label>
              </div>
              <small id="worktree-branch-help">Leave the branch empty for a unique `dpi/project/label-id` branch. Committed branches are retained after checkout removal.</small>
              <button type="submit" class="secondary worktree-submit" :disabled="creatingWorktree">{{ creatingWorktree ? "Creating…" : "Create managed worktree" }}</button>
              <p class="worktree-status" role="status" aria-live="polite">{{ worktreeStatusMessage }}</p>
            </form>
          </section>

          <section v-if="teamPlan?.roles.length" class="project-section">
            <div class="project-section-title">
              <strong>Template team plan</strong>
              <span>Frozen from {{ teamPlan.templateId || "the project template" }}. Permission mismatches require an explicit member update.</span>
            </div>
            <div class="team-plan-list" aria-live="polite">
              <article v-for="planned in teamPlan.roles" :key="planned.role" class="team-plan-card">
                <header>
                  <strong>{{ planned.role }}</strong>
                  <span>{{ planned.status === "BOUND" ? "Bound" : "Unbound" }}</span>
                </header>
                <dl>
                  <div><dt>Planned permission</dt><dd>{{ planned.permissionProfile }}</dd></div>
                  <div><dt>Permission check</dt><dd>{{ planned.status === "UNBOUND" ? "Waiting for Agent" : (planned.permissionAligned ? "Aligned" : "Mismatch") }}</dd></div>
                </dl>
                <ul v-if="planned.members.length">
                  <li v-for="member in planned.members" :key="member.id">
                    <strong>{{ member.name }}</strong>
                    <span>{{ member.executor }} · {{ member.permissionProfile }}</span>
                    <code v-if="member.workspace">{{ member.workspace }}</code>
                  </li>
                </ul>
                <p v-else>No active Agent currently fills this role.</p>
              </article>
            </div>
          </section>

          <section class="project-section">
            <div class="project-section-title"><strong>Agents in this project</strong><span>Only these addresses can receive project messages.</span></div>
            <div class="member-list">
              <article v-for="member in active.members" :key="member.id" class="member-card">
                <button class="member-open" :disabled="member.executor === 'codex'" @click="openMember(member)">
                  <strong>{{ member.name }}</strong>
                  <span>{{ member.role }} · {{ member.executor === 'codex' ? `Codex · ${member.permissionProfile} · ${environmentName(member.t3EnvironmentId)}` : member.deviceId }}{{ member.temporary ? ' · temporary' : '' }}</span>
                  <small v-if="member.executor === 'codex'">{{ member.model }} · {{ member.cwd }}</small>
                  <small v-if="member.executor === 'codex' && member.allowModelFallback">Fallback: {{ member.fallbackModels.join(' → ') }}</small>
                  <small v-if="member.executor !== 'codex'">{{ member.sessionId }} / {{ member.agentId }}</small>
                </button>
                <div v-if="member.executor === 'codex'" class="member-settings">
                  <label class="member-permission" :for="`member-permission-${member.id}`">Permission
                    <select :id="`member-permission-${member.id}`" v-model="member.permissionProfile" name="permissionProfile">
                      <option value="ROLE_DEFAULT">Role default</option><option value="READ_ONLY">Read only</option><option value="WORKSPACE_WRITE">Workspace write</option>
                    </select>
                  </label>
                  <label class="member-permission" :for="`member-environment-${member.id}`">Execution environment
                    <select :id="`member-environment-${member.id}`" v-model="member.t3EnvironmentId" name="t3EnvironmentId" :aria-describedby="`member-environment-help-${member.id}`">
                      <option value="">This computer</option>
                      <option v-if="member.t3EnvironmentId && !remoteEnvironments.some((item) => item.environmentId === member.t3EnvironmentId)" :value="member.t3EnvironmentId" disabled>{{ environmentName(member.t3EnvironmentId) }}</option>
                      <option v-for="environment in remoteEnvironments" :key="environment.environmentId" :value="environment.environmentId" :disabled="!environmentReachable(environment)">{{ environment.label }} · {{ environment.status }} · {{ environment.access }}</option>
                    </select>
                  </label>
                  <label class="member-permission member-workspace" :for="`member-cwd-${member.id}`">Working directory
                    <input :id="`member-cwd-${member.id}`" v-model="member.cwd" name="cwd" autocapitalize="none" autocorrect="off" spellcheck="false" required />
                  </label>
                  <small :id="`member-environment-help-${member.id}`" class="environment-help">{{ t3EnvironmentHelp }}</small>
                </div>
                <button v-if="member.executor === 'codex'" type="button" class="secondary small" :disabled="savingMemberPermission === member.id" @click="saveMemberPermission(member)">{{ savingMemberPermission === member.id ? "Saving…" : "Save" }}</button>
                <button class="icon-button" :title="member.temporary ? 'Archive temporary agent' : 'Remove from project'" @click="removeMember(member)"><Trash2 :size="15" /></button>
              </article>
              <p v-if="!active.members.length" class="hint">Add a selected agent from the network tree.</p>
            </div>
            <form v-if="agentBlueprints.length" class="blueprint-binding" aria-labelledby="blueprint-binding-title" @submit.prevent="bindImportedAgentBlueprint">
              <div class="project-section-title">
                <strong id="blueprint-binding-title">Imported Agent blueprints</strong>
                <span>Source configuration is advisory. Choose this computer's model, directory and permission before creating an Agent.</span>
              </div>
              <label class="blueprint-field" for="blueprint-select">Source Agent
                <select id="blueprint-select" v-model="bindingBlueprintId" name="blueprintId" required>
                  <option v-for="blueprint in agentBlueprints" :key="blueprint.id" :value="blueprint.id">
                    {{ blueprint.name }} · {{ blueprint.executor }} · {{ blueprint.bindingState === 'BOUND' ? 'bound' : blueprint.bindingState === 'SOURCE_TEMPORARY' ? 'source temporary' : 'ready' }}
                  </option>
                </select>
              </label>
              <template v-if="selectedAgentBlueprint">
                <p class="blueprint-source">
                  Source: {{ selectedAgentBlueprint.role }} · {{ selectedAgentBlueprint.permissionProfile }}<template v-if="selectedAgentBlueprint.model"> · {{ selectedAgentBlueprint.model }}</template>
                  <template v-if="selectedAgentBlueprint.boundMemberId"> · target {{ selectedAgentBlueprint.boundMemberId }}</template>
                </p>
                <div class="blueprint-grid">
                  <label class="blueprint-field" for="blueprint-name">Target name<input id="blueprint-name" v-model="bindingName" name="name" maxlength="120" required /></label>
                  <label class="blueprint-field" for="blueprint-role">Target role<input id="blueprint-role" v-model="bindingRole" name="role" maxlength="80" required /></label>
                  <label class="blueprint-field" for="blueprint-permission">Target permission
                    <select id="blueprint-permission" v-model="bindingPermissionProfile" name="permissionProfile" aria-describedby="blueprint-permission-help" required>
                      <option value="READ_ONLY">Read only</option><option value="ROLE_DEFAULT">Default for role</option><option value="WORKSPACE_WRITE">Workspace write</option>
                    </select>
                    <small id="blueprint-permission-help">Defaults to read-only. Source permission is never restored automatically.</small>
                  </label>
                  <template v-if="selectedAgentBlueprint.executor === 'codex'">
                    <label class="blueprint-field" for="blueprint-model">Target model
                      <select id="blueprint-model" v-model="bindingModel" name="model" required>
                        <option v-for="model in codexModels" :key="model.id" :value="model.id">{{ model.displayName }} · {{ model.capabilities.dynamicTools === 'supported' ? 'Coordinator tools verified' : 'tools unverified' }}</option>
                      </select>
                    </label>
                    <label class="blueprint-field blueprint-cwd" for="blueprint-cwd">Target working directory<input id="blueprint-cwd" v-model="bindingCwd" name="cwd" autocapitalize="none" autocorrect="off" spellcheck="false" required /></label>
                    <label class="blueprint-field" for="blueprint-environment">Execution environment
                      <select id="blueprint-environment" v-model="bindingEnvironmentId" name="t3EnvironmentId" aria-describedby="blueprint-environment-help">
                        <option value="">This computer</option>
                        <option v-for="environment in remoteEnvironments" :key="environment.environmentId" :value="environment.environmentId" :disabled="!environmentReachable(environment)">{{ environment.label }} · {{ environment.status }} · {{ environment.access }}</option>
                      </select>
                      <small id="blueprint-environment-help">{{ t3EnvironmentHelp }}</small>
                    </label>
                  </template>
                </div>
                <fieldset v-if="selectedAgentBlueprint.executor === 'codex'" class="fallback-config" aria-describedby="blueprint-fallback-help">
                  <legend>Target model fallback</legend>
                  <label class="fallback-enable" for="blueprint-allow-fallback"><input id="blueprint-allow-fallback" v-model="bindingAllowFallback" name="allowModelFallback" type="checkbox" />Allow only selected target-account models</label>
                  <div v-if="bindingAllowFallback" class="fallback-options">
                    <label v-for="model in bindingFallbackOptions" :key="model.id" :for="`blueprint-fallback-${model.id}`">
                      <input :id="`blueprint-fallback-${model.id}`" v-model="bindingFallbackModels" name="fallbackModels" type="checkbox" :value="model.id" :disabled="!bindingFallbackEligible(model) || (!bindingFallbackModels.includes(model.id) && bindingFallbackModels.length >= 5)" />
                      {{ model.displayName }}{{ bindingFallbackEligible(model) ? '' : ' · Coordinator tools unverified' }}
                    </label>
                  </div>
                  <small id="blueprint-fallback-help">Source fallback choices are suggestions only and are filtered against the current Codex login.</small>
                </fieldset>
                <p v-else class="blueprint-target">Target Pi Agent: {{ selected ? currentAgentName : 'select one from the network tree' }}</p>
                <button type="submit" class="secondary blueprint-submit" :disabled="bindingBlueprint || selectedAgentBlueprint.bindingState !== 'UNBOUND'">
                  <UserPlus :size="16" />{{ bindingBlueprint ? "Binding…" : selectedAgentBlueprint.bindingState === 'BOUND' ? "Already bound" : selectedAgentBlueprint.bindingState === 'SOURCE_TEMPORARY' ? "Temporary source not bindable" : "Bind on this device" }}
                </button>
                <p class="blueprint-status" role="status" aria-live="polite">{{ bindingStatusMessage }}</p>
              </template>
            </form>
            <div class="member-add">
              <label for="member-role">Agent role<select id="member-role" v-model="role" name="role"><option value="coordinator">Coordinator</option><option value="worker">Worker</option><option value="researcher">Researcher</option><option value="reviewer">Reviewer</option></select></label>
              <button class="secondary" :disabled="!selected || !!currentMember" @click="addCurrent"><UserPlus :size="16" />{{ currentMember ? "Current agent added" : "Add selected agent" }}</button>
            </div>
            <form class="codex-add" aria-label="Add Codex agent" @submit.prevent="addLocalCodex">
              <label class="codex-field" for="codex-model">Model
                <select id="codex-model" v-model="codexModel" name="model" aria-describedby="codex-model-help" required>
                  <option v-for="model in codexModels" :key="model.id" :value="model.id">{{ model.displayName }} · {{ model.capabilities.dynamicTools === 'supported' ? 'Coordinator tools verified' : 'tools unverified' }}</option>
                </select>
                <small id="codex-model-help" class="model-capability">{{ codexModelHelp }}</small>
              </label>
              <label class="codex-field" for="codex-permission">Permission<select id="codex-permission" v-model="codexPermissionProfile" name="permissionProfile" required><option value="ROLE_DEFAULT">Default for role</option><option value="READ_ONLY">Read only</option><option value="WORKSPACE_WRITE">Workspace write</option></select></label>
              <label class="codex-field" for="codex-cwd">Working directory<input id="codex-cwd" v-model="codexCwd" name="cwd" required /></label>
              <label class="codex-field" for="codex-environment">Execution environment
                <select id="codex-environment" v-model="codexEnvironmentId" name="t3EnvironmentId" aria-describedby="codex-environment-help">
                  <option value="">This computer</option>
                  <option v-for="environment in remoteEnvironments" :key="environment.environmentId" :value="environment.environmentId" :disabled="!environmentReachable(environment)">{{ environment.label }} · {{ environment.status }} · {{ environment.access }}</option>
                </select>
                <small id="codex-environment-help" class="environment-help">{{ t3EnvironmentHelp }}</small>
              </label>
              <fieldset class="fallback-config" aria-describedby="fallback-help">
                <legend>Automatic model fallback</legend>
                <label class="fallback-enable" for="codex-allow-fallback"><input id="codex-allow-fallback" v-model="codexAllowFallback" name="allowModelFallback" type="checkbox" />Allow only the explicitly selected fallback models</label>
                <div v-if="codexAllowFallback" class="fallback-options">
                  <label v-for="model in fallbackModelOptions" :key="model.id" :for="`fallback-${model.id}`">
                    <input :id="`fallback-${model.id}`" v-model="codexFallbackModels" name="fallbackModels" type="checkbox" :value="model.id" :disabled="!fallbackModelEligible(model) || (!codexFallbackModels.includes(model.id) && codexFallbackModels.length >= 5)" />
                    {{ model.displayName }}{{ fallbackModelEligible(model) ? '' : ' · Coordinator tools unverified' }}
                  </label>
                </div>
                <small id="fallback-help">Disabled by default. Selection priority follows this displayed model order; every candidate is revalidated before use. At most five.</small>
              </fieldset>
              <label class="temporary-toggle" for="codex-temporary"><input id="codex-temporary" v-model="codexTemporary" name="temporary" type="checkbox" />Temporary agent (archive when finished)</label>
              <button type="submit" class="secondary codex-submit" :disabled="addingCodex"><UserPlus :size="16" />{{ addingCodex ? "Adding…" : "Add Codex Agent" }}</button>
            </form>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong><Brain :size="16" /> Project memory</strong><span>Shared facts reach every Agent; private facts reach only the selected Agent.</span></div>
              <div class="memory-scope"><select v-model="memoryScopeMemberId" :disabled="memoryVersion !== undefined" @change="changeMemoryScope"><option value="">Shared project memory</option><option v-for="member in active.members" :key="member.id" :value="member.id">{{ member.name }} private</option></select><button class="icon-button" title="Refresh memory" @click="loadMemories"><RefreshCw :size="16" /></button></div>
            </div>
            <div class="memory-list">
              <article v-for="item in memories" :key="item.id" class="memory-card">
                <button class="memory-open" :disabled="item.key.startsWith('system.')" @click="editMemory(item)">
                  <strong>{{ item.key }} <small>v{{ item.version }}{{ item.key.startsWith('system.') ? ' · platform read-only' : item.memberId ? ' · private' : ' · shared' }}</small></strong>
                  <pre>{{ memoryText(item.value) }}</pre>
                </button>
                <button v-if="!item.key.startsWith('system.')" class="icon-button" title="Expire memory" @click="expireMemory(item)"><Trash2 :size="15" /></button>
              </article>
              <p v-if="!memories.length" class="hint">No active project facts yet.</p>
            </div>
            <div class="memory-form">
              <input v-model="memoryKey" :disabled="memoryVersion !== undefined" maxlength="160" placeholder="Key, e.g. architecture.runtime" />
              <textarea v-model="memoryValue" rows="3" placeholder="Text or JSON value" />
              <div class="memory-actions">
                <button class="primary small" :disabled="savingMemory || !memoryKey.trim() || !memoryValue.trim()" @click="saveMemory">{{ savingMemory ? "Saving…" : (memoryVersion === undefined ? "Add fact" : `Update v${memoryVersion}`) }}</button>
                <button v-if="memoryVersion !== undefined" class="secondary small" @click="clearMemoryForm">Cancel edit</button>
              </div>
            </div>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong><ShieldCheck :size="16" /> Approvals</strong><span>Authorization is one-use, expires, and is bound to the exact operation hash.</span></div>
              <button class="icon-button" title="Refresh approvals" @click="loadApprovals"><RefreshCw :size="16" /></button>
            </div>
            <div class="approval-list">
              <article v-for="item in approvals" :key="item.id" class="approval-card">
                <div>
                  <strong>{{ item.status }} · {{ item.requestedBy }}</strong>
                  <pre>{{ memoryText(item.operation) }}</pre>
                  <small>{{ item.operationHash.slice(0, 16) }}… · expires {{ new Date(item.expiresAt).toLocaleString() }}</small>
                </div>
                <div class="task-actions">
                  <button v-if="item.status === 'PENDING'" class="primary small" @click="approvalAction(item, 'APPROVED')">Approve</button>
                  <button v-if="item.status === 'PENDING'" class="secondary small" @click="approvalAction(item, 'DENIED')">Deny</button>
                  <button v-if="item.status === 'APPROVED'" class="secondary small" @click="approvalAction(item, 'REVOKED')">Revoke</button>
                </div>
              </article>
              <p v-if="!approvals.length" class="hint">No approval requests in this project.</p>
            </div>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong>Artifacts</strong><span>Project-scoped files with size and SHA-256 verification; file bodies stay outside SQLite.</span></div>
              <button class="icon-button" title="Refresh artifacts" @click="loadArtifacts"><RefreshCw :size="16" /></button>
            </div>
            <div class="artifact-list">
              <article v-for="item in artifacts" :key="item.id" class="artifact-card">
                <div>
                  <a :href="hub.artifactContentUrl(active.id, item.id)" target="_blank" rel="noopener">{{ item.name }}</a>
                  <span>{{ item.kind }} · {{ item.sizeBytes }} bytes <template v-if="item.includeInHandoff">· handoff</template></span>
                  <small>{{ item.sha256 }}</small>
                </div>
                <button class="icon-button" title="Expire artifact" @click="expireArtifact(item)"><Trash2 :size="15" /></button>
              </article>
              <p v-if="!artifacts.length" class="hint">No active project artifacts.</p>
            </div>
            <div class="artifact-form">
              <div class="environment-scan">
                <label for="project-workspace">Project workspace</label>
                <input id="project-workspace" v-model="environmentWorkspace" aria-describedby="project-workspace-hint" autocapitalize="none" autocorrect="off" spellcheck="false" />
                <small id="project-workspace-hint">Used for environment reports and optional Git-aware handoffs.</small>
                <button type="button" class="secondary small" :disabled="scanningEnvironment || !environmentWorkspace.trim()" @click="scanEnvironment">{{ scanningEnvironment ? "Scanning…" : "Scan environment" }}</button>
              </div>
              <input v-model="artifactName" maxlength="240" placeholder="Artifact filename, e.g. research.md" />
              <textarea v-model="artifactContent" rows="4" placeholder="Text report or project note" />
              <label><input v-model="artifactHandoff" type="checkbox" /> Include in future handoff package</label>
              <button class="primary small" :disabled="publishingArtifact || !artifactName.trim() || !artifactContent" @click="publishArtifact">{{ publishingArtifact ? "Publishing…" : "Publish artifact" }}</button>
              <div class="binary-upload">
                <input type="file" @change="selectBinaryFile" />
                <label><input v-model="binaryHandoff" type="checkbox" /> Include binary in future handoff package</label>
                <button class="secondary small" :disabled="uploadingBinary || !binaryFile" @click="uploadBinaryArtifact">{{ uploadingBinary ? "Uploading…" : "Upload binary" }}</button>
              </div>
            </div>
          </section>

          <section class="project-section">
            <div class="project-section-title"><strong>Dispatch inside boundary</strong><span>The hub routes this only to a member of {{ active.name }}.</span></div>
            <select v-model="targetId"><option value="" disabled>Select target agent</option><option v-for="member in active.members" :key="member.id" :value="member.id">{{ member.name }} · {{ member.deviceId }}</option></select>
            <textarea v-model="task" rows="4" placeholder="Ask this agent to inspect its local files, perform work, or report findings…" />
            <button class="primary" :disabled="sending || !targetId || !task.trim()" @click="sendTask"><Send :size="17" />{{ sending ? "Queueing…" : "Queue durable task" }}</button>
          </section>

          <section class="project-section">
            <div class="handoff-workspace">
              <label for="handoff-workspace">Git repository root (optional)</label>
              <input id="handoff-workspace" v-model="handoffWorkspace" aria-describedby="handoff-workspace-hint" autocapitalize="none" autocorrect="off" spellcheck="false" />
              <small id="handoff-workspace-hint">Set this to pin a clean committed revision and enable conflict preflight; leave it empty for a metadata-only handoff.</small>
              <button type="button" class="secondary small" :disabled="checkingImportedBaseline || !handoffWorkspace.trim()" @click="checkImportedGitBaseline">{{ checkingImportedBaseline ? "Checking imported baseline…" : "Check imported baseline" }}</button>
            </div>
            <div class="project-list-head">
              <div class="project-section-title"><strong>Activity &amp; tool audit</strong><span>Durable task, approval, Codex thread/turn and bounded tool records.</span></div>
              <button class="icon-button" title="Refresh activity" @click="loadEvents"><RefreshCw :size="16" /></button>
            </div>
            <div class="audit-list">
              <details v-for="item in events" :key="item.id" class="audit-card">
                <summary><strong>{{ item.kind }}</strong><span>{{ new Date(item.createdAt).toLocaleString() }}</span></summary>
                <pre>{{ eventText(item.detail) }}</pre>
              </details>
              <p v-if="!events.length" class="hint">No project activity recorded yet.</p>
            </div>
            <div class="project-list-head">
              <div class="project-section-title"><strong>Execution evidence</strong><span>Fenced, redacted records tied to the exact task attempt.</span></div>
              <button class="icon-button" title="Refresh execution evidence" @click="loadToolCalls"><RefreshCw :size="16" /></button>
            </div>
            <label for="tool-evidence-kind">Evidence type</label>
            <select id="tool-evidence-kind" v-model="toolEvidenceKind" @change="loadToolCalls">
              <option value="">All evidence</option>
              <option value="TEST">Tests</option>
              <option value="BUILD">Builds</option>
              <option value="FILE_CHANGE">File changes</option>
              <option value="TOOL">Other tools</option>
            </select>
            <div class="audit-list" aria-live="polite">
              <details v-for="item in toolCalls" :key="item.id" class="audit-card">
                <summary>
                  <strong>{{ item.evidenceKind }} · {{ item.type }}</strong>
                  <span>{{ item.status }}<template v-if="item.exitCode !== undefined"> · exit {{ item.exitCode }}</template> · {{ new Date(item.startedAt).toLocaleString() }}</span>
                </summary>
                <pre>{{ eventText({ taskId: item.taskId, attemptId: item.attemptId, fenceEpoch: item.fenceEpoch, request: item.request, result: item.result }) }}</pre>
              </details>
              <p v-if="!toolCalls.length" class="hint">No matching execution evidence recorded yet.</p>
            </div>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong>Model usage</strong><span>Recorded per project, task, attempt, member and model.</span></div>
              <button class="icon-button" title="Refresh usage" @click="loadUsage"><RefreshCw :size="16" /></button>
            </div>
            <div v-if="usageSummary" class="usage-grid">
              <div><strong>{{ usageSummary.requests }}</strong><span>turns</span></div>
              <div><strong>{{ usageSummary.inputTokens.toLocaleString() }}</strong><span>input</span></div>
              <div><strong>{{ usageSummary.cachedInputTokens.toLocaleString() }}</strong><span>cached input</span></div>
              <div><strong>{{ usageSummary.outputTokens.toLocaleString() }}</strong><span>output</span></div>
              <div><strong>{{ usageSummary.reasoningOutputTokens.toLocaleString() }}</strong><span>reasoning</span></div>
              <div><strong>{{ usageSummary.totalTokens.toLocaleString() }}</strong><span>total</span></div>
            </div>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong>Handoff bundles</strong><span>Versioned manifest, active memories and explicitly selected artifacts; source code remains in Git/copy workflow.</span></div>
              <button type="button" class="primary small" :disabled="creatingHandoff" @click="createHandoff">{{ creatingHandoff ? "Exporting…" : "Create handoff" }}</button>
            </div>
            <div class="handoff-list">
              <article v-for="item in handoffs" :key="item.id" class="handoff-card">
                <div class="handoff-head">
                  <strong>{{ item.status }} · {{ new Date(item.createdAt).toLocaleString() }}</strong>
                  <div class="handoff-actions">
                    <button type="button" class="secondary small" :disabled="checkingHandoff === item.id || !handoffWorkspace.trim()" @click="checkHandoffGit(item)">{{ checkingHandoff === item.id ? "Checking…" : "Check Git" }}</button>
                    <button type="button" class="secondary small" :disabled="validatingHandoff === item.id" @click="validateHandoff(item)">{{ validatingHandoff === item.id ? "Validating…" : "Validate" }}</button>
                  </div>
                </div>
                <span>{{ item.artifactCount }} artifacts · {{ item.totalBytes }} bytes</span>
                <small>{{ item.manifestSha256 }}</small>
                <code :title="item.directory">{{ item.directory }}</code>
              </article>
              <p v-if="!handoffs.length" class="hint">No handoff bundle created yet.</p>
            </div>
          </section>

          <section class="project-section">
            <div class="project-list-head">
              <div class="project-section-title"><strong>Durable tasks</strong><span>Scheduler state refreshes every two seconds.</span></div>
              <button class="icon-button" title="Refresh tasks" @click="loadTasks"><RefreshCw :size="16" /></button>
            </div>
            <div class="task-list">
              <article v-for="item in tasks" :key="item.id" class="project-task">
                <div>
                  <strong>{{ item.title }}</strong>
                  <span><b :data-status="item.status">{{ item.status }}</b> · attempt {{ item.attemptCount }}/{{ item.maxAttempts }} · fence {{ item.fenceEpoch }}<template v-if="item.timeoutMs"> · timeout {{ Math.ceil(item.timeoutMs / 1000) }}s</template></span>
                  <small>{{ item.id }}<template v-if="item.dependsOn.length"> · after {{ item.dependsOn.join(", ") }}</template></small>
                  <small v-if="item.error" class="task-error" :title="memoryText(item.error)">{{ taskError(item.error) }}</small>
                </div>
                <div class="task-actions">
                  <button v-if="['QUEUED','RETRYING','WAITING_DEPENDENCY'].includes(item.status)" class="secondary small" @click="taskAction(item, 'pause')">Pause</button>
                  <button v-if="item.status === 'PAUSED' && !isUnknownSideEffect(item)" class="secondary small" @click="taskAction(item, 'resume')">Resume</button>
                  <button v-if="isUnknownSideEffect(item)" class="secondary small" @click="openSideEffectResolution(item)">Resolve effect</button>
                  <button v-if="!['COMPLETED','FAILED','CANCELLED'].includes(item.status)" class="secondary small" @click="taskAction(item, 'cancel')">Cancel</button>
                </div>
              </article>
              <p v-if="!tasks.length && !tasksLoading" class="hint">No durable tasks in this project.</p>
            </div>
          </section>
        </div>
        <div v-else class="project-detail project-empty"><FolderKanban :size="36" /><p>Create a project to define an isolated multi-device workspace.</p></div>
      </div>
    </section>
    <dialog ref="sideEffectDialog" class="side-effect-dialog" aria-labelledby="side-effect-title">
      <h2 id="side-effect-title">Resolve unknown side effect</h2>
      <p>The previous approval was consumed before the worker lost its lease. Verify the external system before choosing an outcome.</p>
      <label>
        Verification note
        <textarea v-model="sideEffectNote" rows="4" maxlength="1000" placeholder="What did you check, and what state did you observe?" autofocus></textarea>
      </label>
      <div class="side-effect-actions">
        <button type="button" class="secondary" :disabled="resolvingSideEffect" @click="sideEffectDialog?.close()">Cancel</button>
        <button type="button" class="secondary" :disabled="resolvingSideEffect || !sideEffectNote.trim()" @click="resolveSideEffect('RETRY')">Confirmed not applied — retry</button>
        <button type="button" :disabled="resolvingSideEffect || !sideEffectNote.trim()" @click="resolveSideEffect('MARK_COMPLETED')">Confirmed applied — complete</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.project-backdrop { padding: 3vh 3vw; }
.project-modal { width: min(1120px, 96vw); height: min(780px, 94vh); max-width: none; display: flex; flex-direction: column; }
.project-modal > header h2 { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 21px; }
.project-layout { display: grid; grid-template-columns: 280px 1fr; min-height: 0; flex: 1; border-top: 1px solid var(--line); }
.project-list { border-right: 1px solid var(--line); padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.project-list-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.project-row { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px 12px; border: 1px solid transparent; border-radius: 7px; text-align: left; }
.project-row:hover { background: #ffffff08; }
.project-row.active { background: #ff899714; border-color: #634448; }
.project-row span { color: var(--muted); font-size: 13px; }
.project-create { border-top: 1px solid var(--line); margin-top: auto; padding-top: 14px; display: grid; gap: 9px; }
.backup-panel { border-top: 1px solid var(--line); margin-top: auto; padding-top: 12px; display: grid; gap: 7px; }
.platform-summary { border-top: 1px solid var(--line); margin-top: auto; padding-top: 12px; display: grid; gap: 4px; }
.platform-summary span { color: var(--muted); font-size: 11px; }
.platform-summary + .backup-panel { margin-top: 0; }
.backup-panel small { color: var(--muted); font-size: 11px; }
.backup-panel code { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.backup-panel + .project-create { margin-top: 0; }
.handoff-import { border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 7px; }
.handoff-import small, .handoff-import code { color: var(--muted); font-size: 10px; }
.handoff-import code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.handoff-import + .project-create { margin-top: 0; }
.project-create label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
.project-detail { padding: 22px; overflow: auto; display: flex; flex-direction: column; gap: 20px; }
.project-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.project-heading h3 { font-size: 22px; }
.project-heading p { color: var(--muted); margin-top: 5px; }
.project-heading code { color: var(--muted); font-size: 12px; }
.project-mode { display: grid; justify-items: end; gap: 6px; }
.project-mode select { min-width: 190px; }
.project-mode small { color: var(--muted); font-size: 11px; }
.budget-field { display: grid; justify-items: end; gap: 4px; color: var(--muted); font-size: 11px; }
.budget-field input { width: 190px; }
.project-section { border: 1px solid var(--line); background: #ffffff03; border-radius: 9px; padding: 16px; display: grid; gap: 12px; }
.project-section-title { display: flex; flex-direction: column; gap: 3px; }
.project-section-title span { color: var(--muted); font-size: 13px; }
.worktree-list { display: grid; gap: 7px; }
.worktree-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--line); border-radius: 7px; padding: 9px 11px; }
.worktree-card > div:first-child { min-width: 0; display: grid; gap: 3px; }
.worktree-card span, .worktree-card small, .worktree-card code { color: var(--muted); }
.worktree-card code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.worktree-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.worktree-create { display: grid; gap: 9px; padding: 11px; border: 1px solid var(--line); border-radius: 7px; }
.worktree-create > label, .worktree-fields label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.worktree-create small, .worktree-status { color: var(--muted); font-size: 11px; line-height: 1.4; }
.worktree-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.worktree-fields input { min-width: 0; font: inherit; }
.worktree-submit { justify-self: start; min-height: 42px; }
.worktree-status { margin: 0; }
.worktree-status:empty { display: none; }
.member-list { display: grid; gap: 7px; }
.member-card { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 7px; padding: 4px 6px 4px 11px; }
.team-plan-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 8px; }
.team-plan-card { container-type: inline-size; display: grid; gap: 9px; border: 1px solid var(--line); border-radius: 7px; padding: 11px; }
.team-plan-card > header { display: flex; justify-content: space-between; gap: 10px; }
.team-plan-card > header span { color: var(--muted); font-size: 12px; }
.team-plan-card dl { display: grid; gap: 5px; margin: 0; }
.team-plan-card dl > div { display: flex; justify-content: space-between; gap: 10px; }
.team-plan-card dt, .team-plan-card p { color: var(--muted); font-size: 12px; }
.team-plan-card dd, .team-plan-card p { margin: 0; }
.team-plan-card ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.team-plan-card li { display: grid; gap: 2px; border-top: 1px solid var(--line); padding-top: 6px; }
.team-plan-card li span, .team-plan-card li code { color: var(--muted); font-size: 11px; }
.team-plan-card li code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-open { flex: 1; display: grid; justify-items: start; gap: 2px; padding: 5px; }
.member-open span, .member-open small { color: var(--muted); }
.member-open small { font: 11px "IBM Plex Mono", monospace; }
.member-settings { display: grid; grid-template-columns: 145px minmax(180px, 230px); align-items: end; gap: 5px 7px; padding: 5px; }
.member-permission { display: grid; gap: 3px; color: var(--muted); font-size: 10px; }
.member-permission select { max-width: 145px; }
.member-settings .member-permission select { max-width: none; }
.member-workspace { grid-column: 1 / -1; }
.member-workspace input { min-width: 0; font: inherit; }
.environment-help { color: var(--muted); line-height: 1.35; }
.member-settings > .environment-help { grid-column: 1 / -1; max-width: 380px; font-size: 10px; }
.blueprint-binding { display: grid; gap: 10px; padding: 12px; border: 1px solid #5d536f; border-radius: 8px; background: #8d78bb0b; }
.blueprint-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.blueprint-field { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.blueprint-field input, .blueprint-field select { min-width: 0; font: inherit; }
.blueprint-field small, .blueprint-source, .blueprint-target, .blueprint-status { color: var(--muted); font-size: 11px; line-height: 1.4; }
.blueprint-source, .blueprint-target, .blueprint-status { margin: 0; }
.blueprint-cwd { grid-column: span 2; }
.blueprint-submit { justify-self: start; min-height: 42px; }
.blueprint-status:empty { display: none; }
.member-add { display: flex; align-items: end; gap: 8px; }
.member-add label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.member-add select { width: 170px; }
.codex-add { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); align-items: end; gap: 8px; }
.codex-field { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.codex-field input, .codex-field select { min-width: 0; }
.model-capability { color: var(--muted); line-height: 1.35; }
.codex-submit { min-height: 42px; justify-self: start; }
.fallback-config { grid-column: 1 / -1; display: grid; gap: 7px; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 7px; }
.fallback-config legend { padding-inline: 5px; color: var(--muted); font-size: 12px; }
.fallback-enable, .fallback-options label { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.fallback-enable input, .fallback-options input { width: auto; }
.fallback-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 7px 12px; }
.fallback-config small { color: var(--muted); line-height: 1.4; }
.temporary-toggle { grid-column: 1 / -1; display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.temporary-toggle input { width: auto; }
@media (max-width: 820px) {
  .worktree-card { align-items: stretch; flex-direction: column; }
  .worktree-fields { grid-template-columns: 1fr; }
  .blueprint-grid { grid-template-columns: 1fr; }
  .blueprint-cwd { grid-column: auto; }
  .member-card { align-items: stretch; flex-wrap: wrap; }
  .member-settings { flex: 1 1 100%; grid-template-columns: 1fr; }
  .member-workspace, .member-settings > .environment-help { grid-column: auto; }
  .codex-add { grid-template-columns: 1fr; }
}
.project-section-title strong { display: flex; align-items: center; gap: 6px; }
.memory-list { display: grid; gap: 7px; }
.memory-scope { display: flex; align-items: center; gap: 6px; }
.memory-card { display: flex; align-items: flex-start; border: 1px solid var(--line); border-radius: 7px; padding: 5px 6px 5px 11px; }
.memory-open { flex: 1; min-width: 0; display: grid; justify-items: start; gap: 4px; padding: 5px; text-align: left; }
.memory-open small { color: var(--muted); font-weight: normal; }
.memory-open pre { max-width: 100%; max-height: 90px; overflow: auto; white-space: pre-wrap; color: var(--muted); font: 12px "IBM Plex Mono", monospace; }
.memory-form { display: grid; gap: 8px; }
.memory-actions { display: flex; gap: 7px; }
.environment-scan { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 8px; }
.approval-list { display: grid; gap: 7px; }
.approval-card { display: flex; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; }
.approval-card > div:first-child { min-width: 0; display: grid; gap: 4px; }
.approval-card pre { max-height: 90px; overflow: auto; white-space: pre-wrap; color: var(--muted); font: 12px "IBM Plex Mono", monospace; }
.approval-card small { color: var(--muted); font: 11px "IBM Plex Mono", monospace; }
.artifact-list { display: grid; gap: 7px; }
.artifact-card { display: flex; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 7px; padding: 9px 11px; }
.artifact-card > div { min-width: 0; display: grid; gap: 3px; }
.artifact-card a { color: #9fc8ff; font-weight: 600; }
.artifact-card span, .artifact-card small { color: var(--muted); }
.artifact-card small { overflow: hidden; text-overflow: ellipsis; font: 10px "IBM Plex Mono", monospace; }
.artifact-form { display: grid; gap: 8px; }
.artifact-form label { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.binary-upload { border-top: 1px solid var(--line); padding-top: 8px; display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; align-items: center; gap: 8px; }
.audit-list { display: grid; gap: 7px; }
.audit-card { border: 1px solid var(--line); border-radius: 7px; padding: 9px 11px; }
.audit-card summary { cursor: pointer; display: flex; justify-content: space-between; gap: 12px; }
.audit-card summary span { color: var(--muted); font-size: 12px; }
.audit-card pre { max-height: 220px; overflow: auto; margin-top: 9px; white-space: pre-wrap; color: var(--muted); font: 11px "IBM Plex Mono", monospace; }
.usage-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.usage-grid > div { border: 1px solid var(--line); border-radius: 7px; padding: 10px; display: grid; gap: 2px; }
.usage-grid strong { font: 600 18px "IBM Plex Mono", monospace; }
.usage-grid span { color: var(--muted); font-size: 11px; }
.handoff-list { display: grid; gap: 7px; }
.handoff-card { border: 1px solid var(--line); border-radius: 7px; padding: 9px 11px; display: grid; gap: 3px; }
.handoff-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.handoff-actions { display: flex; gap: 6px; }
.handoff-workspace { display: grid; gap: 6px; }
.handoff-workspace label { color: var(--muted); font-size: 12px; }
.handoff-workspace small { color: var(--muted); font-size: 10px; }
.environment-scan { display: grid; gap: 6px; }
.environment-scan label { color: var(--muted); font-size: 12px; }
.environment-scan small { color: var(--muted); font-size: 10px; }
.handoff-card span, .handoff-card small, .handoff-card code { color: var(--muted); }
.handoff-card small, .handoff-card code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10px "IBM Plex Mono", monospace; }
.task-list { display: grid; gap: 7px; }
.project-task { display: flex; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; }
.project-task > div:first-child { min-width: 0; display: grid; gap: 3px; }
.project-task span, .project-task small { color: var(--muted); }
.project-task small { overflow: hidden; text-overflow: ellipsis; font: 11px "IBM Plex Mono", monospace; }
.project-task .task-error { color: #ff9da5; }
.project-task b { color: #9fc8ff; font-weight: 600; }
.project-task b[data-status="COMPLETED"] { color: #8ed5a2; }
.project-task b[data-status="FAILED"], .project-task b[data-status="CANCELLED"] { color: #ff9da5; }
.project-task b[data-status="PAUSED"], .project-task b[data-status="WAITING_DEPENDENCY"] { color: #e8c982; }
.project-task b[data-status="WAITING_APPROVAL"] { color: #f3b86b; }
.task-actions { display: flex; align-items: center; gap: 6px; }
.side-effect-dialog { width: min(620px, calc(100vw - 32px)); border: 1px solid var(--line); border-radius: 10px; padding: 22px; background: var(--surface); color: inherit; }
.side-effect-dialog::backdrop { background: #0009; overflow: hidden; overscroll-behavior: contain; }
.side-effect-dialog:modal { overscroll-behavior: contain; }
.side-effect-dialog h2 { margin: 0 0 8px; }
.side-effect-dialog p { color: var(--muted); }
.side-effect-dialog label { display: grid; gap: 7px; margin-top: 16px; }
.side-effect-dialog textarea { width: 100%; resize: vertical; }
.side-effect-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.project-error { background: #5b2429; color: #ffd9dc; padding: 9px 14px; }
.project-empty { align-items: center; justify-content: center; color: var(--muted); text-align: center; }
@media (max-width: 760px) {
  .project-backdrop { padding: 0; }
  .project-modal { width: 100vw; height: 100dvh; border-radius: 0; }
  .project-layout { grid-template-columns: 1fr; overflow: auto; }
  .project-list { border-right: 0; border-bottom: 1px solid var(--line); max-height: 310px; }
  .project-detail { overflow: visible; }
  .project-heading { flex-direction: column; }
  .codex-add { grid-template-columns: 1fr; }
}
</style>
