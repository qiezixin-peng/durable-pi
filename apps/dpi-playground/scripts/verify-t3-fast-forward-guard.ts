import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const requestId = `fast-forward-guard-${Date.now()}`;
const gateway = new T3RuntimeGateway();
const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · fast-forward guard validation",
  message: [
    "Use only the plan_durable_fast_forward MCP tool. Do not use shell, PowerShell, Git, or command tools.",
    "Call it once with",
    `request_id=${requestId}, source_id=linux-home, project_slug=t3-self-service-validation-linux.`,
    "The Windows HEAD already equals the verified remote revision, so the tool must reject the plan as unnecessary.",
    "Reply with only FAST_FORWARD_GUARD_OK after observing that exact safe rejection.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status === "waiting")
  await gateway.cancel({ threadId: result.threadId, runId: result.runId, runtimeMode: "approval-required" }, "Guard verification must not request command approval");
if (result.status !== "completed") throw Error(`T3 fast-forward guard ended in ${result.status}: ${JSON.stringify(result)}`);
if (result.text.trim() !== "FAST_FORWARD_GUARD_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected FAST_FORWARD_GUARD_OK`);
process.stdout.write(`${JSON.stringify({ ok: true, threadId: result.threadId, runId: result.runId })}\n`);
