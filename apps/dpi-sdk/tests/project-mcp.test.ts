import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectMemoryStore } from "../src/node/memories.js";
import { DurableProjectMcpServer, resolveDurableProjectContext } from "../src/node/project-mcp.js";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectRelayStore } from "../src/node/relays.js";
import { ProjectReturnStore } from "../src/node/returns.js";
import { ProjectTaskStore } from "../src/node/tasks.js";

const fixture = async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-project-mcp-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  projects.create({ id: "alpha", name: "Alpha", autonomyMode: "SUPERVISED", maxConcurrentTasks: 2 });
  const coordinator = projects.addMember("alpha", {
    id: "coord",
    deviceId: "local-codex",
    sessionId: "t3",
    agentId: "thread-coord",
    name: "Coordinator",
    role: "coordinator",
    executor: "codex",
    model: "gpt-test",
    cwd: workspace,
  });
  const coder = projects.addMember("alpha", {
    id: "coder",
    deviceId: "local-codex",
    sessionId: "t3",
    agentId: "thread-coder",
    name: "Coder",
    role: "coder",
    executor: "codex",
    model: "gpt-test",
    cwd: join(workspace, "worktrees", "coder"),
  });
  projects.close();
  const memories = new ProjectMemoryStore(database);
  memories.put("alpha", { key: "architecture.runtime", value: { controlPlane: "t3" }, sourceType: "test" });
  memories.put("alpha", { key: "private.note", value: "coordinator-only", sourceType: "test", memberId: coordinator.id });
  memories.put("alpha", { key: "private.note", value: "coder-only", sourceType: "test", memberId: coder.id });
  memories.close();
  return { root, workspace, database, coordinator, coder };
};

test("project MCP context resolves the nearest workspace and prefers its Coordinator", async () => {
  const { workspace } = await fixture();
  const registry = new ProjectRegistry(join(workspace, "..", "projects.sqlite"));
  const context = resolveDurableProjectContext(registry.list(), { cwd: join(workspace, "src") });
  assert.equal(context.project.id, "alpha");
  assert.equal(context.member.id, "coord");
  const coder = resolveDurableProjectContext(registry.list(), { cwd: join(workspace, "worktrees", "coder", "src") });
  assert.equal(coder.member.id, "coder");
  registry.close();
});

test("project MCP exposes bounded read-only project tools without leaking another Agent's memory", async () => {
  const { workspace, database } = await fixture();
  const server = new DurableProjectMcpServer({ cwd: workspace, databasePath: database });
  try {
    const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal((initialized?.result as { serverInfo: { name: string } }).serverInfo.name, "durable-pi-project");

    const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(
      (listed?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      [
        "get_durable_project",
        "list_durable_agents",
        "list_durable_execution_targets",
        "list_durable_data_folders",
        "bind_durable_data_folder",
        "list_durable_tasks",
        "list_durable_memories",
        "list_durable_artifacts",
        "list_durable_handoffs",
        "list_durable_relays",
        "list_durable_relay_plans",
        "list_durable_returns",
        "inspect_durable_return",
        "create_durable_handoff",
        "plan_durable_relay",
        "plan_durable_return",
        "plan_durable_fast_forward",
        "prepare_durable_integration_agent",
        "plan_durable_integration_promotion",
        "finalize_durable_integration_agent",
        "stage_data_artifact",
        "remember_durable_fact",
        "delegate_durable_task",
        "materialize_durable_agent",
        "materialize_durable_remote_agent",
        "isolate_durable_agent_workspace",
        "create_durable_agent",
        "archive_durable_agent",
        "cancel_durable_task",
      ],
    );
    assert.equal(
      (listed?.result as { tools: { annotations: { readOnlyHint: boolean } }[] }).tools[0]?.annotations.readOnlyHint,
      true,
    );

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_durable_memories", arguments: { limit: 10 } },
    });
    const structured = (response?.result as { structuredContent: { memories: { value: unknown }[] } }).structuredContent;
    assert.deepEqual(structured.memories.map((memory) => memory.value), [
      { controlPlane: "t3" },
      "coordinator-only",
    ]);

    const largeMemories = new ProjectMemoryStore(database);
    for (let index = 0; index < 8; index += 1)
      largeMemories.put("alpha", {
        key: `large.${index}`,
        value: "x".repeat(10_000),
        sourceType: "test",
        requestId: `large-${index}`,
      });
    largeMemories.close();
    const bounded = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_durable_memories", arguments: { limit: 20 } },
    });
    const boundedView = (bounded?.result as {
      structuredContent: {
        total: number; returned: number; truncated: boolean; truncatedBySize: boolean;
        resultChars: number; maxResultChars: number; memories: Array<{ value: unknown }>;
      };
    }).structuredContent;
    assert.equal(boundedView.total, 10);
    assert.equal(boundedView.truncated, true);
    assert.equal(boundedView.truncatedBySize, true);
    assert.ok(boundedView.returned < boundedView.total);
    assert.ok(boundedView.resultChars <= boundedView.maxResultChars);
    assert.equal(
      boundedView.memories.some((memory) =>
        Boolean(memory.value && typeof memory.value === "object" && "truncated" in memory.value)),
      true,
    );

    const invalid = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_durable_tasks", arguments: { limit: 101 } },
    });
    assert.equal((invalid?.result as { isError: boolean }).isError, true);
  } finally {
    server.close();
  }
});

test("project MCP refreshes project membership changed by another process", async () => {
  const { workspace, database } = await fixture();
  const server = new DurableProjectMcpServer({ cwd: workspace, databasePath: database });
  try {
    const first = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_durable_agents", arguments: {} },
    });
    assert.equal(
      (first?.result as { structuredContent: { agents: unknown[] } }).structuredContent.agents.length,
      2,
    );

    const external = new ProjectRegistry(database);
    external.addMember("alpha", {
      id: "reviewer",
      deviceId: "local-codex",
      sessionId: "t3",
      agentId: "thread-reviewer",
      name: "Reviewer",
      role: "reviewer",
      executor: "codex",
      model: "gpt-test",
      cwd: join(workspace, "worktrees", "reviewer"),
    });
    external.addMember("alpha", {
      id: "cleanup-pending",
      deviceId: "local-codex",
      sessionId: "t3",
      agentId: "thread-cleanup",
      name: "Cleanup pending",
      role: "debugger",
      executor: "codex",
      model: "gpt-test",
      cwd: join(workspace, "worktrees", "cleanup"),
      temporary: true,
      parentMemberId: "coord",
      scopeTaskId: "completed-scope",
      spawnRequestId: "test:cleanup",
    });
    external.setMemberThread("alpha", "coder", "private-thread-id", 10, "gpt-test", "t3", "codex");
    external.close();
    const externalTasks = new ProjectTaskStore(database);
    externalTasks.enqueue("alpha", {
      id: "queued-for-coder",
      title: "Queued work",
      input: { kind: "agent.message", memberId: "coder", content: "implementation details" },
    });
    externalTasks.enqueue("alpha", {
      id: "queued-for-reviewer",
      title: "Private review work",
      input: { kind: "agent.message", memberId: "reviewer", content: "review details" },
    });
    externalTasks.enqueue("alpha", {
      id: "completed-scope",
      title: "Completed temporary work",
      input: { kind: "agent.message", memberId: "cleanup-pending", content: "done" },
      priority: 100,
    });
    const completedLease = externalTasks.claim("alpha", "test-worker", { leaseMs: 10_000 })!;
    assert.equal(completedLease.id, "completed-scope");
    externalTasks.complete(completedLease.id, "test-worker", completedLease.fenceEpoch, { ok: true });
    externalTasks.close();

    const second = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_durable_agents", arguments: {} },
    });
    assert.deepEqual(
      (second?.result as { structuredContent: { agents: Array<{ id: string }> } }).structuredContent.agents
        .map((agent) => agent.id).sort(),
      ["cleanup-pending", "coder", "coord", "reviewer"],
    );
    const agents = (second?.result as {
      structuredContent: { agents: Array<{ id: string; workState: string; workload: { activeTaskCount: number; tasks: Array<Record<string, unknown>> } }> };
    }).structuredContent.agents;
    assert.equal(agents.find((agent) => agent.id === "coord")?.workState, "IDLE");
    assert.equal(agents.find((agent) => agent.id === "coder")?.workState, "QUEUED");
    assert.equal(agents.find((agent) => agent.id === "coder")?.workload.activeTaskCount, 1);
    assert.equal("input" in agents.find((agent) => agent.id === "coder")!.workload.tasks[0]!, false);
    assert.equal("threadId" in agents.find((agent) => agent.id === "coder")!, false);
    assert.equal("sessionId" in agents.find((agent) => agent.id === "coder")!, false);
    assert.equal((agents.find((agent) => agent.id === "cleanup-pending") as unknown as { cleanupPending: boolean }).cleanupPending, true);

    const coderServer = new DurableProjectMcpServer({ projectId: "alpha", memberId: "coder", databasePath: database });
    try {
      const coderTools = await coderServer.handle({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} });
      assert.deepEqual(
        (coderTools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
        [
          "get_durable_project", "list_durable_agents", "list_durable_tasks",
          "list_durable_memories", "list_durable_artifacts", "remember_durable_fact",
        ],
      );
      const coderTasks = await coderServer.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_durable_tasks", arguments: {} },
      });
      const taskView = (coderTasks?.result as {
        structuredContent: { scope: string; tasks: Array<Record<string, unknown>> };
      }).structuredContent;
      assert.equal(taskView.scope, "assigned");
      assert.deepEqual(taskView.tasks.map((task) => task.id), ["queued-for-coder"]);
      assert.equal("input" in taskView.tasks[0]!, false);
      const deniedHandoffs = await coderServer.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_durable_handoffs", arguments: {} },
      });
      assert.equal((deniedHandoffs?.result as { isError: boolean }).isError, true);
      assert.match(
        (deniedHandoffs?.result as { content: Array<{ text: string }> }).content[0]!.text,
        /Only the project Coordinator/,
      );
    } finally {
      coderServer.close();
    }

    const policyUpdate = new ProjectRegistry(database);
    policyUpdate.updateMember("alpha", "coord", { role: "reviewer", permissionProfile: "READ_ONLY" });
    policyUpdate.close();
    const denied = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "remember_durable_fact",
        arguments: { request_id: "stale-role", key: "security.stale", value: true, visibility: "shared" },
      },
    });
    assert.equal((denied?.result as { isError: boolean }).isError, true);
    assert.match(
      String((denied?.result as { content: Array<{ text: string }> }).content[0]?.text),
      /Only the project Coordinator/,
    );
  } finally {
    server.close();
  }
});

