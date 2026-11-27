import { createHash, randomBytes } from "node:crypto";

import type { T3CodeClient } from "./t3-code.ts";

type JsonObject = Record<string, unknown>;

export type T3McpAccess = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type T3RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface T3McpClientOptions {
  endpoint?: string;
  accessToken: string;
  modeLimit?: { runtimeMode: T3RuntimeMode; interactionMode?: string };
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Internal lifecycle hook used by pair() to revoke the minted auth session. */
  onClose?: () => Promise<void>;
}

export interface T3McpPairingOptions {
  endpoint?: string;
  access?: T3McpAccess;
  modeLimit?: { runtimeMode: T3RuntimeMode; interactionMode?: string };
  ttl?: string;
  label?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  scopes?: string[];
}

export interface T3McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface T3LaunchThreadInput {
  environmentId?: string;
  projectId: string;
  title: string;
  message?: string;
  providerInstanceId?: string;
  model?: string;
  runtimeMode?: T3RuntimeMode;
  interactionMode?: "default" | "plan";
  workspaceStrategy?:
    | { type: "root"; branch?: string }
    | { type: "existing_worktree"; worktreePath: string; branch?: string }
    | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };
  clientRequestId: string;
}

export interface T3LaunchThreadResult extends JsonObject {
  threadId: string;
  projectId: string;
  runId: string | null;
  status: string | null;
  link?: string | null;
}

export interface T3WaitThreadResult extends JsonObject {
  threadId: string;
  runId: string | null;
  status: string;
  timedOut: boolean;
  next?: string | null;
}

export interface T3McpProject extends JsonObject {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface T3CreateProjectInput {
  environmentId?: string;
  title: string;
  workspaceRoot: string;
}

export class T3McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "T3McpError";
  }
}

