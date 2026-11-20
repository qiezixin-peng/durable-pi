import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectTaskStore } from "../src/node/tasks.js";

test("legacy idle projects receive the current model and on-demand team plan", async () => {
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
        model: "gpt-6.2-sol",
      });
    }
    tasks.enqueue("busy", { id: "busy-task", title: "Still queued", input: {} });
    tasks.close();
    projects.close();

    const script = resolve(process.cwd(), "../../scripts/reconcile-durable-project-defaults.mjs");
    const result = spawnSync(process.execPath, [script, databasePath, "gpt-5.6-sol"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.membersUpdated, 1);
    assert.equal(summary.blankPlansUpdated, 1);
    assert.deepEqual(summary.skippedBusyProjects, [{ projectId: "busy", activeTasks: 1 }]);

    projects = new ProjectRegistry(databasePath);
    const idle = projects.get("idle")!;
    assert.equal(idle.members[0]?.model, "gpt-5.6-sol");
    assert.equal(idle.maxConcurrentTasks, 3);
    assert.deepEqual(idle.templatePlan.map((item) => item.role), ["coordinator", "coder", "tester", "reviewer"]);
    assert.equal(projects.events("idle")[0]?.kind, "project.defaults.reconciled");

    const busy = projects.get("busy")!;
    assert.equal(busy.members[0]?.model, "gpt-6.2-sol");
    assert.equal(busy.maxConcurrentTasks, 1);
    assert.deepEqual(busy.templatePlan.map((item) => item.role), ["coordinator"]);
  } finally {
    try { tasks.close(); } catch {}
    try { projects.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
