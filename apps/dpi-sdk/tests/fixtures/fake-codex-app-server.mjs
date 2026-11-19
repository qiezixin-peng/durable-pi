import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let pendingTurn;
let dynamicTools = [];
let experimentalApi = false;
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    experimentalApi = message.params?.capabilities?.experimentalApi === true;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } })}\n`);
  } else if (message.method === "model/list") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { data: [{ id: "current-model" }, { id: "backup-model", inputModalities: ["text"] }], nextCursor: null } })}\n`);
  } else if (message.method === "thread/start") {
    if (message.params.dynamicTools?.length && !experimentalApi) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "thread/start.dynamicTools requires experimentalApi capability" } })}\n`);
      continue;
    }
    dynamicTools = message.params.dynamicTools ?? [];
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } })}\n`);
  } else if (message.method === "thread/resume") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } })}\n`);
  } else if (message.method === "thread/archive") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
  } else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turn = { id: "turn-1", items: [], status: "completed" };
    if (message.params.input?.[0]?.text === "DELAY_START") {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turn.id, items: [], status: "inProgress" } } })}\n`);
      }, 100);
      continue;
    }
    pendingTurn = { threadId, turn };
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turn.id, items: [], status: "inProgress" } } })}\n`);
    if (message.params.input?.[0]?.text === "DYNAMIC_TOOL" && dynamicTools.length) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 901, method: "item/tool/call", params: { threadId, turnId: turn.id, callId: "call-1", namespace: "durable_pi", tool: "list_project_agents", arguments: { project_id: "alpha" } } })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "item/fileChange/requestApproval", params: { threadId, turnId: turn.id, itemId: "item-approval", startedAtMs: Date.now() } })}\n`);
  } else if (message.id === 901 && message.result?.success === true && pendingTurn) {
    const { threadId, turn } = pendingTurn;
    const text = message.result.contentItems?.[0]?.text ?? "";
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "item-1", delta: text } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn } })}\n`);
    pendingTurn = undefined;
  } else if (message.id === 900 && message.result?.decision === "decline" && pendingTurn) {
    const { threadId, turn } = pendingTurn;
    const command = { id: "item-command", type: "commandExecution", command: "echo ok", commandActions: [], cwd: ".", status: "inProgress" };
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId: turn.id, startedAtMs: Date.now(), item: command } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "item-1", delta: "DURABLE_" } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "item-1", delta: "CODEX_OK" } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "ok" } } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn } })}\n`);
    pendingTurn = undefined;
  }
}
