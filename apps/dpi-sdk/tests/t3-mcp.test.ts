import assert from "node:assert/strict";
import { test } from "node:test";

import { T3McpClient } from "../src/node/t3-mcp.js";
import type { T3CodeClient, T3PairingCredential } from "../src/node/t3-code.js";

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

test("T3 MCP pairing exchanges a one-use credential and caps every request", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let revokedSession: string | undefined;
  const accessToken = `${Buffer.from(JSON.stringify({ sid: "auth-session-1" })).toString("base64url")}.signature`;
  const fakeT3 = {
    createPairingCredential: async () => ({
      id: "pair-1",
      credential: "pair-secret",
      label: "Durable Pi",
      scopes: ["orchestration:read", "orchestration:operate"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    } satisfies T3PairingCredential),
    revokePairingCredential: async () => undefined,
    revokeAuthSession: async (id: string) => { revokedSession = id; },
  } as unknown as T3CodeClient;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/mcp/register")) return json({ client_id: "client-1" });
    if (url.endsWith("/oauth/mcp/decision")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.decision.code, "pair-secret");
      assert.equal(body.decision.access, "approval-required");
      return json({ redirectTo: `http://127.0.0.1:49731/callback?code=code-1&state=${body.authorization.state}` });
    }
    if (url.endsWith("/oauth/mcp/token")) return json({ access_token: accessToken });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(headers.get("t3-mode-limit"), "approval-required/default");
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "session-1" } });
    assert.equal(headers.get("mcp-session-id"), "session-1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t3_thread_launch" }] } });
    if (body.method === "tools/call") {
      const name = body.params.name;
      const structuredContent = name === "t3_project_list"
        ? { projects: [{ id: "project-1", title: "Demo", workspaceRoot: "C:\\work" }], nextCursor: null }
        : name === "t3_project_create"
          ? { id: "project-2", title: "Remote", workspaceRoot: "/srv/remote", defaultModelSelection: null, scripts: [], createdAt: "now", updatedAt: "now", deletedAt: null }
        : name === "t3_environment_links"
          ? { environmentId: "env-a", links: [{ environmentId: "env-b", label: "Linux B", status: "reachable", access: "auto", expiresAt: "2030-01-01T00:00:00Z", lastError: null }], notListed: "link it" }
        : name === "t3_thread_launch"
        ? { threadId: "thread-1", projectId: "project-1", runId: "run-1", status: "running" }
        : name === "t3_thread_send"
          ? { threadId: "thread-1", messageId: "message-2", runId: "run-2", status: "running", delivery: "started" }
        : name === "t3_thread_wait"
          ? { threadId: "thread-1", runId: "run-1", status: "completed", timedOut: false }
          : name === "t3_thread_interrupt"
            ? { threadId: "thread-1", runId: "run-1", status: "interrupt_requested" }
          : name === "t3_thread_read"
            ? { thread: { threadId: "thread-1" }, items: [] }
            : { providers: [] };
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent } });
    }
    throw Error(`unexpected request ${url}`);
  };

  const client = await T3McpClient.pair(fakeT3, {
    endpoint: "http://127.0.0.1:3773/mcp",
    access: "approval-required",
    modeLimit: { runtimeMode: "approval-required" },
    fetch: fetcher,
  });
  await client.initialize();
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["t3_thread_launch"]);
  assert.equal((await client.listProjects())[0]?.workspaceRoot, "C:\\work");
  assert.equal((await client.createProject({
    environmentId: "env-b", title: "Remote", workspaceRoot: "/srv/remote",
  })).id, "project-2");
  assert.equal((await client.environmentLinks()).links[0]?.environmentId, "env-b");
  const launched = await client.launchThread({
    projectId: "project-1",
    title: "Validation",
    message: "test",
    providerInstanceId: "codex",
    model: "gpt-6-astra",
    runtimeMode: "approval-required",
    clientRequestId: "task-1",
  });
  assert.equal(launched.threadId, "thread-1");
  assert.equal((await client.sendThread({ threadId: launched.threadId, message: "continue", clientRequestId: "task-2" })).runId, "run-2");
  assert.equal((await client.waitThread({ threadId: launched.threadId })).status, "completed");
  assert.equal((await client.interruptThread({ threadId: launched.threadId, runId: "run-1", reason: "cancelled" })).status, "interrupt_requested");
  assert.deepEqual((await client.readThread({ threadId: launched.threadId })).items, []);
  await client.close();
  assert.equal(revokedSession, "auth-session-1");
  assert.equal(calls.length, 15);
});

test("T3 MCP rejects calls before initialization", async () => {
  const client = new T3McpClient({ accessToken: "secret", fetch: async () => json({}) });
  await assert.rejects(client.listTools(), /not initialized/);
});