test("project MCP stages a bound device file once and rejects cross-project or non-Coordinator imports", async () => {
  const { root, database, coordinator, coder } = await fixture();
  const sourceRoot = join(root, "device-data");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "sample.bin"), Buffer.from([0, 1, 2, 3, 4, 255]));
  const catalog = join(root, "data-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "device-b",
      label: "Device B",
      root: sourceRoot,
      device: "test-device",
      projectIds: ["alpha"],
      readOnly: true,
    }],
  }));
  const artifactRoot = join(root, "artifacts");
  const coordinatorServer = new DurableProjectMcpServer({
    projectId: "alpha",
    memberId: coordinator.id,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    artifactRoot,
  });
  const coderServer = new DurableProjectMcpServer({
    projectId: "alpha",
    memberId: coder.id,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    artifactRoot,
  });
  const stage = (server: DurableProjectMcpServer, requestId = "stage-1", path = "sample.bin") => server.handle({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: "stage_data_artifact",
      arguments: {
        request_id: requestId,
        source_id: "device-b",
        path,
        kind: "model-input",
        mime_type: "application/octet-stream",
        retention_days: 2,
      },
    },
  });
  try {
    const first = await stage(coordinatorServer);
    const replay = await stage(coordinatorServer);
    const firstResult = (first?.result as {
      structuredContent: { artifact: { id: string; sizeBytes: number; sha256: string; createdAt: number; expiresAt: number }; replayed: boolean };
    }).structuredContent;
    const replayResult = (replay?.result as {
      structuredContent: { artifact: { id: string }; replayed: boolean };
    }).structuredContent;
    assert.equal(firstResult.replayed, false);
    assert.equal(firstResult.artifact.sizeBytes, 6);
    assert.match(firstResult.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(firstResult.artifact.expiresAt, firstResult.artifact.createdAt + 2 * 86_400_000);
    assert.equal(replayResult.replayed, true);
    assert.equal(replayResult.artifact.id, firstResult.artifact.id);
    const denied = await stage(coderServer, "stage-coder");
    assert.equal((denied?.result as { isError: boolean }).isError, true);
    const changed = await stage(coordinatorServer, "stage-1", "other.bin");
    assert.equal((changed?.result as { isError: boolean }).isError, true);
    const listed = await coordinatorServer.handle({
      jsonrpc: "2.0", id: "list-artifacts", method: "tools/call",
      params: { name: "list_durable_artifacts", arguments: {} },
    });
    assert.equal(
      (listed?.result as { structuredContent: { artifacts: unknown[] } }).structuredContent.artifacts.length,
      1,
    );
  } finally {
    coderServer.close();
    coordinatorServer.close();
  }
});

test("project MCP writes idempotent private memory and restricts shared memory to the Coordinator", async () => {
  const { database, coder } = await fixture();
  const server = new DurableProjectMcpServer({ projectId: "alpha", memberId: coder.id, databasePath: database });
  try {
    const write = async (visibility: "private" | "shared", requestId: string) => server.handle({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: "remember_durable_fact",
        arguments: { request_id: requestId, key: "work.note", value: { done: true }, visibility },
      },
    });
    const first = await write("private", "memory-1");
    const replay = await write("private", "memory-1");
    const firstMemory = (first?.result as { structuredContent: { id: string; memberId: string } }).structuredContent;
    const replayMemory = (replay?.result as { structuredContent: { id: string } }).structuredContent;
    assert.equal(firstMemory.memberId, coder.id);
    assert.equal(replayMemory.id, firstMemory.id);

    const denied = await write("shared", "memory-2");
    assert.equal((denied?.result as { isError: boolean }).isError, true);
    assert.match((denied?.result as { content: { text: string }[] }).content[0]!.text, /Only the project Coordinator/);
  } finally {
    server.close();
  }
});

test("project MCP lets only the Coordinator idempotently delegate bounded durable tasks", async () => {
  const { database, coordinator, coder } = await fixture();
  const call = (server: DurableProjectMcpServer, requestId: string, targetMemberId = coder.id) => server.handle({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: "delegate_durable_task",
      arguments: {
        request_id: requestId,
        coordination_id: "t3-turn-1",
        target_member_id: targetMemberId,
        content: "Inspect the scheduler and report risks.",
        title: "Inspect scheduler",
      },
    },
  });
  const coordinatorServer = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
  });
  const coderServer = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coder.id, databasePath: database,
  });
  try {
    const first = await call(coordinatorServer, "delegate-1");
    const replay = await call(coordinatorServer, "delegate-1");
    const firstTask = (first?.result as { structuredContent: { id: string; input: { memberId: string } } }).structuredContent;
    const replayTask = (replay?.result as { structuredContent: { id: string } }).structuredContent;
    assert.equal(firstTask.input.memberId, coder.id);
    assert.equal(replayTask.id, firstTask.id);

    const denied = await call(coderServer, "delegate-2", coordinator.id);
    assert.equal((denied?.result as { isError: boolean }).isError, true);
    assert.match((denied?.result as { content: { text: string }[] }).content[0]!.text, /Only the project Coordinator/);
  } finally {
    coderServer.close();
    coordinatorServer.close();
  }
});

