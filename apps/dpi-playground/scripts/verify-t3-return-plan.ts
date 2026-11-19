import { resolve } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { ProjectReturnStore } from "../../dpi-sdk/src/node/returns.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3];
const sourceId = process.argv[4];
const slug = process.argv[5];
if (!projectId || !sourceId || !slug)
  throw Error("Usage: verify-t3-return-plan.ts <workspace> <project-id> <source-id> <slug>");

const requestId = `return-plan-verification-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · remote return plan validation",
  message: [
    "Call plan_durable_return exactly once with",
    `request_id=${requestId}, source_id=${sourceId}, project_slug=${slug}.`,
    "Do not execute the returned command.",
    "Then call list_durable_returns and verify that the same plan is PLANNED and the command says it does not checkout or merge.",
    "Reply with only RETURN_PLAN_OK after both tools succeed.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});
if (result.status !== "completed") throw Error(`T3 return plan verification ended in ${result.status}`);
if (result.text.trim() !== "RETURN_PLAN_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected RETURN_PLAN_OK`);

const projects = new ProjectRegistry();
const returns = new ProjectReturnStore(projects.path);
try {
  const plan = returns.listPlans(projectId).find((candidate) => candidate.requestId.endsWith(requestId));
  if (!plan || plan.status !== "PLANNED" || plan.sourceId !== sourceId || plan.projectSlug !== slug)
    throw Error("T3 did not persist the expected return plan");
  process.stdout.write(`${JSON.stringify({
    ok: true, projectId, planId: plan.id, sourceId, projectSlug: slug, status: plan.status,
    threadId: result.threadId, runId: result.runId,
  })}\n`);
} finally {
  returns.close();
  projects.close();
}
