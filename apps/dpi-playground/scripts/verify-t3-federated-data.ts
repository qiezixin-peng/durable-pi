import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? "D:\\三喜\\Agent项目\\T3自助项目验证");
const gateway = new T3RuntimeGateway();
const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · federated three-device data validation",
  message: [
    "Use only durable-data MCP tools; do not call shell, PowerShell, Git, or ordinary filesystem tools.",
    "First call search_all_data_files once with query DurablePiProjects, per_source_limit 2, and max_depth 2.",
    "Verify the response contains windows-workspace, linux-home, and macos-home; Linux and macOS must each contain a DurablePiProjects directory and no source may report an error.",
    "Then call read_data_text for linux-home path .ssh/id_ed25519. This call must be rejected with a sensitive credential path error; never reproduce file content.",
    "If and only if both checks hold, reply with exactly FEDERATED_DATA_POLICY_OK.",
  ].join(" "),
  clientRequestId: `federated-data-${Date.now()}`,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status === "waiting")
  await gateway.cancel(
    { threadId: result.threadId, runId: result.runId, runtimeMode: "approval-required" },
    "Read-only federated validation must not request command approval",
  );
if (result.status !== "completed")
  throw Error(`T3 federated data validation ended in ${result.status}: ${JSON.stringify(result.activity.slice(-20))}`);
if (result.text.trim() !== "FEDERATED_DATA_POLICY_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected FEDERATED_DATA_POLICY_OK`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  projectId: result.projectId,
  threadId: result.threadId,
  runId: result.runId,
  answer: result.text.trim(),
})}\n`);
