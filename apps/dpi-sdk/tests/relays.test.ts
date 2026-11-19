import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectArtifactStore } from "../src/node/artifacts.js";
import { ProjectHandoffStore } from "../src/node/handoffs.js";
import { ProjectMemoryStore } from "../src/node/memories.js";
import { ProjectRegistry } from "../src/node/projects.js";
import { ProjectRelayStore } from "../src/node/relays.js";

test("relay receipts are idempotent and commit their project event atomically", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-relays-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const memories = new ProjectMemoryStore(database);
  const artifacts = new ProjectArtifactStore(database, join(root, "artifacts"));
  const handoffs = new ProjectHandoffStore(database, projects, memories, artifacts, join(root, "handoffs"), join(root, "inbox"));
  const relays = new ProjectRelayStore(database);
  try {
    projects.create({ id: "alpha", name: "Alpha" });
    const handoff = handoffs.create("alpha", { requestId: "relay-source" });
    const planInput = {
      requestId: "relay-linux",
      handoffId: handoff.id,
      sourceId: "linux-home",
      repository: "D:\\projects\\alpha",
      projectSlug: "alpha-linux",
      title: "Alpha Linux",
    };
    const plan = relays.plan("alpha", planInput, 50);
    assert.equal(relays.plan("alpha", planInput, 60).id, plan.id);
    assert.throws(
      () => relays.plan("alpha", { ...planInput, projectSlug: "changed" }, 70),
      /request_id was reused/,
    );
    const input = {
      handoffId: handoff.id,
      sourceId: "linux-home",
      environmentId: "env-linux",
      target: "/home/user/DurablePiProjects/alpha",
      revision: "a".repeat(40),
      branch: "main",
      bundleSha256: "b".repeat(64),
      targetCreated: true,
      planId: plan.id,
    };
    const first = relays.record("alpha", input, 100);
    const replay = relays.record("alpha", { ...input, targetCreated: false }, 200);
    assert.equal(replay.id, first.id);
    assert.equal(relays.list("alpha").length, 1);
    assert.equal(projects.events("alpha").filter((event) => event.kind === "project.relay.ready").length, 1);
    assert.equal(first.status, "READY");
    assert.equal(first.planId, plan.id);
    assert.equal(relays.getPlan("alpha", plan.id)?.status, "READY");
    assert.equal(relays.getPlan("alpha", plan.id)?.receiptId, first.id);
    assert.equal(projects.events("alpha").filter((event) => event.kind === "project.relay.planned").length, 1);
  } finally {
    relays.close();
    handoffs.close();
    artifacts.close();
    memories.close();
    projects.close();
  }
});
