import { resolve } from "node:path";

import { ProjectMemoryStore } from "../../dpi-sdk/src/node/memories.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3] ?? "durable-pi-platform";
const memberId = process.argv[4] ?? "t3-coordinator";
const requestId = `write-verification-${Date.now()}`;
const key = "verification.t3_mcp_write";
const gateway = new T3RuntimeGateway();

const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · T3 写入链路验证",
  message: [
    "Call the remember_durable_fact MCP tool exactly once with:",
    `request_id=${requestId}`,
    `key=${key}`,
    'value={"verified":true,"path":"t3-codex-mcp"}',
    "visibility=private",
    "After the tool succeeds, reply with only WRITE_OK.",
  ].join("\n"),
  clientRequestId: `durable-pi-mcp-write-${requestId}`,
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  runtimeMode: "auto",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 verification ended in ${result.status}`);
if (result.text.trim() !== "WRITE_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected WRITE_OK`);

const memories = new ProjectMemoryStore();
try {
  const memory = memories.visible(projectId, memberId).find((candidate) => candidate.key === key);
  if (!memory) throw Error(`T3 did not persist ${key}`);
  if (memory.memberId !== memberId) throw Error("T3 write was not scoped to the calling Agent");
  if (JSON.stringify(memory.value) !== JSON.stringify({ verified: true, path: "t3-codex-mcp" }))
    throw Error(`T3 persisted unexpected value: ${JSON.stringify(memory.value)}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    memberId,
    memoryId: memory.id,
    memoryVersion: memory.version,
    t3ProjectId: result.projectId,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  memories.close();
}
