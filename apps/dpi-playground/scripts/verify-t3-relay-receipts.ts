import { resolve } from "node:path";

import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const expected = (process.argv[3] ?? "linux-home,macos-home").split(",").map((value) => value.trim()).filter(Boolean);
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · relay receipt validation",
  message: [
    "Call list_durable_relays.",
    `Verify that READY receipts exist for every source id in ${JSON.stringify(expected)}.`,
    "Reply with only RELAYS_OK after verification.",
  ].join(" "),
  clientRequestId: `relay-receipts-${Date.now()}`,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status !== "completed") throw Error(`T3 relay receipt verification ended in ${result.status}`);
if (result.text.trim() !== "RELAYS_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected RELAYS_OK`);
process.stdout.write(`${JSON.stringify({ ok: true, expected, threadId: result.threadId, runId: result.runId })}\n`);
