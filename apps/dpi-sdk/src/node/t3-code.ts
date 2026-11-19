import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface T3CodeClientOptions {
  command?: string;
  commandArgs?: string[];
  baseDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface T3Project {
  projectId: string;
  title: string;
  path: string;
}

export interface T3ThreadStartOptions {
  title?: string;
  provider?: string;
  model?: string;
  worktree?: string;
  branch?: string;
  wait?: boolean;
  signal?: AbortSignal;
}

export interface T3ThreadRunResult {
  threadId: string;
  runId: string;
  status: string;
  reply: string | null;
  error: unknown;
}

export interface T3ThreadSummary extends JsonObject {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  providerInstanceId: string;
  model: string;
  branch: string | null;
  worktreePath?: string | null;
}

export interface T3ThreadDetail extends JsonObject {
  thread: T3ThreadSummary;
  messages: Array<{ role: string; text: string; runId?: string }>;
}

export interface T3EnvironmentSummary extends JsonObject {
  environmentId: string;
  name?: string;
  status?: string;
}

export interface T3PairingCredential {
  id: string;
  credential: string;
  label: string | null;
  scopes: string[];
  expiresAt: string;
}

export class T3CodeCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "T3CodeCommandError";
  }
}

const versionParts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);

const compareVersions = (left: string, right: string) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
};

/** Find T3's real executable so Windows does not need a shell to run t3.cmd. */
export function findT3Command(env = process.env) {
  if (env.T3_COMMAND) return env.T3_COMMAND;
  if (process.platform !== "win32") return "t3";
  const root = join(env.USERPROFILE || homedir(), ".t3", "runtime", "versions");
  if (!existsSync(root)) return "t3";
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "t3.exe")))
    .map((entry) => entry.name)
    .sort(compareVersions)
    .reverse();
  return versions[0] ? join(root, versions[0], "t3.exe") : "t3";
}

const isObject = (value: unknown): value is JsonObject => Boolean(value && typeof value === "object" && !Array.isArray(value));

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value) throw Error(`T3 response is missing ${field}`);
  return value;
};

/** Typed, shell-free boundary around T3 Code's documented CLI. */
export class T3CodeClient {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;

  constructor(private readonly options: T3CodeClientOptions = {}) {
    this.command = options.command ?? findT3Command(options.env);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;
  }

  private scoped(args: string[]) {
    if (!this.options.baseDir) return args;
    // Every current T3 operation here is a two-part command (for example
    // `thread start`). Keep flags before positionals so strict CLI parsers do
    // not mistake the base directory for a project, message or thread id.
    return [args[0]!, args[1]!, "--base-dir", this.options.baseDir, ...args.slice(2)];
  }

