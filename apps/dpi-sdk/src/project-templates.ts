import type { ProjectTemplate, ProjectTemplateRole } from "./api.js";

const coordinator: ProjectTemplateRole = { role: "coordinator", permissionProfile: "READ_ONLY" };

/**
 * The single project-template catalog used by the Hub and every embedded MCP
 * entry point. Keep this data independent of Node so desktop clients can use it.
 */
export const DURABLE_PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank project",
    description: "General-purpose team plan with workers activated only when the task needs them.",
    autonomyMode: "RESTRICTED_UNATTENDED",
    maxCoordinationDepth: 8,
    maxDelegatedTasksPerTurn: 12,
    maxActiveTasks: 64,
    maxConcurrentTasks: 3,
    suggestedRoles: [
      coordinator,
      { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
      { role: "tester", permissionProfile: "ROLE_DEFAULT" },
      { role: "reviewer", permissionProfile: "READ_ONLY" },
    ],
  },
  {
    id: "web",
    name: "Web application",
    description: "Architecture, frontend/backend implementation, testing and review.",
    autonomyMode: "RESTRICTED_UNATTENDED",
    maxCoordinationDepth: 8,
    maxDelegatedTasksPerTurn: 10,
    maxActiveTasks: 48,
    maxConcurrentTasks: 3,
    suggestedRoles: [
      coordinator,
      { role: "architect", permissionProfile: "READ_ONLY" },
      { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
      { role: "tester", permissionProfile: "ROLE_DEFAULT" },
      { role: "reviewer", permissionProfile: "READ_ONLY" },
    ],
  },
  {
    id: "python",
    name: "Python project",
    description: "Implementation, tests, dependency review and documentation.",
    autonomyMode: "RESTRICTED_UNATTENDED",
    maxCoordinationDepth: 7,
    maxDelegatedTasksPerTurn: 8,
    maxActiveTasks: 40,
    maxConcurrentTasks: 3,
    suggestedRoles: [
      coordinator,
      { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
      { role: "tester", permissionProfile: "ROLE_DEFAULT" },
      { role: "reviewer", permissionProfile: "READ_ONLY" },
    ],
  },
  {
    id: "research",
    name: "Technical research",
    description: "Evidence collection, analysis, architecture and documentation with read-only defaults.",
    autonomyMode: "RESTRICTED_UNATTENDED",
    maxCoordinationDepth: 10,
    maxDelegatedTasksPerTurn: 12,
    maxActiveTasks: 64,
    maxConcurrentTasks: 4,
    suggestedRoles: [
      coordinator,
      { role: "researcher", permissionProfile: "READ_ONLY" },
      { role: "architect", permissionProfile: "READ_ONLY" },
      { role: "documentation", permissionProfile: "READ_ONLY" },
    ],
  },
  {
    id: "cross-platform",
    name: "Cross-platform software",
    description: "Shared architecture plus isolated implementation and verification for each target system.",
    autonomyMode: "RESTRICTED_UNATTENDED",
    maxCoordinationDepth: 10,
    maxDelegatedTasksPerTurn: 12,
    maxActiveTasks: 72,
    maxConcurrentTasks: 4,
    suggestedRoles: [
      coordinator,
      { role: "architect", permissionProfile: "READ_ONLY" },
      { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
      { role: "tester", permissionProfile: "ROLE_DEFAULT" },
      { role: "reviewer", permissionProfile: "READ_ONLY" },
    ],
  },
] as const;

export function durableProjectTemplate(id: string): ProjectTemplate | undefined {
  return DURABLE_PROJECT_TEMPLATES.find((template) => template.id === id);
}

/** Every project has a coordinator and a frozen, pre-authorized team plan. */
export function durableProjectTeamPlan(template: ProjectTemplate): ProjectTemplateRole[] {
  const roles = template.suggestedRoles.length ? template.suggestedRoles : [coordinator];
  return roles.map((role) => ({ ...role }));
}
