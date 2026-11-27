import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectTaskStore } from "../src/node/tasks.js";

test("idle projects reconcile unified Provider fallback chains without rewriting models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-reconcile-"));
  const databasePath = join(dir, "projects.sqlite");
  let projects = new ProjectRegistry(databasePath);
  let tasks = new ProjectTaskStore(databasePath);
  try {
    for (const id of ["idle", "busy"]) {
      projects.create({
        id,
        templateId: "blank",
        templatePlan: [{ role: "coordinator", permissionProfile: "READ_ONLY" }],
        name: id,
        description: "Conservative defaults and no assumed worker team.",
        maxConcurrentTasks: 1,
      });
      projects.addMember(id, {
        id: `${id}-coordinator`,
        deviceId: "local-t3",
        sessionId: "t3-code",
        agentId: `${id}-coordinator`,
        name: "Coordinator",
        role: "coordinator",
        executor: "codex",
        model: "gpt-5.6-sol",
      });
    }
    projects.addMember("idle", {
      id: "idle-deepseek",
      deviceId: "local-t3",
      sessionId: "t3-code",
      agentId: "idle-deepseek",
      name: "DeepSeek Worker",
      role: "coder",
      executor: "pi",
      model: "deepseek/deepseek-flash",
      cwd: dir,
    });
    projects.addMember("idle", {
      id: "idle-codex-non-primary",
      deviceId: "local-t3",
      sessionId: "t3-code",
      agentId: "idle-codex-non-primary",
      name: "Codex Non-primary",
      role: "reviewer",
      executor: "codex",
      model: "gpt-6.2-sol",
    });
    projects.addMember("idle", {
      id: "idle-deepseek-non-primary",
      deviceId: "local-t3",
      sessionId: "t3-code",
      agentId: "idle-deepseek-non-primary",
      name: "DeepSeek Non-primary",
      role: "tester",
      executor: "pi",
      model: "deepseek/deepseek-v4-pro",
      cwd: dir,
    });
    projects.addMember("idle", {
      id: "idle-antigravity",
      deviceId: "local-t3",
      sessionId: "t3-code",
      agentId: "idle-antigravity",
      name: "Antigravity",
      role: "researcher",
      executor: "pi",
      model: "google/gemini-4-neon",
      cwd: dir,
    });
    projects.addMember("idle", {
      id: "idle-archived",
      deviceId: "local-t3",
      sessionId: "t3-code",
      agentId: "idle-archived",
      name: "Archived",
      role: "coder",
      executor: "codex",
      model: "gpt-5.6-sol",
      temporary: true,
    });
    projects.archiveMember("idle", "idle-archived");
    tasks.enqueue("busy", { id: "busy-task", title: "Still queued", input: {} });
    tasks.close();
    projects.close();

    const script = resolve(process.cwd(), "../../scripts/reconcile-durable-project-defaults.mjs");
    const result = spawnSync(process.execPath, [script, databasePath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.membersUpdated, 2);
    assert.equal(summary.blankPlansUpdated, 1);
    assert.deepEqual(summary.skippedBusyProjects, [{ projectId: "busy", activeTasks: 1 }]);

    projects = new ProjectRegistry(databasePath);
    const idle = projects.get("idle")!;
    const idleMembers = new Map(idle.members.map((member) => [member.id, member]));
    assert.equal(idleMembers.get("idle-coordinator")?.model, "gpt-5.6-sol");
    assert.equal(idleMembers.get("idle-coordinator")?.allowModelFallback, true);
    assert.deepEqual(idleMembers.get("idle-coordinator")?.fallbackModels, ["gpt-6-astra", "gpt-6.1-sol"]);
    assert.equal(idleMembers.get("idle-deepseek")?.model, "deepseek/deepseek-flash");
    assert.equal(idleMembers.get("idle-deepseek")?.allowModelFallback, true);
    assert.deepEqual(idleMembers.get("idle-deepseek")?.fallbackModels, ["deepseek/deepseek-v4-pro"]);
    for (const id of ["idle-codex-non-primary", "idle-deepseek-non-primary", "idle-antigravity"]) {
      assert.equal(idleMembers.get(id)?.allowModelFallback, false);
      assert.deepEqual(idleMembers.get(id)?.fallbackModels, []);
    }
    assert.equal(projects.getMember("idle", "idle-archived", true)?.allowModelFallback, false);
    assert.equal(idle.maxConcurrentTasks, 3);
    assert.deepEqual(idle.templatePlan.map((item) => item.role), ["coordinator", "coder", "tester", "reviewer"]);
    assert.equal(projects.events("idle")[0]?.kind, "project.defaults.reconciled");

    const busy = projects.get("busy")!;
    assert.equal(busy.members[0]?.model, "gpt-5.6-sol");
    assert.equal(busy.members[0]?.allowModelFallback, false);
    assert.equal(busy.maxConcurrentTasks, 1);
    assert.deepEqual(busy.templatePlan.map((item) => item.role), ["coordinator"]);
  } finally {
    try { tasks.close(); } catch {}
    try { projects.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
