import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const expectedProjectId = process.argv[3] ?? "durable-pi-platform";
const model = process.argv[4] ?? "gpt-6.2-sol";
const providerInstanceId = process.argv[5] ?? "codex";
const gateway = new T3RuntimeGateway();

const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · T3 控制面验证",
  message:
    "Call the get_durable_project MCP tool. Reply with only the Durable Pi project id returned by that tool, with no punctuation or explanation.",
  clientRequestId: `durable-pi-mcp-verification-${Date.now()}`,
  providerInstanceId,
  model,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 verification ended in ${result.status}`);
if (result.text.trim() !== expectedProjectId)
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected ${expectedProjectId}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  projectId: expectedProjectId,
  t3ProjectId: result.projectId,
  threadId: result.threadId,
  runId: result.runId,
  model,
  providerInstanceId,
})}\n`);