test("project MCP creates, archives and permission-bounds temporary Agents", async () => {
  const { database, coordinator, coder } = await fixture();
  const server = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
  });
  const call = (requestId: string, permissionProfile = "READ_ONLY") => server.handle({
    jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
      name: "create_durable_agent",
      arguments: {
        request_id: requestId,
        template_member_id: coder.id,
        role: "debugger",
        name: "Temporary Debugger",
        permission_profile: permissionProfile,
      },
    },
  });
  try {
    const first = await call("spawn-1");
    const replay = await call("spawn-1");
    const temporary = (first?.result as { structuredContent: { id: string; temporary: boolean } }).structuredContent;
    assert.equal(temporary.temporary, true);
    assert.equal((replay?.result as { structuredContent: { id: string } }).structuredContent.id, temporary.id);

    const escalated = await server.handle({
      jsonrpc: "2.0", id: "spawn-escalated", method: "tools/call", params: {
        name: "create_durable_agent",
        arguments: {
          request_id: "spawn-escalated",
          template_member_id: coordinator.id,
          role: "coder",
          permission_profile: "WORKSPACE_WRITE",
        },
      },
    });
    assert.equal((escalated?.result as { isError: boolean }).isError, true);
    const contextualEscalation = await server.handle({
      jsonrpc: "2.0", id: "spawn-contextual-escalation", method: "tools/call", params: {
        name: "create_durable_agent",
        arguments: {
          request_id: "spawn-contextual-escalation",
          template_member_id: coordinator.id,
          role: "coder",
          permission_profile: "ROLE_DEFAULT",
        },
      },
    });
    assert.equal((contextualEscalation?.result as { isError: boolean }).isError, true);
    assert.match(
      (contextualEscalation?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /cannot exceed/,
    );

    const archived = await server.handle({
      jsonrpc: "2.0", id: "archive-1", method: "tools/call",
      params: { name: "archive_durable_agent", arguments: { member_id: temporary.id } },
    });
    assert.equal(
      (archived?.result as { structuredContent: { lifecycleState: string } }).structuredContent.lifecycleState,
      "ARCHIVED",
    );
  } finally {
    server.close();
  }
});

test("project MCP cancellation is limited to tasks delegated by the same Coordinator", async () => {
  const { database, coordinator, coder } = await fixture();
  const runtimeCancellations: Array<{ threadId: string; runId: string; runtimeMode: string }> = [];
  const server = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
    t3RuntimeGateway: {
      cancel: async (input) => {
        runtimeCancellations.push({ threadId: input.threadId, runId: input.runId, runtimeMode: input.runtimeMode });
        return { threadId: input.threadId, runId: input.runId, status: "interrupted", timedOut: false };
      },
    },
  });
  try {
    const delegated = await server.handle({
      jsonrpc: "2.0", id: "delegate-cancel", method: "tools/call", params: {
        name: "delegate_durable_task",
        arguments: {
          request_id: "delegate-cancel",
          coordination_id: "cancel-turn",
          target_member_id: coder.id,
          content: "Wait for cancellation",
        },
      },
    });
    const taskId = (delegated?.result as { structuredContent: { id: string } }).structuredContent.id;
    const taskStore = new ProjectTaskStore(database);
    const now = Date.now();
    const lease = taskStore.claim("alpha", "worker", { now, leaseMs: 30_000 })!;
    taskStore.bindRuntime(taskId, "worker", lease.fenceEpoch, {
      kind: "t3", threadId: "thread-cancel", runId: "run-cancel", provider: "codex", model: "gpt-test",
    }, now + 1);
    taskStore.pauseForUserInput(taskId, "worker", lease.fenceEpoch, {
      threadId: "thread-cancel", runId: "run-cancel", message: "waiting",
    }, now + 2);
    taskStore.close();
    const cancelled = await server.handle({
      jsonrpc: "2.0", id: "cancel", method: "tools/call",
      params: { name: "cancel_durable_task", arguments: { task_id: taskId, reason: "test cleanup" } },
    });
    const cancelledValue = (cancelled?.result as {
      structuredContent: { status: string; runtimeCancellation: { status: string } };
    }).structuredContent;
    assert.equal(cancelledValue.status, "CANCELLED");
    assert.equal(cancelledValue.runtimeCancellation.status, "INTERRUPTED");
    assert.deepEqual(runtimeCancellations, [{
      threadId: "thread-cancel", runId: "run-cancel", runtimeMode: "approval-required",
    }]);
  } finally {
    server.close();
  }
});

test("project MCP exposes only safe onboarding tools outside a managed project", async () => {
  const { root, database } = await fixture();
  const server = new DurableProjectMcpServer({ cwd: join(root, "unmanaged"), databasePath: database });
  try {
    const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal((initialized?.result as { serverInfo: { name: string } }).serverInfo.name, "durable-pi-project");
    const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(
      (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ["list_durable_data_source_options", "initialize_durable_project"],
    );
  } finally {
    server.close();
  }
});

test("project MCP Coordinator mode bootstraps before publishing its first tool list", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "automatic-tool-list-project");
  await mkdir(workspace);
  const catalog = join(root, "automatic-tool-list-sources.json");
  await writeFile(catalog, JSON.stringify({ version: 1, sources: [] }));
  const server = new DurableProjectMcpServer({
    cwd: workspace,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    autoInitialize: true,
  });
  try {
    const listed = await server.handle({ jsonrpc: "2.0", id: "first-list", method: "tools/list", params: {} });
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.equal(names.includes("get_durable_project"), true);
    assert.equal(names.includes("initialize_durable_project"), false);
    const registry = new ProjectRegistry(database);
    const project = registry.list().find((candidate) => candidate.name === "automatic-tool-list-project");
    assert.equal(project?.autonomyMode, "SUPERVISED");
    assert.equal(project?.templateId, "blank");
    registry.close();
  } finally {
    server.close();
  }
});

test("project MCP automatically infers safe first-use defaults from an empty initialization call", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "automatic-web-project");
  const windowsRoot = join(root, "windows-data");
  const linuxRoot = join(root, "linux-data");
  const macosRoot = join(root, "macos-data");
  await mkdir(workspace);
  await mkdir(windowsRoot);
  await mkdir(linuxRoot);
  await mkdir(macosRoot);
  await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true }));
  const catalog = join(root, "automatic-data-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [
      { id: "windows-workspace", label: "Windows", root: windowsRoot, device: "windows", readOnly: true },
      { id: "linux-home", label: "Linux", root: linuxRoot, device: "linux", readOnly: true },
      { id: "macos-home", label: "macOS", root: macosRoot, device: "macos", readOnly: true },
    ],
  }));
  const server = new DurableProjectMcpServer({ cwd: workspace, databasePath: database, dataSourceCatalogPath: catalog });
  try {
    const initialized = await server.handle({
      jsonrpc: "2.0", id: "auto-init", method: "tools/call",
      params: { name: "initialize_durable_project", arguments: {} },
    });
    const value = (initialized?.result as {
      structuredContent: {
        created: boolean;
        project: { name: string; templateId: string; autonomyMode: string };
        boundSources: string[];
      };
    }).structuredContent;
    assert.equal(value.created, true);
    assert.equal(value.project.name, "automatic-web-project");
    assert.equal(value.project.templateId, "web");
    assert.equal(value.project.autonomyMode, "SUPERVISED");
    assert.deepEqual(value.boundSources.sort(), ["linux-home", "macos-home", "windows-workspace"]);

    const replay = await server.handle({
      jsonrpc: "2.0", id: "auto-init-replay", method: "tools/call",
      params: { name: "initialize_durable_project", arguments: {} },
    });
    assert.equal((replay?.result as { structuredContent: { created: boolean } }).structuredContent.created, false);
  } finally {
    server.close();
  }
});

test("project MCP auto-initialization binds remote sources without probing SSH", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "automatic-remote-project");
  await mkdir(workspace);
  const catalog = join(root, "automatic-remote-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "offline-remote",
      label: "Offline remote",
      root: join(root, "unmounted-remote"),
      device: "linux",
      readOnly: true,
      sshHost: "durable-pi-test.invalid",
      remoteRoot: "/home/test",
    }],
  }));
  const server = new DurableProjectMcpServer({
    cwd: workspace,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    autoInitialize: true,
  });
  try {
    const startedAt = Date.now();
    const listed = await server.handle({ jsonrpc: "2.0", id: "remote-list", method: "tools/list", params: {} });
    assert.ok(Date.now() - startedAt < 1_000, "tools/list must not wait for remote source reachability");
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.equal(names.includes("get_durable_project"), true);
    const registry = new ProjectRegistry(database);
    const project = registry.list().find((candidate) => candidate.name === "automatic-remote-project");
    registry.close();
    assert.ok(project);
    const savedCatalog = JSON.parse(await readFile(catalog, "utf8")) as {
      sources: Array<{ id: string; projectIds?: string[] }>;
    };
    assert.deepEqual(savedCatalog.sources[0]?.projectIds, [project.id]);
  } finally {
    server.close();
  }
});

