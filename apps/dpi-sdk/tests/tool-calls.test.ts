import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectTaskStore } from "../src/node/tasks.js";
import { ProjectToolCallStore } from "../src/node/tool-calls.js";

test("tool evidence is fenced, idempotent, redacted and committed with its audit event", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-tool-calls-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  projects.create({ id: "alpha", name: "Alpha" });
  projects.addMember("alpha", { id: "coder", deviceId: "local", sessionId: "s", agentId: "a", role: "coder" });
  const tasks = new ProjectTaskStore(database);
  const tools = new ProjectToolCallStore(database);
  try {
    tasks.enqueue("alpha", { id: "test-task", title: "Run tests", input: {} }, 1_000);
    const lease = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 10_000 })!;
    const started = tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "started", at: 1_200,
      item: {
        id: "command-1", type: "commandExecution", status: "inProgress",
        command: "npm test -- --token=secret-value", cwd: "/repo",
        arguments: { apiKey: "unstructured-value", nested: { password: "another-plain-value" } },
      },
    });
    assert.equal(started.status, "STARTED");
    assert.equal(started.evidenceKind, "TEST");
    assert.match(JSON.stringify(started.request), /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(started.request), /secret-value/);
    assert.doesNotMatch(JSON.stringify(started.request), /unstructured-value|another-plain-value/);
    assert.match(JSON.stringify(started.request), /REDACTED_SECRET_FIELD/);
    const completedInput = {
      id: "command-1", type: "commandExecution", status: "completed", command: "npm test -- --token=secret-value",
      cwd: "/repo", exitCode: 0, aggregatedOutput: "ok Bearer top-secret-token",
    };
    const completed = tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed", at: 1_300, item: completedInput,
    });
    assert.equal(completed.id, started.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.exitCode, 0);
    assert.match(JSON.stringify(completed.result), /Bearer \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(completed.result), /top-secret-token/);
    assert.equal(tools.list("alpha", { taskId: lease.id }).length, 1);
    assert.equal(tools.list("alpha", { evidenceKind: "TEST" })[0]?.id, started.id);
    const eventCount = projects.events("alpha").filter((event) => event.kind.startsWith("codex.item.")).length;
    assert.equal(eventCount, 2);
    assert.equal(tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed", at: 1_400, item: completedInput,
    }).id, started.id);
    assert.equal(
      projects.events("alpha").filter((event) => event.kind.startsWith("codex.item.")).length,
      eventCount,
      "an identical completion replay creates neither a second row nor a second event",
    );
    assert.throws(() => tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed", item: { ...completedInput, exitCode: 1 },
    }), /different data/);
    tasks.complete(lease.id, "worker", lease.fenceEpoch, { ok: true }, 1_500);
    assert.equal(tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed", at: 1_600, item: completedInput,
    }).id, started.id, "an exact terminal-state replay is read-only and idempotent");
    assert.throws(() => tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "started", item: { id: "late", type: "fileChange", status: "inProgress" },
    }), /Stale task fence/);
  } finally {
    tools.close();
    tasks.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed commands and file changes retain authoritative evidence types", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-tool-calls-kinds-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  projects.create({ id: "alpha", name: "Alpha" });
  const tasks = new ProjectTaskStore(database);
  const tools = new ProjectToolCallStore(database);
  try {
    tasks.enqueue("alpha", { id: "build-task", title: "Build", input: {} }, 1_000);
    const lease = tasks.claim("alpha", "worker", { now: 1_100, leaseMs: 10_000 })!;
    const failed = tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed",
      item: { id: "build", type: "commandExecution", status: "failed", command: "npm run build", exitCode: 2, aggregatedOutput: "compile failed" },
    });
    assert.equal(failed.evidenceKind, "BUILD");
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.exitCode, 2);
    const fileChange = tools.record({
      projectId: "alpha", taskId: lease.id, attemptId: lease.attemptId, fenceEpoch: lease.fenceEpoch,
      memberId: "coder", event: "completed",
      item: { id: "files", type: "fileChange", status: "completed", changes: [{ path: "src/app.ts", kind: "update" }] },
    });
    assert.equal(fileChange.evidenceKind, "FILE_CHANGE");
    assert.equal(fileChange.status, "COMPLETED");
  } finally {
    tools.close();
    tasks.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
