import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { T3CodeClient, T3CodeCommandError } from "../src/node/t3-code.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-t3.mjs", import.meta.url));
const client = () => new T3CodeClient({
  command: process.execPath,
  commandArgs: [fixture],
  baseDir: "test-home",
  timeoutMs: 2_000,
});

test("T3 adapter registers projects and lists durable threads", async () => {
  const t3 = client();
  assert.deepEqual(await t3.addProject("C:\\work", "Demo"), {
    projectId: "project-1",
    title: "Demo",
    path: "C:\\work",
  });
  const threads = await t3.listThreads("C:\\work");
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.threadId, "thread-1");
});

test("T3 adapter starts isolated worktree threads and resumes them", async () => {
  const t3 = client();
  const started = await t3.startThread("C:\\work", "build", {
    provider: "codex",
    model: "model-1",
    worktree: "main",
    branch: "feature/test",
    wait: true,
  });
  assert.deepEqual(started, {
    threadId: "thread-2",
    runId: "run-2",
    status: "completed",
    reply: "ok",
    error: null,
  });
  assert.equal((await t3.send(started.threadId, "continue", { wait: true })).reply, "continued");
  const detail = await t3.showThread(started.threadId, 10);
  assert.equal(detail.thread.threadId, started.threadId);
  assert.equal(detail.messages[0]?.text, "ok");
});

test("T3 adapter exposes linked execution environments", async () => {
  assert.deepEqual(await client().listEnvironments(), [{ environmentId: "env-1", name: "Linux B", status: "online" }]);
});

test("T3 adapter issues narrowly scoped one-use credentials", async () => {
  const t3 = client();
  const issued = await t3.createPairingCredential({
    scopes: ["orchestration:read", "orchestration:operate"],
    ttl: "10m",
    label: "Durable Pi",
  });
  assert.equal(issued.id, "pairing-1");
  assert.equal(issued.credential, "one-use-secret");
  assert.deepEqual(issued.scopes, ["orchestration:read", "orchestration:operate"]);
  await t3.revokePairingCredential(issued.id);
  await t3.revokeAuthSession("session-1");
});

test("T3 adapter rejects incomplete model selection and surfaces command failures", async () => {
  const t3 = client();
  await assert.rejects(t3.startThread("C:\\work", "build", { provider: "codex" }), /supplied together/);
  const failing = new T3CodeClient({ command: process.execPath, commandArgs: [fixture, "FAIL"], timeoutMs: 2_000 });
  await assert.rejects(
    failing.listEnvironments(),
    (error: unknown) => error instanceof T3CodeCommandError && error.exitCode === 7 && /synthetic failure/.test(error.stderr),
  );
});
