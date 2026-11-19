import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectTaskStore } from "../src/node/tasks.js";

test("project tasks use atomic leases and reject stale fencing epochs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tasks-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const first = new ProjectTaskStore(path);
  const second = new ProjectTaskStore(path);
  try {
    const task = first.enqueue(
      "alpha",
      { id: "task-1", title: "Build feature", input: { goal: "ship" }, maxAttempts: 3 },
      1_000,
    );
    assert.equal(task.status, "QUEUED");
    assert.equal(projects.events("alpha")[0]?.kind, "task.queued");

    const leaseA = first.claim("alpha", "worker-a", { now: 1_100, leaseMs: 1_000 })!;
    assert.equal(leaseA.fenceEpoch, 1);
    assert.equal(leaseA.attemptNumber, 1);
    assert.equal(second.claim("alpha", "worker-b", { now: 1_200, leaseMs: 1_000 }), undefined);

    const leaseB = second.claim("alpha", "worker-b", { now: 2_101, leaseMs: 2_000 })!;
    assert.equal(leaseB.id, task.id);
    assert.equal(leaseB.fenceEpoch, 2);
    assert.equal(leaseB.attemptNumber, 2);
    assert.throws(() => first.heartbeat(task.id, "worker-a", 1, 1_000, 2_200), /Stale or expired/);
    assert.throws(() => first.complete(task.id, "worker-a", 1, { stale: true }, 2_200), /Stale or expired/);

    const heartbeat = second.heartbeat(task.id, "worker-b", 2, 2_000, 2_200);
    assert.equal(heartbeat.leaseUntil, 4_200);
    const done = second.complete(task.id, "worker-b", 2, { revision: "abc123" }, 2_300);
    assert.equal(done.status, "COMPLETED");
    assert.deepEqual(done.result, { revision: "abc123" });
    assert.deepEqual(
      second.attempts(task.id).map((attempt) => [attempt.attemptNumber, attempt.workerId, attempt.fenceEpoch, attempt.status]),
      [
        [1, "worker-a", 1, "EXPIRED"],
        [2, "worker-b", 2, "COMPLETED"],
      ],
    );
    assert.equal(projects.events("alpha")[0]?.kind, "task.completed");
  } finally {
    second.close();
    first.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("member workloads expose exact bounded scheduling metadata without task input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-workloads-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", {
      id: "coder-low", title: "Low priority",
      input: { kind: "agent.message", memberId: "coder", content: "private task body" },
      priority: 1,
    }, 1_000);
    tasks.enqueue("alpha", {
      id: "coder-high", title: "High priority",
      input: { kind: "agent.message", memberId: "coder", content: "another private body" },
      priority: 10,
    }, 1_001);
    tasks.enqueue("alpha", {
      id: "review", title: "Review",
      input: { kind: "agent.message", memberId: "reviewer", content: "review body" },
    }, 1_002);
    const running = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 10_000 })!;
    assert.equal(running.id, "coder-high");

    const workloads = tasks.memberWorkloads("alpha", 1);
    assert.deepEqual(workloads.get("coder"), {
      activeTaskCount: 2,
      statusCounts: { RUNNING: 1, QUEUED: 1 },
      tasks: [{ id: "coder-high", title: "High priority", status: "RUNNING", priority: 10, updatedAt: 1_100 }],
      truncated: true,
    });
    assert.equal(workloads.get("reviewer")?.activeTaskCount, 1);
    assert.equal("input" in workloads.get("coder")!.tasks[0]!, false);
    assert.deepEqual(tasks.listForMember("alpha", "coder").map((task) => task.id), ["coder-high", "coder-low"]);
    assert.deepEqual(tasks.listForMember("alpha", "reviewer").map((task) => task.id), ["review"]);
    assert.throws(() => tasks.memberWorkloads("alpha", 101), /taskLimitPerMember/);
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded administrative enqueue enforces the project active-task limit inside the transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-admission-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha", maxActiveTasks: 1 });
  const first = new ProjectTaskStore(path);
  const second = new ProjectTaskStore(path);
  try {
    first.enqueue("alpha", { id: "one", title: "One" }, 1_000, 1);
    assert.throws(
      () => second.enqueue("alpha", { id: "two", title: "Two" }, 1_001, 1),
      /active task limit reached/,
    );
    first.cancel("one", 1_100);
    assert.equal(second.enqueue("alpha", { id: "two", title: "Two" }, 1_101, 1).status, "QUEUED");
    assert.throws(() => second.enqueue("alpha", { id: "bad", title: "Bad" }, 1_102, 0), /maxActiveTasks/);
  } finally {
    second.close();
    first.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("external runtime identity is fenced, durable and only fills missing fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-runtime-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "runtime", title: "Run in T3", maxAttempts: 2 }, 1_000);
    const first = tasks.claim("alpha", "worker-a", { now: 1_100, leaseMs: 1_000 })!;
    assert.deepEqual(tasks.bindRuntime("runtime", "worker-a", first.fenceEpoch, {
      kind: "t3", threadId: "thread-1", provider: "codex", model: "model-1",
    }, 1_200), {
      kind: "t3", threadId: "thread-1", provider: "codex", model: "model-1",
    });
    assert.deepEqual(tasks.bindRuntime("runtime", "worker-a", first.fenceEpoch, {
      kind: "t3", threadId: "thread-1", runId: "run-1", provider: "codex", model: "model-1",
    }, 1_300), {
      kind: "t3", threadId: "thread-1", runId: "run-1", provider: "codex", model: "model-1",
    });
    assert.equal(tasks.attempts("runtime")[0]?.runtime?.runId, "run-1");
    assert.throws(() => tasks.bindRuntime("runtime", "worker-a", first.fenceEpoch, {
      kind: "t3", threadId: "thread-other",
    }, 1_400), /already bound/);

    const second = tasks.claim("alpha", "worker-b", { now: 2_101, leaseMs: 2_000 })!;
    assert.throws(() => tasks.bindRuntime("runtime", "worker-a", first.fenceEpoch, {
      kind: "t3", threadId: "thread-1", runId: "run-1",
    }, 2_200), /Stale or expired/);
    tasks.bindRuntime("runtime", "worker-b", second.fenceEpoch, {
      kind: "t3", threadId: "thread-2", runId: "run-2", environmentId: "env-b",
    }, 2_200);
    assert.deepEqual(tasks.attempts("runtime").map((attempt) => attempt.runtime?.threadId), ["thread-1", "thread-2"]);
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed tasks retry up to maxAttempts and cancellation fences a running worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-retry-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  projects.addMember("alpha", {
    id: "coordinator", deviceId: "local", sessionId: "session", agentId: "coordinator",
    name: "Coordinator", role: "coordinator",
  });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "retry", title: "Retry me", maxAttempts: 2 }, 1_000);
    const first = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 2_000 })!;
    const retrying = tasks.fail("retry", "worker", first.fenceEpoch, { code: "TEMPORARY" }, { now: 1_200, retryDelayMs: 500 });
    assert.equal(retrying.status, "RETRYING");
    assert.equal(tasks.claim("alpha", "worker", { now: 1_600 }), undefined);
    const second = tasks.claim("alpha", "worker", { now: 1_700, leaseMs: 2_000 })!;
    const failed = tasks.fail("retry", "worker", second.fenceEpoch, { code: "PERMANENT" }, { now: 1_800 });
    assert.equal(failed.status, "FAILED");
    assert.equal(tasks.claim("alpha", "worker", { now: 1_900 }), undefined);

    tasks.enqueue("alpha", { id: "invalid", title: "Do not retry", maxAttempts: 5 }, 1_900);
    const invalid = tasks.claim("alpha", "worker", { now: 2_000, leaseMs: 2_000 })!;
    assert.equal(
      tasks.fail("invalid", "worker", invalid.fenceEpoch, { code: "INVALID_INPUT" }, { now: 2_050, retryable: false }).status,
      "FAILED",
    );

    tasks.enqueue("alpha", {
      id: "cancel", title: "Cancel me",
      input: {
        kind: "agent.message", memberId: "coder", content: "work", messageId: "cancel-assignment",
        payload: {
          replyToMemberId: "coordinator", coordinationDepth: 2, coordinationRootTaskId: "root",
        },
      },
    }, 2_000);
    const active = tasks.claim("alpha", "worker", { now: 2_100, leaseMs: 2_000 })!;
    const cancelled = tasks.cancel("cancel", 2_200);
    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(cancelled.fenceEpoch > active.fenceEpoch);
    const cancellationNotice = tasks.list("alpha").find((task) => task.title === "Cancelled: Cancel me");
    assert.ok(cancellationNotice);
    assert.equal(cancellationNotice.status, "QUEUED");
    assert.equal((cancellationNotice.input as { messageType?: string }).messageType, "task_blocked");
    assert.equal((cancellationNotice.input as { payload?: { code?: string } }).payload?.code, "TASK_CANCELLED");
    assert.equal((cancellationNotice.input as { payload?: { effectsMayPersist?: boolean } }).payload?.effectsMayPersist, true);
    assert.throws(() => tasks.complete("cancel", "worker", active.fenceEpoch, {}, 2_300), /Stale or expired/);
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal failure and its Coordinator notification commit atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-failure-notice-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "source", title: "Source", maxAttempts: 1 }, 1_000);
    const lease = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 2_000 })!;
    const failed = tasks.fail("source", "worker", lease.fenceEpoch, { code: "PERMANENT" }, {
      now: 1_200,
      retryable: false,
      finalFailureTask: {
        id: "failure-notice",
        title: "Failed: Source",
        input: { kind: "agent.message", memberId: "coordinator", messageType: "task_failed", content: "failed" },
      },
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(tasks.get("failure-notice")?.status, "QUEUED");
    assert.equal(tasks.activeCount("alpha"), 1);

    tasks.enqueue("alpha", { id: "conflicting-notice", title: "Existing", input: { value: 1 } }, 1_300);
    tasks.enqueue("alpha", { id: "rollback-source", title: "Rollback source", maxAttempts: 1 }, 1_301);
    const rollbackLease = tasks.claim("alpha", "worker", { now: 1_400, leaseMs: 2_000 })!;
    assert.equal(rollbackLease.id, "failure-notice");
    tasks.cancel("failure-notice", 1_450);
    const sourceLease = tasks.claim("alpha", "worker", { now: 1_500, leaseMs: 2_000 })!;
    assert.equal(sourceLease.id, "conflicting-notice");
    tasks.cancel("conflicting-notice", 1_550);
    const finalLease = tasks.claim("alpha", "worker", { now: 1_600, leaseMs: 2_000 })!;
    assert.equal(finalLease.id, "rollback-source");
    tasks.enqueue("alpha", { id: "collision", title: "Other", input: { value: 2 } }, 1_650);
    assert.throws(() => tasks.fail("rollback-source", "worker", finalLease.fenceEpoch, { code: "FAIL" }, {
      now: 1_700,
      retryable: false,
      finalFailureTask: { id: "collision", title: "Failed: Rollback", input: { value: 3 } },
    }), /does not match/);
    assert.equal(tasks.get("rollback-source")?.status, "RUNNING", "the failed source mutation rolls back with the notification collision");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Coordinator task admission checks idempotency and limits in one transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-coordination-admission-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "prerequisite", title: "Prerequisite" }, 800);
    const prerequisite = tasks.claim("alpha", "setup-worker", { now: 850, leaseMs: 2_000 })!;
    tasks.complete(prerequisite.id, "setup-worker", prerequisite.fenceEpoch, {}, 900);
    const taskInput = {
      kind: "agent.message", memberId: "coder", content: "work",
      payload: { coordinatorTaskId: "coordinator-turn" },
    };
    const first = tasks.enqueueCoordination("alpha", {
      id: "delegated-one", title: "Delegated one", input: taskInput,
      priority: 10, maxAttempts: 2, timeoutMs: 30_000, dependsOn: ["prerequisite"],
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 1, maxActiveProjectTasks: 10,
    }, 1_000);
    assert.equal(first.status, "QUEUED");
    assert.equal(first.priority, 10);
    assert.equal(first.maxAttempts, 2);
    assert.equal(first.timeoutMs, 30_000);
    assert.deepEqual(first.dependsOn, ["prerequisite"]);
    assert.equal(tasks.activeCountForMember("alpha", "coder"), 1);
    const replay = tasks.enqueueCoordination("alpha", {
      id: "delegated-one", title: "Delegated one", input: taskInput,
      priority: 10, maxAttempts: 2, timeoutMs: 30_000, dependsOn: ["prerequisite"],
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 1, maxActiveProjectTasks: 1,
    }, 1_001);
    assert.equal(replay.id, first.id, "an immutable Call ID replay bypasses later admission changes");
    assert.throws(() => tasks.enqueueCoordination("alpha", {
      id: "delegated-one", title: "Delegated one", input: taskInput,
      priority: 11, maxAttempts: 2, timeoutMs: 30_000, dependsOn: ["prerequisite"],
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 2, maxActiveProjectTasks: 10,
    }, 1_001), /reused with different/);
    assert.throws(() => tasks.enqueueCoordination("alpha", {
      id: "delegated-one", title: "Delegated one", input: taskInput,
      priority: 10, maxAttempts: 2, timeoutMs: 30_000, dependsOn: [],
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 2, maxActiveProjectTasks: 10,
    }, 1_001), /reused with different/);
    assert.throws(() => tasks.enqueueCoordination("alpha", {
      id: "delegated-one", title: "Changed title", input: taskInput,
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 2, maxActiveProjectTasks: 10,
    }, 1_002), /reused with different/);
    assert.throws(() => tasks.enqueueCoordination("alpha", {
      id: "delegated-two", title: "Delegated two",
      input: { ...taskInput, content: "more" },
    }, {
      coordinatorTaskId: "coordinator-turn", maxDelegatedTasksPerTurn: 1, maxActiveProjectTasks: 10,
    }, 1_003), /delegation limit reached \(1\)/);
    assert.throws(() => tasks.enqueueCoordination("alpha", {
      id: "other-turn", title: "Other turn",
      input: { ...taskInput, payload: { coordinatorTaskId: "other-coordinator-turn" } },
    }, {
      coordinatorTaskId: "other-coordinator-turn", maxDelegatedTasksPerTurn: 5, maxActiveProjectTasks: 1,
    }, 1_004), /active task limit reached \(1\)/);
    assert.equal(tasks.list("alpha").length, 2);

    projects.create({ id: "dag", name: "DAG" });
    tasks.enqueue("dag", { id: "dag-parent", title: "DAG parent" }, 2_000);
    const dependent = tasks.enqueueCoordination("dag", {
      id: "dag-child", title: "DAG child",
      input: { ...taskInput, payload: { coordinatorTaskId: "dag-coordinator" } },
      dependsOn: ["dag-parent"],
    }, {
      coordinatorTaskId: "dag-coordinator", maxDelegatedTasksPerTurn: 2, maxActiveProjectTasks: 10,
    }, 2_001);
    assert.equal(dependent.status, "WAITING_DEPENDENCY");
    assert.deepEqual(dependent.dependsOn, ["dag-parent"]);
    const parentLease = tasks.claim("dag", "dag-worker", { now: 2_100, leaseMs: 2_000 })!;
    assert.equal(parentLease.id, "dag-parent", "the dependent task must not be claimable early");
    tasks.complete(parentLease.id, "dag-worker", parentLease.fenceEpoch, {}, 2_200);
    assert.equal(tasks.get("dag-child")?.status, "QUEUED", "completion atomically releases the dependent task");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution receipts survive a failed completion commit and are fenced from stale workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-receipt-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  const requestSha256 = "a".repeat(64);
  try {
    tasks.enqueue("alpha", { id: "receipt", title: "External side effect", maxAttempts: 3 }, 1_000);
    const first = tasks.claim("alpha", "worker-a", { now: 1_100, leaseMs: 2_000 })!;
    const recorded = tasks.recordExecutionReceipt(
      first.id,
      "worker-a",
      first.fenceEpoch,
      requestSha256,
      { status: "done", submissionId: "turn-1", answer: { text: "finished" } },
      1_200,
    );
    assert.equal(recorded.attemptId, first.attemptId);
    assert.equal(recorded.fenceEpoch, first.fenceEpoch);
    tasks.fail(first.id, "worker-a", first.fenceEpoch, { code: "COMMIT_INTERRUPTED" }, { now: 1_300, retryDelayMs: 0 });

    const second = tasks.claim("alpha", "worker-b", { now: 1_301, leaseMs: 2_000 })!;
    assert.deepEqual(tasks.executionReceipt(second.id)?.result, {
      status: "done",
      submissionId: "turn-1",
      answer: { text: "finished" },
    });
    assert.throws(
      () => tasks.recordExecutionReceipt(second.id, "worker-b", second.fenceEpoch, "b".repeat(64), {}, 1_400),
      /input hash mismatch/,
    );
    assert.equal(
      tasks.recordExecutionReceipt("receipt", "worker-a", first.fenceEpoch, requestSha256, {}, 1_400).attemptId,
      first.attemptId,
      "repeating the same receipt is idempotent even after ownership changes",
    );
    tasks.complete(second.id, "worker-b", second.fenceEpoch, tasks.executionReceipt(second.id)?.result, 1_500);
    assert.equal(tasks.get(second.id)?.status, "COMPLETED");
    tasks.enqueue("alpha", { id: "stale-receipt", title: "Fence stale receipt", maxAttempts: 2 }, 2_000);
    const stale = tasks.claim("alpha", "worker-a", { now: 2_100, leaseMs: 1_000 })!;
    tasks.claim("alpha", "worker-b", { now: 3_101, leaseMs: 2_000 });
    assert.throws(
      () => tasks.recordExecutionReceipt("stale-receipt", "worker-a", stale.fenceEpoch, requestSha256, {}, 3_200),
      /Stale or expired/,
    );
    assert.ok(projects.events("alpha").some((event) => event.kind === "task.execution_receipt_recorded"));
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("device-offline deferral releases the lease without consuming the failure retry budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-device-wait-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "remote-task", title: "Run remotely", maxAttempts: 1 }, 1_000);
    const first = tasks.claim("alpha", "worker-a", { now: 1_100, leaseMs: 2_000 })!;
    const waiting = tasks.waitForDevice(first.id, "worker-a", first.fenceEpoch, "device-b", "offline", {
      now: 1_200,
      blockedTask: {
        id: "device-blocked-notice",
        title: "Blocked: Run remotely",
        input: { kind: "agent.message", memberId: "coordinator", messageType: "task_blocked", content: "offline" },
      },
    });
    assert.equal(waiting.status, "WAITING_DEVICE");
    assert.equal(waiting.waitingDeviceId, "device-b");
    assert.equal(waiting.deferredAttemptCount, 1);
    const notice = tasks.claim("alpha", "worker-b", { now: 1_300, leaseMs: 2_000 });
    assert.equal(notice?.id, "device-blocked-notice");
    tasks.cancel("device-blocked-notice", 1_350);
    assert.equal(tasks.resumeDevice("device-c", 1_400), 0);
    assert.equal(tasks.resumeDevice("device-b", 1_500), 1);

    const second = tasks.claim("alpha", "worker-b", { now: 1_501, leaseMs: 2_000 });
    assert.ok(second, "the offline attempt is excluded from maxAttempts=1");
    tasks.complete(second.id, "worker-b", second.fenceEpoch, { ok: true }, 1_600);
    assert.deepEqual(
      tasks.attempts("remote-task").map((attempt) => attempt.status),
      ["WAITING_DEVICE", "COMPLETED"],
    );

    tasks.enqueue("alpha", { id: "pause-wait", title: "Pause waiting task" }, 2_000);
    const pauseLease = tasks.claim("alpha", "worker-a", { now: 2_100, leaseMs: 2_000 })!;
    tasks.waitForDevice(pauseLease.id, "worker-a", pauseLease.fenceEpoch, "device-b", "offline", { now: 2_200 });
    assert.equal(tasks.pause("pause-wait", 2_300).pausedFromStatus, "WAITING_DEVICE");
    const resumed = tasks.resume("pause-wait", 2_400);
    assert.equal(resumed.status, "WAITING_DEVICE");
    assert.equal(resumed.waitingDeviceId, "device-b");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider circuit deferral releases the lease without consuming retry budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-provider-wait-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "provider-task", title: "Wait for provider", maxAttempts: 1 }, 1_000);
    const first = tasks.claim("alpha", "worker-a", { now: 1_100, leaseMs: 2_000 })!;
    const waiting = tasks.deferForProvider(
      first.id,
      "worker-a",
      first.fenceEpoch,
      "codex",
      "model-a",
      5_000,
      1_200,
    );
    assert.equal(waiting.status, "RETRYING");
    assert.equal(waiting.availableAt, 5_000);
    assert.equal(waiting.deferredAttemptCount, 1);
    assert.equal((waiting.error as { code: string }).code, "PROVIDER_CIRCUIT_OPEN");
    assert.equal(tasks.claim("alpha", "worker-b", { now: 4_999, leaseMs: 2_000 }), undefined);
    const second = tasks.claim("alpha", "worker-b", { now: 5_000, leaseMs: 2_000 })!;
    assert.ok(second, "provider deferral is excluded from maxAttempts=1");
    tasks.complete(second.id, "worker-b", second.fenceEpoch, { ok: true }, 5_100);
    assert.deepEqual(tasks.attempts("provider-task").map((attempt) => attempt.status), ["WAITING_PROVIDER", "COMPLETED"]);
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval waits are bound to the current fence and consumed approvals pause takeover as unknown side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-approval-fence-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "approval-fence", title: "Approval fence", maxAttempts: 3 }, 1_000);
    const first = tasks.claim("alpha", "worker-a", { now: 1_100, leaseMs: 1_000 })!;
    const waiting = tasks.waitForApproval(first.id, "worker-a", first.fenceEpoch, "approval-old", 1_200);
    assert.equal(waiting.status, "WAITING_APPROVAL");
    assert.equal(waiting.waitingApprovalId, "approval-old");
    assert.throws(
      () => tasks.resumeFromApproval(first.id, "worker-a", first.fenceEpoch, "approval-other", 1_300),
      /does not belong/,
    );

    const takeover = tasks.claim("alpha", "worker-b", { now: 2_101, leaseMs: 2_000 })!;
    assert.equal(takeover.supersededApprovalId, "approval-old");
    assert.equal(takeover.waitingApprovalId, undefined);
    const paused = tasks.pauseForUnknownSideEffect(
      takeover.id,
      "worker-b",
      takeover.fenceEpoch,
      "approval-old",
      "approval was consumed before takeover",
      2_200,
    );
    assert.equal(paused.status, "PAUSED");
    assert.equal((paused.error as { code: string }).code, "UNKNOWN_SIDE_EFFECT");
    assert.deepEqual(tasks.attempts(takeover.id).map((attempt) => attempt.status), ["EXPIRED", "CANCELLED"]);
    assert.throws(() => tasks.resume(takeover.id, 2_300), /explicit operator resolution/);
    const cleared = tasks.resolveUnknownSideEffect(
      takeover.id,
      "RETRY",
      "operator-a",
      "Verified that the target file was not created",
      2_400,
    );
    assert.equal(cleared.status, "QUEUED");
    assert.equal(cleared.deferredAttemptCount, 1);
    assert.equal(cleared.error, undefined);
    tasks.cancel(cleared.id, 2_500);

    tasks.enqueue("alpha", { id: "approval-applied", title: "Applied approval", maxAttempts: 3 }, 3_000);
    const appliedFirst = tasks.claim("alpha", "worker-a", { now: 3_100, leaseMs: 1_000 })!;
    tasks.waitForApproval(appliedFirst.id, "worker-a", appliedFirst.fenceEpoch, "approval-applied-old", 3_200);
    const appliedTakeover = tasks.claim("alpha", "worker-b", { now: 4_101, leaseMs: 2_000 })!;
    tasks.pauseForUnknownSideEffect(
      appliedTakeover.id,
      "worker-b",
      appliedTakeover.fenceEpoch,
      "approval-applied-old",
      "approval may have changed an external system",
      4_200,
    );
    tasks.enqueue("alpha", { id: "after-applied", title: "After applied", dependsOn: [appliedTakeover.id] }, 4_300);
    const completed = tasks.resolveUnknownSideEffect(
      appliedTakeover.id,
      "MARK_COMPLETED",
      "operator-b",
      "Verified the deployment exists with the expected revision",
      4_400,
    );
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(completed.result, {
      kind: "operator_confirmed_side_effect",
      actor: "operator-b",
      note: "Verified the deployment exists with the expected revision",
      approvalId: "approval-applied-old",
      confirmedAt: 4_400,
    });
    assert.equal(tasks.get("after-applied")?.status, "QUEUED");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependencies block claims, unlock on completion and fail transitively", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-deps-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "research", title: "Research" }, 1_000);
    const build = tasks.enqueue(
      "alpha",
      { id: "build", title: "Build", dependsOn: ["research"] },
      1_001,
    );
    const testTask = tasks.enqueue(
      "alpha",
      { id: "test", title: "Test", dependsOn: ["build"] },
      1_002,
    );
    assert.equal(build.status, "WAITING_DEPENDENCY");
    assert.deepEqual(build.dependsOn, ["research"]);
    assert.equal(testTask.status, "WAITING_DEPENDENCY");

    const research = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 2_000 })!;
    assert.equal(research.id, "research");
    tasks.complete("research", "worker", research.fenceEpoch, {}, 1_200);
    assert.equal(tasks.get("build")?.status, "QUEUED");
    assert.equal(tasks.get("test")?.status, "WAITING_DEPENDENCY");

    const claimedBuild = tasks.claim("alpha", "worker", { now: 1_300, leaseMs: 2_000 })!;
    assert.equal(claimedBuild.id, "build");
    tasks.fail("build", "worker", claimedBuild.fenceEpoch, { code: "BROKEN" }, { now: 1_400, retryable: false });
    assert.equal(tasks.get("build")?.status, "FAILED");
    assert.equal(tasks.get("test")?.status, "FAILED");
    assert.deepEqual(tasks.get("test")?.error, {
      code: "DEPENDENCY_FAILED",
      dependencyTaskId: "build",
      dependencyStatus: "FAILED",
    });
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued and dependency-waiting tasks pause and resume without pretending to pause live work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-pause-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "parent", title: "Parent" }, 1_000);
    tasks.enqueue("alpha", { id: "child", title: "Child", dependsOn: ["parent"] }, 1_001);
    const paused = tasks.pause("child", 1_100);
    assert.equal(paused.status, "PAUSED");
    assert.equal(paused.pausedFromStatus, "WAITING_DEPENDENCY");
    assert.equal(tasks.resume("child", 1_200).status, "WAITING_DEPENDENCY");

    const parent = tasks.claim("alpha", "worker", { now: 1_300, leaseMs: 2_000 })!;
    assert.throws(() => tasks.pause("parent", 1_400), /must be cancelled/);
    tasks.complete("parent", "worker", parent.fenceEpoch, {}, 1_500);
    assert.equal(tasks.get("child")?.status, "QUEUED");
    assert.equal(tasks.pause("child", 1_600).status, "PAUSED");
    assert.equal(tasks.claim("alpha", "worker", { now: 1_700 }), undefined);
    assert.equal(tasks.resume("child", 1_800).status, "QUEUED");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claim enforces global, project and worker concurrency inside the claim transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-limits-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  projects.create({ id: "beta", name: "Beta" });
  const first = new ProjectTaskStore(path);
  const second = new ProjectTaskStore(path);
  try {
    first.enqueue("alpha", { id: "a1", title: "A1" }, 1_000);
    first.enqueue("alpha", { id: "a2", title: "A2" }, 1_001);
    first.enqueue("beta", { id: "b1", title: "B1" }, 1_002);
    first.enqueue("beta", { id: "b2", title: "B2" }, 1_003);

    const a1 = first.claim("alpha", "worker-a", {
      now: 1_100,
      leaseMs: 10_000,
      maxGlobalRunning: 2,
      maxProjectRunning: 1,
    })!;
    assert.equal(a1.id, "a1");
    assert.equal(
      second.claim("alpha", "worker-b", {
        now: 1_101,
        maxGlobalRunning: 2,
        maxProjectRunning: 1,
      }),
      undefined,
    );
    const b1 = second.claim("beta", "worker-a", {
      now: 1_102,
      leaseMs: 10_000,
      maxGlobalRunning: 2,
      maxProjectRunning: 1,
      maxWorkerRunning: 2,
    })!;
    assert.equal(b1.id, "b1");
    assert.equal(
      second.claim("beta", "worker-b", { now: 1_103, maxGlobalRunning: 2 }),
      undefined,
    );

    first.complete("a1", "worker-a", a1.fenceEpoch, {}, 1_200);
    assert.equal(
      first.claim("alpha", "worker-a", { now: 1_201, maxWorkerRunning: 1 }),
      undefined,
    );
    const a2 = first.claim("alpha", "worker-b", {
      now: 1_202,
      leaseMs: 10_000,
      maxGlobalRunning: 2,
      maxProjectRunning: 1,
      maxWorkerRunning: 1,
    });
    assert.equal(a2?.id, "a2");
  } finally {
    second.close();
    first.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claim serializes each member and shared Codex workspace while allowing distinct worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-member-lock-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  for (const [id, cwd] of [
    ["coder-a", join(dir, "shared")],
    ["coder-b", join(dir, "shared")],
    ["coder-c", join(dir, "worktree-c")],
  ] as const) projects.addMember("alpha", {
    id, deviceId: "local-codex", sessionId: "codex-app-server", agentId: id,
    name: id, role: "coder", executor: "codex", model: "current-model", cwd,
  });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", {
      id: "coder-a-1", title: "A first",
      input: { kind: "agent.message", memberId: "coder-a", content: "first" },
    }, 1_000);
    tasks.enqueue("alpha", {
      id: "coder-a-2", title: "A second",
      input: { kind: "agent.message", memberId: "coder-a", content: "second" },
    }, 1_001);
    tasks.enqueue("alpha", {
      id: "coder-b-1", title: "B first",
      input: { kind: "agent.message", memberId: "coder-b", content: "same workspace" },
    }, 1_002);
    tasks.enqueue("alpha", {
      id: "coder-c-1", title: "C first",
      input: { kind: "agent.message", memberId: "coder-c", content: "different worktree" },
    }, 1_003);
    const a = tasks.claim("alpha", "worker", {
      now: 1_100, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    })!;
    const b = tasks.claim("alpha", "worker", {
      now: 1_101, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    })!;
    assert.equal(a.id, "coder-a-1");
    assert.equal(b.id, "coder-c-1", "the scheduler skips both the active member and another member sharing its workspace");
    assert.equal(tasks.claim("alpha", "worker", {
      now: 1_102, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    }), undefined);
    tasks.complete(a.id, "worker", a.fenceEpoch, {}, 1_200);
    const nextA = tasks.claim("alpha", "worker", {
      now: 1_201, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    });
    assert.equal(nextA?.id, "coder-a-2");
    tasks.complete(nextA!.id, "worker", nextA!.fenceEpoch, {}, 1_300);
    const sameWorkspaceAfterRelease = tasks.claim("alpha", "worker", {
      now: 1_301, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    });
    assert.equal(sameWorkspaceAfterRelease?.id, "coder-b-1");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("remote workspace locks are scoped by T3 environment and target-native path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-remote-lock-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  for (const [id, environment] of [
    ["linux-b-1", "env-linux-b"],
    ["linux-b-2", "env-linux-b"],
    ["linux-c", "env-linux-c"],
  ] as const) projects.addMember("alpha", {
    id, deviceId: "local-codex", sessionId: "t3", agentId: id,
    name: id, role: "coder", executor: "codex", model: "current-model",
    cwd: "/srv/project", t3EnvironmentId: environment,
  });
  const tasks = new ProjectTaskStore(path);
  try {
    for (const [index, memberId] of ["linux-b-1", "linux-b-2", "linux-c"].entries())
      tasks.enqueue("alpha", {
        id: `remote-${index}`, title: memberId,
        input: { kind: "agent.message", memberId, content: "work" },
      }, 1_000 + index);
    const first = tasks.claim("alpha", "worker", {
      now: 1_100, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    })!;
    const second = tasks.claim("alpha", "worker", {
      now: 1_101, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    })!;
    assert.equal(first.title, "linux-b-1");
    assert.equal(second.title, "linux-c", "the same path on another machine is an independent resource");
    assert.equal(tasks.claim("alpha", "worker", {
      now: 1_102, leaseMs: 10_000, maxGlobalRunning: 3, maxProjectRunning: 3, maxWorkerRunning: 3,
    }), undefined, "the same target path on the same machine remains serialized");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("project deletion fence atomically rejects new task admission and can be rolled back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-task-delete-fence-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(path);
  try {
    tasks.enqueue("alpha", { id: "active", title: "Active" }, 1_000);
    assert.throws(() => projects.beginRemoval("alpha", 1_001), /still has 1 active task/);
    tasks.cancel("active", 1_002, { reason: "test" });
    assert.deepEqual(projects.beginRemoval("alpha", 1_003, ["device-b", "device-a"]), {
      projectId: "alpha", startedAt: 1_003, sourceIds: ["device-a", "device-b"], resumed: false,
    });
    assert.deepEqual(projects.beginRemoval("alpha", 1_999, []), {
      projectId: "alpha", startedAt: 1_003, sourceIds: ["device-a", "device-b"], resumed: true,
    });
    assert.throws(
      () => tasks.enqueue("alpha", { id: "too-late", title: "Too late" }, 1_004),
      /deletion is in progress/,
    );
    assert.equal(projects.cancelRemoval("alpha"), true);
    assert.equal(tasks.enqueue("alpha", { id: "after-rollback", title: "After rollback" }, 1_005).status, "QUEUED");
  } finally {
    tasks.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});
