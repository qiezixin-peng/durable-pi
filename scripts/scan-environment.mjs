#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem, type } from "node:os";
import { delimiter, resolve, sep } from "node:path";

process.on("uncaughtException", (error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw Error(`${flag} requires a value`);
  return result;
};
for (const argument of args) {
  if (argument.startsWith("--") && !["--workspace", "--output"].includes(argument))
    throw Error(`Unknown option: ${argument}`);
}

const clean = (text) => text.replaceAll("\0", "").trim().slice(0, 4_000);
const command = (name, commandArgs) => {
  const result = spawnSync(name, commandArgs, {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error?.code === "ENOENT") return { available: false };
  if (result.error)
    return { available: false, error: clean(result.error.message) };
  const output = clean(result.stdout || result.stderr || "");
  return {
    available: result.status === 0,
    exitCode: result.status,
    ...(output ? { version: output.split(/\r?\n/u)[0] } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  };
};

const tools = {
  git: command("git", ["--version"]),
  npm: command("npm", ["--version"]),
  pnpm: command("pnpm", ["--version"]),
  python: command(platform() === "win32" ? "python" : "python3", ["--version"]),
  gcc: command("gcc", ["--version"]),
  clang: command("clang", ["--version"]),
  cmake: command("cmake", ["--version"]),
  make: command("make", ["--version"]),
  docker: command("docker", ["--version"]),
  rustc: command("rustc", ["--version"]),
  cargo: command("cargo", ["--version"]),
  java: command("java", ["-version"]),
  nvidiaSmi: command("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"]),
};

const workspaceArg = value("--workspace");
let workspace;
if (workspaceArg) {
  const path = resolve(workspaceArg);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw Error(`Workspace is not a directory: ${path}`);
  const git = (gitArgs) => command("git", ["-C", path, ...gitArgs]);
  const root = git(["rev-parse", "--show-toplevel"]);
  const revision = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const status = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
  workspace = {
    path,
    git: {
      repository: root.available,
      ...(root.available ? { root: root.version } : {}),
      ...(revision.available ? { revision: revision.version } : {}),
      ...(branch.available ? { branch: branch.version || null } : {}),
      ...(status.exitCode === 0
        ? {
            dirty: Boolean(status.version),
            statusPreview: status.version ? status.version.split(/\r?\n/u).slice(0, 100) : [],
          }
        : {}),
      coreAutocrlf: git(["config", "--get", "core.autocrlf"]).version ?? null,
      coreFilemode: git(["config", "--get", "core.filemode"]).version ?? null,
      coreIgnorecase: git(["config", "--get", "core.ignorecase"]).version ?? null,
    },
  };
}

const cpuList = cpus();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  system: {
    platform: platform(),
    type: type(),
    release: release(),
    arch: arch(),
    hostname: hostname(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    pathSeparator: sep,
    pathListDelimiter: delimiter,
    defaultEol: platform() === "win32" ? "CRLF" : "LF",
    wsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
    containerHint: existsSync("/.dockerenv") || Boolean(process.env.container),
  },
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    uv: process.versions.uv,
    openssl: process.versions.openssl,
  },
  tools,
  ...(workspace ? { workspace } : {}),
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = value("--output");
if (output) {
  const target = resolve(output);
  writeFileSync(target, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${target}\n`);
} else {
  process.stdout.write(serialized);
}
