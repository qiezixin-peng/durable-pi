import { resolve, sep } from "node:path";

import { T3CodeClient, type T3CodeClientOptions } from "./t3-code.js";
import {
  T3McpClient,
  type T3McpPairingOptions,
  type T3LaunchThreadInput,
  type T3RuntimeMode,
} from "./t3-mcp.js";

type JsonObject = Record<string, unknown>;

export interface T3RuntimeTaskInput {
  cwd: string;
  /** T3 project root used for project resolution when cwd is an external managed worktree. */
  projectWorkspace?: string;
  workspaceStrategy?: T3LaunchThreadInput["workspaceStrategy"];
  title: string;
  message: string;
  clientRequestId: string;
  model: string;
  providerInstanceId?: string;
  environmentId?: string;
  runtimeMode: T3RuntimeMode;
  interactionMode?: "default" | "plan";
  existingThreadId?: string;
  registerProjectIfMissing?: boolean;
  projectTitle?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStarted?: (binding: { threadId: string; runId: string; projectId: string }) => void | Promise<void>;
}

export interface T3RuntimeTaskResult {
  threadId: string;
  runId: string;
  status: string;
  text: string;
  projectId: string;
  waitingForUser: boolean;
  activity: JsonObject[];
  environmentId?: string;
}

export interface T3RuntimeRecoveryInput {
  threadId: string;
  runId: string;
  runtimeMode: T3RuntimeMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  environmentId?: string;
}

export interface T3RuntimeStatus {
  threadId: string;
  runId: string;
  status: string;
  timedOut: boolean;
}

type RuntimeSession = Pick<
  T3McpClient,
  "initialize" | "listProjects" | "launchThread" | "sendThread" | "waitThread" | "interruptThread" | "readThread" | "environmentLinks" | "close"
> & { createProject?: T3McpClient["createProject"] };

export interface T3RuntimeGatewayOptions {
  t3?: T3CodeClientOptions;
  mcp?: Omit<T3McpPairingOptions, "access" | "modeLimit">;
  connect?: (runtimeMode: T3RuntimeMode) => Promise<RuntimeSession>;
}

const normalized = (path: string) => {
  const value = resolve(path).replaceAll("/", sep).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
};

const isInside = (path: string, parent: string) => path === parent || path.startsWith(`${parent}${sep}`);

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back", "waiting"]);

const hasPendingUserRequest = (read: JsonObject, runId: string) =>
  Array.isArray(read.items) && (read.items as JsonObject[]).some((item) =>
    item.runId === runId && item.status === "waiting" &&
    (item.type === "approval_request" || item.type === "user_question")
  );

export class T3EnvironmentUnavailableError extends Error {
  constructor(readonly environmentId: string, readonly environmentStatus: string, message?: string) {
    super(message ?? `T3 environment ${environmentId} is ${environmentStatus}`);
    this.name = "T3EnvironmentUnavailableError";
  }
}

/**
 * Executes one durable T3 turn without persisting credentials. The caller owns
 * policy selection; the gateway enforces the selected mode as both credential
 * ceiling and per-request T3-Mode-Limit.
 */
export class T3RuntimeGateway {
  constructor(private readonly options: T3RuntimeGatewayOptions = {}) {}

  private async connect(runtimeMode: T3RuntimeMode): Promise<RuntimeSession> {
    if (this.options.connect) return this.options.connect(runtimeMode);
    const t3 = new T3CodeClient(this.options.t3);
    return T3McpClient.pair(t3, {
      ...this.options.mcp,
      access: runtimeMode,
      modeLimit: { runtimeMode },
      label: this.options.mcp?.label ?? "Durable Pi runtime",
    });
  }

