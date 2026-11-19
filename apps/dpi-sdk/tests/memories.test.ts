import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemoryStore } from "../src/node/memories.js";
import { ProjectRegistry } from "../src/node/projects.js";

test("project memories keep current facts, optimistic versions and immutable revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-memory-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const agentA = projects.addMember("alpha", { id: "agent-a", deviceId: "box", sessionId: "s", agentId: "a" });
  const agentB = projects.addMember("alpha", { id: "agent-b", deviceId: "box", sessionId: "s", agentId: "b" });
  const memories = new ProjectMemoryStore(path);
  try {
    const first = memories.put(
      "alpha",
      { key: "architecture.database", value: { engine: "sqlite" }, sourceType: "decision", sourceId: "task-1" },
      1_000,
    );
    assert.equal(first.version, 1);
    assert.deepEqual(first.value, { engine: "sqlite" });
    assert.throws(
      () => memories.put("alpha", { key: "system.handoff.agent_blueprints", value: [], sourceType: "user" }),
      /namespace is reserved/,
    );
    const systemMemory = memories.putSystem(
      "alpha",
      { key: "system.test.projection", value: { safe: true }, sourceType: "platform" },
      1_050,
    );
    assert.equal(systemMemory.key, "system.test.projection");
    assert.equal(
      memories.visible("alpha", agentA.id).some((memory) => memory.id === systemMemory.id),
      false,
      "platform projections never enter Agent-visible context",
    );
    assert.throws(
      () => memories.putSystem("alpha", { key: "user.fact", value: true, sourceType: "platform" }),
      /must use the system/,
    );
    assert.throws(() => memories.expire("alpha", systemMemory.id, 1, 1_051), /cannot be expired/);
    memories.expireSystem("alpha", systemMemory.id, 1, 1_051);
    const second = memories.put(
      "alpha",
      {
        key: first.key,
        value: { engine: "sqlite", mode: "wal" },
        sourceType: "decision",
        sourceId: "task-2",
        expectedVersion: 1,
      },
      1_100,
    );
    assert.equal(second.version, 2);
    assert.throws(
      () =>
        memories.put("alpha", {
          key: first.key,
          value: {},
          sourceType: "decision",
          expectedVersion: 1,
        }),
      /version conflict/,
    );
    assert.throws(
      () =>
        memories.put("alpha", {
          key: first.key,
          value: {},
          sourceType: "decision",
          expectedVersion: Number.NaN,
        }),
      /positive integer/,
    );
    assert.deepEqual(
      memories.history("alpha", first.id).map((revision) => [revision.version, revision.status, revision.value]),
      [
        [1, "ACTIVE", { engine: "sqlite" }],
        [2, "ACTIVE", { engine: "sqlite", mode: "wal" }],
      ],
    );
    const privateMemory = memories.put("alpha", {
      key: "architecture.database",
      value: { note: "agent A only" },
      sourceType: "agent-note",
      memberId: agentA.id,
    }, 1_150);
    assert.equal(privateMemory.memberId, agentA.id);
    assert.equal(privateMemory.key, "architecture.database");
    assert.equal(memories.list("alpha").length, 1, "shared listings never expose private memory");
    assert.equal(memories.visible("alpha", agentA.id).length, 2);
    assert.equal(memories.visible("alpha", agentB.id).length, 1);
    assert.equal(memories.visible("alpha", agentB.id).some((memory) => memory.id === privateMemory.id), false);
    const idempotent = memories.put("alpha", {
      key: "debugging.root_cause",
      value: "lease expired",
      sourceType: "agent",
      memberId: agentA.id,
      requestId: "tool-call-1",
    }, 1_160);
    const replay = memories.put("alpha", {
      key: "debugging.root_cause",
      value: "lease expired",
      sourceType: "agent",
      memberId: agentA.id,
      requestId: "tool-call-1",
    }, 1_170);
    assert.equal(replay.id, idempotent.id);
    assert.equal(replay.version, 1, "a retried tool call must not create a second revision");
    assert.throws(
      () => memories.put("alpha", {
        key: "debugging.root_cause",
        value: "different input",
        sourceType: "agent",
        memberId: agentA.id,
        requestId: "tool-call-1",
      }),
      /reused with different input/,
    );
    const expired = memories.expire("alpha", first.id, 2, 1_200);
    assert.equal(expired.status, "EXPIRED");
    assert.equal(memories.list("alpha").length, 0);
    assert.equal(memories.list("alpha", "ALL").length, 2);
    assert.equal(memories.history("alpha", first.id).length, 3);
    assert.equal(projects.events("alpha")[0]?.kind, "memory.expired");
  } finally {
    memories.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory validity expires automatically and keeps an auditable revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-memory-expiry-"));
  const path = join(dir, "projects.sqlite");
  const projects = new ProjectRegistry(path);
  projects.create({ id: "alpha", name: "Alpha" });
  const memories = new ProjectMemoryStore(path);
  try {
    const now = Date.now();
    const fact = memories.put("alpha", {
      key: "environment.endpoint",
      value: "temporary",
      sourceType: "probe",
      expiresAt: now + 10_000,
      requestId: "probe-1",
    }, now);
    assert.equal(fact.expiresAt, now + 10_000);
    assert.deepEqual(memories.expireDue(now + 9_999), { expired: 0, remaining: 0 });
    assert.deepEqual(memories.expireDue(now + 10_000), { expired: 1, remaining: 0 });
    assert.equal(memories.get("alpha", fact.id)?.status, "EXPIRED");
    assert.deepEqual(memories.expireDue(now + 10_000), { expired: 0, remaining: 0 });
    const history = memories.history("alpha", fact.id);
    assert.deepEqual(history.map((item) => [item.version, item.status, item.expiresAt]), [
      [1, "ACTIVE", now + 10_000],
      [2, "EXPIRED", now + 10_000],
    ]);
    assert.equal((projects.events("alpha", 20).filter((event) => event.kind === "memory.expired")).length, 1);
    assert.throws(() => memories.put("alpha", {
      key: "invalid.expiry", value: true, sourceType: "probe", expiresAt: now,
    }, now), /future integer/);
  } finally {
    memories.close();
    projects.close();
    await rm(dir, { recursive: true, force: true });
  }
});