  private async run(args: string[], signal?: AbortSignal) {
    const child = spawn(this.command, [...(this.options.commandArgs ?? []), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...this.options.env },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let outputError: Error | undefined;
    const append = (target: "stdout" | "stderr", chunk: string) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > this.maxOutputBytes) {
        outputError ??= Error(`T3 output exceeded ${this.maxOutputBytes} bytes`);
        child.kill();
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => append("stderr", chunk));

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => {
        child.kill();
        finish(() => reject(Error("T3 command aborted")));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(Error(`T3 command timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        finish(() => {
          if (outputError) return reject(outputError);
          if (code !== 0)
            return reject(
              new T3CodeCommandError(
                `T3 command failed (${code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
                code,
                stderr,
              ),
            );
          resolve(stdout.trim());
        });
      });
      if (signal?.aborted) abort();
    });
  }

  private async json<T>(args: string[], signal?: AbortSignal): Promise<T> {
    const output = await this.run(args, signal);
    try {
      return JSON.parse(output) as T;
    } catch (error) {
      throw Error(`T3 returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async addProject(path: string, title?: string) {
    const args = this.scoped(["project", "add", ...(title ? ["--title", title] : []), path]);
    const output = await this.run(args);
    const match = /^Added project ([^ ]+) \((.+)\) at (.+)\.$/m.exec(output);
    if (!match) throw Error(`Unexpected T3 project response: ${output}`);
    return { projectId: match[1]!, title: match[2]!, path: match[3]! } satisfies T3Project;
  }

  async listThreads(project: string) {
    const result = await this.json<unknown>(this.scoped(["thread", "list", "--project", project, "--json"]));
    if (!Array.isArray(result)) throw Error("T3 thread list response is not an array");
    return result as T3ThreadSummary[];
  }

  async startThread(project: string, message: string, options: T3ThreadStartOptions = {}) {
    if (Boolean(options.provider) !== Boolean(options.model))
      throw Error("T3 provider and model must be supplied together");
    const args = this.scoped([
      "thread",
      "start",
      ...(options.title ? ["--title", options.title] : []),
      ...(options.provider ? ["--provider", options.provider, "--model", options.model!] : []),
      ...(options.worktree ? ["--worktree", options.worktree] : []),
      ...(options.branch ? ["--branch", options.branch] : []),
      ...(options.wait ? ["--wait"] : []),
      "--json",
      project,
      message,
    ]);
    const result = await this.json<unknown>(args, options.signal);
    return this.runResult(result);
  }

  async send(threadId: string, message: string, options: { wait?: boolean; signal?: AbortSignal } = {}) {
    const result = await this.json<unknown>(
      this.scoped(["thread", "send", ...(options.wait ? ["--wait"] : []), "--json", threadId, message]),
      options.signal,
    );
    return this.runResult(result);
  }

  async showThread(threadId: string, messages?: number) {
    const result = await this.json<unknown>(
      this.scoped(["thread", "show", ...(messages ? ["--messages", String(messages)] : []), "--json", threadId]),
    );
    if (!isObject(result) || !isObject(result.thread) || !Array.isArray(result.messages))
      throw Error("T3 thread detail response has an invalid shape");
    return result as unknown as T3ThreadDetail;
  }

  async listEnvironments() {
    const result = await this.json<unknown>(this.scoped(["environment", "list", "--json"]));
    if (!Array.isArray(result)) throw Error("T3 environment list response is not an array");
    return result as T3EnvironmentSummary[];
  }

  /** Issue a one-use bootstrap credential. The secret must never be logged or persisted. */
  async createPairingCredential(options: {
    scopes: string[];
    ttl?: string;
    label?: string;
    signal?: AbortSignal;
  }) {
    if (options.scopes.length === 0) throw Error("T3 pairing credential requires at least one scope");
    const result = await this.json<unknown>(
      [
        "auth",
        "pairing",
        "create",
        ...(this.options.baseDir ? ["--base-dir", this.options.baseDir] : []),
        ...options.scopes.flatMap((scope) => ["--scope", scope]),
        ...(options.ttl ? ["--ttl", options.ttl] : []),
        ...(options.label ? ["--label", options.label] : []),
        "--json",
      ],
      options.signal,
    );
    if (!isObject(result) || !Array.isArray(result.scopes))
      throw Error("T3 pairing credential response has an invalid shape");
    return {
      id: requireString(result.id, "id"),
      credential: requireString(result.credential, "credential"),
      label: typeof result.label === "string" ? result.label : null,
      scopes: result.scopes.map((scope) => requireString(scope, "scope")),
      expiresAt: requireString(result.expiresAt, "expiresAt"),
    } satisfies T3PairingCredential;
  }

  async revokePairingCredential(id: string, signal?: AbortSignal) {
    await this.run(
      ["auth", "pairing", "revoke", ...(this.options.baseDir ? ["--base-dir", this.options.baseDir] : []), id],
      signal,
    );
  }

  async revokeAuthSession(id: string, signal?: AbortSignal) {
    await this.run(
      ["auth", "session", "revoke", ...(this.options.baseDir ? ["--base-dir", this.options.baseDir] : []), id],
      signal,
    );
  }

  private runResult(value: unknown): T3ThreadRunResult {
    if (!isObject(value)) throw Error("T3 thread run response is not an object");
    return {
      threadId: requireString(value.threadId, "threadId"),
      runId: requireString(value.runId, "runId"),
      status: requireString(value.status, "status"),
      reply: typeof value.reply === "string" ? value.reply : null,
      error: value.error ?? null,
    };
  }
}
