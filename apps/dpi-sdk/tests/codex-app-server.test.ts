import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/node/codex-app-server.js";

test("Codex app-server adapter initializes, lists models and closes", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    shell: false,
    requestTimeoutMs: 2_000,
  });
  try {
    await client.start();
    assert.deepEqual(await client.models(), {
      data: [{ id: "current-model" }, { id: "backup-model", inputModalities: ["text"] }],
      nextCursor: null,
    });
  } finally {
    await client.close();
  }
});

test("Codex app-server adapter runs a thread turn and safely declines server approval requests", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    shell: false,
    requestTimeoutMs: 2_000,
  });
  try {
    const { threadId } = await client.startThread({ model: "current-model", ephemeral: true });
    assert.equal((await client.resumeThread(threadId, { model: "current-model" })).threadId, threadId);
    const events: string[] = [];
    const result = await client.runTurn(threadId, "Reply exactly DURABLE_CODEX_OK", {
      timeoutMs: 2_000,
      onEvent: (method) => events.push(method),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "DURABLE_CODEX_OK");
    assert.equal(result.turnId, "turn-1");
    assert.ok(events.includes("item/started"));
    assert.ok(events.includes("item/completed"));
    await client.archiveThread(threadId);
  } finally {
    await client.close();
  }
});

test("Codex app-server adapter registers and executes application-owned dynamic tools", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    shell: false,
    requestTimeoutMs: 2_000,
    experimentalApi: true,
    serverRequestHandler: async (method, params) => {
      calls.push({ method, params });
      if (method !== "item/tool/call") return undefined;
      return {
        contentItems: [{ type: "inputText", text: JSON.stringify([{ id: "agent-1", role: "coder" }]) }],
        success: true,
      };
    },
  });
  try {
    const thread = await client.startThread({
      dynamicTools: [{
        type: "namespace",
        name: "durable_pi",
        description: "Project coordination tools",
        tools: [{
          type: "function",
          name: "list_project_agents",
          description: "List active project agents",
          inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
        }],
      }],
    });
    const result = await client.runTurn(thread.threadId, "DYNAMIC_TOOL");
    assert.match(result.text, /agent-1/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "item/tool/call");
    assert.deepEqual(calls[0]?.params.arguments, { project_id: "alpha" });
  } finally {
    await client.close();
  }
});

test("Codex app-server abort during pending turn/start is handled without an unhandled rejection", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const client = new CodexAppServerClient({ command: process.execPath, args: [fixture], shell: false, requestTimeoutMs: 2_000 });
  try {
    const { threadId } = await client.startThread({ model: "current-model", ephemeral: true });
    const controller = new AbortController();
    const turn = client.runTurn(threadId, "DELAY_START", { timeoutMs: 2_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(turn, /Codex turn aborted/);
  } finally {
    await client.close();
  }
});
