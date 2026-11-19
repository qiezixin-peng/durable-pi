import { resolve } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3] ?? "durable-pi-platform";
const coordinatorMemberId = process.argv[4] ?? "t3-coordinator";
const templateMemberId = process.argv[5] ?? "t3-coder";
const requestId = `agent-lifecycle-${Date.now()}`;
const gateway = new T3RuntimeGateway();

const result = await gateway.run({
  cwd: workspace,
  title: "Durable Pi · T3 临时 Agent 生命周期验证",
  message: [
    "Call create_durable_agent exactly once with:",
    `request_id=${requestId}`,
    `template_member_id=${templateMemberId}`,
    "role=reviewer",
    "name=Lifecycle Verification Reviewer",
    "permission_profile=READ_ONLY",
    "Then call archive_durable_agent exactly once with member_id set to the id returned by create_durable_agent.",
    "After both tools succeed, reply with only LIFECYCLE_OK.",
  ].join("\n"),
  clientRequestId: `durable-pi-mcp-agent-lifecycle-${requestId}`,
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  runtimeMode: "auto",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 verification ended in ${result.status}`);
if (result.text.trim() !== "LIFECYCLE_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected LIFECYCLE_OK`);

const projects = new ProjectRegistry();
try {
  const temporary = projects.members(projectId, true)
    .find((member) => member.spawnRequestId === `t3-mcp:${coordinatorMemberId}:${requestId}`);
  if (!temporary) throw Error("T3 did not create the temporary Agent");
  if (temporary.lifecycleState !== "ARCHIVED")
    throw Error(`Temporary Agent ended in ${temporary.lifecycleState}; expected ARCHIVED`);
  if (temporary.permissionProfile !== "READ_ONLY")
    throw Error(`Temporary Agent permission is ${temporary.permissionProfile}; expected READ_ONLY`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    temporaryMemberId: temporary.id,
    lifecycleState: temporary.lifecycleState,
    t3ProjectId: result.projectId,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  projects.close();
}
