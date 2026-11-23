import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class WorkspaceBoundaryError extends Error {
  readonly code: "PERMISSION_BOUNDARY_VIOLATION" | "WORKSPACE_PATH_ESCAPE" | "UNSANDBOXED_SHELL_FORBIDDEN";

  constructor(
    code: "PERMISSION_BOUNDARY_VIOLATION" | "WORKSPACE_PATH_ESCAPE" | "UNSANDBOXED_SHELL_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}

const realpath = (target: string): string =>
  (realpathSync.native ?? realpathSync)(target);

export function resolvePhysicalDirectory(dirPath: string, label = "Directory"): string {
  const trimmed = dirPath.trim();
  if (!trimmed) throw new WorkspaceBoundaryError("WORKSPACE_PATH_ESCAPE", `${label} must not be empty`);
  const absolute = resolve(trimmed);
  if (!existsSync(absolute)) {
    throw new WorkspaceBoundaryError("WORKSPACE_PATH_ESCAPE", `${label} does not exist: ${dirPath}`);
  }
  const stat = statSync(absolute);
  if (!stat.isDirectory()) {
    throw new WorkspaceBoundaryError("WORKSPACE_PATH_ESCAPE", `${label} is not a directory: ${dirPath}`);
  }
  return realpath(absolute);
}

export function resolvePathWithExistingAncestor(baseCwd: string, candidatePath: string): string {
  const raw = candidatePath.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(baseCwd, raw);
  const tailSegments: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tailSegments.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ""));
    cursor = parent;
  }
  const canonicalAncestor = existsSync(cursor) ? realpath(cursor) : cursor;
  return tailSegments.length > 0 ? resolve(canonicalAncestor, ...tailSegments) : canonicalAncestor;
}

export function isPathWithinRoot(targetPath: string, canonicalRoot: string): boolean {
  const normTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const normRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const rel = relative(normRoot, normTarget);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
  "shell",
  "exec",
  "terminal",
  "run_command",
  "run_shell_command",
  "run_terminal_cmd",
  "execute_command",
]);

const WRITE_FILE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "write_file",
  "edit_file",
  "replace",
  "create_file",
  "delete_file",
  "remove_file",
  "move_file",
  "copy_file",
  "patch",
  "apply_patch",
  "mkdir",
  "rm",
  "mv",
  "cp",
]);

const PATH_ARGUMENT_KEYS = new Set([
  "path",
  "file_path",
  "filepath",
  "target_file",
  "targetfile",
  "dir_path",
  "dirpath",
  "directory",
  "dir",
  "cwd",
  "workdir",
  "working_directory",
  "source",
  "destination",
  "dest",
  "from",
  "to",
]);

const PATH_ARRAY_KEYS = new Set([
  "paths",
  "files",
  "file_paths",
  "filepaths",
  "directories",
  "include_directories",
]);

function extractCandidatePaths(args: unknown, depth = 0): string[] {
  if (depth > 6 || !args || typeof args !== "object") return [];
  if (Array.isArray(args)) {
    return args.flatMap((item) => extractCandidatePaths(item, depth + 1));
  }
  const paths: string[] = [];
  for (const [rawKey, value] of Object.entries(args as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (PATH_ARGUMENT_KEYS.has(key) && typeof value === "string" && value.trim()) {
      paths.push(value.trim());
    } else if (PATH_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) paths.push(item.trim());
      }
    } else if (value && typeof value === "object") {
      paths.push(...extractCandidatePaths(value, depth + 1));
    }
  }
  return paths;
}

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export function isWriteOrShellToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return WRITE_FILE_TOOL_NAMES.has(normalized) || SHELL_TOOL_NAMES.has(normalized);
}

export function assertToolArgumentsWithinWorkspace(input: {
  cwd: string;
  additionalAllowedDirs?: readonly string[];
  toolName: string;
  args: unknown;
  readOnly: boolean;
  allowShellInWriteMode?: boolean;
}): void {
  const canonicalCwd = resolvePhysicalDirectory(input.cwd, "Workspace cwd");
  const allowedRoots = [
    canonicalCwd,
    ...(input.additionalAllowedDirs ?? []).map((dir) => resolvePhysicalDirectory(dir, "Allowed directory")),
  ];
  const normalizedTool = input.toolName.trim().toLowerCase();

  if (input.readOnly && isWriteOrShellToolName(normalizedTool)) {
    throw new WorkspaceBoundaryError(
      "PERMISSION_BOUNDARY_VIOLATION",
      `Read-only task forbade side-effect tool "${input.toolName}"`,
    );
  }

  if (!input.readOnly && !input.allowShellInWriteMode && isShellToolName(normalizedTool)) {
    throw new WorkspaceBoundaryError(
      "UNSANDBOXED_SHELL_FORBIDDEN",
      `Direct runtime forbade unsandboxed shell tool "${input.toolName}" outside an OS/Harness shell sandbox`,
    );
  }

  const candidatePaths = extractCandidatePaths(input.args);
  for (const candidate of candidatePaths) {
    const resolved = resolvePathWithExistingAncestor(canonicalCwd, candidate);
    const permitted = allowedRoots.some((root) => isPathWithinRoot(resolved, root));
    if (!permitted) {
      throw new WorkspaceBoundaryError(
        "WORKSPACE_PATH_ESCAPE",
        `Tool "${input.toolName}" path "${candidate}" resolves outside allowed workspace roots (${canonicalCwd})`,
      );
    }
  }
}
