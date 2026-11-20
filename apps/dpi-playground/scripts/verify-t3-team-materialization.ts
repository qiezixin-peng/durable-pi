import { resolve } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3];
const role = process.argv[4] ?? "coder";
const workspaceStrategy = process.argv[5] ?? "shared";
const expectedPermission = process.argv[6] ?? "WORKSPACE_WRITE";
const coordinatorModel = process.env.DPI_COORDINATOR_MODEL?.trim() || "gpt-5.6-sol";
if (!projectId)
  throw Error("Usage: verify-t3-team-materialization.ts <workspace> <durable-project-id> [role] [shared|worktree] [permission]");

const requestId = `team-materialization-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · planned team validation",
  message: [
    "Call materialize_durable_agent exactly once with",
    `request_id=${requestId}, role=${role}, name=Planned ${role}, workspace_strategy=${workspaceStrategy}.`,
    `Then call list_durable_agents and verify that exactly one active ${role} exists with ${expectedPermission} permission.`,
    "Reply with only TEAM_OK after both tools succeed.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: coordinatorModel,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 team verification ended in ${result.status}`);
if (result.text.trim() !== "TEAM_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected TEAM_OK`);

const registry = new ProjectRegistry();
try {
  const agents = registry.members(projectId).filter((member) => member.role.toLowerCase() === role.toLowerCase());
  if (agents.length !== 1 || agents[0]!.permissionProfile !== expectedPermission)
    throw Error(`Expected one ${expectedPermission} ${role}, found ${JSON.stringify(agents)}`);
  if (workspaceStrategy === "worktree" && resolve(agents[0]!.cwd ?? "") === workspace)
    throw Error(`Expected ${role} to use an isolated worktree, but it uses the project root`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    role,
    memberId: agents[0]!.id,
    permissionProfile: agents[0]!.permissionProfile,
    workspaceStrategy,
    workspace: agents[0]!.cwd,
    t3ProjectId: result.projectId,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  registry.close();
}
