import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LocalPiProviderId } from "./local-model-providers.js";
import { killProcessTree } from "./process-tree.js";
import {
  assertToolArgumentsWithinWorkspace,
  resolvePhysicalDirectory,
  WorkspaceBoundaryError,
} from "./workspace-confinement.js";

type JsonObject = Record<string, unknown>;

export interface PiLocalClientOptions {
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  sessionDir?: string;
}

export interface PiLocalTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface PiLocalToolEvent {
  event: "started" | "completed";
  callId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  writes: boolean;
}

export interface PiLocalTurnInput {
  cwd: string;
  provider: LocalPiProviderId;
  modelId: string;
  prompt: string;
  readOnly: boolean;
  sessionId?: string;
  sessionDir?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  signal?: AbortSignal;
  onToolEvent?: (event: PiLocalToolEvent) => void;
}

export interface PiLocalTurnResult {
  sessionId?: string;
  text: string;
  usage?: PiLocalTurnUsage;
  sideEffectToolObserved: boolean;
}

const READ_ONLY_PI_TOOLS = "read,grep,find,ls";
const WRITE_TOOL_NAMES = new Set(["write", "edit", "bash", "powershell"]);

export function findPiLaunchSpec(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (env.DPI_PI_COMMAND?.trim()) return { command: env.DPI_PI_COMMAND.trim(), args: [] };
  if (process.platform === "win32") {
    const baseDir = env.PI_CODING_AGENT_DIR?.trim() || join(env.USERPROFILE || homedir(), ".pi", "agent");
    const launcher = join(baseDir, "bin", "pi-launcher.js");
    if (existsSync(launcher)) return { command: process.execPath, args: [launcher] };
    const exe = join(baseDir, "bin", "pi.exe");
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  return { command: "pi", args: [] };
}

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const extractAssistantText = (message: JsonObject | undefined): string => {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => {
      const item = asObject(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("");
};

const extractUsage = (value: unknown): PiLocalTurnUsage | undefined => {
  const usage = asObject(value);
  if (!usage) return undefined;
  const inputTokens = Number(usage.input ?? usage.inputTokens ?? 0);
  const outputTokens = Number(usage.output ?? usage.outputTokens ?? 0);
  const cachedInputTokens = Number(usage.cacheRead ?? usage.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = Number(usage.cacheWrite ?? usage.cacheWriteInputTokens ?? 0);
  const reasoningOutputTokens = Number(usage.reasoning ?? usage.reasoningOutputTokens ?? 0);
  const totalTokens = Number(usage.totalTokens ?? (inputTokens + outputTokens + cachedInputTokens + cacheWriteInputTokens));
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  return {
    inputTokens: Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0 ? cachedInputTokens : 0,
    cacheWriteInputTokens: Number.isFinite(cacheWriteInputTokens) && cacheWriteInputTokens >= 0 ? cacheWriteInputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
    reasoningOutputTokens: Number.isFinite(reasoningOutputTokens) && reasoningOutputTokens >= 0 ? reasoningOutputTokens : 0,
    totalTokens,
  };
};

/**
 * Shell-free local Pi CLI runner using strict LF JSONL framing.
 * Used for local read-only Gemini/DeepSeek turns (enforcing `--tools read,grep,find,ls`)
 * and for local execution when T3 runtime is disabled.
 */
export class PiLocalClient {
  readonly command: string;
  readonly baseArgs: string[];
  readonly maxOutputBytes: number;

  constructor(private readonly options: PiLocalClientOptions = {}) {
    const spec = options.command
      ? { command: options.command, args: options.commandArgs ?? [] }
      : findPiLaunchSpec(options.env);
    this.command = spec.command;
    this.baseArgs = [...spec.args, ...(options.command ? [] : (options.commandArgs ?? []))];
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  async runTurn(input: PiLocalTurnInput): Promise<PiLocalTurnResult> {
    if (input.signal?.aborted) throw Error("Local Pi task aborted");
    if (!input.readOnly) {
      throw new WorkspaceBoundaryError(
        "PERMISSION_BOUNDARY_VIOLATION",
        "PiLocalClient only supports hard read-only execution (--tools read,grep,find,ls); write tasks must run via DeepSeekHarnessClient or T3 runtime",
      );
    }
    const canonicalCwd = resolvePhysicalDirectory(input.cwd, "PiLocalClient workspace cwd");
    const sessionDir = input.sessionDir ?? this.options.sessionDir;
    if (sessionDir) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const args = [
      ...this.baseArgs,
      "--print",
      "--mode", "json",
      "--provider", input.provider,
      "--model", input.modelId,
      "--no-mcp",
      "--tools", READ_ONLY_PI_TOOLS,
      ...(input.thinkingLevel ? ["--thinking", input.thinkingLevel] : []),
      ...(sessionDir ? ["--session-dir", sessionDir] : []),
      ...(input.sessionId ? ["--session-id", input.sessionId] : (!sessionDir ? ["--no-session"] : [])),
      "--",
      input.prompt,
    ];

    const child = spawn(this.command, args, {
      cwd: canonicalCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      env: { ...process.env, ...this.options.env },
    });
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let buffer = "";
    let stderr = "";
    let totalBytes = 0;
    let outputError: Error | undefined;
    let boundaryError: WorkspaceBoundaryError | undefined;
    let sessionId: string | undefined = input.sessionId;
    let lastAssistantText = "";
    let lastAssistantError: string | undefined;
    let usage: PiLocalTurnUsage | undefined;
    let sideEffectToolObserved = false;

    const handleRecord = (line: string) => {
      const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!cleaned.trim()) return;
      let event: JsonObject | undefined;
      try {
        event = asObject(JSON.parse(cleaned));
      } catch {
        return;
      }
      if (!event) return;
      const type = event.type;
      if (type === "session" && typeof event.id === "string" && event.id.trim()) {
        sessionId = event.id.trim();
        return;
      }
      if (type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        const callId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : `pi-${Date.now()}`;
        const writes = WRITE_TOOL_NAMES.has(toolName.toLowerCase());
        if (writes) sideEffectToolObserved = true;
        try {
          assertToolArgumentsWithinWorkspace({
            cwd: canonicalCwd,
            toolName,
            args: event.args,
            readOnly: true,
          });
        } catch (err) {
          boundaryError = err instanceof WorkspaceBoundaryError
            ? err
            : new WorkspaceBoundaryError("WORKSPACE_PATH_ESCAPE", err instanceof Error ? err.message : String(err));
          killProcessTree(child);
          return;
        }
        input.onToolEvent?.({
          event: "started",
          callId,
          toolName,
          args: event.args,
          writes,
        });
        return;
      }
      if (type === "tool_execution_end") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        const callId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : `pi-${Date.now()}`;
        const writes = WRITE_TOOL_NAMES.has(toolName.toLowerCase());
        input.onToolEvent?.({
          event: "completed",
          callId,
          toolName,
          result: event.result,
          isError: event.isError === true,
          writes,
        });
        return;
      }
      if (type === "message_end" || type === "turn_end") {
        const message = asObject(event.message);
        const text = extractAssistantText(message);
        if (text) lastAssistantText = text;
        if (message?.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
          lastAssistantError = message.errorMessage.trim();
        }
        const extracted = extractUsage(message?.usage ?? event.usage);
        if (extracted) usage = extracted;
        return;
      }
      if (type === "message_update") {
        const extracted = extractUsage(event.usage);
        if (extracted) usage = extracted;
        const inner = asObject(event.assistantMessageEvent);
        if (inner?.type === "error" && typeof inner.error === "string" && inner.error.trim()) {
          lastAssistantError = inner.error.trim();
        }
      }
    };

    const appendBytes = (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > this.maxOutputBytes) {
        outputError ??= Error(`Local Pi output exceeded ${this.maxOutputBytes} bytes`);
        killProcessTree(child);
        return false;
      }
      return true;
    };

    child.stdout.on("data", (chunk: string) => {
      if (!appendBytes(chunk)) return;
      buffer += chunk;
      for (;;) {
        const lf = buffer.indexOf("\n");
        if (lf < 0) break;
        const line = buffer.slice(0, lf);
        buffer = buffer.slice(lf + 1);
        handleRecord(line);
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (!appendBytes(chunk)) return;
      stderr += chunk;
    });

    const timeoutMs = input.timeoutMs ?? 300_000;
    let timedOut = false;
    let aborted = false;

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        aborted = true;
        killProcessTree(child);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (error) => {
        cleanup();
        rejectExit(error);
      });
      child.on("close", (code) => {
        cleanup();
        resolveExit(code);
      });
    });

    if (buffer.trim()) handleRecord(buffer);

    if (boundaryError) throw Object.assign(boundaryError, { sideEffectToolObserved });
    if (outputError) throw outputError;
    if (aborted) throw Error("Local Pi task aborted");
    if (timedOut) throw Error(`Local Pi task timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) {
      const detail = lastAssistantError || stderr.trim() || `exit code ${exitCode}`;
      throw Object.assign(
        Error(`Local Pi (${input.provider}/${input.modelId}) failed: ${detail.slice(0, 1_500)}`),
        { sideEffectToolObserved },
      );
    }
    if (lastAssistantError && !lastAssistantText) {
      throw Object.assign(
        Error(`Local Pi (${input.provider}/${input.modelId}) error: ${lastAssistantError.slice(0, 1_500)}`),
        { sideEffectToolObserved },
      );
    }
    if (!lastAssistantText) {
      throw Object.assign(
        Error(`Local Pi (${input.provider}/${input.modelId}) completed without an assistant response`),
        { sideEffectToolObserved },
      );
    }
    return {
      ...(sessionId ? { sessionId } : {}),
      text: lastAssistantText,
      ...(usage ? { usage } : {}),
      sideEffectToolObserved,
    };
  }
}
