import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { ProjectTaskStore } from "../../dpi-sdk/src/node/tasks.js";
import { T3ThreadLifecycleMonitor } from "../apps/dpi-playground-hub/src/t3-thread-lifecycle-monitor.js";

test("T3 child-thread lifecycle archives only idle stale workers after 24 hours", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-t3-thread-lifecycle-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const tasks = new ProjectTaskStore(database);
  try {
    projects.create({ id: "project", name: "Project" });
    const add = (id: string, role: string, environmentId?: string) => {
      projects.addMember("project", {
        id, deviceId: "local", sessionId: "t3", agentId: id, name: id, role,
        executor: "codex", model: "gpt-5.6-sol", cwd: root,
        ...(environmentId ? { t3EnvironmentId: environmentId } : {}),
      });
      projects.setMemberThread("project", id, `thread-${id}`, 0, "gpt-5.6-sol", "t3", "codex");
    };
    add("coordinator", "coordinator");
    add("stale", "coder", "env-mac");
    add("recent", "tester");
    add("busy", "reviewer");
    tasks.enqueue("project", {
      id: "busy-task", title: "Still queued",
      input: { kind: "agent.message", memberId: "busy", content: "work" },
    });
    tasks.enqueue("project", {
      id: "old-stale-task", title: "Old completed work",
      input: { kind: "agent.message", memberId: "stale", content: "old" },
    }, 1_000);
    const oldLease = tasks.claim("project", "worker", { now: 1_100, leaseMs: 10_000 })!;
    tasks.bindRuntime(oldLease.id, "worker", oldLease.fenceEpoch, {
      kind: "t3", threadId: "thread-stale-old", runId: "run-old", environmentId: "env-mac",
    }, 1_200);
    tasks.complete(oldLease.id, "worker", oldLease.fenceEpoch, { ok: true }, 1_300);
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    const archived: Array<Record<string, unknown>> = [];
    const runtime = {
      async inspectThread(input: { threadId: string; environmentId?: string }) {
        return {
          thread: {
            id: input.threadId,
            status: "completed",
            activeRunId: null,
            archived: false,
            updatedAt: input.threadId.startsWith("thread-stale")
              ? "2026-11-25T11:59:59.000Z"
              : "2026-11-26T11:30:00.000Z",
          },
          items: [],
        };
      },
      async organizeThread(input: Record<string, unknown>) {
        archived.push(input);
        return { sequence: 1 };
      },
    };
    const monitor = new T3ThreadLifecycleMonitor(tasks, projects, runtime, 24 * 60 * 60_000);

    assert.deepEqual(await monitor.runOnce(now), { inspected: 3, archived: 2, errors: 0 });
    assert.deepEqual(archived, [
      { threadId: "thread-stale", action: "archive", environmentId: "env-mac" },
      { threadId: "thread-stale-old", action: "archive", environmentId: "env-mac" },
    ]);
    assert.equal(projects.events("project").some((event) => event.kind === "member.thread.auto_archived"), true);
  } finally {
    tasks.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 child-thread lifecycle backs off recent archive failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-t3-thread-backoff-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const tasks = new ProjectTaskStore(database);
  try {
    projects.create({ id: "project", name: "Project" });
    projects.addMember("project", {
      id: "worker", deviceId: "linux", sessionId: "t3", agentId: "worker", name: "worker", role: "coder",
      executor: "codex", model: "gpt-5.6-sol", cwd: root, t3EnvironmentId: "env-linux",
    });
    projects.setMemberThread("project", "worker", "thread-worker", 0, "gpt-5.6-sol", "t3", "codex");
    projects.event("project", "member.thread_auto_archive_failed", {
      memberId: "worker", threadId: "thread-worker", environmentId: "env-linux", message: "legacy link",
    });
    let inspected = 0;
    const monitor = new T3ThreadLifecycleMonitor(tasks, projects, {
      async inspectThread() { inspected += 1; return { thread: {} }; },
      async organizeThread() { return { sequence: 1 }; },
    });

    assert.deepEqual(await monitor.runOnce(Date.now()), { inspected: 0, archived: 0, errors: 0 });
    assert.equal(inspected, 0);
  } finally {
    tasks.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