test("project MCP idempotently initializes the current T3 workspace and binds selected data sources", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "new-t3-project");
  const sourceRoot = join(root, "shared-data");
  await mkdir(workspace);
  await mkdir(sourceRoot);
  await mkdir(join(sourceRoot, "reference", "music"), { recursive: true });
  const catalog = join(root, "bootstrap-data-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{ id: "device-b", label: "Device B", root: sourceRoot, device: "linux", readOnly: true }],
  }));
  const server = new DurableProjectMcpServer({
    cwd: workspace,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    artifactRoot: join(root, "bootstrap-artifacts"),
    t3EnvironmentLister: async () => [{
      environmentId: "env-device-b",
      status: "reachable",
      lastReachedAt: "2026-11-18T06:24:00.304Z",
    }],
  });
  const initialize = (requestId: string) => server.handle({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: "initialize_durable_project",
      arguments: {
        request_id: requestId,
        name: "New T3 project",
        template_id: "cross-platform",
        autonomy_mode: "AUTHORIZED_AUTONOMY",
        coordinator_model: "gpt-6.1-sol",
        data_source_ids: ["device-b"],
      },
    },
  });
  try {
    const options = await server.handle({
      jsonrpc: "2.0", id: "source-options", method: "tools/call",
      params: { name: "list_durable_data_source_options", arguments: {} },
    });
    const option = (options?.result as {
      structuredContent: { sources: Array<Record<string, unknown>> };
    }).structuredContent.sources[0]!;
    assert.deepEqual(option, {
      id: "device-b", label: "Device B", device: "linux", readOnly: true, remote: false,
    });
    assert.equal("root" in option, false);
    assert.equal("projectIds" in option, false);
    const first = await initialize("bootstrap-1");
    const created = (first?.result as {
      structuredContent: { created: boolean; project: { id: string; templateId: string }; boundSources: string[] };
    }).structuredContent;
    assert.equal(created.created, true);
    assert.equal(created.project.templateId, "cross-platform");
    assert.deepEqual(created.boundSources, ["device-b"]);
    const interruptedAudit = new ProjectRegistry(database);
    interruptedAudit.db.prepare(
      "DELETE FROM project_events WHERE project_id=? AND kind='project.initialization_completed'",
    ).run(created.project.id);
    interruptedAudit.close();
    const replay = await initialize("bootstrap-1");
    assert.equal(
      (replay?.result as { structuredContent: { created: boolean } }).structuredContent.created,
      false,
    );
    assert.equal(
      (replay?.result as { structuredContent: { recovered: boolean } }).structuredContent.recovered,
      true,
    );
    const postInitializationOptions = await server.handle({
      jsonrpc: "2.0", id: "post-init-options", method: "tools/call",
      params: { name: "list_durable_data_source_options", arguments: {} },
    });
    assert.equal((postInitializationOptions?.result as { isError: boolean }).isError, true);
    const postInitializationTools = await server.handle({ jsonrpc: "2.0", id: "post-init-tools", method: "tools/list" });
    assert.equal(
      (postInitializationTools?.result as { tools: Array<{ name: string }> }).tools.some(
        (tool) => tool.name === "list_durable_data_source_options" || tool.name === "initialize_durable_project",
      ),
      false,
    );
    const listed = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.equal(names.includes("get_durable_project"), true);
    const initialFolders = await server.handle({
      jsonrpc: "2.0", id: "initial-folders", method: "tools/call",
      params: { name: "list_durable_data_folders", arguments: {} },
    });
    assert.deepEqual(
      (initialFolders?.result as { structuredContent: { sources: Array<{ folders: string[] }> } })
        .structuredContent.sources[0]?.folders,
      [],
    );
    const boundFolder = await server.handle({
      jsonrpc: "2.0", id: "bind-folder", method: "tools/call",
      params: {
        name: "bind_durable_data_folder",
        arguments: { request_id: "bind-folder", source_id: "device-b", path: "reference/music" },
      },
    });
    assert.deepEqual(
      (boundFolder?.result as { structuredContent: { folder: string; folders: string[]; readOnly: boolean } })
        .structuredContent,
      {
        projectId: created.project.id,
        sourceId: "device-b",
        folder: "reference/music",
        folders: ["reference/music"],
        replayed: false,
        readOnly: true,
      },
    );
    const boundFolderReplay = await server.handle({
      jsonrpc: "2.0", id: "bind-folder-replay", method: "tools/call",
      params: {
        name: "bind_durable_data_folder",
        arguments: { request_id: "bind-folder", source_id: "device-b", path: "reference/music" },
      },
    });
    assert.equal(
      (boundFolderReplay?.result as { structuredContent: { replayed: boolean } }).structuredContent.replayed,
      true,
    );
    const remoteTool = (listed?.result as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    }).tools.find((tool) => tool.name === "materialize_durable_remote_agent");
    assert.equal(remoteTool?.inputSchema.required?.includes("model"), true);
    const registry = new ProjectRegistry(database);
    assert.equal(registry.list().filter((project) => project.id === created.project.id).length, 1);
    assert.equal(registry.get(created.project.id)?.members[0]?.role, "coordinator");
    registry.close();
    const localOnly = await server.handle({
      jsonrpc: "2.0", id: "remote-local-source", method: "tools/call", params: {
        name: "materialize_durable_remote_agent",
        arguments: {
          request_id: "remote-local-source",
          source_id: "device-b",
          project_slug: "target-project",
          template_role: "coder",
          role: "coder-linux",
        },
      },
    });
    assert.equal((localOnly?.result as { isError: boolean }).isError, true);
    assert.match(
      (localOnly?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /not a remote T3 execution target/,
    );
    const configured = JSON.parse(await readFile(catalog, "utf8")) as {
      version: number;
      sources: Array<Record<string, unknown>>;
    };
    configured.sources[0] = {
      ...configured.sources[0],
      environmentId: "env-device-b",
      sshHost: "unreachable-device-b",
      remoteRoot: "/home/test",
      verifiedModels: ["gpt-5.6-sol"],
    };
    await writeFile(catalog, JSON.stringify(configured));
    const unverifiedModel = await server.handle({
      jsonrpc: "2.0", id: "remote-unverified-model", method: "tools/call", params: {
        name: "materialize_durable_remote_agent",
        arguments: {
          request_id: "remote-unverified-model",
          source_id: "device-b",
          project_slug: "target-project",
          template_role: "coder",
          role: "coder-linux",
          model: "gpt-6.2-sol",
        },
      },
    });
    assert.equal((unverifiedModel?.result as { isError: boolean }).isError, true);
    assert.match(
      (unverifiedModel?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /not verified for data source device-b/,
    );
    const executionTargets = await server.handle({
      jsonrpc: "2.0", id: "execution-targets", method: "tools/call",
      params: { name: "list_durable_execution_targets", arguments: {} },
    });
    assert.deepEqual(
      (executionTargets?.result as { structuredContent: { targets: unknown[] } }).structuredContent.targets,
      [{
        sourceId: "device-b",
        label: "Device B",
        device: "linux",
        environmentId: "env-device-b",
        verifiedModels: ["gpt-5.6-sol"],
        status: "reachable",
        lastReachedAt: "2026-11-18T06:24:00.304Z",
      }],
    );
    assert.equal(
      (executionTargets?.result as { structuredContent: { liveStatusAvailable: boolean } }).structuredContent.liveStatusAvailable,
      true,
    );
  } finally {
    server.close();
  }
});

