import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectArtifactStore } from "../src/node/artifacts.js";
import { ProjectHandoffStore } from "../src/node/handoffs.js";
import { ProjectMemoryStore } from "../src/node/memories.js";
import { ProjectRegistry } from "../src/node/projects.js";

test("handoff bundles contain versioned manifest, active memories and selected verified artifacts", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-handoff-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const memories = new ProjectMemoryStore(database);
  const artifacts = new ProjectArtifactStore(database, join(root, "artifacts"));
  const inbox = join(root, "inbox");
  const handoffs = new ProjectHandoffStore(database, projects, memories, artifacts, join(root, "handoffs"), inbox);
  try {
    projects.create({
      id: "alpha", templateId: "cross-platform", name: "Alpha", tokenLimit24h: 50_000, maxTaskTokens: 12_000,
      templatePlan: [{ role: "coordinator", permissionProfile: "READ_ONLY" }, { role: "coder", permissionProfile: "WORKSPACE_WRITE" }],
      maxCoordinationDepth: 6, maxDelegatedTasksPerTurn: 7,
      maxActiveTasks: 40, maxConcurrentTasks: 3,
    });
    projects.addMember("alpha", {
      id: "coordinator", deviceId: "device-a", sessionId: "session-a", agentId: "agent-a",
      name: "Coordinator", role: "coordinator", permissionProfile: "WORKSPACE_WRITE",
      executor: "codex", model: "gpt-6.1-sol", allowModelFallback: true,
      fallbackModels: ["gpt-6-astra"], cwd: "D:\\projects\\alpha",
    });
    memories.put("alpha", { key: "architecture.runtime", value: "durable", sourceType: "decision" });
    const environmentExpiry = Date.now() + 3_600_000;
    memories.put("alpha", {
      key: "environment.temporary_endpoint",
      value: "https://temporary.invalid",
      sourceType: "probe",
      expiresAt: environmentExpiry,
    });
    const expiredBeforeImport = Date.now() + 1_800_000;
    memories.put("alpha", {
      key: "environment.short_probe",
      value: "stale-before-import",
      sourceType: "probe",
      expiresAt: expiredBeforeImport,
    });
    const selected = artifacts.put("alpha", {
      id: "report",
      name: "report.md",
      content: "# Ready\n",
      mimeType: "text/markdown",
      includeInHandoff: true,
    });
    artifacts.put("alpha", { id: "private", name: "private.txt", content: "not exported" });
    const handoff = handoffs.create("alpha", 1_700_000_000_000);
    assert.equal(handoff.artifactCount, 1);
    const manifestText = await readFile(join(handoff.directory, "manifest.json"), "utf8");
    assert.equal(createHash("sha256").update(manifestText).digest("hex"), handoff.manifestSha256);
    const manifest = JSON.parse(manifestText) as {
      schemaVersion: number;
      project: {
        id: string; templateId: string; templatePlan: Array<{ role: string }>; tokenLimit24h: number; maxTaskTokens: number; maxCoordinationDepth: number;
        maxDelegatedTasksPerTurn: number; maxActiveTasks: number; maxConcurrentTasks: number;
        members: Array<{
          id: string; permissionProfile: string; model: string; allowModelFallback: boolean;
          fallbackModels: string[]; temporary: boolean; lifecycleState: string;
        }>;
      };
      memories: Array<{ key: string; expiresAt?: number }>;
      artifacts: Array<{ id: string; sha256: string; file: string }>;
      sourceCode: { included: boolean };
    };
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.project.id, "alpha");
    assert.equal(manifest.project.templateId, "cross-platform");
    assert.deepEqual(manifest.project.templatePlan.map((item) => item.role), ["coordinator", "coder"]);
    assert.equal(manifest.project.tokenLimit24h, 50_000);
    assert.equal(manifest.project.maxTaskTokens, 12_000);
    assert.equal(manifest.project.maxCoordinationDepth, 6);
    assert.equal(manifest.project.maxDelegatedTasksPerTurn, 7);
    assert.equal(manifest.project.maxActiveTasks, 40);
    assert.equal(manifest.project.maxConcurrentTasks, 3);
    assert.deepEqual(manifest.project.members, [{
      id: "coordinator",
      name: "Coordinator",
      role: "coordinator",
      permissionProfile: "WORKSPACE_WRITE",
      executor: "codex",
      model: "gpt-6.1-sol",
      allowModelFallback: true,
      fallbackModels: ["gpt-6-astra"],
      cwd: "D:\\projects\\alpha",
      temporary: false,
      lifecycleState: "ACTIVE",
    }]);
    assert.equal(manifest.memories[0]?.key, "architecture.runtime");
    assert.equal(
      manifest.memories.find((memory) => memory.key === "environment.temporary_endpoint")?.expiresAt,
      environmentExpiry,
    );
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.id), ["report"]);
    assert.equal(manifest.artifacts[0]?.sha256, selected.sha256);
    assert.equal(await readFile(join(handoff.directory, manifest.artifacts[0]!.file), "utf8"), "# Ready\n");
    assert.equal(manifest.sourceCode.included, false);
    const validation = handoffs.validate("alpha", handoff.id, 1_700_000_001_000);
    assert.equal(validation.valid, true);
    assert.equal(validation.schemaVersion, 2);
    assert.equal(validation.artifactCount, 1);
    assert.equal(validation.manifestSha256, handoff.manifestSha256);
    const requested = handoffs.create("alpha", { requestId: "handoff-request-1" }, 1_700_000_001_100);
    const replayed = handoffs.create("alpha", { requestId: "handoff-request-1" }, 1_700_000_001_200);
    assert.equal(replayed.id, requested.id);
    assert.equal(handoffs.list("alpha").filter((item) => item.id === requested.id).length, 1);
    assert.throws(
      () => handoffs.create("alpha", { requestId: "handoff-request-1", workspace: root }),
      /reused with different arguments/,
    );
    await cp(handoff.directory, join(inbox, "alpha-transfer"), { recursive: true });
    const imported = handoffs.importFromInbox("alpha-transfer", "alpha-imported", expiredBeforeImport + 1);
    assert.equal(imported.project.id, "alpha-imported");
    assert.equal(imported.project.templateId, "cross-platform");
    assert.deepEqual(imported.project.templatePlan.map((item) => item.role), ["coordinator", "coder"]);
    assert.equal(imported.project.autonomyMode, "SUPERVISED");
    assert.equal(imported.project.tokenLimit24h, 50_000);
    assert.equal(imported.project.maxTaskTokens, 12_000);
    assert.equal(imported.project.maxCoordinationDepth, 6);
    assert.equal(imported.project.maxDelegatedTasksPerTurn, 7);
    assert.equal(imported.project.maxActiveTasks, 40);
    assert.equal(imported.project.maxConcurrentTasks, 3);
    assert.equal(imported.project.members.length, 0);
    assert.equal(imported.memoriesImported, 2);
    assert.equal(imported.artifactsImported, 1);
    assert.equal(memories.list("alpha-imported").find((memory) => memory.key === "architecture.runtime")?.value, "durable");
    assert.equal(
      memories.list("alpha-imported").find((memory) => memory.key === "environment.temporary_endpoint")?.expiresAt,
      environmentExpiry,
    );
    assert.equal(
      memories.list("alpha-imported", "ALL").some((memory) => memory.key === "environment.short_probe"),
      false,
      "a fact that expired in transit must not be resurrected",
    );
    const blueprints = memories.list("alpha-imported").find((memory) => memory.key === "system.handoff.agent_blueprints")?.value as {
      bindingRequired: boolean; members: Array<{ id: string; fallbackModels: string[] }>;
    };
    assert.equal(blueprints.bindingRequired, true);
    assert.equal(blueprints.members[0]?.id, "coordinator");
    assert.deepEqual(blueprints.members[0]?.fallbackModels, ["gpt-6-astra"]);
    const importedBlueprints = handoffs.agentBlueprints("alpha-imported");
    assert.equal(importedBlueprints[0]?.bindingState, "UNBOUND");
    assert.equal(importedBlueprints[0]?.permissionProfile, "WORKSPACE_WRITE");
    const relayedHandoff = handoffs.create("alpha-imported", 1_700_000_002_050);
    const relayedManifest = JSON.parse(await readFile(join(relayedHandoff.directory, "manifest.json"), "utf8")) as {
      project: { members: Array<{ id: string }> }; memories: Array<{ key: string }>;
    };
    assert.deepEqual(relayedManifest.project.members.map((member) => member.id), ["coordinator"]);
    assert.equal(
      relayedManifest.memories.some((memory) => memory.key.startsWith("system.")),
      false,
      "platform projections are reconstructed explicitly instead of exported as ordinary project memory",
    );
    const rebound = projects.addMember("alpha-imported", {
      id: "target-coordinator", deviceId: "target-device", sessionId: "target-session", agentId: "target-agent",
      name: "Target Coordinator", role: "coordinator", permissionProfile: "READ_ONLY",
      executor: "codex", model: "gpt-6.1-sol", cwd: "C:\\target\\alpha",
    });
    const bound = handoffs.recordAgentBlueprintBinding(
      "alpha-imported", handoff.id, "coordinator", rebound.id, 1_700_000_002_100,
    );
    assert.equal(bound.bindingState, "BOUND");
    assert.equal(bound.boundMemberId, rebound.id);
    assert.equal(
      handoffs.recordAgentBlueprintBinding(
        "alpha-imported", handoff.id, "coordinator", rebound.id, 1_700_000_002_200,
      ).boundMemberId,
      rebound.id,
      "repeating the same binding is idempotent",
    );
    assert.equal(artifacts.list("alpha-imported")[0]?.sha256, selected.sha256);
    assert.throws(() => handoffs.importFromInbox("../escape", "escape-import"), /Invalid inbox bundle name/);
    await cp(handoff.directory, join(inbox, "broken-transfer"), { recursive: true });
    const brokenPath = join(inbox, "broken-transfer", "manifest.json");
    const broken = JSON.parse(await readFile(brokenPath, "utf8")) as { memories: unknown[] };
    broken.memories.push({ key: "broken", value: true, sourceType: 42 });
    const brokenText = `${JSON.stringify(broken, null, 2)}\n`;
    await writeFile(brokenPath, brokenText);
    await writeFile(
      join(inbox, "broken-transfer", "manifest.sha256"),
      `${createHash("sha256").update(brokenText).digest("hex")}  manifest.json\n`,
    );
    assert.throws(() => handoffs.importFromInbox("broken-transfer", "broken-import"), /Invalid memory metadata/);
    assert.equal(projects.get("broken-import"), undefined);
    assert.equal(artifacts.list("broken-import", "ALL").length, 0);
    await cp(handoff.directory, join(inbox, "future-transfer"), { recursive: true });
    const futurePath = join(inbox, "future-transfer", "manifest.json");
    const future = JSON.parse(await readFile(futurePath, "utf8")) as { minimumRuntimeVersion: string };
    future.minimumRuntimeVersion = "999.0.0";
    const futureText = `${JSON.stringify(future, null, 2)}\n`;
    await writeFile(futurePath, futureText);
    await writeFile(
      join(inbox, "future-transfer", "manifest.sha256"),
      `${createHash("sha256").update(futureText).digest("hex")}  manifest.json\n`,
    );
    assert.throws(() => handoffs.importFromInbox("future-transfer", "future-import"), /requires runtime 999\.0\.0/);
    assert.equal(projects.get("future-import"), undefined);
    await cp(handoff.directory, join(inbox, "legacy-v1-transfer"), { recursive: true });
    const legacyV1Path = join(inbox, "legacy-v1-transfer", "manifest.json");
    const legacyV1 = JSON.parse(await readFile(legacyV1Path, "utf8")) as {
      schemaVersion: number;
      project: { members: Array<Record<string, unknown>> };
    };
    legacyV1.schemaVersion = 1;
    for (const member of legacyV1.project.members) {
      delete member.permissionProfile;
      delete member.allowModelFallback;
      delete member.fallbackModels;
      delete member.temporary;
      delete member.lifecycleState;
    }
    const legacyV1Text = `${JSON.stringify(legacyV1, null, 2)}\n`;
    await writeFile(legacyV1Path, legacyV1Text);
    await writeFile(
      join(inbox, "legacy-v1-transfer", "manifest.sha256"),
      `${createHash("sha256").update(legacyV1Text).digest("hex")}  manifest.json\n`,
    );
    const legacyImported = handoffs.importFromInbox("legacy-v1-transfer", "legacy-v1-import", 1_700_000_002_500);
    assert.equal(legacyImported.project.id, "legacy-v1-import");
    const migratedBlueprint = handoffs.agentBlueprints("legacy-v1-import")[0]!;
    assert.equal(migratedBlueprint.permissionProfile, "ROLE_DEFAULT");
    assert.equal(migratedBlueprint.allowModelFallback, false);
    assert.deepEqual(migratedBlueprint.fallbackModels, []);
    assert.equal(migratedBlueprint.temporary, false);
    assert.equal(migratedBlueprint.lifecycleState, "ACTIVE");
    assert.deepEqual(
      memories.list("legacy-v1-import").find((memory) => memory.key === "system.handoff.schema_migration")?.value,
      { sourceSchemaVersion: 1, targetSchemaVersion: 2, handoffProtocol: "1.0" },
    );
    await cp(handoff.directory, join(inbox, "future-schema-transfer"), { recursive: true });
    const futureSchemaPath = join(inbox, "future-schema-transfer", "manifest.json");
    const futureSchema = JSON.parse(await readFile(futureSchemaPath, "utf8")) as { schemaVersion: number };
    futureSchema.schemaVersion = 3;
    const futureSchemaText = `${JSON.stringify(futureSchema, null, 2)}\n`;
    await writeFile(futureSchemaPath, futureSchemaText);
    await writeFile(
      join(inbox, "future-schema-transfer", "manifest.sha256"),
      `${createHash("sha256").update(futureSchemaText).digest("hex")}  manifest.json\n`,
    );
    assert.throws(
      () => handoffs.importFromInbox("future-schema-transfer", "future-schema-import"),
      /Unsupported handoff schema version: 3/,
    );
    assert.equal(projects.get("future-schema-import"), undefined);
    await cp(handoff.directory, join(inbox, "unsafe-policy-transfer"), { recursive: true });
    const unsafePolicyPath = join(inbox, "unsafe-policy-transfer", "manifest.json");
    const unsafePolicy = JSON.parse(await readFile(unsafePolicyPath, "utf8")) as {
      project: { maxConcurrentTasks: number };
    };
    unsafePolicy.project.maxConcurrentTasks = 1_001;
    const unsafePolicyText = `${JSON.stringify(unsafePolicy, null, 2)}\n`;
    await writeFile(unsafePolicyPath, unsafePolicyText);
    await writeFile(
      join(inbox, "unsafe-policy-transfer", "manifest.sha256"),
      `${createHash("sha256").update(unsafePolicyText).digest("hex")}  manifest.json\n`,
    );
    assert.throws(
      () => handoffs.importFromInbox("unsafe-policy-transfer", "unsafe-policy-import"),
      /Invalid handoff maxConcurrentTasks/,
    );
    assert.equal(projects.get("unsafe-policy-import"), undefined);
    await cp(handoff.directory, join(inbox, "unsafe-blueprint-transfer"), { recursive: true });
    const unsafeBlueprintPath = join(inbox, "unsafe-blueprint-transfer", "manifest.json");
    const unsafeBlueprint = JSON.parse(await readFile(unsafeBlueprintPath, "utf8")) as {
      project: { members: Array<{ model: string; fallbackModels: string[] }> };
    };
    unsafeBlueprint.project.members[0]!.fallbackModels = [unsafeBlueprint.project.members[0]!.model];
    const unsafeBlueprintText = `${JSON.stringify(unsafeBlueprint, null, 2)}\n`;
    await writeFile(unsafeBlueprintPath, unsafeBlueprintText);
    await writeFile(
      join(inbox, "unsafe-blueprint-transfer", "manifest.sha256"),
      `${createHash("sha256").update(unsafeBlueprintText).digest("hex")}  manifest.json\n`,
    );
    assert.throws(
      () => handoffs.importFromInbox("unsafe-blueprint-transfer", "unsafe-blueprint-import"),
      /Invalid handoff member blueprint/,
    );
    assert.equal(projects.get("unsafe-blueprint-import"), undefined);
    const secret = artifacts.put("alpha", {
      id: "secret",
      name: "accidental-key.txt",
      content: "-----BEGIN PRIVATE KEY-----\nnot-for-transfer\n-----END PRIVATE KEY-----",
      includeInHandoff: true,
    });
    assert.throws(() => handoffs.create("alpha", 1_700_000_003_000), /Handoff blocked: possible private key/);
    artifacts.expire("alpha", secret.id, 1_700_000_004_000);
    await writeFile(join(handoff.directory, manifest.artifacts[0]!.file), "tampered");
    assert.throws(() => handoffs.validate("alpha", handoff.id), /size mismatch|checksum mismatch/);
  } finally {
    handoffs.close();
    artifacts.close();
    memories.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Git-aware handoffs pin a clean revision and detect target drift", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-handoff-git-"));
  const database = join(root, "projects.sqlite");
  const workspace = join(root, "workspace");
  const projects = new ProjectRegistry(database);
  const memories = new ProjectMemoryStore(database);
  const artifacts = new ProjectArtifactStore(database, join(root, "artifacts"));
  const inbox = join(root, "inbox");
  const handoffs = new ProjectHandoffStore(database, projects, memories, artifacts, join(root, "handoffs"), inbox);
  const runGit = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", windowsHide: true }).trim();
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    runGit("init");
    runGit("config", "user.name", "Durable Pi Test");
    runGit("config", "user.email", "durable-pi@example.invalid");
    await writeFile(join(workspace, "README.md"), "baseline\n");
    runGit("add", "README.md");
    runGit("commit", "-m", "baseline");
    const baseline = runGit("rev-parse", "HEAD");
    projects.create({ id: "git-project", name: "Git project" });

    const handoff = handoffs.create("git-project", { workspace }, 1_700_100_000_000);
    const manifest = JSON.parse(await readFile(join(handoff.directory, "manifest.json"), "utf8")) as {
      sourceCode: { git: { repositoryName: string; revision: string; branch: string | null } };
    };
    assert.equal(manifest.sourceCode.git.repositoryName, "workspace");
    assert.equal(manifest.sourceCode.git.revision, baseline);
    assert.equal(handoffs.checkGit("git-project", handoff.id, workspace, 1_700_100_001_000).status, "SAME");
    await cp(handoff.directory, join(inbox, "git-transfer"), { recursive: true });
    handoffs.importFromInbox("git-transfer", "git-imported", 1_700_100_001_500);
    const importedCheck = handoffs.checkImportedGit("git-imported", workspace, 1_700_100_001_600);
    assert.equal(importedCheck.status, "SAME");
    assert.equal(importedCheck.handoffId, handoff.id);
    assert.equal(
      (memories.list("git-imported").find((item) => item.key === "system.handoff.git_baseline")?.value as { revision: string }).revision,
      baseline,
    );

    await writeFile(join(workspace, "README.md"), "baseline\nahead\n");
    runGit("add", "README.md");
    runGit("commit", "-m", "ahead");
    const ahead = handoffs.checkGit("git-project", handoff.id, workspace, 1_700_100_002_000);
    assert.equal(ahead.status, "TARGET_AHEAD");
    assert.equal(ahead.safeToApply, true);

    await writeFile(join(workspace, "dirty.txt"), "not committed\n");
    const dirty = handoffs.checkGit("git-project", handoff.id, workspace, 1_700_100_003_000);
    assert.equal(dirty.status, "TARGET_DIRTY");
    assert.equal(dirty.safeToApply, false);
    assert.throws(() => handoffs.create("git-project", { workspace }), /uncommitted changes/);
    await rm(join(workspace, "dirty.txt"));

    runGit("reset", "--hard", baseline);
    await writeFile(join(workspace, "README.md"), "replacement history\n");
    runGit("add", "README.md");
    runGit("commit", "--amend", "-m", "diverged");
    const diverged = handoffs.checkGit("git-project", handoff.id, workspace, 1_700_100_004_000);
    assert.equal(diverged.status, "DIVERGED");
    assert.equal(diverged.safeToApply, false);
  } finally {
    handoffs.close();
    artifacts.close();
    memories.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
