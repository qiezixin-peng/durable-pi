import { resolve } from "node:path";

import { ProjectArtifactStore } from "../../dpi-sdk/src/node/artifacts.js";
import { ProjectHandoffStore } from "../../dpi-sdk/src/node/handoffs.js";
import { ProjectMemoryStore } from "../../dpi-sdk/src/node/memories.js";
import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3];
if (!projectId) throw Error("Usage: verify-t3-handoff.ts <workspace> <durable-project-id>");

const requestId = `handoff-verification-${Date.now()}`;
const result = await new T3RuntimeGateway().run({
  cwd: workspace,
  title: "Durable Pi · handoff validation",
  message: [
    "Call create_durable_handoff exactly once with",
    `request_id=${requestId} and include_git_baseline=true.`,
    "Then call list_durable_handoffs and verify the returned handoff is present.",
    "Reply with only HANDOFF_OK after both tools succeed.",
  ].join(" "),
  clientRequestId: requestId,
  providerInstanceId: "codex_durable_coordinator",
  model: "gpt-6.1-sol",
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed") throw Error(`T3 handoff verification ended in ${result.status}`);
if (result.text.trim() !== "HANDOFF_OK")
  throw Error(`T3 returned ${JSON.stringify(result.text.trim())}; expected HANDOFF_OK`);

const projects = new ProjectRegistry();
const memories = new ProjectMemoryStore(projects.path);
const artifacts = new ProjectArtifactStore(projects.path);
const handoffs = new ProjectHandoffStore(projects.path, projects, memories, artifacts);
try {
  const handoff = handoffs.list(projectId).find((item) => item.status === "READY");
  if (!handoff) throw Error(`No READY handoff exists for ${projectId}`);
  const validation = handoffs.validate(projectId, handoff.id);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    handoffId: handoff.id,
    manifestSha256: validation.manifestSha256,
    artifactCount: validation.artifactCount,
    threadId: result.threadId,
    runId: result.runId,
  })}\n`);
} finally {
  handoffs.close();
  artifacts.close();
  memories.close();
  projects.close();
}
