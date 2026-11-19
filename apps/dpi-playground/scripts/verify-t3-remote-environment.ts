import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const environmentId = process.argv[2];
const cwd = process.argv[3];
const expectedOs = process.argv[4] ?? "Linux";
const model = process.argv[5] ?? "gpt-5.6-sol";
const providerInstanceId = process.argv[6] ?? "codex_durable_worker";
if (!environmentId || !cwd)
  throw Error(
    "Usage: verify-t3-remote-environment.ts <environment-id> <remote-cwd> [expected-os] [model] [provider-instance-id]",
  );

const marker = `REMOTE_T3_OK:${expectedOs}`;
const result = await new T3RuntimeGateway().run({
  environmentId,
  cwd,
  title: `Durable Pi · ${expectedOs} remote validation`,
  message: `This is a read-only connectivity check. Reply with only ${marker}. Do not call tools.`,
  clientRequestId: `durable-pi-remote-${environmentId}-${Date.now()}`,
  providerInstanceId,
  model,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed")
  throw Error(
    `Remote T3 run ended in ${result.status}: ${JSON.stringify(result.activity.slice(-10))}`,
  );
if (result.text.trim() !== marker)
  throw Error(`Remote Agent returned ${JSON.stringify(result.text.trim())}; expected ${marker}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  environmentId,
  expectedOs,
  cwd,
  model,
  providerInstanceId,
  projectId: result.projectId,
  threadId: result.threadId,
  runId: result.runId,
  answer: result.text.trim(),
})}\n`);
