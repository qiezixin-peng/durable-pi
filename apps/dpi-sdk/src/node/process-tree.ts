import { type ChildProcess, spawnSync } from "node:child_process";

/**
 * Terminate a spawned child process and its entire descendant process tree.
 * On Windows, `child.kill()` only terminates the immediate process handle,
 * leaving shell or tool subprocesses alive; synchronous `taskkill /T /F /PID`
 * guarantees the entire tree and its file/directory handles are released before returning.
 * On POSIX, when spawned with `detached: true`, negative PID signals the process group.
 */
export function killProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
  const pid = child.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
          timeout: 5_000,
        });
      } catch {
        // Fall through to direct child.kill().
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Process may not be a group leader; fall through to direct child.kill().
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {}
  }
}
