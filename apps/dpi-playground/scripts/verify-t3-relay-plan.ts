import { resolve } from "node:path";

import { ProjectRelayStore } from "../../dpi-sdk/src/node/relays.js";
import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3];
const handoffId = process.argv[4];
const sourceId = process.argv[5];
const slug = process.argv[6];
if (!projectId || !handoffId || !sourceId || !slug)
  throw Error("Usage: verify-t3-relay-plan.ts <workspace> <project-id> <handoff-id> <source-id> <slug>");

const requestId = `relay-plan-verification-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · relay plan validation",
  message: [
    "Call plan_durable_relay exactly once with",
    `request_id=${requestId}, handoff_id=${handoffId}, source_id=${sourceId}, project_slug=${slug}.`,
    "Do not execute the returned command.",
    "Then call list_durable_relay_plans and verify that the same plan is PLANNED and requires T3 command approval.",
    "Reply with only RELAY_PLAN_OK after both tools succeed.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status !== "completed") throw Error(`T3 relay plan verification ended in ${result.status}`);
if (result.text.trim() !== "RELAY_PLAN_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected RELAY_PLAN_OK`);

const projects = new ProjectRegistry();
const relays = new ProjectRelayStore(projects.path);
try {
  const plan = relays.listPlans(projectId).find((candidate) => candidate.requestId.endsWith(requestId));
  if (!plan || plan.status !== "PLANNED" || plan.handoffId !== handoffId || plan.sourceId !== sourceId)
    throw Error("T3 did not persist the expected relay plan");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    planId: plan.id,
    handoffId,
    sourceId,
    projectSlug: plan.projectSlug,
    status: plan.status,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  relays.close();
  projects.close();
}