test("project MCP rolls back a failed first-time initialization so onboarding can retry", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "retryable-onboarding");
  const sourceRoot = join(root, "retryable-source");
  await mkdir(workspace);
  await mkdir(sourceRoot);
  const catalog = join(root, "retryable-data-sources.json");
  const source = {
    id: "device-b", label: "Device B", root: sourceRoot, device: "linux", readOnly: true,
    projectIds: Array.from({ length: 100 }, (_, index) => `existing-${index}`),
  };
  await writeFile(catalog, JSON.stringify({ version: 1, sources: [source] }));
  const server = new DurableProjectMcpServer({ cwd: workspace, databasePath: database, dataSourceCatalogPath: catalog });
  const initialize = () => server.handle({
    jsonrpc: "2.0", id: "retryable-init", method: "tools/call", params: {
      name: "initialize_durable_project",
      arguments: { request_id: "retryable-init", name: "Retryable", data_source_ids: ["device-b"] },
    },
  });
  try {
    const failed = await initialize();
    assert.equal((failed?.result as { isError: boolean }).isError, true);
    assert.match(
      (failed?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /more than 100 projects/,
    );
    const registryAfterFailure = new ProjectRegistry(database);
    assert.equal(registryAfterFailure.list().some((project) => project.name === "Retryable"), false);
    registryAfterFailure.close();
    const toolsAfterFailure = await server.handle({ jsonrpc: "2.0", id: "retryable-tools", method: "tools/list" });
    assert.deepEqual(
      (toolsAfterFailure?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ["list_durable_data_source_options", "initialize_durable_project"],
    );

    await writeFile(catalog, JSON.stringify({ version: 1, sources: [{ ...source, projectIds: [] }] }));
    const retried = await initialize();
    const value = (retried?.result as { structuredContent: { created: boolean; boundSources: string[] } }).structuredContent;
    assert.equal(value.created, true);
    assert.deepEqual(value.boundSources, ["device-b"]);
  } finally {
    server.close();
  }
});

test("project MCP materializes only pre-authorized team roles and reuses them idempotently", async () => {
  const { root, database } = await fixture();
  const workspace = join(root, "planned-team-project");
  await mkdir(workspace);
  const server = new DurableProjectMcpServer({ cwd: workspace, databasePath: database });
  try {
    await server.handle({
      jsonrpc: "2.0", id: "initialize-team", method: "tools/call", params: {
        name: "initialize_durable_project",
        arguments: { request_id: "initialize-team", name: "Planned team", template_id: "web" },
      },
    });
    const materialize = (id: string, role: string) => server.handle({
      jsonrpc: "2.0", id, method: "tools/call", params: {
        name: "materialize_durable_agent", arguments: { request_id: id, role },
      },
    });
    const first = await materialize("team-coder", "coder");
    const replay = await materialize("team-coder-replay", "coder");
    const firstValue = (first?.result as {
      structuredContent: { agent: { id: string; role: string; permissionProfile: string }; replayed: boolean; workspaceStrategy: string; automaticWorktreeDecision: string };
    }).structuredContent;
    const replayValue = (replay?.result as {
      structuredContent: { agent: { id: string }; replayed: boolean };
    }).structuredContent;
    assert.equal(firstValue.replayed, false);
    assert.equal(firstValue.agent.role, "coder");
    assert.equal(firstValue.agent.permissionProfile, "WORKSPACE_WRITE");
    assert.equal(firstValue.workspaceStrategy, "shared");
    assert.equal(firstValue.automaticWorktreeDecision, "NOT_GIT_TOP_LEVEL");
    assert.equal(replayValue.replayed, true);
    assert.equal(replayValue.agent.id, firstValue.agent.id);

    const denied = await materialize("team-unknown", "security-auditor");
    assert.equal((denied?.result as { isError: boolean }).isError, true);
    assert.match(
      (denied?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /not pre-authorized/,
    );
    const registry = new ProjectRegistry(database);
    const project = registry.list().find((item) => item.name === "Planned team")!;
    assert.equal(project.members.filter((candidate) => candidate.role === "coder").length, 1);
    registry.close();
  } finally {
    server.close();
  }
});

test("project MCP automatically materializes a write-capable planned Agent in an isolated clean Git worktree", async () => {
  const { root, database } = await fixture();
  const repository = join(root, "worktree-project");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "# Worktree project\n");
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "initial"], { stdio: "ignore" });
  const server = new DurableProjectMcpServer({
    cwd: repository,
    databasePath: database,
    worktreeRoot: join(root, "managed-worktrees"),
  });
  try {
    await server.handle({
      jsonrpc: "2.0", id: "initialize-worktree", method: "tools/call", params: {
        name: "initialize_durable_project",
        arguments: { request_id: "initialize-worktree", name: "Worktree team", template_id: "web" },
      },
    });
    const response = await server.handle({
      jsonrpc: "2.0", id: "worktree-coder", method: "tools/call", params: {
        name: "materialize_durable_agent",
        arguments: { request_id: "worktree-coder", role: "coder" },
      },
    });
    const value = (response?.result as {
      structuredContent: {
        agent: { cwd: string; permissionProfile: string };
        workspaceStrategy: string;
        requestedWorkspaceStrategy: string;
        worktree: { path: string; branch: string; state: string };
      };
    }).structuredContent;
    assert.equal(value.workspaceStrategy, "worktree");
    assert.equal(value.requestedWorkspaceStrategy, "auto");
    assert.equal(value.agent.cwd, value.worktree.path);
    assert.notEqual(value.agent.cwd, repository);
    assert.equal(value.agent.permissionProfile, "WORKSPACE_WRITE");
    assert.equal(value.worktree.state, "ACTIVE");
    assert.equal(
      execFileSync("git", ["-C", value.agent.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(),
      value.worktree.branch,
    );
    const temporaryResponse = await server.handle({
      jsonrpc: "2.0", id: "temporary-debugger", method: "tools/call", params: {
        name: "create_durable_agent",
        arguments: {
          request_id: "temporary-debugger",
          template_member_id: (response?.result as { structuredContent: { agent: { id: string } } }).structuredContent.agent.id,
          role: "debugger",
          permission_profile: "WORKSPACE_WRITE",
        },
      },
    });
    const temporary = (temporaryResponse?.result as {
      structuredContent: { id: string; cwd: string; temporary: boolean };
    }).structuredContent;
    assert.equal(temporary.temporary, true);
    assert.notEqual(temporary.cwd, value.agent.cwd);
    assert.equal(existsSync(temporary.cwd), true);
    const archivedTemporary = await server.handle({
      jsonrpc: "2.0", id: "archive-temporary-debugger", method: "tools/call",
      params: { name: "archive_durable_agent", arguments: { member_id: temporary.id } },
    });
    assert.equal(
      (archivedTemporary?.result as { structuredContent: { lifecycleState: string } }).structuredContent.lifecycleState,
      "ARCHIVED",
    );
    assert.equal(existsSync(temporary.cwd), false, "archiving a clean temporary Agent removes only its owned worktree");
    const sharedTesterResponse = await server.handle({
      jsonrpc: "2.0", id: "shared-tester", method: "tools/call", params: {
        name: "materialize_durable_agent",
        arguments: { request_id: "shared-tester", role: "tester", workspace_strategy: "shared" },
      },
    });
    const sharedTester = (sharedTesterResponse?.result as {
      structuredContent: { agent: { id: string; cwd: string }; workspaceStrategy: string };
    }).structuredContent;
    assert.equal(sharedTester.workspaceStrategy, "shared");
    assert.equal(sharedTester.agent.cwd, repository);
    const isolate = () => server.handle({
      jsonrpc: "2.0", id: "isolate-tester", method: "tools/call", params: {
        name: "isolate_durable_agent_workspace",
        arguments: { request_id: "isolate-tester", member_id: sharedTester.agent.id },
      },
    });
    const isolatedResponse = await isolate();
    const isolated = (isolatedResponse?.result as {
      structuredContent: {
        agent: { id: string; cwd: string };
        worktree: { path: string; branch: string; state: string };
        replayed: boolean;
      };
    }).structuredContent;
    assert.equal(isolated.replayed, false);
    assert.equal(isolated.agent.id, sharedTester.agent.id);
    assert.equal(isolated.agent.cwd, isolated.worktree.path);
    assert.equal(isolated.worktree.state, "ACTIVE");
    const isolatedReplay = (await isolate())?.result as { structuredContent: { replayed: boolean; worktree: { id: string } } };
    assert.equal(isolatedReplay.structuredContent.replayed, true);
  } finally {
    server.close();
  }
});

