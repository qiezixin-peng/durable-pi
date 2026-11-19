import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const targets = [
  { source: "linux-home", slug: "t3-self-service-validation-linux" },
  { source: "macos-home", slug: "t3-self-service-validation-macos" },
];
const gateway = new T3RuntimeGateway();
const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · remote return inspection",
  message: [
    "Use only the inspect_durable_return MCP tool. Do not call shell, PowerShell, Git, or any command tool.",
    "Call inspect_durable_return once for each of these targets:",
    JSON.stringify(targets),
    "Verify both verified remote revisions are SAME as the current Windows HEAD, both worktrees are reported clean,",
    "and neither inspection changes the current branch or files. Reply with only RETURN_INSPECTION_OK.",
  ].join(" "),
  clientRequestId: `return-inspection-${Date.now()}`,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status === "waiting")
  await gateway.cancel({ threadId: result.threadId, runId: result.runId, runtimeMode: "approval-required" }, "Verification must not request shell approval");
if (result.status !== "completed")
  throw Error(`T3 return inspection ended in ${result.status}: ${JSON.stringify(result)}`);
if (result.text.trim() !== "RETURN_INSPECTION_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected RETURN_INSPECTION_OK`);
process.stdout.write(`${JSON.stringify({ ok: true, targets, threadId: result.threadId, runId: result.runId })}\n`);
