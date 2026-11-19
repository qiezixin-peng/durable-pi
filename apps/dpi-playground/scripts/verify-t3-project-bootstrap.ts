import { resolve } from "node:path";
import { createHash } from "node:crypto";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { DataSourceBindingStore } from "../../dpi-sdk/src/node/data-sources.js";
import { dpiHome } from "../../dpi-sdk/src/node/registry.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const title = process.argv[3] ?? "T3 自助项目验证";
const sourceIds = (process.argv[4] ?? "windows-workspace,linux-home,macos-home")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const gateway = new T3RuntimeGateway();
const requestId = `t3-bootstrap-verification-${Date.now()}`;
const result = await gateway.run({
  cwd: workspace,
  title,
  message: [
    "这是一个刚在 T3 打开的新项目。请直接开始处理，不要让我填写例行初始化配置。",
    "判断当前目录的项目类型，并用一句话说明你已经可以如何协助这个项目。",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  registerProjectIfMissing: true,
  projectTitle: title,
  timeoutMs: 240_000,
});

if (result.status !== "completed" && result.status !== "waiting")
  throw Error(`T3 bootstrap verification ended in ${result.status}`);
const normalizedWorkspace = process.platform === "win32" ? workspace.toLowerCase() : workspace;
const projectId = `t3-${createHash("sha256").update(normalizedWorkspace).digest("hex").slice(0, 20)}`;
const registry = new ProjectRegistry();
try {
  const project = registry.get(projectId);
  if (!project) throw Error(`Durable project ${projectId} was not persisted`);
  const coordinator = project.members.find((member) => member.role.toLowerCase() === "coordinator");
  if (!coordinator || resolve(coordinator.cwd ?? "") !== workspace)
    throw Error(`Durable project ${projectId} has no Coordinator for ${workspace}`);
  if (project.autonomyMode !== "SUPERVISED") throw Error(`Durable project ${projectId} is not supervised`);
  const bound = new Set(new DataSourceBindingStore(resolve(dpiHome(), "data-sources.json")).boundSourceIds(projectId));
  for (const sourceId of sourceIds) {
    if (!bound.has(sourceId)) throw Error(`Durable project ${projectId} did not bind ${sourceId}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    durableProjectName: project.name,
    coordinatorMemberId: coordinator.id,
    t3ProjectId: result.projectId,
    threadId: result.threadId,
    runId: result.runId,
    taskStatus: result.status,
    sources: sourceIds,
    response: result.text.trim(),
  })}\n`);
} finally {
  registry.close();
}