const requireObject = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} is not an object`);
  return value as JsonObject;
};

const requireString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0) throw Error(`${label} is missing`);
  return value;
};

const sessionIdFromToken = (token: string) => {
  try {
    const claims = requireObject(JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")), "T3 MCP token claims");
    return requireString(claims.sid, "T3 MCP session id");
  } catch (error) {
    throw Error(`T3 MCP returned an invalid session token: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const responsePayload = async (response: Response) => {
  const body = await response.text();
  if (!response.ok) throw new T3McpError(`T3 MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    if (!data) throw new T3McpError("T3 MCP SSE response contained no data event");
    return JSON.parse(data) as unknown;
  }
  return body.length === 0 ? undefined : (JSON.parse(body) as unknown);
};

/** Minimal Streamable HTTP MCP client with a deliberately narrow T3 credential. */
export class T3McpClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;
  private sessionId?: string;
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: T3McpClientOptions) {
    if (!options.accessToken) throw Error("T3 MCP access token is required");
    this.endpoint = options.endpoint ?? "http://127.0.0.1:3773/mcp";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  static async pair(t3: T3CodeClient, options: T3McpPairingOptions = {}) {
    const endpoint = options.endpoint ?? "http://127.0.0.1:3773/mcp";
    const origin = new URL(endpoint).origin;
    const fetcher = options.fetch ?? globalThis.fetch;
    const pairing = await t3.createPairingCredential({
      scopes: options.scopes ?? ["orchestration:read", "orchestration:operate"],
      ttl: options.ttl ?? "10m",
      label: options.label ?? "Durable Pi",
    });
    let consumed = false;
    try {
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const redirectUri = "http://127.0.0.1:49731/callback";
      const registered = requireObject(
        await responsePayload(
          await fetcher(`${origin}/oauth/mcp/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: options.label ?? "Durable Pi",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              token_endpoint_auth_method: "none",
            }),
          }),
        ),
        "T3 MCP registration",
      );
      const authorization = {
        response_type: "code",
        client_id: requireString(registered.client_id, "T3 MCP client_id"),
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: randomBytes(16).toString("hex"),
        resource: endpoint,
      };
      const decision = requireObject(
        await responsePayload(
          await fetcher(`${origin}/oauth/mcp/decision`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              authorization,
              decision: {
                _tag: "pairing-code",
                access: options.access ?? "approval-required",
                code: pairing.credential,
              },
            }),
          }),
        ),
        "T3 MCP decision",
      );
      consumed = true;
      const code = new URL(requireString(decision.redirectTo, "T3 MCP redirectTo")).searchParams.get("code");
      if (!code) throw Error("T3 MCP authorization returned no code");
      const token = requireObject(
        await responsePayload(
          await fetcher(`${origin}/oauth/mcp/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: authorization.client_id,
              code_verifier: verifier,
              resource: endpoint,
            }),
          }),
        ),
        "T3 MCP token",
      );
      const accessToken = requireString(token.access_token, "T3 MCP access_token");
      const authSessionId = sessionIdFromToken(accessToken);
      return new T3McpClient({
        endpoint,
        accessToken,
        modeLimit: options.modeLimit,
        timeoutMs: options.timeoutMs,
        fetch: fetcher,
        onClose: () => t3.revokeAuthSession(authSessionId),
      });
    } finally {
      if (!consumed) await t3.revokePairingCredential(pairing.id).catch(() => undefined);
    }
  }

  private headers() {
    return {
      authorization: `Bearer ${this.options.accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.options.modeLimit
        ? {
            "t3-mode-limit": `${this.options.modeLimit.runtimeMode}/${this.options.modeLimit.interactionMode ?? "default"}`,
          }
        : {}),
    };
  }

  private async post(payload: unknown, initialize = false, signal?: AbortSignal) {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (initialize) this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
      return await responsePayload(response);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async initialize() {
    const response = requireObject(
      await this.post(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "durable-pi", version: "0.1.0" },
          },
        },
        true,
      ),
      "T3 MCP initialize response",
    );
    this.unwrap(response);
    if (!this.sessionId) throw new T3McpError("T3 MCP returned no session id");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response.result;
  }

  async listTools() {
    const result = requireObject(await this.call("tools/list", {}), "T3 MCP tools/list result");
    if (!Array.isArray(result.tools)) throw Error("T3 MCP tools/list returned no tools array");
    return result.tools as T3McpTool[];
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal) {
    const result = requireObject(await this.call("tools/call", { name, arguments: args }, signal), `T3 MCP tool ${name}`);
    if (result.isError === true) throw new T3McpError(`T3 MCP tool ${name} failed`, undefined, result);
    return result;
  }

  async capabilities(input: { environmentId?: string; search?: string } = {}) {
    return this.structured(await this.callTool("orchestrator_capabilities", input), "orchestrator_capabilities");
  }

  async listProjects(environmentId?: string) {
    const projects: T3McpProject[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = this.structured(
        await this.callTool("t3_project_list", {
          ...(environmentId ? { environmentId } : {}),
          cursor,
          limit: 100,
        }),
        "t3_project_list",
      );
      if (!Array.isArray(page.projects)) throw Error("T3 MCP project list returned no projects array");
      projects.push(...page.projects.map((project) => {
        const value = requireObject(project, "T3 MCP project");
        return {
          ...value,
          id: requireString(value.id, "T3 project id"),
          title: requireString(value.title, "T3 project title"),
          workspaceRoot: requireString(value.workspaceRoot, "T3 project workspaceRoot"),
        };
      }));
      cursor = typeof page.nextCursor === "number" ? page.nextCursor : null;
    }
    return projects;
  }

  async createProject(input: T3CreateProjectInput) {
    const result = this.structured(
      await this.callTool("t3_project_create", {
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        title: requireString(input.title, "T3 project title"),
        workspaceRoot: requireString(input.workspaceRoot, "T3 project workspaceRoot"),
        createWorkspaceRootIfMissing: false,
      }),
      "t3_project_create",
    );
    return {
      ...result,
      id: requireString(result.id, "T3 project id"),
      title: requireString(result.title, "T3 project title"),
      workspaceRoot: requireString(result.workspaceRoot, "T3 project workspaceRoot"),
    } satisfies T3McpProject;
  }

  async launchThread(input: T3LaunchThreadInput) {
    if (Boolean(input.providerInstanceId) !== Boolean(input.model))
      throw Error("T3 MCP providerInstanceId and model must be supplied together");
    const result = this.structured(
      await this.callTool("t3_thread_launch", {
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        projectId: input.projectId,
        title: input.title,
        ...(input.message ? { message: input.message } : {}),
        ...(input.providerInstanceId
          ? { modelSelection: { instanceId: input.providerInstanceId, model: input.model } }
          : {}),
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.workspaceStrategy ? { workspaceStrategy: input.workspaceStrategy } : {}),
        clientRequestId: input.clientRequestId,
      }),
      "t3_thread_launch",
    );
    return {
      ...result,
      threadId: requireString(result.threadId, "T3 threadId"),
      projectId: requireString(result.projectId, "T3 projectId"),
      runId: typeof result.runId === "string" ? result.runId : null,
      status: typeof result.status === "string" ? result.status : null,
      link: typeof result.link === "string" ? result.link : null,
    } satisfies T3LaunchThreadResult;
  }

  async waitThread(input: {
    threadId: string;
    runId?: string;
    timeoutMs?: number;
    untilDelegatedWorkSettled?: boolean;
    environmentId?: string;
    signal?: AbortSignal;
  }) {
    const { signal, ...request } = input;
    const result = this.structured(await this.callTool("t3_thread_wait", request, signal), "t3_thread_wait");
    return {
      ...result,
      threadId: requireString(result.threadId, "T3 wait threadId"),
      runId: typeof result.runId === "string" ? result.runId : null,
      status: requireString(result.status, "T3 wait status"),
      timedOut: result.timedOut === true,
      next: typeof result.next === "string" ? result.next : null,
    } satisfies T3WaitThreadResult;
  }

  async interruptThread(input: {
    threadId: string;
    runId?: string;
    reason?: string;
    stop?: boolean;
    clientRequestId?: string;
    environmentId?: string;
  }) {
    const result = this.structured(await this.callTool("t3_thread_interrupt", input), "t3_thread_interrupt");
    return {
      ...result,
      threadId: requireString(result.threadId, "T3 interrupt threadId"),
      runId: typeof result.runId === "string" ? result.runId : null,
      status: requireString(result.status, "T3 interrupt status"),
    };
  }

  async sendThread(input: {
    threadId: string;
    message: string;
    mode?: "auto" | "queue" | "steer" | "restart";
    freshContext?: boolean;
    clientRequestId: string;
    environmentId?: string;
  }) {
    const result = this.structured(await this.callTool("t3_thread_send", input), "t3_thread_send");
    return {
      ...result,
      threadId: requireString(result.threadId, "T3 send threadId"),
      messageId: requireString(result.messageId, "T3 send messageId"),
      runId: requireString(result.runId, "T3 send runId"),
      status: requireString(result.status, "T3 send status"),
      delivery: requireString(result.delivery, "T3 send delivery"),
    };
  }

  async readThread(input: {
    threadId: string;
    view?: "messages" | "activity";
    afterPosition?: number;
    beforePosition?: number;
    limit?: number;
    runLimit?: number;
    maxCharsPerItem?: number;
    environmentId?: string;
  }) {
    return this.structured(await this.callTool("t3_thread_read", input), "t3_thread_read");
  }

  async organizeThread(input: {
    threadId: string;
    action: "archive" | "unarchive";
    environmentId?: string;
  }) {
    return this.structured(await this.callTool("t3_thread_organize", input), "t3_thread_organize");
  }

  async environmentLinks() {
    const result = this.structured(await this.callTool("t3_environment_links", {}), "t3_environment_links");
    if (!Array.isArray(result.links)) throw Error("T3 MCP environment links returned no links array");
    return {
      environmentId: requireString(result.environmentId, "T3 environment id"),
      links: result.links.map((link) => {
        const value = requireObject(link, "T3 environment link");
        return {
          ...value,
          environmentId: requireString(value.environmentId, "T3 linked environment id"),
          label: requireString(value.label, "T3 linked environment label"),
          status: requireString(value.status, "T3 linked environment status"),
          access: requireString(value.access, "T3 linked environment access"),
        };
      }),
      notListed: typeof result.notListed === "string" ? result.notListed : "",
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.sessionId)
        await this.fetcher(this.endpoint, { method: "DELETE", headers: this.headers(), signal: controller.signal });
    } finally {
      clearTimeout(timer);
      this.sessionId = undefined;
      await this.options.onClose?.();
    }
  }

  private async call(method: string, params: JsonObject, signal?: AbortSignal) {
    if (!this.sessionId) throw new T3McpError("T3 MCP client is not initialized");
    const response = requireObject(
      await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, false, signal),
      `T3 MCP ${method} response`,
    );
    return this.unwrap(response);
  }

  private unwrap(response: JsonObject) {
    if (response.error) {
      const error = requireObject(response.error, "T3 MCP error");
      throw new T3McpError(
        typeof error.message === "string" ? error.message : "T3 MCP request failed",
        typeof error.code === "number" ? error.code : undefined,
        error.data,
      );
    }
    return response.result;
  }

  private structured(result: JsonObject, tool: string) {
    return requireObject(result.structuredContent, `T3 MCP ${tool} structuredContent`);
  }
}
