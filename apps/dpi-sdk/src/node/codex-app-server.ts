import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type JsonObject = Record<string, unknown>;
type NotificationListener = (method: string, params: JsonObject) => void;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  /** Boolean Codex config overrides applied only to this app-server process. */
  configOverrides?: Record<string, boolean>;
  shell?: boolean;
  requestTimeoutMs?: number;
  experimentalApi?: boolean;
  serverRequestHandler?: (
    method: string,
    params: JsonObject,
  ) => JsonObject | undefined | Promise<JsonObject | undefined>;
}

export interface CodexThreadOptions {
  model?: string;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  ephemeral?: boolean;
  dynamicTools?: CodexDynamicToolSpec[];
}

export type CodexDynamicToolFunction = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonObject;
  deferLoading?: boolean;
};

export type CodexDynamicToolSpec = CodexDynamicToolFunction | {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexDynamicToolFunction[];
};

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: "completed";
  text: string;
  turn: JsonObject;
}

/** Minimal JSON-RPC client for an already-authenticated local Codex app-server. */
export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private stderr = "";
  private started = false;
  readonly requestTimeoutMs: number;

  constructor(private readonly options: CodexAppServerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async start() {
    if (this.started) return;
    const windowsDefault = process.platform === "win32" && this.options.command === undefined;
    const command = this.options.command ?? (windowsDefault ? (process.env.ComSpec ?? "cmd.exe") : "codex");
    const configArgs = Object.entries(this.options.configOverrides ?? {}).flatMap(([key, value]) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw Error(`Invalid Codex config override key: ${key}`);
      return ["-c", `${key}=${value ? "true" : "false"}`];
    });
    const defaultArgs = ["app-server", "--stdio", ...configArgs];
    const args = this.options.args ?? (windowsDefault
      ? ["/d", "/s", "/c", ["codex", ...defaultArgs].join(" ")]
      : defaultArgs);
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: this.options.shell ?? false,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.pending.size)
        this.failAll(
          new Error(
            `Codex app-server exited (${code ?? signal ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
          ),
        );
      this.started = false;
    });
    await this.request("initialize", {
      clientInfo: { name: "durable-pi", title: "Durable Pi", version: "0.1.0" },
      capabilities: { experimentalApi: this.options.experimentalApi ?? false },
    });
    this.notify("initialized", {});
    this.started = true;
  }

  private receive(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      void this.handleServerRequest(
        message.id,
        message.method,
        message.params && typeof message.params === "object" ? (message.params as JsonObject) : {},
      );
      return;
    }
    if (typeof message.id !== "number") {
      if (typeof message.method === "string" && message.params && typeof message.params === "object") {
        for (const listener of this.notificationListeners)
          listener(message.method, message.params as JsonObject);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: number; message?: string };
      pending.reject(new Error(`Codex RPC ${error.code ?? "error"}: ${error.message ?? "Unknown error"}`));
    } else pending.resolve(message.result);
  }

  private async handleServerRequest(id: number, method: string, params: JsonObject) {
    try {
      let result = await this.options.serverRequestHandler?.(method, params);
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")
        result ??= { decision: "decline" };
      else if (method === "applyPatchApproval" || method === "execCommandApproval")
        result ??= { decision: { denied: { rejection: "Durable Pi requires explicit platform approval" } } };
      else if (method === "item/permissions/requestApproval")
        result ??= { permissions: { fileSystem: null, network: null }, scope: "turn" };
      else if (method === "mcpServer/elicitation/request") result ??= { action: "decline" };
      else if (method === "item/tool/requestUserInput") result ??= { answers: {} };
      if (result) this.send({ jsonrpc: "2.0", id, result });
      else
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unsupported Codex server request: ${method}` },
        });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(message: JsonObject) {
    if (!this.child || this.child.stdin.destroyed) throw Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: JsonObject = {}) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: JsonObject = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(listener: NotificationListener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async models() {
    if (!this.started) await this.start();
    return this.request("model/list", { includeHidden: false, limit: 100 });
  }

  async startThread(options: CodexThreadOptions = {}) {
    if (!this.started) await this.start();
    const result = (await this.request("thread/start", {
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      sandbox: options.sandbox ?? "read-only",
      approvalPolicy: options.approvalPolicy ?? "never",
      approvalsReviewer: "user",
      ephemeral: options.ephemeral ?? false,
      ...(options.dynamicTools?.length ? { dynamicTools: options.dynamicTools } : {}),
    })) as { thread?: { id?: string } };
    const threadId = result.thread?.id;
    if (!threadId) throw Error("Codex thread/start returned no thread ID");
    return { threadId, response: result };
  }

  async resumeThread(threadId: string, options: CodexThreadOptions = {}) {
    if (!this.started) await this.start();
    const result = (await this.request("thread/resume", {
      threadId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      sandbox: options.sandbox ?? "read-only",
      approvalPolicy: options.approvalPolicy ?? "never",
      approvalsReviewer: "user",
    })) as { thread?: { id?: string } };
    const resumedId = result.thread?.id;
    if (!resumedId) throw Error("Codex thread/resume returned no thread ID");
    return { threadId: resumedId, response: result };
  }

  async archiveThread(threadId: string) {
    if (!this.started) await this.start();
    await this.request("thread/archive", { threadId });
  }

  async runTurn(
    threadId: string,
    text: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onEvent?: (method: string, params: JsonObject) => void;
    } = {},
  ): Promise<CodexTurnResult> {
    if (!this.started) await this.start();
    const timeoutMs = options.timeoutMs ?? 120_000;
    let expectedTurnId: string | undefined;
    let bufferedCompletion: JsonObject | undefined;
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let rejectCompletion: (error: Error) => void = () => undefined;
    let resolveCompletion: (turn: JsonObject) => void = () => undefined;

    const completion = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
      timer = setTimeout(() => reject(new Error(`Codex turn timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    // Abort can happen while turn/start is still pending. Observe the rejection
    // immediately so modern Node versions do not treat that brief window as an
    // unhandled rejection; awaiting `completion` below still throws normally.
    void completion.catch(() => undefined);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const unsubscribe = this.onNotification((method, params) => {
      if (params.threadId !== threadId) return;
      try {
        options.onEvent?.(method, params);
      } catch (error) {
        finish(() => rejectCompletion(error instanceof Error ? error : Error(String(error))));
        return;
      }
      if (method === "item/agentMessage/delta") {
        if ((!expectedTurnId || params.turnId === expectedTurnId) && typeof params.delta === "string")
          output += params.delta;
        return;
      }
      if (method !== "turn/completed" || !params.turn || typeof params.turn !== "object") return;
      const turn = params.turn as JsonObject;
      if (expectedTurnId && turn.id !== expectedTurnId) return;
      if (!expectedTurnId) bufferedCompletion = turn;
      else finish(() => resolveCompletion(turn));
    });

    const abort = () => {
      const turnId = expectedTurnId;
      if (turnId) void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      finish(() => rejectCompletion(new Error("Codex turn aborted")));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (options.signal?.aborted) abort();
      const started = (await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
      })) as { turn?: { id?: string } };
      expectedTurnId = started.turn?.id;
      if (!expectedTurnId) throw Error("Codex turn/start returned no turn ID");
      if (bufferedCompletion?.id === expectedTurnId) finish(() => resolveCompletion(bufferedCompletion!));
      const turn = await completion;
      const status = turn.status;
      if (status !== "completed") {
        const detail = turn.error ? `: ${JSON.stringify(turn.error)}` : "";
        throw Error(`Codex turn ${String(status ?? "unknown")}${detail}`);
      }
      return { threadId, turnId: expectedTurnId, status, text: output, turn };
    } finally {
      clearTimeout(timer!);
      unsubscribe();
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.lines?.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    this.child = undefined;
    this.started = false;
    this.notificationListeners.clear();
    this.failAll(new Error("Codex app-server closed"));
  }
}
