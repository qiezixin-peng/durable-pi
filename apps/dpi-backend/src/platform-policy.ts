import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const DANGEROUS_SHELL = [
  /\brm\s+-[^\r\n]*[rf][^\r\n]*\s/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b[^\r\n]*--force(?:-with-lease)?\b/i,
  /\b(?:mkfs|diskpart|format)\b/i,
  /\bRemove-Item\b[^\r\n]*-Recurse\b[^\r\n]*-Force\b/i,
] as const;

const inside = (root: string, candidate: string) => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function nearestExisting(path: string) {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Mandatory deterministic policy. It is intentionally small: deny file tools
 * that escape the session root (including through existing links), and deny a
 * conservative set of destructive shell commands. Approval can later replace
 * a deny without moving the enforcement point.
 */
export function createPlatformPolicy(sessionRoot: string) {
  const root = realpath(sessionRoot);
  return defineExtension({
    name: "platform-policy",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (FILE_TOOLS.has(call.name)) {
            const input = String((call.arguments as { path?: unknown }).path ?? "");
            const rootPath = await root;
            const target = resolve(rootPath, input);
            if (!inside(rootPath, target))
              return { block: `platform-policy blocked ${call.name}: path is outside the session root` };
            const existing = await nearestExisting(target);
            if (!inside(rootPath, existing))
              return { block: `platform-policy blocked ${call.name}: path resolves outside the session root` };
          }
          if (call.name === "bash") {
            const command = String((call.arguments as { command?: unknown }).command ?? "");
            if (DANGEROUS_SHELL.some((pattern) => pattern.test(command)))
              return { block: "platform-policy blocked bash: destructive command requires approval" };
          }
        },
      }),
    ],
  });
}