test("project MCP creates and validates one idempotent handoff per Coordinator request", async () => {
  const { root, database, coordinator } = await fixture();
  const server = new DurableProjectMcpServer({
    projectId: "alpha",
    memberId: coordinator.id,
    databasePath: database,
    artifactRoot: join(root, "handoff-artifacts"),
    handoffRoot: join(root, "handoffs"),
    handoffInboxRoot: join(root, "handoff-inbox"),
  });
  const create = () => server.handle({
    jsonrpc: "2.0", id: "handoff-create", method: "tools/call", params: {
      name: "create_durable_handoff",
      arguments: { request_id: "handoff-create", include_git_baseline: false },
    },
  });
  try {
    const first = await create();
    const replay = await create();
    const firstValue = (first?.result as {
      structuredContent: { handoff: { id: string }; validation: { valid: boolean } };
    }).structuredContent;
    const replayValue = (replay?.result as {
      structuredContent: { handoff: { id: string }; validation: { valid: boolean } };
    }).structuredContent;
    assert.equal(firstValue.validation.valid, true);
    assert.equal(replayValue.validation.valid, true);
    assert.equal(replayValue.handoff.id, firstValue.handoff.id);
    const listed = await server.handle({
      jsonrpc: "2.0", id: "handoff-list", method: "tools/call",
      params: { name: "list_durable_handoffs", arguments: {} },
    });
    assert.equal(
      (listed?.result as { structuredContent: { total: number } }).structuredContent.total,
      1,
    );
  } finally {
    server.close();
  }
});

test("project MCP freezes an exact remote relay plan and returns an approval-gated command", async () => {
  const { root, workspace, database, coordinator } = await fixture();
  await writeFile(join(workspace, "README.md"), "# Relay project\n");
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "initial"], { stdio: "ignore" });
  const relayScript = join(root, "relay-project.ps1");
  await writeFile(relayScript, "param()\n");
  const catalog = join(root, "relay-data-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "linux-home",
      label: "Linux home",
      root: workspace,
      device: "linux",
      environmentId: "env-linux",
      sshHost: "linux-target",
      remoteRoot: "/home/test",
      projectIds: ["alpha"],
      readOnly: true,
    }],
  }));
  const server = new DurableProjectMcpServer({
    projectId: "alpha",
    memberId: coordinator.id,
    databasePath: database,
    dataSourceCatalogPath: catalog,
    artifactRoot: join(root, "relay-artifacts"),
    handoffRoot: join(root, "relay-handoffs"),
    handoffInboxRoot: join(root, "relay-inbox"),
    relayScriptPath: relayScript,
  });
  try {
    const handoffResponse = await server.handle({
      jsonrpc: "2.0", id: "handoff-relay", method: "tools/call", params: {
        name: "create_durable_handoff",
        arguments: { request_id: "handoff-relay", include_git_baseline: true },
      },
    });
    const handoffId = (handoffResponse?.result as {
      structuredContent: { handoff: { id: string } };
    }).structuredContent.handoff.id;
    const plan = (projectSlug = "alpha-linux") => server.handle({
      jsonrpc: "2.0", id: `plan-${projectSlug}`, method: "tools/call", params: {
        name: "plan_durable_relay",
        arguments: {
          request_id: "relay-request-1",
          handoff_id: handoffId,
          source_id: "linux-home",
          project_slug: projectSlug,
          title: "Alpha on Linux",
        },
      },
    });
    const first = await plan();
    const replay = await plan();
    const value = (first?.result as {
      structuredContent: {
        plan: { id: string; status: string };
        execution: { executable: string; arguments: string[]; commandLine: string; requiresT3CommandApproval: boolean };
      };
    }).structuredContent;
    const replayValue = (replay?.result as { structuredContent: { plan: { id: string } } }).structuredContent;
    assert.equal(value.plan.status, "PLANNED");
    assert.equal(replayValue.plan.id, value.plan.id);
    assert.equal(value.execution.executable, "powershell.exe");
    assert.equal(value.execution.requiresT3CommandApproval, true);
    assert.equal(value.execution.arguments.includes(value.plan.id), true);
    assert.match(value.execution.commandLine, /-PlanId/);
    const changed = await plan("changed-linux");
    assert.equal((changed?.result as { isError: boolean }).isError, true);
    assert.match(
      (changed?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /request_id was reused/,
    );
    const listed = await server.handle({
      jsonrpc: "2.0", id: "list-relay-plans", method: "tools/call",
      params: { name: "list_durable_relay_plans", arguments: {} },
    });
    assert.equal(
      (listed?.result as { structuredContent: { total: number } }).structuredContent.total,
      1,
    );
  } finally {
    server.close();
  }
});

test("project MCP plans a remote return only from a matching READY relay receipt", async () => {
  const { root, workspace, database, coordinator } = await fixture();
  const returnScript = join(root, "fetch-remote-project.ps1");
  await writeFile(returnScript, "param()\n");
  const catalog = join(root, "return-data-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "linux-home", label: "Linux home", root: workspace, device: "linux",
      environmentId: "env-linux", sshHost: "linux-target", remoteRoot: "/home/test",
      projectIds: ["alpha"], readOnly: true,
    }],
  }));
  const server = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
    dataSourceCatalogPath: catalog, artifactRoot: join(root, "return-artifacts"),
    handoffRoot: join(root, "return-handoffs"), handoffInboxRoot: join(root, "return-inbox"),
    returnScriptPath: returnScript,
  });
  try {
    const missing = await server.handle({
      jsonrpc: "2.0", id: "return-missing", method: "tools/call", params: {
        name: "plan_durable_return",
        arguments: { request_id: "return-missing", source_id: "linux-home", project_slug: "alpha-linux" },
      },
    });
    assert.equal((missing?.result as { isError: boolean }).isError, true);
    assert.match((missing?.result as { content: Array<{ text: string }> }).content[0]!.text, /READY Relay Receipt/);
    const handoffResponse = await server.handle({
      jsonrpc: "2.0", id: "return-handoff", method: "tools/call", params: {
        name: "create_durable_handoff", arguments: { request_id: "return-handoff" },
      },
    });
    const handoffId = (handoffResponse?.result as {
      structuredContent: { handoff: { id: string } };
    }).structuredContent.handoff.id;
    const relays = new ProjectRelayStore(database);
    try {
      relays.record("alpha", {
        handoffId, sourceId: "linux-home", environmentId: "env-linux",
        target: "/home/test/DurablePiProjects/alpha-linux", revision: "a".repeat(40),
        branch: "main", bundleSha256: "b".repeat(64), targetCreated: true,
      });
    } finally {
      relays.close();
    }
    const planCall = () => server.handle({
      jsonrpc: "2.0", id: "return-plan", method: "tools/call", params: {
        name: "plan_durable_return",
        arguments: { request_id: "return-plan", source_id: "linux-home", project_slug: "alpha-linux" },
      },
    });
    const first = await planCall();
    const replay = await planCall();
    const value = (first?.result as {
      structuredContent: {
        plan: { id: string; status: string };
        execution: { arguments: string[]; commandLine: string; requiresT3CommandApproval: boolean; effect: string };
      };
    }).structuredContent;
    const replayValue = (replay?.result as { structuredContent: { plan: { id: string } } }).structuredContent;
    assert.equal(value.plan.status, "PLANNED");
    assert.equal(replayValue.plan.id, value.plan.id);
    assert.equal(value.execution.arguments.includes(value.plan.id), true);
    assert.equal(value.execution.requiresT3CommandApproval, true);
    assert.match(value.execution.commandLine, /fetch-remote-project/);
    assert.match(value.execution.effect, /does not checkout or merge/);
  } finally {
    server.close();
  }
});

