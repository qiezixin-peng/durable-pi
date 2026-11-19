import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const model = process.argv[3] ?? "gpt-6.2-sol";
const providerInstanceId = process.argv[4] ?? "codex_durable_coordinator";
const requestId = `execution-targets-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · execution-target discovery validation",
  message: [
    "Call list_durable_execution_targets exactly once.",
    "Verify linux-home lists only gpt-5.6-sol, macos-home lists only gpt-6.1-sol, liveStatusAvailable is true, and both targets are reachable.",
    "Do not use shell or filesystem tools. Reply with only EXECUTION_TARGETS_OK after the MCP result proves both conditions.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId,
  model,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status !== "completed") throw Error(`T3 execution-target validation ended in ${result.status}`);
if (result.text.trim() !== "EXECUTION_TARGETS_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected EXECUTION_TARGETS_OK`);
process.stdout.write(`${JSON.stringify({ ok: true, model, providerInstanceId, threadId: result.threadId, runId: result.runId })}\n`);
