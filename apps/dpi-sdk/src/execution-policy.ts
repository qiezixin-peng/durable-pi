import type { ProjectAutonomyMode, ProjectPermissionProfile } from "./api.js";
import type { T3RuntimeMode } from "./node/t3-mcp.js";

const WRITE_CAPABLE_ROLE = /(^|[\s_-])(coder|developer|engineer|debugger|tester)([\s_-]|$)/i;

export const memberRoleCanWrite = (
  role: string,
  permissionProfile: ProjectPermissionProfile = "ROLE_DEFAULT",
) => permissionProfile === "WORKSPACE_WRITE" ||
  (permissionProfile === "ROLE_DEFAULT" && WRITE_CAPABLE_ROLE.test(role.trim()));

/** ROLE_DEFAULT is contextual, so a role rename must not silently promote a
 * read-only template into a write-capable temporary Agent. */
export const memberPermissionWithinTemplate = (
  templateRole: string,
  templateProfile: ProjectPermissionProfile,
  requestedRole: string,
  requestedProfile: ProjectPermissionProfile,
) => {
  const grants: Record<ProjectPermissionProfile, ReadonlySet<ProjectPermissionProfile>> = {
    READ_ONLY: new Set(["READ_ONLY"]),
    ROLE_DEFAULT: new Set(["READ_ONLY", "ROLE_DEFAULT"]),
    WORKSPACE_WRITE: new Set(["READ_ONLY", "ROLE_DEFAULT", "WORKSPACE_WRITE"]),
  };
  if (!grants[templateProfile].has(requestedProfile)) return false;
  return memberRoleCanWrite(templateRole, templateProfile) ||
    !memberRoleCanWrite(requestedRole, requestedProfile);
};

/** T3 is the approval surface: supervised asks, authorized autonomy accepts edits, unattended runs automatically. */
export const t3RuntimeModeFor = (
  autonomyMode: ProjectAutonomyMode,
  role: string,
  permissionProfile: ProjectPermissionProfile = "ROLE_DEFAULT",
): T3RuntimeMode | undefined => {
  if (!memberRoleCanWrite(role, permissionProfile)) return undefined;
  if (autonomyMode === "SUPERVISED") return "approval-required";
  if (autonomyMode === "AUTHORIZED_AUTONOMY") return "auto-accept-edits";
  return "auto";
};

/** The Coordinator owns orchestration rather than a writable role profile, but
 * still needs bounded inspection and scheduling commands to follow the selected
 * project autonomy mode. Durable governance remains the approval boundary for
 * destructive or externally visible operations. */
export const t3CoordinatorRuntimeModeFor = (
  autonomyMode: ProjectAutonomyMode,
): T3RuntimeMode => {
  if (autonomyMode === "SUPERVISED") return "approval-required";
  if (autonomyMode === "AUTHORIZED_AUTONOMY") return "auto-accept-edits";
  return "auto";
};