test("project MCP inspects a verified remote return without changing the current branch", async () => {
  const { root, workspace, database, coordinator } = await fixture();
  await writeFile(join(workspace, "README.md"), "# Base\n");
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "base"], { stdio: "ignore" });
  const mainBranch = execFileSync("git", ["-C", workspace, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const baseRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", workspace, "checkout", "-b", "remote-adaptation"], { stdio: "ignore" });
  await writeFile(join(workspace, "linux.txt"), "adapted\n");
  execFileSync("git", ["-C", workspace, "add", "linux.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "linux adaptation"], { stdio: "ignore" });
  const remoteRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", workspace, "checkout", mainBranch], { stdio: "ignore" });
  const managedRef = "refs/dpi/remotes/linux-home/alpha-linux";
  execFileSync("git", ["-C", workspace, "update-ref", managedRef, remoteRevision], { stdio: "ignore" });
  const catalog = join(root, "inspect-return-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "linux-home", label: "Linux home", root: workspace, device: "linux",
      environmentId: "env-linux", sshHost: "linux-target", remoteRoot: "/home/test",
      projectIds: ["alpha"], readOnly: true,
    }],
  }));
  const server = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
    dataSourceCatalogPath: catalog, artifactRoot: join(root, "inspect-artifacts"),
    handoffRoot: join(root, "inspect-handoffs"), handoffInboxRoot: join(root, "inspect-inbox"),
  });
  try {
    const handoffResponse = await server.handle({
      jsonrpc: "2.0", id: "inspect-handoff", method: "tools/call", params: {
        name: "create_durable_handoff", arguments: { request_id: "inspect-handoff" },
      },
    });
    const handoffId = (handoffResponse?.result as { structuredContent: { handoff: { id: string } } })
      .structuredContent.handoff.id;
    const relays = new ProjectRelayStore(database);
    const returns = new ProjectReturnStore(database);
    try {
      const relay = relays.record("alpha", {
        handoffId, sourceId: "linux-home", environmentId: "env-linux",
        target: "/home/test/DurablePiProjects/alpha-linux", revision: baseRevision,
        branch: mainBranch, bundleSha256: "b".repeat(64), targetCreated: true,
      });
      const plan = returns.plan("alpha", {
        requestId: "inspect-return", sourceId: "linux-home", relayReceiptId: relay.id,
        repository: workspace, projectSlug: "alpha-linux",
      });
      returns.record("alpha", {
        planId: plan.id, sourceId: "linux-home", environmentId: "env-linux",
        remoteTarget: "/home/test/DurablePiProjects/alpha-linux", localRef: managedRef,
        revision: remoteRevision, branch: "remote-adaptation", bundleSha256: "c".repeat(64),
      });
    } finally {
      returns.close();
      relays.close();
    }
    const response = await server.handle({
      jsonrpc: "2.0", id: "inspect-return", method: "tools/call", params: {
        name: "inspect_durable_return",
        arguments: { source_id: "linux-home", project_slug: "alpha-linux", max_files: 10 },
      },
    });
    const value = (response?.result as {
      structuredContent: {
        relationship: string; safeToFastForward: boolean; dirty: boolean; hasConflicts: boolean;
        currentRevision: string; remoteRevision: string; changes: Array<{ status: string; paths: string[] }>;
      };
    }).structuredContent;
    assert.equal(value.relationship, "REMOTE_AHEAD");
    assert.equal(value.safeToFastForward, true);
    assert.equal(value.dirty, false);
    assert.equal(value.hasConflicts, false);
    assert.equal(value.currentRevision, baseRevision);
    assert.equal(value.remoteRevision, remoteRevision);
    assert.deepEqual(value.changes, [{ status: "A", paths: ["linux.txt"] }]);
    assert.equal(
      execFileSync("git", ["-C", workspace, "branch", "--show-current"], { encoding: "utf8" }).trim(),
      mainBranch,
    );
    assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseRevision);
    const integration = await server.handle({
      jsonrpc: "2.0", id: "plan-fast-forward", method: "tools/call", params: {
        name: "plan_durable_fast_forward",
        arguments: { request_id: "plan-fast-forward", source_id: "linux-home", project_slug: "alpha-linux" },
      },
    });
    const integrationValue = (integration?.result as {
      structuredContent: {
        plan: { id: string; baseRevision: string; remoteRevision: string; status: string };
        execution: { commandLine: string; requiresT3CommandApproval: boolean; effect: string };
      };
    }).structuredContent;
    assert.equal(integrationValue.plan.status, "PLANNED");
    assert.equal(integrationValue.plan.baseRevision, baseRevision);
    assert.equal(integrationValue.plan.remoteRevision, remoteRevision);
    assert.equal(integrationValue.execution.requiresT3CommandApproval, true);
    assert.match(integrationValue.execution.commandLine, /apply-fast-forward/);
    assert.match(integrationValue.execution.effect, /Fast-forward/);
    assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseRevision);
  } finally {
    server.close();
  }
});

