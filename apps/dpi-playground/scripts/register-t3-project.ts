import { resolve } from "node:path";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";

const workspace = resolve(process.argv[2] ?? process.cwd());
const projectId = process.argv[3] ?? "durable-pi-platform";
const registry = new ProjectRegistry();

try {
  const project = registry.get(projectId) ?? registry.create({
    id: projectId,
    name: "Durable Pi 协作平台",
    description: "T3 Code is the user-facing control plane; Durable Pi provides policy, scheduling, memory and audit.",
    autonomyMode: "SUPERVISED",
    maxCoordinationDepth: 3,
    maxDelegatedTasksPerTurn: 8,
    maxActiveTasks: 32,
    maxConcurrentTasks: 4,
  });
  const coordinator = registry.getMember(projectId, "t3-coordinator") ?? registry.addMember(projectId, {
    id: "t3-coordinator",
    deviceId: "local-t3",
    sessionId: "t3-code",
    agentId: "t3-coordinator",
    name: "T3 Coordinator",
    role: "coordinator",
    permissionProfile: "READ_ONLY",
    executor: "codex",
    model: "gpt-6.1-sol",
    cwd: workspace,
  });
  const coder = registry.getMember(projectId, "t3-coder") ?? registry.addMember(projectId, {
    id: "t3-coder",
    deviceId: "local-t3",
    sessionId: "t3-code",
    agentId: "t3-coder",
    name: "T3 Coder",
    role: "coder",
    permissionProfile: "WORKSPACE_WRITE",
    executor: "codex",
    model: "gpt-6.1-sol",
    cwd: workspace,
  });
  process.stdout.write(`${JSON.stringify({
    projectId: project.id,
    coordinatorMemberId: coordinator.id,
    coderMemberId: coder.id,
    workspace,
  })}\n`);
} finally {
  registry.close();
}
