import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectApprovalStore } from "../src/node/approvals.js";
import { ProjectRegistry } from "../src/node/projects.js";

test("approvals bind exact parameters and can be consumed only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-approvals-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const approvals = new ProjectApprovalStore(path);
  try {
    const operation = { tool: "delete", args: { paths: ["temp/a", "temp/b"] } };
    const request = approvals.request(
      "alpha",
      { id: "approval-1", operation, requestedBy: "agent:coder", ttlMs: 10_000 },
      1_000,
    );
    assert.equal(request.status, "PENDING");
    assert.equal(approvals.decide("alpha", request.id, { decision: "APPROVED", decidedBy: "user:admin" }, 1_100).status, "APPROVED");
    assert.throws(
      () => approvals.consume("alpha", request.id, { tool: "delete", args: { paths: ["temp"] } }, "worker:1", 1_200),
      /does not match/,
    );
    const consumed = approvals.consume("alpha", request.id, operation, "worker:1", 1_300);
    assert.equal(consumed.status, "CONSUMED");
    assert.equal(consumed.consumedBy, "worker:1");
    assert.throws(() => approvals.consume("alpha", request.id, operation, "worker:1", 1_400), /consumed/);
  } finally {
    approvals.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approvals expire and approved authorization can be revoked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-approval-expiry-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const approvals = new ProjectApprovalStore(path);
  try {
    approvals.request("alpha", { id: "expired", operation: { tool: "install", package: "x" }, requestedBy: "agent", ttlMs: 1_000 }, 1_000);
    assert.equal(approvals.list("alpha", 2_001).find((item) => item.id === "expired")?.status, "EXPIRED");
    assert.throws(
      () => approvals.decide("alpha", "expired", { decision: "APPROVED", decidedBy: "user" }, 2_002),
      /expired/,
    );
    approvals.request("alpha", { id: "orphan-pending", operation: { tool: "write", path: "a" }, requestedBy: "agent" }, 3_000);
    const invalidated = approvals.invalidate("alpha", "orphan-pending", "scheduler", "lease superseded", 3_100);
    assert.equal(invalidated.status, "EXPIRED");
    assert.throws(
      () => approvals.decide("alpha", "orphan-pending", { decision: "APPROVED", decidedBy: "user" }, 3_200),
      /expired/,
    );

    const active = approvals.request("alpha", { id: "revoke", operation: { tool: "push", remote: "origin" }, requestedBy: "agent" }, 3_000);
    approvals.decide("alpha", active.id, { decision: "APPROVED", decidedBy: "user" }, 3_100);
    assert.equal(approvals.revoke("alpha", active.id, "user", 3_200).status, "REVOKED");
    assert.throws(() => approvals.consume("alpha", active.id, active.operation, "worker", 3_300), /revoked/);
  } finally {
    approvals.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});