  private async requireEnvironment(session: RuntimeSession, environmentId?: string) {
    if (!environmentId) return;
    let links: Awaited<ReturnType<RuntimeSession["environmentLinks"]>>;
    try {
      links = await session.environmentLinks();
    } catch (error) {
      throw new T3EnvironmentUnavailableError(
        environmentId,
        "unavailable",
        `T3 could not inspect linked environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const link = links.links.find((item) => item.environmentId === environmentId);
    if (!link)
      throw new T3EnvironmentUnavailableError(environmentId, "not-linked", `T3 environment ${environmentId} is not linked`);
    if (link.status.toLowerCase() !== "reachable")
      throw new T3EnvironmentUnavailableError(environmentId, link.status, `T3 environment ${link.label} is ${link.status}`);
  }

  private async finish(
    session: RuntimeSession,
    input: T3RuntimeRecoveryInput,
    initialStatus = "running",
  ): Promise<T3RuntimeTaskResult> {
    const timeoutMs = input.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    let status = initialStatus;
    let read: Awaited<ReturnType<RuntimeSession["readThread"]>> | undefined;
    while (!terminal.has(status)) {
      if (input.signal?.aborted) {
        await this.interrupt(session, input, "Durable Pi task was cancelled");
        throw Error("T3 runtime task aborted after interrupting its active run");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.interrupt(session, input, `Durable Pi task timed out after ${timeoutMs}ms`);
        throw Error(`T3 runtime task timed out after ${timeoutMs}ms and its active run was interrupted`);
      }
      let waited: Awaited<ReturnType<RuntimeSession["waitThread"]>>;
      try {
        waited = await session.waitThread({
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          threadId: input.threadId,
          runId: input.runId,
          timeoutMs: Math.min(20_000, remaining),
          signal: input.signal,
        });
      } catch (error) {
        if (!input.signal?.aborted) throw error;
        await this.interrupt(session, input, "Durable Pi task was cancelled");
        throw Error("T3 runtime task aborted after interrupting its active run", { cause: error });
      }
      status = waited.status;
      if (waited.timedOut) {
        status = "running";
        // T3 keeps a run in `running` while a provider command approval is pending.
        // Inspect the read-only activity after each bounded wait so Durable Pi pauses
        // instead of pretending the Agent is still executing until its task timeout.
        read = await session.readThread({
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          threadId: input.threadId,
          view: "activity",
          limit: 100,
          runLimit: 10,
          maxCharsPerItem: 20_000,
        });
        if (hasPendingUserRequest(read, input.runId)) status = "waiting";
        else read = undefined;
      }
    }

    read ??= await session.readThread({
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      threadId: input.threadId,
      view: "activity",
      limit: 100,
      runLimit: 10,
      maxCharsPerItem: 20_000,
    });
    const items = Array.isArray(read.items) ? read.items as JsonObject[] : [];
    // A tool-using turn can emit a short assistant preamble before the tool call and a
    // final answer afterwards. T3 returns activity in chronological order, so select
    // the last assistant message from the exact run instead of the first one.
    const assistantMessages = items.filter((item) =>
      item.type === "assistant_message" && typeof item.text === "string"
    );
    const answer = assistantMessages.filter((item) => item.runId === input.runId).at(-1) ?? assistantMessages.at(-1);
    const text = typeof answer?.text === "string" ? answer.text : "";
    if (status === "completed" && !text) throw Error("T3 runtime completed without an agent result");
    const thread = read.thread && typeof read.thread === "object" && !Array.isArray(read.thread)
      ? read.thread as JsonObject
      : undefined;
    return {
      threadId: input.threadId,
      runId: input.runId,
      status,
      text,
      projectId: typeof thread?.projectId === "string" ? thread.projectId : "unknown",
      waitingForUser: status === "waiting",
      activity: items.filter((item) => item.runId === input.runId),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    };
  }

  private async interrupt(session: RuntimeSession, input: T3RuntimeRecoveryInput, reason: string) {
    const interrupted = await session.interruptThread({
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      threadId: input.threadId,
      runId: input.runId,
      reason,
    });
    if (interrupted.status !== "interrupt_requested") return interrupted;
    const confirmed = await session.waitThread({
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      threadId: input.threadId,
      runId: input.runId,
      timeoutMs: 10_000,
    });
    if (confirmed.timedOut || !terminal.has(confirmed.status))
      throw Error(`T3 accepted the interrupt but run ${input.runId} did not reach a terminal state`);
    return confirmed;
  }

  /** Reattach to an already-started run after a worker crash or lost response. */
  async recover(input: T3RuntimeRecoveryInput): Promise<T3RuntimeTaskResult> {
    if (input.signal?.aborted) throw Error("T3 runtime task aborted");
    const session = await this.connect(input.runtimeMode);
    try {
      await session.initialize();
      await this.requireEnvironment(session, input.environmentId);
      return await this.finish(session, input);
    } finally {
      await session.close();
    }
  }

  async cancel(input: T3RuntimeRecoveryInput, reason = "Durable Pi task was cancelled") {
    const session = await this.connect(input.runtimeMode);
    try {
      await session.initialize();
      await this.requireEnvironment(session, input.environmentId);
      return await this.interrupt(session, input, reason);
    } finally {
      await session.close();
    }
  }

  /** Non-mutating short poll used to notice that a user answered a T3 question.
   * Unlike recover(), this never interrupts a still-running turn. */
  async status(input: T3RuntimeRecoveryInput, timeoutMs = 1): Promise<T3RuntimeStatus> {
    if (input.signal?.aborted) throw Error("T3 runtime status check aborted");
    const session = await this.connect(input.runtimeMode);
    try {
      await session.initialize();
      await this.requireEnvironment(session, input.environmentId);
      const result = await session.waitThread({
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        threadId: input.threadId,
        runId: input.runId,
        timeoutMs: Math.max(1, Math.min(5_000, timeoutMs)),
        signal: input.signal,
      });
      if ((result.status === "running" || result.timedOut) && input.runId) {
        const read = await session.readThread({
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          threadId: input.threadId,
          view: "activity",
          limit: 100,
          runLimit: 10,
          maxCharsPerItem: 20_000,
        });
        if (hasPendingUserRequest(read, input.runId))
          return { threadId: input.threadId, runId: input.runId, status: "waiting", timedOut: false };
      }
      return {
        threadId: input.threadId,
        runId: input.runId,
        status: result.status,
        timedOut: result.timedOut,
      };
    } finally {
      await session.close();
    }
  }

  async run(input: T3RuntimeTaskInput): Promise<T3RuntimeTaskResult> {
    if (input.signal?.aborted) throw Error("T3 runtime task aborted");
    const session = await this.connect(input.runtimeMode);
    try {
      await session.initialize();
      await this.requireEnvironment(session, input.environmentId);
      const cwd = normalized(input.projectWorkspace ?? input.cwd);
      const candidates = (await session.listProjects(input.environmentId))
        .map((project) => ({ project, root: normalized(project.workspaceRoot) }))
        .filter(({ root }) => isInside(cwd, root))
        .sort((left, right) => right.root.length - left.root.length);
      let project = candidates[0]?.project;
      if (!project && input.registerProjectIfMissing) {
        if (!session.createProject) throw Error("T3 runtime does not support project registration");
        project = await session.createProject({
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          title: input.projectTitle?.trim() || input.title,
          workspaceRoot: input.cwd,
        });
      }
      if (!project) throw Error(`T3 has no registered project containing ${input.cwd}`);

      const started = input.existingThreadId
        ? await session.sendThread({
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            threadId: input.existingThreadId,
            message: input.message,
            mode: "auto",
            clientRequestId: input.clientRequestId,
          })
        : await session.launchThread({
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            projectId: project.id,
            title: input.title,
            message: input.message,
            providerInstanceId: input.providerInstanceId ?? "codex",
            model: input.model,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode ?? "default",
            workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
            clientRequestId: input.clientRequestId,
          });
      const threadId = started.threadId;
      const runId = started.runId;
      if (!runId) throw Error("T3 runtime started no run");
      await input.onStarted?.({ threadId, runId, projectId: project.id });

      const result = await this.finish(
        session,
        {
          threadId,
          runId,
          runtimeMode: input.runtimeMode,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          environmentId: input.environmentId,
        },
        started.status ?? "running",
      );
      return { ...result, projectId: project.id };
    } finally {
      await session.close();
    }
  }
}
