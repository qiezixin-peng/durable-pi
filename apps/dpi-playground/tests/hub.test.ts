import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bootServer,
  freePort,
  newToken,
  tempStore,
  until,
  faux,
  delay,
} from "../../dpi-backend/tests/helpers.js";
import { readSse } from "../../dpi-sdk/src/sse.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import type { MuxFrame, NetworkDevice } from "../../dpi-sdk/src/api.js";

async function bootHub(home: string, networkFile: string, env: Record<string, string>) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(import.meta.dirname, "../apps/dpi-playground-hub/src/main.ts"),
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        DPI_CODEX_APP_SERVER_COMMAND: process.execPath,
        DPI_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([
          resolve(import.meta.dirname, "../../dpi-sdk/tests/fixtures/fake-codex-app-server.mjs"),
        ]),
        DPI_HOME: home,
        DPI_NETWORK_FILE: networkFile,
        DPI_TASK_WORKER: "0",
        DPI_T3_PROJECT_MONITOR: "0",
        NODE_NO_WARNINGS: "1",
        ...env,
      },
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (output += x));
  child.stderr?.on("data", (x) => (output += x));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/network`)).ok) break;
    } catch {}
    await delay(100);
  }
  return {
    base,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("hub: registry from YAML, monitoring, token-injecting proxy, guard, mux, offline and mismatch", async () => {
  const t = await tempStore();
  const tokenA = newToken();
  const tokenB = newToken();
  const a = await bootServer({
    home: join(t.root, "a"),
    startDirs: t.work,
    token: tokenA,
    name: "box-a",
  });
  let b = await bootServer({
    home: join(t.root, "b"),
    startDirs: t.work,
    token: tokenB,
    name: "box-b",
  });
  const hubHome = join(t.root, "hub");
  mkdirSync(hubHome, { recursive: true });
  const fixtureDataRoot = join(t.root, "fixture-data");
  mkdirSync(fixtureDataRoot);
  writeFileSync(join(hubHome, "data-sources.json"), `${JSON.stringify({
    version: 1,
    sources: [{ id: "fixture-source", label: "Fixture source", root: fixtureDataRoot, device: "test", readOnly: true }],
  })}\n`);
  const networkFile = join(t.root, "dpi-network.yaml");
  writeFileSync(
    networkFile,
    `devices:\n  box-a:\n    kind: url\n    url: ${a.base}\n    token_env: TOKEN_A\n  box-b:\n    kind: url\n    url: ${b.base}\n    token_env: TOKEN_B\n`,
  );
  const hub = await bootHub(hubHome, networkFile, { TOKEN_A: tokenA, TOKEN_B: tokenB });
  const network = async () =>
    ((await (await fetch(`${hub.base}/api/network`)).json()) as { devices: NetworkDevice[] })
      .devices;
  const status = async (id: string) => (await network()).find((d) => d.id === id)?.status;
  try {
    await until(
      async () => (await status("box-a")) === "online" && (await status("box-b")) === "online",
      15000,
      "both online",
    );
    const all = await (await fetch(`${hub.base}/api/network`)).text();
    assert.equal(
      all.includes(tokenA) || all.includes(tokenB),
      false,
      "tokens never reach the browser",
    );

    // Proxy: browser requests carry no token; the hub injects it.
    const info = await (await fetch(`${hub.base}/api/devices/box-a/v1/device`)).json();
    assert.equal(info.name, "box-a");
    const created = await fetch(
      `${hub.base}/api/devices/box-a/v1/sessions`,
      json({ name: "Via hub", cwd: t.work, model: faux }),
    );
    assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal(
      (await fetch(`${hub.base}/api/devices/box-a/v1/sessions/${session.id}/agents/main/events`))
        .status,
      400,
      "streams only via mux",
    );

    // Projects are a hub-level routing boundary across device sessions.
    const templates = await (await fetch(`${hub.base}/api/project-templates`)).json();
    assert.ok(templates.templates.some((item: { id: string }) => item.id === "web"));
    const project = await (
      await fetch(`${hub.base}/api/projects`, json({ id: "project-one", name: "Project One", templateId: "web" }))
    ).json();
    assert.equal(project.id, "project-one");
    assert.equal(project.templateId, "web");
    assert.equal(project.autonomyMode, "SUPERVISED");
    assert.equal(project.maxConcurrentTasks, 3);
    assert.equal(project.maxActiveTasks, 48);
    assert.deepEqual(project.templatePlan.map((item: { role: string }) => item.role), ["coordinator", "architect", "coder", "tester", "reviewer"]);
    const teamPlan = await (await fetch(`${hub.base}/api/projects/project-one/team-plan`)).json();
    assert.equal(teamPlan.templateId, "web");
    assert.equal(teamPlan.roles.length, 5);
    assert.ok(teamPlan.roles.every((item: { status: string }) => item.status === "UNBOUND"));
    const templateEvents = await (await fetch(`${hub.base}/api/projects/project-one/events`)).json();
    assert.equal(templateEvents.events.filter((item: { kind: string }) => item.kind === "project.template.applied").length, 1);

    await fetch(
      `${hub.base}/api/projects`,
      json({ id: "project-task-limit", name: "Task limit", maxActiveTasks: 1 }),
    );
    const limitedTask = await fetch(
      `${hub.base}/api/projects/project-task-limit/tasks`,
      json({ id: "limited-one", title: "First" }),
    );
    assert.equal(limitedTask.status, 201);
    const overLimitTask = await fetch(
      `${hub.base}/api/projects/project-task-limit/tasks`,
      json({ id: "limited-two", title: "Second" }),
    );
    assert.equal(overLimitTask.status, 400);
    assert.match((await overLimitTask.json()).error.message, /active task limit/);
    await fetch(`${hub.base}/api/projects/project-task-limit/tasks/limited-one/cancel`, json({}));

    await fetch(`${hub.base}/api/projects`, json({ id: "project-delete-proof", name: "Delete proof" }));
    const bindDeleteProof = await fetch(`${hub.base}/api/projects/project-delete-proof/data-sources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceIds: ["fixture-source"] }),
    });
    assert.equal(bindDeleteProof.status, 200, await bindDeleteProof.text());
    const deletedProjectResponse = await fetch(`${hub.base}/api/projects/project-delete-proof`, { method: "DELETE" });
    const deletedProject = await deletedProjectResponse.json();
    assert.equal(deletedProjectResponse.status, 200, JSON.stringify(deletedProject));
    assert.equal(deletedProject.ok, true);
    assert.match(deletedProject.recoveryBackup.name, /-pre-delete-project-delete-proof-/);
    assert.equal(existsSync(deletedProject.recoveryBackup.path), true, "project deletion keeps a recovery snapshot");
    assert.deepEqual(deletedProject.unboundDataSources, ["fixture-source"]);
    const catalogAfterDelete = JSON.parse(readFileSync(join(hubHome, "data-sources.json"), "utf8"));
    assert.deepEqual(catalogAfterDelete.sources[0].projectIds, [], "project deletion revokes its data-source grants");
    assert.equal((await fetch(`${hub.base}/api/projects/project-delete-proof`)).status, 404);

    const gitWorkspace = join(t.root, "git-workspace");
    mkdirSync(gitWorkspace);
    const git = (...args: string[]) => execFileSync("git", ["-C", gitWorkspace, ...args], { encoding: "utf8", windowsHide: true }).trim();
    git("init");
    git("config", "user.name", "Durable Pi Hub Test");
    git("config", "user.email", "durable-pi@example.invalid");
    git("commit", "--allow-empty", "-m", "baseline");
    const worktreeResponse = await fetch(
      `${hub.base}/api/projects/project-one/worktrees`,
      json({ repositoryRoot: gitWorkspace, label: "Coder one" }),
    );
    const managedWorktree = await worktreeResponse.json();
    assert.equal(worktreeResponse.status, 201, JSON.stringify(managedWorktree));
    assert.equal(managedWorktree.state, "ACTIVE");
    assert.equal(managedWorktree.dirty, false);
    assert.equal(managedWorktree.baseIsAncestor, true);
    const listedWorktrees = await (
      await fetch(`${hub.base}/api/projects/project-one/worktrees`)
    ).json();
    assert.equal(listedWorktrees.worktrees[0].id, managedWorktree.id);
    assert.equal(
      (await (
        await fetch(
          `${hub.base}/api/projects/project-one/worktrees/${managedWorktree.id}/check`,
          json({}),
        )
      ).json()).headRevision,
      managedWorktree.headRevision,
    );
    writeFileSync(join(managedWorktree.path, "dirty.txt"), "do not discard\n");
    const bindBeforeFailedDelete = await fetch(`${hub.base}/api/projects/project-one/data-sources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceIds: ["fixture-source"] }),
    });
    assert.equal(bindBeforeFailedDelete.status, 200, await bindBeforeFailedDelete.text());
    const dirtyProjectDelete = await fetch(`${hub.base}/api/projects/project-one`, { method: "DELETE" });
    assert.equal(dirtyProjectDelete.status, 409);
    assert.match((await dirtyProjectDelete.json()).error.message, /uncommitted changes/);
    assert.equal((await fetch(`${hub.base}/api/projects/project-one`)).status, 200, "dirty worktree blocks project deletion");
    const sourcesAfterFailedDelete = await (await fetch(`${hub.base}/api/projects/project-one/data-sources`)).json();
    assert.equal(sourcesAfterFailedDelete.sources.find((source: { id: string }) => source.id === "fixture-source").bound, true);
    const postRollbackTask = await fetch(
      `${hub.base}/api/projects/project-one/tasks`,
      json({ id: "post-delete-rollback", title: "Fence was released" }),
    );
    assert.equal(postRollbackTask.status, 201, await postRollbackTask.text());
    await fetch(`${hub.base}/api/projects/project-one/tasks/post-delete-rollback/cancel`, json({ reason: "test complete" }));
    execFileSync("git", ["-C", managedWorktree.path, "clean", "-f", "dirty.txt"], { windowsHide: true });
    const removedWorktree = await (
      await fetch(`${hub.base}/api/projects/project-one/worktrees/${managedWorktree.id}`, { method: "DELETE" })
    ).json();
    assert.equal(removedWorktree.state, "REMOVED");
    assert.equal(git("show-ref", "--verify", `refs/heads/${managedWorktree.branch}`).length > 0, true);
    const handoffResponse = await fetch(
      `${hub.base}/api/projects/project-one/handoffs`,
      json({ workspace: gitWorkspace }),
    );
    const handoff = await handoffResponse.json();
    assert.equal(handoffResponse.status, 201, JSON.stringify(handoff));
    const sourceGitCheck = await (
      await fetch(
        `${hub.base}/api/projects/project-one/handoffs/${handoff.id}/check-git`,
        json({ workspace: gitWorkspace }),
      )
    ).json();
    assert.equal(sourceGitCheck.status, "SAME");
    const inboxBundle = join(hubHome, "handoff-inbox", "git-transfer");
    cpSync(handoff.directory, inboxBundle, { recursive: true });
    const imported = await (
      await fetch(
        `${hub.base}/api/handoffs/import`,
        json({ bundleName: "git-transfer", targetProjectId: "project-imported" }),
      )
    ).json();
    assert.equal(imported.project.id, "project-imported");
    const importedGitCheck = await (
      await fetch(
        `${hub.base}/api/projects/project-imported/imported-git-baseline/check`,
        json({ workspace: gitWorkspace }),
      )
    ).json();
    assert.equal(importedGitCheck.status, "SAME");
    assert.equal(importedGitCheck.handoffId, handoff.id);

    const memory = await (
      await fetch(
        `${hub.base}/api/projects/project-one/memories`,
        json({ key: "architecture.runtime", value: { harness: "pi" }, sourceType: "test" }),
      )
    ).json();
    assert.equal(memory.version, 1);
    const memory2 = await (
      await fetch(
        `${hub.base}/api/projects/project-one/memories`,
        json({
          key: "architecture.runtime",
          value: { harness: "pi-durable" },
          sourceType: "test",
          expectedVersion: 1,
        }),
      )
    ).json();
    assert.equal(memory2.version, 2);
    const revisions = await (
      await fetch(
        `${hub.base}/api/projects/project-one/memories/${memory.id}/history`,
      )
    ).json();
    assert.deepEqual(revisions.revisions.map((item: { version: number }) => item.version), [1, 2]);

    const environmentArtifactResponse = await fetch(
      `${hub.base}/api/projects/project-one/environment-scan`,
      json({ workspace: t.work, includeInHandoff: true }),
    );
    const environmentArtifact = await environmentArtifactResponse.json();
    assert.equal(environmentArtifactResponse.status, 201, JSON.stringify(environmentArtifact));
    assert.equal(environmentArtifact.kind, "environment-report");
    assert.equal(environmentArtifact.includeInHandoff, true);
    const environmentReport = await (
      await fetch(
        `${hub.base}/api/projects/project-one/artifacts/${environmentArtifact.id}/content`,
      )
    ).json();
    assert.equal(environmentReport.schemaVersion, 1);
    assert.equal(typeof environmentReport.system.platform, "string");
    await fetch(
      `${hub.base}/api/projects/project-one/artifacts/${environmentArtifact.id}`,
      { method: "DELETE" },
    );

    const approval = await (
      await fetch(
        `${hub.base}/api/projects/project-one/approvals`,
        json({
          operation: { tool: "delete", args: { paths: ["temp/report.txt"] } },
          requestedBy: "agent:coder",
          ttlMs: 60_000,
        }),
      )
    ).json();
    assert.equal(approval.status, "PENDING");
    const approved = await (
      await fetch(
        `${hub.base}/api/projects/project-one/approvals/${approval.id}/decision`,
        json({ decision: "APPROVED", decidedBy: "user:admin" }),
      )
    ).json();
    assert.equal(approved.status, "APPROVED");
    const mismatch = await fetch(
      `${hub.base}/api/projects/project-one/approvals/${approval.id}/consume`,
      json({ operation: { tool: "delete", args: { paths: ["temp"] } }, consumedBy: "worker:a" }),
    );
    assert.equal(mismatch.status, 400);
    const consumed = await (
      await fetch(
        `${hub.base}/api/projects/project-one/approvals/${approval.id}/consume`,
        json({
          operation: { tool: "delete", args: { paths: ["temp/report.txt"] } },
          consumedBy: "worker:a",
        }),
      )
    ).json();
    assert.equal(consumed.status, "CONSUMED");

    // Hub-level tasks are claimed with a lease and completed with a fencing epoch.
    const task = await (
      await fetch(
        `${hub.base}/api/projects/project-one/tasks`,
        json({ id: "hub-task-1", title: "Implement the adapter", input: { area: "backend" } }),
      )
    ).json();
    assert.equal(task.status, "QUEUED");
    const lease = await (
      await fetch(
        `${hub.base}/api/projects/project-one/tasks/claim`,
        json({ workerId: "worker-a", leaseMs: 10_000 }),
      )
    ).json();
    assert.equal(lease.id, task.id);
    assert.equal(lease.fenceEpoch, 1);
    assert.equal(
      (
        await fetch(
          `${hub.base}/api/projects/project-one/tasks/claim`,
          json({ workerId: "worker-b", leaseMs: 10_000 }),
        )
      ).status,
      204,
    );
    const completed = await (
      await fetch(
        `${hub.base}/api/projects/project-one/tasks/${task.id}/complete`,
        json({ workerId: "worker-a", fenceEpoch: lease.fenceEpoch, result: { ok: true } }),
      )
    ).json();
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(completed.result, { ok: true });

    const codexCatalog = await (await fetch(`${hub.base}/api/codex/models`)).json();
    assert.equal(codexCatalog.data[0].id, "current-model");
    assert.equal(codexCatalog.data[0].capabilities.dynamicTools, "unknown");
    const unavailableCodex = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({ executor: "codex", model: "not-in-catalog", cwd: t.work, name: "Unavailable" }),
    );
    assert.equal(unavailableCodex.status, 409);
    assert.match((await unavailableCodex.json()).error.message, /not available/);
    const unavailableFallback = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: t.work, name: "Unavailable fallback",
        allowModelFallback: true, fallbackModels: ["not-in-catalog"],
      }),
    );
    assert.equal(unavailableFallback.status, 409);
    assert.match((await unavailableFallback.json()).error.message, /not available/);
    const unverifiedCoordinator = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({ executor: "codex", model: "current-model", cwd: t.work, name: "Unsafe coordinator", role: "coordinator" }),
    );
    assert.equal(unverifiedCoordinator.status, 409);
    assert.match((await unverifiedCoordinator.json()).error.message, /not been platform-verified/);

    const remoteCodexResponse = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: "/srv/music-tagger",
        t3EnvironmentId: "env-linux-b", name: "Linux coder", role: "coder",
      }),
    );
    const remoteCodex = await remoteCodexResponse.json();
    assert.equal(remoteCodexResponse.status, 201, JSON.stringify(remoteCodex));
    assert.equal(remoteCodex.cwd, "/srv/music-tagger", "remote paths are not resolved on the Windows hub");
    assert.equal(remoteCodex.t3EnvironmentId, "env-linux-b");
    const updatedRemoteResponse = await fetch(
      `${hub.base}/api/projects/project-one/members/${remoteCodex.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/opt/music-tagger", t3EnvironmentId: "env-linux-c" }),
      },
    );
    const updatedRemote = await updatedRemoteResponse.json();
    assert.equal(updatedRemoteResponse.status, 200, JSON.stringify(updatedRemote));
    assert.equal(updatedRemote.cwd, "/opt/music-tagger");
    assert.equal(updatedRemote.t3EnvironmentId, "env-linux-c");

    const sourceBlueprintMember = await (
      await fetch(
        `${hub.base}/api/projects/project-one/members`,
        json({
          executor: "codex", model: "current-model", cwd: t.work,
          name: "Source blueprint coder", role: "coder", permissionProfile: "WORKSPACE_WRITE",
          allowModelFallback: true, fallbackModels: ["backup-model"],
        }),
      )
    ).json();
    assert.equal(sourceBlueprintMember.permissionProfile, "WORKSPACE_WRITE");

    const projectRegistry = new ProjectRegistry(join(hubHome, "projects.sqlite"));
    const restCoordinator = projectRegistry.addMember("project-one", {
      id: "rest-coordinator", deviceId: "local-codex", sessionId: "t3", agentId: "rest-coordinator",
      name: "REST Coordinator", role: "coordinator", permissionProfile: "READ_ONLY",
      executor: "codex", model: "current-model", cwd: gitWorkspace,
    });
    projectRegistry.close();
    const localGitTemplateResponse = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: gitWorkspace,
        name: "Local Git coder", role: "coder", permissionProfile: "WORKSPACE_WRITE",
      }),
    );
    const localGitTemplate = await localGitTemplateResponse.json();
    assert.equal(localGitTemplateResponse.status, 201, JSON.stringify(localGitTemplate));
    const missingSpawnRequest = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({ requestedByMemberId: restCoordinator.id, templateMemberId: localGitTemplate.id, role: "debugger" }),
    );
    assert.equal(missingSpawnRequest.status, 400);
    const remoteSpawn = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: remoteCodex.id,
        requestId: "remote-template", role: "debugger",
      }),
    );
    assert.equal(remoteSpawn.status, 400);
    assert.match((await remoteSpawn.json()).error.message, /local Codex member/);
    const readOnlyTemplateResponse = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: gitWorkspace,
        name: "Read-only template", role: "reviewer", permissionProfile: "READ_ONLY",
      }),
    );
    const readOnlyTemplate = await readOnlyTemplateResponse.json();
    assert.equal(readOnlyTemplateResponse.status, 201, JSON.stringify(readOnlyTemplate));
    const escalation = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: readOnlyTemplate.id,
        requestId: "permission-escalation", role: "coder", permissionProfile: "WORKSPACE_WRITE",
      }),
    );
    assert.equal(escalation.status, 400);
    assert.match((await escalation.json()).error.message, /cannot exceed/);
    const contextualTemplateResponse = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: gitWorkspace,
        name: "Contextual read template", role: "reviewer", permissionProfile: "ROLE_DEFAULT",
      }),
    );
    const contextualTemplate = await contextualTemplateResponse.json();
    assert.equal(contextualTemplateResponse.status, 201, JSON.stringify(contextualTemplate));
    const contextualEscalation = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: contextualTemplate.id,
        requestId: "contextual-permission-escalation", role: "coder", permissionProfile: "ROLE_DEFAULT",
      }),
    );
    assert.equal(contextualEscalation.status, 400);
    assert.match((await contextualEscalation.json()).error.message, /cannot exceed/);
    const spawnedResponse = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: localGitTemplate.id,
        requestId: "isolated-debugger", role: "debugger", permissionProfile: "WORKSPACE_WRITE",
      }),
    );
    const spawned = await spawnedResponse.json();
    assert.equal(spawnedResponse.status, 201, JSON.stringify(spawned));
    assert.notEqual(resolve(spawned.cwd), resolve(gitWorkspace));
    const spawnedReplayResponse = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: localGitTemplate.id,
        requestId: "isolated-debugger", role: "debugger", permissionProfile: "WORKSPACE_WRITE",
      }),
    );
    const spawnedReplay = await spawnedReplayResponse.json();
    assert.equal(spawnedReplayResponse.status, 200, JSON.stringify(spawnedReplay));
    assert.equal(spawnedReplay.id, spawned.id);
    const changedReplay = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id, templateMemberId: localGitTemplate.id,
        requestId: "isolated-debugger", role: "architect", permissionProfile: "WORKSPACE_WRITE",
      }),
    );
    assert.equal(changedReplay.status, 400);
    assert.match((await changedReplay.json()).error.message, /reused with different/);
    const spawnedWorktree = ((await (
      await fetch(`${hub.base}/api/projects/project-one/worktrees`)
    ).json()).worktrees as Array<{ id: string; path: string; state: string }>).find(
      (item) => resolve(item.path) === resolve(spawned.cwd),
    );
    assert.equal(spawnedWorktree?.state, "ACTIVE");
    const unsavedTemporaryFile = join(spawned.cwd, "unsaved-temporary.txt");
    writeFileSync(unsavedTemporaryFile, "must not be discarded\n");
    const dirtyArchive = await fetch(
      `${hub.base}/api/projects/project-one/members/${spawned.id}/archive-temporary`,
      json({ requestedByMemberId: restCoordinator.id }),
    );
    assert.equal(dirtyArchive.status, 409);
    assert.match((await dirtyArchive.json()).error.message, /uncommitted changes/);
    assert.equal(existsSync(unsavedTemporaryFile), true);
    rmSync(unsavedTemporaryFile);
    const archiveSpawnedResponse = await fetch(
      `${hub.base}/api/projects/project-one/members/${spawned.id}/archive-temporary`,
      json({ requestedByMemberId: restCoordinator.id }),
    );
    const archiveSpawned = await archiveSpawnedResponse.json();
    assert.equal(archiveSpawnedResponse.status, 200, JSON.stringify(archiveSpawned));
    assert.equal(archiveSpawned.member.lifecycleState, "ARCHIVED");
    const removedSpawnedWorktree = ((await (
      await fetch(`${hub.base}/api/projects/project-one/worktrees`)
    ).json()).worktrees as Array<{ id: string; state: string }>).find((item) => item.id === spawnedWorktree?.id);
    assert.equal(removedSpawnedWorktree?.state, "REMOVED");
    const blueprintHandoffResponse = await fetch(
      `${hub.base}/api/projects/project-one/handoffs`,
      json({}),
    );
    const blueprintHandoff = await blueprintHandoffResponse.json();
    assert.equal(blueprintHandoffResponse.status, 201, JSON.stringify(blueprintHandoff));
    cpSync(blueprintHandoff.directory, join(hubHome, "handoff-inbox", "blueprint-transfer"), { recursive: true });
    const blueprintImportResponse = await fetch(
      `${hub.base}/api/handoffs/import`,
      json({ bundleName: "blueprint-transfer", targetProjectId: "project-blueprints" }),
    );
    assert.equal(blueprintImportResponse.status, 201, await blueprintImportResponse.text());
    const importedBlueprints = await (
      await fetch(`${hub.base}/api/projects/project-blueprints/agent-blueprints`)
    ).json();
    const coderBlueprint = importedBlueprints.blueprints.find(
      (item: { id: string }) => item.id === sourceBlueprintMember.id,
    );
    assert.equal(coderBlueprint.bindingState, "UNBOUND");
    assert.equal(coderBlueprint.permissionProfile, "WORKSPACE_WRITE");
    assert.deepEqual(coderBlueprint.fallbackModels, ["backup-model"]);
    const missingTargetPermission = await fetch(
      `${hub.base}/api/projects/project-blueprints/agent-blueprints/${coderBlueprint.id}/bind`,
      json({ name: "Target coder", role: "coder", model: "current-model", cwd: t.work }),
    );
    assert.equal(missingTargetPermission.status, 400);
    assert.match((await missingTargetPermission.json()).error.message, /permission profile/i);
    const blueprintBindingResponse = await fetch(
      `${hub.base}/api/projects/project-blueprints/agent-blueprints/${coderBlueprint.id}/bind`,
      json({
        name: "Target coder", role: "coder", permissionProfile: "READ_ONLY",
        model: "current-model", cwd: "/srv/imported-project", t3EnvironmentId: "env-linux-b",
        allowModelFallback: true, fallbackModels: ["backup-model"],
      }),
    );
    const blueprintBinding = await blueprintBindingResponse.json();
    assert.equal(blueprintBindingResponse.status, 201, JSON.stringify(blueprintBinding));
    assert.equal(blueprintBinding.member.permissionProfile, "READ_ONLY");
    assert.equal(blueprintBinding.member.cwd, "/srv/imported-project");
    assert.equal(blueprintBinding.member.t3EnvironmentId, "env-linux-b");
    assert.equal(blueprintBinding.blueprint.bindingState, "BOUND");
    const repeatedBinding = await (
      await fetch(
        `${hub.base}/api/projects/project-blueprints/agent-blueprints/${coderBlueprint.id}/bind`,
        json({ permissionProfile: "WORKSPACE_WRITE" }),
      )
    ).json();
    assert.equal(repeatedBinding.member.id, blueprintBinding.member.id, "a repeated binding does not create a second Agent");
    assert.equal(repeatedBinding.member.permissionProfile, "READ_ONLY", "a retry cannot widen the original target permission");
    const blueprintProject = (await (
      await fetch(`${hub.base}/api/projects`)
    ).json()).projects.find((item: { id: string }) => item.id === "project-blueprints");
    assert.equal(blueprintProject.members.length, 1);
    const blueprintEvents = await (
      await fetch(`${hub.base}/api/projects/project-blueprints/events`)
    ).json();
    assert.equal(
      blueprintEvents.events.filter((item: { kind: string }) => item.kind === "handoff.agent_blueprint.bound").length,
      1,
    );

    const genericTemporaryBypass = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({
        executor: "codex", model: "current-model", cwd: t.work,
        name: "Bypass", role: "coder", temporary: true,
      }),
    );
    assert.equal(genericTemporaryBypass.status, 400);
    assert.match((await genericTemporaryBypass.json()).error.message, /spawn-temporary/);
    const temporaryMemberResponse = await fetch(
      `${hub.base}/api/projects/project-one/members/spawn-temporary`,
      json({
        requestedByMemberId: restCoordinator.id,
        templateMemberId: sourceBlueprintMember.id,
        requestId: "queued-temporary",
        name: "Queued temporary",
        role: "coder",
        permissionProfile: "WORKSPACE_WRITE",
        workspaceStrategy: "shared",
        scopeTaskId: "queued-temp-task",
      }),
    );
    const temporaryMember = await temporaryMemberResponse.json();
    assert.equal(temporaryMemberResponse.status, 201, JSON.stringify(temporaryMember));
    assert.equal(temporaryMember.allowModelFallback, true);
    assert.deepEqual(temporaryMember.fallbackModels, ["backup-model"]);
    const queuedTemporaryTask = await (
      await fetch(
        `${hub.base}/api/projects/project-one/tasks`,
        json({
          id: "queued-temp-task", title: "Queued temporary work",
          input: { kind: "agent.message", memberId: temporaryMember.id, content: "work later" },
        }),
      )
    ).json();
    assert.equal(queuedTemporaryTask.status, "QUEUED");
    const activeTaskProjectDelete = await fetch(`${hub.base}/api/projects/project-one`, { method: "DELETE" });
    assert.equal(activeTaskProjectDelete.status, 409);
    assert.match((await activeTaskProjectDelete.json()).error.message, /active task/);
    const prematureArchive = await fetch(
      `${hub.base}/api/projects/project-one/members/${temporaryMember.id}/archive`,
      json({}),
    );
    assert.equal(prematureArchive.status, 409);
    assert.match((await prematureArchive.json()).error.message, /still has 1 active task/);
    const cancellation = await (
      await fetch(
        `${hub.base}/api/projects/project-one/tasks/queued-temp-task/cancel`,
        json({}),
      )
    ).json();
    assert.equal(cancellation.task.status, "CANCELLED");
    assert.equal(cancellation.archivedMember.id, temporaryMember.id);
    assert.equal(cancellation.archivedMember.lifecycleState, "ARCHIVED");
    assert.equal(
      (cancellation.task.input as { memberId?: string }).memberId,
      temporaryMember.id,
      "queued cancellation keeps the immutable source input",
    );
    const attempts = await (
      await fetch(`${hub.base}/api/projects/project-one/tasks/${task.id}/attempts`)
    ).json();
    assert.deepEqual(
      attempts.attempts.map((attempt: { workerId: string; status: string; fenceEpoch: number }) => [
        attempt.workerId,
        attempt.status,
        attempt.fenceEpoch,
      ]),
      [["worker-a", "COMPLETED", 1]],
    );
    const taskList = await (await fetch(`${hub.base}/api/projects/project-one/tasks`)).json();
    assert.equal(taskList.tasks.some((item: { id: string }) => item.id === task.id), true);

    const member = await (
      await fetch(
        `${hub.base}/api/projects/project-one/members`,
        json({
          id: "box-a-main",
          deviceId: "box-a",
          sessionId: session.id,
          agentId: "main",
          name: "Box A",
          role: "worker",
        }),
      )
    ).json();
    assert.equal(member.deviceId, "box-a");
    const identity = {
      deviceId: member.deviceId,
      sessionId: member.sessionId,
      agentId: member.agentId,
    };
    const privateMemoryResponse = await fetch(
      `${hub.base}/api/projects/project-one/agent-memories`,
      json({
        ...identity,
        key: "debugging.root_cause",
        value: "private to this agent",
        requestId: "agent-memory-once",
      }),
    );
    const privateMemory = await privateMemoryResponse.json();
    assert.equal(privateMemoryResponse.status, 201, JSON.stringify(privateMemory));
    assert.equal(privateMemory.memberId, member.id);
    assert.equal(privateMemory.sourceId, member.id, JSON.stringify(privateMemory));
    const privateMemoryReplay = await (
      await fetch(
        `${hub.base}/api/projects/project-one/agent-memories`,
        json({
          ...identity,
          key: "debugging.root_cause",
          value: "private to this agent",
          requestId: "agent-memory-once",
        }),
      )
    ).json();
    assert.equal(privateMemoryReplay.id, privateMemory.id);
    assert.equal(privateMemoryReplay.version, 1);
    const agentMemories = await (
      await fetch(
        `${hub.base}/api/projects/project-one/agent-memories?${new URLSearchParams(identity)}`,
      )
    ).json();
    assert.deepEqual(
      agentMemories.memories.map((item: { key: string }) => item.key).sort(),
      ["architecture.runtime", "debugging.root_cause"],
    );
    assert.equal(
      (
        await fetch(
          `${hub.base}/api/projects/project-one/agent-memories`,
          json({ ...identity, key: "forbidden.shared", value: true, scope: "shared" }),
        )
      ).status,
      403,
      "a non-coordinator cannot publish shared memory",
    );
    assert.deepEqual(
      ((await (await fetch(`${hub.base}/api/projects/project-one/memories`)).json()).memories as Array<{ key: string }>).map(
        (item) => item.key,
      ),
      ["architecture.runtime"],
      "the administrative shared listing excludes agent-private facts",
    );
    const routed = await (
      await fetch(
        `${hub.base}/api/projects/project-one/messages`,
        json({ toMemberId: member.id, content: "hello project", requestId: "route-once", waitMs: 0 }),
      )
    ).json();
    assert.equal(routed.status, "queued");
    const routedTask = (await (await fetch(`${hub.base}/api/projects/project-one/tasks`)).json()).tasks.find(
      (item: { id: string }) => item.id === routed.taskId,
    );
    assert.equal(routedTask.status, "QUEUED");
    assert.deepEqual(routedTask.input, {
      kind: "agent.message",
      memberId: member.id,
      content: "hello project",
      messageType: "task_assignment",
      messageId: "route-once",
      whenBusy: "followUp",
      waitMs: 300000,
    });
    const routedReplay = await (
      await fetch(
        `${hub.base}/api/projects/project-one/messages`,
        json({ toMemberId: member.id, content: "hello project", requestId: "route-once", waitMs: 0 }),
      )
    ).json();
    assert.equal(routedReplay.taskId, routed.taskId);
    const changedMessageReplay = await fetch(
      `${hub.base}/api/projects/project-one/messages`,
      json({ toMemberId: member.id, content: "different content", requestId: "route-once", waitMs: 0 }),
    );
    assert.equal(changedMessageReplay.status, 409);
    assert.match((await changedMessageReplay.json()).error.message, /reused with different/);
    const invalidBusyPolicy = await fetch(
      `${hub.base}/api/projects/project-one/messages`,
      json({ toMemberId: member.id, content: "invalid policy", requestId: "invalid-policy", whenBusy: "overwrite", waitMs: 0 }),
    );
    assert.equal(invalidBusyPolicy.status, 400);
    const oversizedRequestId = await fetch(
      `${hub.base}/api/projects/project-one/messages`,
      json({ toMemberId: member.id, content: "invalid id", requestId: "x".repeat(241), waitMs: 0 }),
    );
    assert.equal(oversizedRequestId.status, 400);
    await fetch(`${hub.base}/api/projects`, json({ id: "project-two", name: "Project Two" }));
    assert.equal(
      (
        await fetch(
          `${hub.base}/api/projects/project-two/messages`,
          json({ toMemberId: member.id, content: "must not cross projects" }),
        )
      ).status,
      404,
      "a project cannot address another project's member",
    );

    // Guard.
    const { request } = await import("node:http");
    const evil = await new Promise<number>((done) => {
      const u = new URL(`${hub.base}/api/network`);
      request(
        { host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.test" } },
        (r) => (r.resume(), done(r.statusCode ?? 0)),
      ).end();
    });
    assert.equal(evil, 421, "DNS-rebinding Host rejected");
    assert.equal(
      (
        await fetch(`${hub.base}/api/ui-state/x`, {
          method: "PUT",
          body: "{}",
          headers: { "content-type": "application/json", origin: "http://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${hub.base}/api/ui-state/x`, { method: "PUT", body: "id=x" })).status,
      415,
    );

    // Windows operators can register URL workers without putting their tokens in YAML.
    const registeredResponse = await fetch(
      `${hub.base}/api/devices`,
      json({ id: "box-c", name: "Box C", url: a.base, token: tokenA }),
    );
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();
    assert.equal(registered.id, "box-c");
    assert.equal(JSON.stringify(registered).includes(tokenA), false, "registration never echoes the token");
    await until(async () => (await status("box-c")) === "online", 8000, "box-c online");
    assert.equal((await fetch(`${hub.base}/api/devices/box-c`, { method: "DELETE" })).status, 200);
    assert.equal((await network()).some((device) => device.id === "box-c"), false);

    await fetch(
      `${hub.base}/api/devices`,
      json({ id: "dead-worker", name: "Dead worker", url: "http://127.0.0.1:9", token: tokenA }),
    );
    const unreachableMember = await fetch(
      `${hub.base}/api/projects/project-one/members`,
      json({ deviceId: "dead-worker", sessionId: "missing", agentId: "main", role: "worker" }),
    );
    assert.equal(unreachableMember.status, 400, "transport status 0 is normalized to a valid HTTP client error");
    assert.match((await unreachableMember.json()).error.message, /fetch|network|connect|reach/i);
    await fetch(`${hub.base}/api/devices/dead-worker`, { method: "DELETE" });

    // A wrong token in the registry → unauthorized; restoring it and checking brings it online.
    const registry = new NetworkRegistry(join(hubHome, "network.sqlite"));
    registry.setToken("box-b", "x".repeat(40));
    await fetch(`${hub.base}/api/devices/box-b/check`, json({}));
    await until(async () => (await status("box-b")) === "unauthorized", 8000, "box-b unauthorized");
    registry.setToken("box-b", tokenB);
    assert.equal(
      (await (await fetch(`${hub.base}/api/devices/box-b/check`, json({}))).json()).status,
      "online",
    );

    // Mux: one browser stream carries network + device + agent frames; subscription changes close upstreams.
    const stop = new AbortController();
    const res = await fetch(`${hub.base}/api/stream`, { signal: stop.signal });
    const frames: MuxFrame[] = [];
    let streamId = "";
    void (async () => {
      for await (const m of readSse(res.body!)) {
        const frame = JSON.parse(m.data) as MuxFrame;
        frames.push(frame);
        if (frame.frame.type === "stream") streamId = frame.frame.streamId;
      }
    })().catch(() => {});
    await until(async () => !!streamId, 5000, "stream id");
    const subs = [
      "box-a/device",
      `box-a/agent/${session.id}/main?docs=demo.job-runs`,
      `box-a/session/${session.id}`,
    ];
    const put = await fetch(`${hub.base}/api/stream/${streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs }),
    });
    assert.deepEqual((await put.json()).subs, ["network", ...subs]);
    await until(
      async () => frames.some((f) => f.sub === subs[1] && f.frame.type === "snapshot"),
      8000,
      "agent snapshot via mux",
    );
    await fetch(
      `${hub.base}/api/devices/box-a/v1/sessions/${session.id}/agents/main/messages`,
      json({ content: "hi hub", requestId: "hub-1" }),
    );
    await until(
      async () =>
        frames.some(
          (f) =>
            f.sub === subs[1] &&
            f.frame.type === "batch" &&
            f.frame.events.some((e) => e.type === "run_end"),
        ),
      10000,
      "batch via mux",
    );
    assert.ok(frames.some((f) => f.sub === "network" && f.frame.type === "network"));
    assert.ok(frames.some((f) => f.sub === subs[0] && f.frame.type === "tree"));
    assert.ok(frames.some((f) => f.sub === subs[2] && f.frame.type === "session"));
    assert.ok(frames.some((f) => f.sub === subs[1] && f.frame.type === "doc"));
    const bad = await fetch(`${hub.base}/api/stream/${streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: ["nope/agent"] }),
    });
    assert.equal(bad.status, 400);

    // Offline: kill box-b → offline with a cached tree; proxy answers 503; restart → online again.
    await b.stop("SIGKILL");
    await until(async () => (await status("box-b")) === "offline", 15000, "box-b offline");
    assert.equal((await fetch(`${hub.base}/api/devices/box-b/v1/device`)).status, 503);
    assert.ok(
      (await network()).find((d) => d.id === "box-b")?.tree,
      "cached tree survives offline",
    );
    await b.start();
    await until(async () => (await status("box-b")) === "online", 30000, "box-b back online");

    // Mismatch: same URL, different device (new data dir = new uid).
    const port = b.port;
    await b.stop();
    b = await bootServer({
      home: join(t.root, "b2"),
      startDirs: t.work,
      token: tokenB,
      name: "box-b-new",
      port,
    });
    await until(async () => (await status("box-b")) === "mismatch", 30000, "mismatch");
    registry.forgetUid("box-b"); // what `just net register box-b` does
    const accepted = await fetch(`${hub.base}/api/devices/box-b/check`, json({}));
    assert.equal((await accepted.json()).status, "online");
    registry.close();
    stop.abort();
  } finally {
    await hub.stop();
    await a.stop();
    await b.stop();
    await t.cleanup();
  }
});
