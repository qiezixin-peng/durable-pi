import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ProjectTaskStore } from "../../dpi-sdk/src/node/tasks.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3] ?? "durable-pi-platform";
const coordinatorMemberId = process.argv[4] ?? "t3-coordinator";
const coderMemberId = process.argv[5] ?? "t3-coder";
const coordinatorModel = process.env.DPI_COORDINATOR_MODEL?.trim() || "gpt-5.6-sol";
const requestId = `delegation-verification-${randomUUID()}`;
const coordinationId = `t3-verification-${randomUUID()}`;
const taskId = `t3-mcp-${createHash("sha256")
  .update(`${projectId}:${coordinatorMemberId}:${requestId}`)
  .digest("hex")
  .slice(0, 48)}`;
const resultTaskId = `task-result-${createHash("sha256")
  .update(`${projectId}:${taskId}:${coordinatorMemberId}`)
  .digest("hex")
  .slice(0, 48)}`;
const gateway = new T3RuntimeGateway();

const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · T3 任务委派验证",
  message: [
    "Call delegate_durable_task exactly once with:",
    `request_id=${requestId}`,
    `coordination_id=${coordinationId}`,
    `target_member_id=${coderMemberId}`,
    "content=Reply with only CODER_OK. Do not call any tools.",
    "title=Verify durable T3 delegation",
    "After the tool succeeds, reply with only DELEGATED.",
  ].join("\n"),
  clientRequestId: `durable-pi-mcp-delegation-${requestId}`,
  providerInstanceId: "codex_durable_coordinator",
  model: coordinatorModel,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 verification ended in ${result.status}`);
if (result.text.trim() !== "DELEGATED")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected DELEGATED`);

const tasks = new ProjectTaskStore();
try {
  const deadline = Date.now() + 180_000;
  let task = tasks.get(taskId);
  while (task && !["COMPLETED", "FAILED", "CANCELLED"].includes(task.status) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    task = tasks.get(taskId);
  }
  if (!task) throw Error(`Delegated task was not persisted: ${taskId}`);
  if (task.status !== "COMPLETED")
    throw Error(`Delegated task ended in ${task.status}: ${JSON.stringify(task.error)}`);
  const answer = (task.result as { answer?: { text?: unknown } } | undefined)?.answer?.text;
  if (answer !== "CODER_OK") throw Error(`Coder returned ${JSON.stringify(answer)}; expected CODER_OK`);
  const attempts = tasks.attempts(taskId);
  const completedAttempt = attempts.find((attempt) => attempt.status === "COMPLETED");
  if (completedAttempt?.runtime?.kind !== "t3")
    throw Error(`Coder used ${completedAttempt?.runtime?.kind ?? "no runtime"}; expected T3`);
  if (completedAttempt.runtime.provider !== "codex_durable_worker")
    throw Error(`Coder used provider ${completedAttempt.runtime.provider ?? "unknown"}; expected codex_durable_worker`);
  let resultTask = tasks.get(resultTaskId);
  while ((!resultTask || !["COMPLETED", "FAILED", "CANCELLED"].includes(resultTask.status)) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    resultTask = tasks.get(resultTaskId);
  }
  if (!resultTask || resultTask.status !== "COMPLETED")
    throw Error(`Coordinator result task ended in ${resultTask?.status ?? "missing"}: ${JSON.stringify(resultTask?.error)}`);
  const resultAttempt = tasks.attempts(resultTaskId).find((attempt) => attempt.status === "COMPLETED");
  if (resultAttempt?.runtime?.kind !== "t3" || resultAttempt.runtime.provider !== "codex_durable_coordinator")
    throw Error(`Coordinator result used ${resultAttempt?.runtime?.kind ?? "no runtime"}/${resultAttempt?.runtime?.provider ?? "unknown provider"}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    taskId,
    taskStatus: task.status,
    t3ProjectId: result.projectId,
    coordinatorThreadId: result.threadId,
    coordinatorRunId: result.runId,
    coderThreadId: completedAttempt.runtime.threadId,
    coderRunId: completedAttempt.runtime.runId,
    coderProvider: completedAttempt.runtime.provider,
    coderAnswer: answer,
    resultTaskId,
    coordinatorResultThreadId: resultAttempt.runtime.threadId,
    coordinatorResultRunId: resultAttempt.runtime.runId,
    coordinatorProvider: resultAttempt.runtime.provider,
  })}\n`);
} finally {
  tasks.close();
}
