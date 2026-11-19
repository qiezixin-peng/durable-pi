import assert from "node:assert/strict";
import { test } from "node:test";
import { faux, tempStore } from "./helpers.js";

test("Pi Durable SDK adapter owns the agent loop behind serializable platform contracts", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const runtime = store.runtime;
    assert.deepEqual(runtime.info, {
      kind: "pi-durable-sdk",
      version: "1.0.3",
      capabilities: [
        "sessions",
        "agents",
        "fork",
        "streaming",
        "tools",
        "extensions",
        "compaction",
        "recovery",
      ],
    });

    const session = await runtime.createSession({
      name: "Adapter contract",
      cwd: "project",
      model: faux,
      thinkingLevel: "minimal",
    });
    const main = { sessionId: session.id, agentId: 1 };

    const queued = await runtime.send(main, {
      content: "hello through the adapter",
      requestId: "adapter-message-1",
    });
    assert.equal(queued.status, "queued");
    const answer = await runtime.wait(session.id, queued.submissionId, 10_000);
    assert.equal(answer.status === "done" && answer.answer.text, "Echo: hello through the adapter");

    const detail = await runtime.getAgent(main);
    assert.equal(detail.sessionId, session.id);
    assert.equal(detail.config.model?.provider, "faux");
    assert.ok(detail.tools.some((tool) => tool.name === "bash" && tool.writes));

    const readOnly = await runtime.configureAgent(main, { readOnly: true });
    assert.equal(readOnly.readOnly, true);
    assert.equal((await runtime.getAgent(main)).tools.find((tool) => tool.name === "bash")?.offered, false);

    const reviewer = await runtime.createAgent(session.id, { from: 1, name: "Reviewer" });
    assert.equal(reviewer.name, "Reviewer");
    assert.equal((await runtime.getAgent({ sessionId: session.id, agentId: reviewer.id })).config.readOnly, false);

    const history = await runtime.history(main);
    const at = history.items.at(-1)?.id;
    assert.equal(typeof at, "number");
    const fork = await runtime.fork(main, { entryId: at as number, name: "Alternative" });
    assert.equal(fork.kind, "fork");
    assert.equal(fork.parentId, 1);

    await store.close();
    store = await t.open();
    assert.equal((await store.runtime.getAgent(main)).name, "Main");
    const resumed = await store.runtime.send(main, {
      content: "after restart",
      requestId: "adapter-message-2",
      waitMs: 10_000,
    });
    assert.equal(resumed.status === "done" && resumed.answer.text, "Echo: after restart");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
