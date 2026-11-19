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
import { ProjectReturnStore } from "../src/node/returns.js";

test("remote return plans freeze a READY relay and commit one idempotent receipt", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-returns-"));
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  const memories = new ProjectMemoryStore(database);
  const artifacts = new ProjectArtifactStore(database, join(root, "artifacts"));
  const handoffs = new ProjectHandoffStore(database, projects, memories, artifacts, join(root, "handoffs"), join(root, "inbox"));
  const relays = new ProjectRelayStore(database);
  const returns = new ProjectReturnStore(database);
  try {
    projects.create({ id: "alpha", name: "Alpha" });
    const handoff = handoffs.create("alpha", { requestId: "handoff" });
    const relay = relays.record("alpha", {
      handoffId: handoff.id,
      sourceId: "linux-home",
      environmentId: "env-linux",
      target: "/home/user/DurablePiProjects/alpha-linux",
      revision: "a".repeat(40),
      branch: "main",
      bundleSha256: "b".repeat(64),
      targetCreated: true,
    }, 100);
    const planInput = {
      requestId: "return-linux",
      sourceId: "linux-home",
      relayReceiptId: relay.id,
      repository: "D:\\projects\\alpha",
      projectSlug: "alpha-linux",
    };
    const plan = returns.plan("alpha", planInput, 200);
    assert.equal(returns.plan("alpha", planInput, 300).id, plan.id);
    assert.throws(
      () => returns.plan("alpha", { ...planInput, projectSlug: "changed" }, 400),
      /request_id was reused|target does not match/,
    );
    const receiptInput = {
      planId: plan.id,
      sourceId: "linux-home",
      environmentId: "env-linux",
      remoteTarget: "/home/user/DurablePiProjects/alpha-linux",
      localRef: "refs/dpi/remotes/linux-home/alpha-linux",
      revision: "c".repeat(40),
      branch: "main",
      bundleSha256: "d".repeat(64),
    };
    const receipt = returns.record("alpha", receiptInput, 500);
    assert.equal(returns.record("alpha", receiptInput, 600).id, receipt.id);
    assert.equal(returns.getPlan("alpha", plan.id)?.status, "READY");
    assert.equal(returns.getPlan("alpha", plan.id)?.receiptId, receipt.id);
    assert.equal(returns.listReceipts("alpha").length, 1);
    assert.equal(projects.events("alpha").filter((event) => event.kind === "project.return.ready").length, 1);
    assert.throws(
      () => returns.record("alpha", { ...receiptInput, remoteTarget: "/tmp/other" }, 700),
      /does not match/,
    );
    const integrationInput = {
      requestId: "integrate-linux",
      sourceId: "linux-home",
      projectSlug: "alpha-linux",
      returnReceiptId: receipt.id,
      repository: "D:\\projects\\alpha",
      managedRef: "refs/dpi/remotes/linux-home/alpha-linux",
      targetBranch: "main",
      baseRevision: "a".repeat(40),
      remoteRevision: receipt.revision,
    };
    const integration = returns.planFastForward("alpha", integrationInput, 800);
    assert.equal(returns.planFastForward("alpha", integrationInput, 900).id, integration.id);
    const applied = returns.recordFastForward("alpha", {
      planId: integration.id,
      sourceId: "linux-home",
      targetBranch: "main",
      previousRevision: "a".repeat(40),
      appliedRevision: receipt.revision,
    }, 1_000);
    assert.equal(returns.recordFastForward("alpha", {
      planId: integration.id,
      sourceId: "linux-home",
      targetBranch: "main",
      previousRevision: "a".repeat(40),
      appliedRevision: receipt.revision,
    }, 1_100).id, applied.id);
    assert.equal(returns.getIntegrationPlan("alpha", integration.id)?.status, "APPLIED");
    assert.equal(returns.listIntegrationReceipts("alpha").length, 1);
    assert.equal(projects.events("alpha").filter((event) => event.kind === "project.integration.applied").length, 1);
  } finally {
    returns.close();
    relays.close();
    handoffs.close();
    artifacts.close();
    memories.close();
    projects.close();
  }
});
