import { resolve } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3];
const sourceId = process.argv[4];
const slug = process.argv[5];
const role = process.argv[6];
const model = process.argv[7] ?? "gpt-6.1-sol";
if (!projectId || !sourceId || !slug || !role)
  throw Error("Usage: verify-t3-remote-materialization.ts <workspace> <project-id> <source-id> <slug> <role> [model]");

const requestId = `remote-materialization-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: `Durable Pi · ${role} binding validation`,
  message: [
    "Call materialize_durable_remote_agent exactly once with",
    `request_id=${requestId}, source_id=${sourceId}, project_slug=${slug}, template_role=coder, role=${role}, model=${model}.`,
    "Then call list_durable_agents and verify that the returned remote Agent is active and has WORKSPACE_WRITE permission.",
    "Reply with only REMOTE_AGENT_OK after both tools succeed.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status !== "completed") throw Error(`T3 remote materialization ended in ${result.status}`);
if (result.text.trim() !== "REMOTE_AGENT_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected REMOTE_AGENT_OK`);

const projects = new ProjectRegistry();
try {
  const agents = projects.members(projectId).filter((member) => member.role === role);
  if (agents.length !== 1 || !agents[0]!.t3EnvironmentId || agents[0]!.permissionProfile !== "WORKSPACE_WRITE" || agents[0]!.model !== model)
    throw Error(`Remote Agent binding is invalid: ${JSON.stringify(agents)}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    sourceId,
    memberId: agents[0]!.id,
    role,
    model,
    cwd: agents[0]!.cwd,
    environmentId: agents[0]!.t3EnvironmentId,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  projects.close();
}