test("project MCP prepares divergent integration only in an isolated temporary Agent worktree", async () => {
  const { root, workspace, database, coordinator } = await fixture();
  await writeFile(join(workspace, "shared.txt"), "base\n");
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "add", "shared.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "base"], { stdio: "ignore" });
  const mainBranch = execFileSync("git", ["-C", workspace, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const baseRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(join(workspace, "windows.txt"), "windows\n");
  execFileSync("git", ["-C", workspace, "add", "windows.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "windows"], { stdio: "ignore" });
  const localRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", workspace, "checkout", "-b", "remote-diverged", baseRevision], { stdio: "ignore" });
  await writeFile(join(workspace, "linux.txt"), "linux\n");
  execFileSync("git", ["-C", workspace, "add", "linux.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "linux"], { stdio: "ignore" });
  const remoteRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", workspace, "checkout", mainBranch], { stdio: "ignore" });
  const managedRef = "refs/dpi/remotes/linux-home/alpha-linux";
  execFileSync("git", ["-C", workspace, "update-ref", managedRef, remoteRevision], { stdio: "ignore" });
  const registry = new ProjectRegistry(database);
  const template = registry.addMember("alpha", {
    id: "integration-template", deviceId: "local-t3", sessionId: "t3", agentId: "integration-template",
    name: "Writable template", role: "coder", permissionProfile: "WORKSPACE_WRITE",
    executor: "codex", model: "gpt-test", cwd: workspace,
  });
  registry.close();
  const catalog = join(root, "divergent-sources.json");
  await writeFile(catalog, JSON.stringify({
    version: 1,
    sources: [{
      id: "linux-home", label: "Linux home", root: workspace, device: "linux",
      environmentId: "env-linux", sshHost: "linux-target", remoteRoot: "/home/test",
      projectIds: ["alpha"], readOnly: true,
    }],
  }));
  const server = new DurableProjectMcpServer({
    projectId: "alpha", memberId: coordinator.id, databasePath: database,
    dataSourceCatalogPath: catalog, artifactRoot: join(root, "divergent-artifacts"),
    handoffRoot: join(root, "divergent-handoffs"), handoffInboxRoot: join(root, "divergent-inbox"),
    worktreeRoot: join(root, "divergent-worktrees"),
  });
  try {
    const handoffResponse = await server.handle({
      jsonrpc: "2.0", id: "divergent-handoff", method: "tools/call", params: {
        name: "create_durable_handoff", arguments: { request_id: "divergent-handoff" },
      },
    });
    const handoffId = (handoffResponse?.result as { structuredContent: { handoff: { id: string } } })
      .structuredContent.handoff.id;
    const relays = new ProjectRelayStore(database);
    const returns = new ProjectReturnStore(database);
    try {
      const relay = relays.record("alpha", {
        handoffId, sourceId: "linux-home", environmentId: "env-linux",
        target: "/home/test/DurablePiProjects/alpha-linux", revision: baseRevision,
        branch: mainBranch, bundleSha256: "d".repeat(64), targetCreated: true,
      });
      const plan = returns.plan("alpha", {
        requestId: "divergent-return", sourceId: "linux-home", relayReceiptId: relay.id,
        repository: workspace, projectSlug: "alpha-linux",
      });
      returns.record("alpha", {
        planId: plan.id, sourceId: "linux-home", environmentId: "env-linux",
        remoteTarget: "/home/test/DurablePiProjects/alpha-linux", localRef: managedRef,
        revision: remoteRevision, branch: "remote-diverged", bundleSha256: "e".repeat(64),
      });
    } finally {
      returns.close();
      relays.close();
    }
    const prepare = () => server.handle({
      jsonrpc: "2.0", id: "prepare-integration", method: "tools/call", params: {
        name: "prepare_durable_integration_agent",
        arguments: {
          request_id: "prepare-integration", source_id: "linux-home", project_slug: "alpha-linux",
          template_member_id: template.id,
        },
      },
    });
    const first = await prepare();
    const replay = await prepare();
    const value = (first?.result as {
      structuredContent: {
        agent: { id: string; cwd: string; temporary: boolean; permissionProfile: string };
        worktree: { id: string; path: string; branch: string; headRevision: string };
        replayed: boolean; managedRef: string; suggestedTask: { content: string };
      };
    }).structuredContent;
    const replayValue = (replay?.result as {
      structuredContent: { agent: { id: string }; replayed: boolean };
    }).structuredContent;
    assert.equal(value.replayed, false);
    assert.equal(replayValue.replayed, true);
    assert.equal(replayValue.agent.id, value.agent.id);
    assert.equal(value.agent.temporary, true);
    assert.equal(value.agent.permissionProfile, "WORKSPACE_WRITE");
    assert.equal(value.agent.cwd, value.worktree.path);
    assert.equal(value.worktree.headRevision, localRevision);
    assert.match(value.worktree.branch, /^dpi\/integration-/);
    assert.match(value.suggestedTask.content, /Do not modify.*main Windows worktree/);
    assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), localRevision);
    assert.equal(execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    const deniedFastForward = await server.handle({
      jsonrpc: "2.0", id: "divergent-fast-forward", method: "tools/call", params: {
        name: "plan_durable_fast_forward",
        arguments: { request_id: "divergent-fast-forward", source_id: "linux-home", project_slug: "alpha-linux" },
      },
    });
    assert.equal((deniedFastForward?.result as { isError: boolean }).isError, true);
    assert.match(
      (deniedFastForward?.result as { content: Array<{ text: string }> }).content[0]!.text,
      /not a fast-forward/,
    );
    execFileSync("git", [
      "-C", value.worktree.path,
      "-c", "user.name=Durable Pi",
      "-c", "user.email=durable@example.invalid",
      "merge", "--no-ff", "--no-edit", managedRef,
    ], { stdio: "ignore" });
    const integrationRevision = execFileSync(
      "git", ["-C", value.worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" },
    ).trim();
    assert.notEqual(integrationRevision, localRevision);
    assert.equal(
      execFileSync("git", ["-C", value.worktree.path, "status", "--porcelain"], { encoding: "utf8" }).trim(),
      "",
    );
    const postTaskRegistry = new ProjectRegistry(database);
    try {
      assert.equal(postTaskRegistry.archiveMember("alpha", value.agent.id).lifecycleState, "ARCHIVED");
    } finally {
      postTaskRegistry.close();
    }
    const postArchivePrepare = await prepare();
    const postArchivePrepareValue = (postArchivePrepare?.result as {
      structuredContent: { agent: { id: string; lifecycleState: string }; replayed: boolean };
    }).structuredContent;
    assert.equal(postArchivePrepareValue.replayed, true);
    assert.equal(postArchivePrepareValue.agent.id, value.agent.id);
    assert.equal(postArchivePrepareValue.agent.lifecycleState, "ARCHIVED");
    const promote = () => server.handle({
      jsonrpc: "2.0", id: "promote-integration", method: "tools/call", params: {
        name: "plan_durable_integration_promotion",
        arguments: {
          request_id: "promote-integration", integration_member_id: value.agent.id,
          source_id: "linux-home", project_slug: "alpha-linux",
        },
      },
    });
    const promotion = await promote();
    const promotionReplay = await promote();
    const promotionValue = (promotion?.result as {
      structuredContent: {
        plan: {
          id: string; kind: string; managedRef: string; baseRevision: string;
          remoteRevision: string; status: string;
        };
        resolver: { memberId: string; worktreeId: string; branch: string };
        verifiedReturnRevision: string;
        execution: { commandLine: string; requiresT3CommandApproval: boolean; effect: string };
      };
    }).structuredContent;
    const promotionReplayValue = (promotionReplay?.result as {
      structuredContent: { plan: { id: string } };
    }).structuredContent;
    assert.equal(promotionValue.plan.kind, "WORKTREE_PROMOTION");
    assert.equal(promotionValue.plan.status, "PLANNED");
    assert.equal(promotionValue.plan.baseRevision, localRevision);
    assert.equal(promotionValue.plan.remoteRevision, integrationRevision);
    assert.equal(promotionValue.plan.managedRef, `refs/heads/${value.worktree.branch}`);
    assert.equal(promotionValue.verifiedReturnRevision, remoteRevision);
    assert.equal(promotionValue.resolver.memberId, value.agent.id);
    assert.equal(promotionReplayValue.plan.id, promotionValue.plan.id);
    assert.equal(promotionValue.execution.requiresT3CommandApproval, true);
    assert.match(promotionValue.execution.commandLine, /apply-fast-forward/);
    assert.match(promotionValue.execution.effect, /reviewed integration/);
    assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), localRevision);
    assert.equal(execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    execFileSync("git", [
      "-C", workspace, "merge", "--ff-only", promotionValue.plan.managedRef,
    ], { stdio: "ignore" });
    const appliedStore = new ProjectReturnStore(database);
    try {
      appliedStore.recordFastForward("alpha", {
        planId: promotionValue.plan.id,
        sourceId: "linux-home",
        targetBranch: mainBranch,
        previousRevision: localRevision,
        appliedRevision: integrationRevision,
      });
    } finally {
      appliedStore.close();
    }
    const finalize = () => server.handle({
      jsonrpc: "2.0", id: "finalize-integration", method: "tools/call", params: {
        name: "finalize_durable_integration_agent",
        arguments: { integration_member_id: value.agent.id, plan_id: promotionValue.plan.id },
      },
    });
    const guardTasks = new ProjectTaskStore(database);
    try {
      guardTasks.enqueue("alpha", {
        id: "resolver-still-active", title: "Resolver task not yet terminal", input: { memberId: value.agent.id },
      });
      const blockedFinalize = await finalize();
      assert.equal((blockedFinalize?.result as { isError: boolean }).isError, true);
      assert.match(
        (blockedFinalize?.result as { content: Array<{ text: string }> }).content[0]!.text,
        /active Durable tasks/,
      );
      guardTasks.cancel("resolver-still-active", Date.now(), { notifyCoordinator: false });
    } finally {
      guardTasks.close();
    }
    const finalized = await finalize();
    const finalizedReplay = await finalize();
    const finalizedValue = (finalized?.result as {
      structuredContent: {
        agent: { lifecycleState: string };
        worktree: { id: string; state: string; branch: string };
        replayed: boolean;
      };
    }).structuredContent;
    const finalizedReplayValue = (finalizedReplay?.result as {
      structuredContent: { worktree: { id: string; state: string }; replayed: boolean };
    }).structuredContent;
    assert.equal(finalizedValue.agent.lifecycleState, "ARCHIVED");
    assert.equal(finalizedValue.worktree.id, value.worktree.id);
    assert.equal(finalizedValue.worktree.state, "REMOVED");
    assert.equal(finalizedValue.replayed, false);
    assert.equal(finalizedReplayValue.worktree.id, value.worktree.id);
    assert.equal(finalizedReplayValue.worktree.state, "REMOVED");
    assert.equal(finalizedReplayValue.replayed, true);
    assert.equal(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), integrationRevision);
    assert.equal(execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  } finally {
    server.close();
  }
});
