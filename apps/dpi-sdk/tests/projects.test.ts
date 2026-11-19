import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "../src/node/projects.js";

test("projects isolate members, messages and event history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-projects-"));
  const registry = new ProjectRegistry(join(dir, "projects.sqlite"));
  try {
    const alpha = registry.create({
      id: "alpha", name: "Alpha", description: "First project",
      maxTaskTokens: 12_000, maxCoordinationDepth: 4, maxDelegatedTasksPerTurn: 6,
      maxActiveTasks: 24, maxConcurrentTasks: 3,
    });
    const beta = registry.create({ id: "beta", name: "Beta" });
    const templated = registry.create(
      {
        id: "templated", templateId: "web", name: "Templated",
        templatePlan: [
          { role: "coordinator", permissionProfile: "READ_ONLY" },
          { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
        ],
      },
      { kind: "project.template.applied", detail: { templateId: "web" } },
    );
    assert.equal(templated.id, "templated");
    assert.equal(templated.templateId, "web");
    assert.deepEqual(templated.templatePlan, [
      { role: "coordinator", permissionProfile: "READ_ONLY" },
      { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
    ]);
    assert.throws(
      () => registry.create({
        id: "duplicate-plan", name: "Duplicate plan",
        templatePlan: [
          { role: "coder", permissionProfile: "READ_ONLY" },
          { role: "Coder", permissionProfile: "WORKSPACE_WRITE" },
        ],
      }),
      /must be unique/,
    );
    assert.deepEqual(
      registry.events("templated").map((event) => event.kind).sort(),
      ["project.created", "project.template.applied"],
    );
    assert.throws(
      () => registry.create(
        { id: "rolled-back", name: "Rolled back" },
        { kind: "project.template.applied", detail: { invalid: 1n } },
      ),
      /BigInt/,
    );
    assert.equal(registry.get("rolled-back"), undefined, "project and audit events commit atomically");
    assert.equal(alpha.members.length, 0);
    assert.equal(alpha.autonomyMode, "SUPERVISED");
    assert.equal(alpha.maxTaskTokens, 12_000);
    assert.equal(alpha.maxCoordinationDepth, 4);
    assert.equal(alpha.maxDelegatedTasksPerTurn, 6);
    assert.equal(alpha.maxActiveTasks, 24);
    assert.equal(alpha.maxConcurrentTasks, 3);
    assert.equal(beta.members.length, 0);

    const worker = registry.addMember("alpha", {
      id: "worker-a",
      deviceId: "box-a",
      sessionId: "session-a",
      agentId: "main",
      name: "A researcher",
      role: "research",
    });
    assert.equal(worker.permissionProfile, "ROLE_DEFAULT");
    assert.equal(registry.get("alpha")!.members[0]?.id, worker.id);
    assert.equal(registry.get("beta")!.members.length, 0, "projects do not share members");
    assert.equal(registry.getMember("beta", worker.id), undefined, "member lookup is project-scoped");
    assert.throws(
      () => registry.addMember("alpha", { deviceId: "box-a", sessionId: "session-a", agentId: "main" }),
      /already a member/,
    );
    const temporary = registry.addMember("alpha", {
      id: "temp-architect",
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "architect-1",
      name: "Temporary architect",
      role: "architect",
      permissionProfile: "READ_ONLY",
      executor: "codex",
      temporary: true,
      parentMemberId: worker.id,
      scopeTaskId: "design-task",
      spawnRequestId: "spawn-design-task",
    });
    assert.equal(temporary.lifecycleState, "ACTIVE");
    assert.equal(temporary.permissionProfile, "READ_ONLY");
    assert.equal(temporary.parentMemberId, worker.id);
    const replayed = registry.addMember("alpha", {
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "a-different-random-id",
      name: "Duplicate retry",
      role: "architect",
      executor: "codex",
      temporary: true,
      spawnRequestId: "spawn-design-task",
    });
    assert.equal(replayed.id, temporary.id, "the same spawn request is idempotent");
    const fallbackMember = registry.addMember("alpha", {
      id: "fallback-coder",
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "fallback-coder-1",
      name: "Fallback coder",
      role: "coder",
      executor: "codex",
      model: "primary-model",
      allowModelFallback: true,
      fallbackModels: ["backup-a", "backup-b"],
      t3EnvironmentId: "env-linux-b",
    });
    assert.equal(fallbackMember.allowModelFallback, true);
    assert.deepEqual(fallbackMember.fallbackModels, ["backup-a", "backup-b"]);
    assert.equal(fallbackMember.t3EnvironmentId, "env-linux-b");
    assert.throws(
      () => registry.addMember("beta", {
        deviceId: "box-b", sessionId: "session-b", agentId: "pi-with-t3-env",
        t3EnvironmentId: "env-b",
      }),
      /only for Codex/,
    );
    assert.throws(
      () => registry.addMember("beta", {
        deviceId: "box-b", sessionId: "session-b", agentId: "fallback-invalid",
        model: "primary", fallbackModels: ["primary"], executor: "codex",
      }),
      /Primary model cannot also be a fallback/,
    );
    assert.throws(
      () => registry.updateMember("alpha", fallbackMember.id, { allowModelFallback: true, fallbackModels: [] }),
      /At least one fallback model/,
    );
    const fallbackDisabled = registry.updateMember("alpha", fallbackMember.id, { allowModelFallback: false });
    assert.equal(fallbackDisabled.allowModelFallback, false);
    assert.deepEqual(fallbackDisabled.fallbackModels, ["backup-a", "backup-b"], "ordered fallback policy is retained while disabled");
    const remoteWorkspace = registry.updateMember("alpha", fallbackMember.id, { cwd: "/srv/music-tagger" });
    assert.equal(remoteWorkspace.cwd, "/srv/music-tagger", "remote workspace paths remain target-native");
    const localBinding = registry.updateMember("alpha", fallbackMember.id, { t3EnvironmentId: null });
    assert.equal(localBinding.t3EnvironmentId, undefined);
    const threaded = registry.setMemberThread("alpha", fallbackMember.id, "thread-fallback", 8, "backup-a", "t3", "codex_worker");
    assert.equal(threaded.threadModel, "backup-a");
    assert.equal(threaded.threadRuntime, "t3");
    assert.equal(threaded.threadProvider, "codex_worker");
    const remodeled = registry.updateMember("alpha", fallbackMember.id, { model: "gpt-5.6-sol" });
    assert.equal(remodeled.model, "gpt-5.6-sol");
    assert.equal(remodeled.threadId, undefined, "a thread bound to the old model must never be resumed");
    assert.equal(registry.events("alpha").some((event) => event.kind === "member.model.updated"), true);
    assert.throws(
      () => registry.updateMember("alpha", worker.id, { model: "gpt-5.6-sol" }),
      /only for Codex/,
    );
    registry.setMemberThread("alpha", fallbackMember.id, "thread-after-model", 8, "gpt-5.6-sol", "t3", "codex_worker");
    const movedAfterThread = registry.updateMember("alpha", fallbackMember.id, { cwd: "/srv/music-tagger-isolated" });
    assert.equal(movedAfterThread.cwd, "/srv/music-tagger-isolated");
    assert.equal(movedAfterThread.threadId, undefined, "a thread bound to the old workspace must never be resumed");
    assert.equal(registry.events("alpha").some((event) => event.kind === "member.thread.detached"), true);
    const updated = registry.updateMember("alpha", worker.id, { permissionProfile: "WORKSPACE_WRITE" });
    assert.equal(updated.permissionProfile, "WORKSPACE_WRITE");
    assert.equal(registry.events("alpha").some((event) => event.kind === "member.permissions.updated"), true);
    assert.throws(
      () => registry.addMember("beta", {
        deviceId: "box-b",
        sessionId: "session-b",
        agentId: "main",
        permissionProfile: "INVALID" as "READ_ONLY",
      }),
      /Invalid project member permission profile/,
    );
    assert.equal(registry.members("alpha", true).length, 3);
    assert.throws(() => registry.archiveMember("alpha", worker.id), /Only temporary members/);
    const archived = registry.archiveMember("alpha", temporary.id, 1_700_000_000_000);
    assert.equal(archived.lifecycleState, "ARCHIVED");
    assert.equal(archived.archivedAt, 1_700_000_000_000);
    assert.equal(registry.getMember("alpha", temporary.id), undefined, "archived agents cannot receive new work");
    assert.equal(registry.getMember("alpha", temporary.id, true)?.id, temporary.id);
    assert.equal(registry.members("alpha", true).length, 3);

    registry.event("alpha", "message.sent", { text: "hello" }, undefined, worker.id);
    assert.equal(registry.events("alpha")[0]?.kind, "message.sent");
    assert.equal(registry.events("beta").some((event) => event.kind === "message.sent"), false);

    registry.update("alpha", {
      name: "Alpha 2", autonomyMode: "AUTHORIZED_AUTONOMY",
      maxTaskTokens: 8_000,
      maxCoordinationDepth: 5, maxDelegatedTasksPerTurn: null,
      maxConcurrentTasks: 2,
    });
    assert.equal(registry.get("alpha")!.name, "Alpha 2");
    assert.equal(registry.get("alpha")!.autonomyMode, "AUTHORIZED_AUTONOMY");
    assert.equal(registry.get("alpha")!.maxTaskTokens, 8_000);
    assert.equal(registry.get("alpha")!.maxCoordinationDepth, 5);
    assert.equal(registry.get("alpha")!.maxDelegatedTasksPerTurn, undefined);
    assert.equal(registry.get("alpha")!.maxConcurrentTasks, 2);
    assert.throws(() => registry.update("alpha", { maxConcurrentTasks: 1001 }), /1 to 1000/);
    assert.throws(() => registry.update("alpha", { maxTaskTokens: 0 }), /1 to/);
    assert.throws(() => registry.update("alpha", { maxActiveTasks: 0 }), /1 to 10000/);
    assert.equal(registry.removeMember("alpha", worker.id), true);
    assert.equal(registry.remove("alpha"), true);
    assert.equal(registry.get("alpha"), undefined);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("project and member projections roll back when their audit event cannot commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-project-events-"));
  const registry = new ProjectRegistry(join(dir, "projects.sqlite"));
  try {
    registry.create({ id: "atomic", name: "Atomic" });
    const member = registry.addMember("atomic", {
      id: "coder",
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "coder",
      name: "Coder",
      role: "coder",
      executor: "codex",
      permissionProfile: "WORKSPACE_WRITE",
      cwd: "C:\\work\\atomic",
    });

    registry.db.exec(`CREATE TRIGGER reject_project_events BEFORE INSERT ON project_events
      BEGIN SELECT RAISE(ABORT, 'event store unavailable'); END`);
    assert.throws(() => registry.addMember("atomic", {
      id: "uncommitted-reviewer",
      deviceId: "local-codex",
      sessionId: "codex-app-server",
      agentId: "reviewer",
      name: "Reviewer",
      role: "reviewer",
      executor: "codex",
    }), /event store unavailable/);
    assert.equal(registry.getMember("atomic", "uncommitted-reviewer"), undefined);
    assert.throws(() => registry.update("atomic", { name: "Must roll back" }), /event store unavailable/);
    assert.equal(registry.get("atomic")?.name, "Atomic");

    assert.throws(
      () => registry.updateMember("atomic", member.id, { cwd: "C:\\work\\other" }),
      /event store unavailable/,
    );
    assert.equal(registry.getMember("atomic", member.id)?.cwd, "C:\\work\\atomic");

    registry.db.exec("DROP TRIGGER reject_project_events");
    registry.setMemberThread("atomic", member.id, "thread-atomic", 2, "gpt-test", "t3", "codex_worker");
    registry.db.exec(`CREATE TRIGGER reject_project_events BEFORE INSERT ON project_events
      BEGIN SELECT RAISE(ABORT, 'event store unavailable'); END`);
    assert.throws(() => registry.clearMemberThread("atomic", member.id), /event store unavailable/);
    assert.equal(registry.getMember("atomic", member.id)?.threadId, "thread-atomic");
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
