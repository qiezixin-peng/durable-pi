import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { killProcessTree } from "./process-tree.js";
import {
  assertToolArgumentsWithinWorkspace,
  isWriteOrShellToolName,
  resolvePhysicalDirectory,
  WorkspaceBoundaryError,
} from "./workspace-confinement.js";

type JsonObject = Record<string, unknown>;

export type DeepSeekHarnessPermissionMode = "read-only" | "workspace-write";
export type DeepSeekHarnessApprovalPolicy = "never" | "ask";
export type DeepSeekHarnessAuthRoute = "deepseek-account" | "deepseek-official";

export interface DeepSeekHarnessClientOptions {
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  dshHome?: string;
  maxOutputBytes?: number;
}

export interface DeepSeekHarnessTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface DeepSeekHarnessToolEvent {
  event: "started" | "completed";
  callId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  writes: boolean;
}

export interface DeepSeekHarnessTurnInput {
  cwd: string;
  modelId: string;
  prompt: string;
  permissionMode: DeepSeekHarnessPermissionMode;
  approvalPolicy?: DeepSeekHarnessApprovalPolicy;
  sessionId?: string;
  additionalWritableDirs?: readonly string[];
  authRoute?: DeepSeekHarnessAuthRoute;
  timeoutMs?: number;
  signal?: AbortSignal;
  onToolEvent?: (event: DeepSeekHarnessToolEvent) => void;
}

export interface DeepSeekHarnessTurnResult {
  sessionId: string;
  text: string;
  authRoute: DeepSeekHarnessAuthRoute;
  usage?: DeepSeekHarnessTurnUsage;
  sideEffectToolObserved: boolean;
}

export function defaultDshHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_HOME?.trim()) return env.DSH_HOME.trim();
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return join(home, ".dsh");
}

export function inspectDshCredentialsFile(dshHome: string): {
  hasAccountToken: boolean;
  hasStoredSecret: boolean;
} {
  const credFile = join(dshHome, ".credentials.yaml");
  if (!existsSync(credFile)) return { hasAccountToken: false, hasStoredSecret: false };
  try {
    const raw = readFileSync(credFile, "utf8");
    const hasAccountToken = /\btoken\s*:\s*\S+/.test(raw) && /\bissuer\s*:\s*\S+/.test(raw);
    const hasStoredSecret = /\bsecret\s*:\s*\S+/.test(raw);
    return { hasAccountToken, hasStoredSecret };
  } catch {
    return { hasAccountToken: false, hasStoredSecret: false };
  }
}

export function findDeepSeekHarnessLaunchSpec(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
  envOverrides: Record<string, string>;
  installed: boolean;
} {
  if (env.DPI_DSH_COMMAND?.trim()) {
    const cmd = env.DPI_DSH_COMMAND.trim();
    return {
      command: cmd,
      args: [],
      envOverrides: {},
      installed: existsSync(cmd) || !cmd.includes("/") && !cmd.includes("\\"),
    };
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE || homedir(), "AppData", "Local");
    const appDir = join(localAppData, "Programs", "DeepSeek Harness");
    const exePath = join(appDir, "DeepSeek Harness.exe");
    const asarPath = join(appDir, "resources", "app.asar");
    const cliJsPath = join(
      asarPath,
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "cli.js",
    );
    if (existsSync(exePath) && existsSync(asarPath)) {
      return {
        command: exePath,
        args: ["--expose-internals", cliJsPath],
        envOverrides: { ELECTRON_RUN_AS_NODE: "1" },
        installed: true,
      };
    }
  }
  const pathDirs = (env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of process.platform === "win32" ? ["dsh.exe", "dsh"] : ["dsh"]) {
      const full = join(dir, candidate);
      if (existsSync(full)) {
        return { command: full, args: [], envOverrides: {}, installed: true };
      }
    }
  }
  return { command: "dsh", args: [], envOverrides: {}, installed: false };
}

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

function buildPatchOverlayYaml(input: {
  authRoute: DeepSeekHarnessAuthRoute;
  modelId: string;
  enableCredentialStore: boolean;
}): string {
  const safeModelId = JSON.stringify(input.modelId);
  const safeProvider = JSON.stringify(input.authRoute);
  const lines = [
    "- id: agent-default-model",
    "  config:",
    `    provider: ${safeProvider}`,
    `    model: ${safeModelId}`,
  ];
  if (input.authRoute === "deepseek-account" || input.enableCredentialStore) {
    lines.push(
      "- id: credentials",
      "  disabled: false",
      "- id: authorization",
      "  disabled: false",
      "- id: deepseek-account",
      "  disabled: false",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Shell-free DeepSeek Harness (`dsh --profile headless --json`) runner.
 * Reuses the desktop DeepSeek Harness login (`deepseek-account` in `$DSH_HOME/.credentials.yaml`)
 * or official DeepSeek credential store, enforces `--permission-mode` / `--approval-policy` /
 * `--add-dir` workspace confinement, parses NDJSON tool and usage events, and terminates
 * the full child process tree on cancellation or boundary violation.
 */
export class DeepSeekHarnessClient {
  readonly command: string;
  readonly baseArgs: string[];
  readonly envOverrides: Record<string, string>;
  readonly maxOutputBytes: number;
  readonly dshHome: string;

  constructor(private readonly options: DeepSeekHarnessClientOptions = {}) {
    const env = options.env ?? process.env;
    this.dshHome = options.dshHome ?? defaultDshHome(env);
    if (options.command) {
      this.command = options.command;
      this.baseArgs = [...(options.commandArgs ?? [])];
      this.envOverrides = {};
    } else {
      const spec = findDeepSeekHarnessLaunchSpec(env);
      this.command = spec.command;
      this.baseArgs = [...spec.args, ...(options.commandArgs ?? [])];
      this.envOverrides = spec.envOverrides;
    }
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  resolveAuthRoute(): { authRoute: DeepSeekHarnessAuthRoute; enableCredentialStore: boolean } {
    const env = this.options.env ?? process.env;
    const creds = inspectDshCredentialsFile(this.dshHome);
    if (creds.hasAccountToken) {
      return { authRoute: "deepseek-account", enableCredentialStore: true };
    }
    if (env.DEEPSEEK_API_KEY?.trim()) {
      return { authRoute: "deepseek-official", enableCredentialStore: false };
    }
    if (creds.hasStoredSecret) {
      return { authRoute: "deepseek-official", enableCredentialStore: true };
    }
    return { authRoute: "deepseek-account", enableCredentialStore: true };
  }

  async runTurn(input: DeepSeekHarnessTurnInput): Promise<DeepSeekHarnessTurnResult> {
    if (input.signal?.aborted) throw Error("DeepSeek Harness task aborted");
    const canonicalCwd = resolvePhysicalDirectory(input.cwd, "DeepSeek Harness workspace cwd");
    const readOnly = input.permissionMode === "read-only";
    const approvalPolicy: DeepSeekHarnessApprovalPolicy = input.approvalPolicy ?? "never";
    if (input.permissionMode !== "read-only" && input.permissionMode !== "workspace-write") {
      throw Error(`Unsupported DeepSeek Harness permission mode: ${String(input.permissionMode)}`);
    }
    if (approvalPolicy !== "never" && approvalPolicy !== "ask") {
      throw Error(`Unsupported DeepSeek Harness approval policy: ${String(approvalPolicy)}`);
    }

    const canonicalAddDirs: string[] = [];
    if (!readOnly && input.additionalWritableDirs?.length) {
      for (const dir of input.additionalWritableDirs) {
        canonicalAddDirs.push(resolvePhysicalDirectory(dir, "DeepSeek Harness --add-dir"));
      }
    }

    const resolvedAuth = this.resolveAuthRoute();
    const authRoute = input.authRoute ?? resolvedAuth.authRoute;
    const patchDir = join(tmpdir(), "durable-pi-dsh-patches");
    mkdirSync(patchDir, { recursive: true, mode: 0o700 });
    const patchPath = join(patchDir, `dsh-patch-${randomUUID()}.yml`);
    writeFileSync(
      patchPath,
      buildPatchOverlayYaml({
        authRoute,
        modelId: input.modelId,
        enableCredentialStore: resolvedAuth.enableCredentialStore,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const args: string[] = [
      ...this.baseArgs,
      "--profile",
      "headless",
      "--patch",
      patchPath,
      "--json",
      "--permission-mode",
      input.permissionMode,
      "--approval-policy",
      approvalPolicy,
    ];
    for (const dir of canonicalAddDirs) {
      args.push("--add-dir", dir);
    }
    if (input.sessionId?.trim()) {
      args.push("--session-id", input.sessionId.trim());
    }
    args.push(input.prompt);

    const baseEnv = { ...process.env, ...this.options.env, ...this.envOverrides };
    baseEnv.DSH_HOME = this.dshHome;
    baseEnv.DSH_PERMISSION_MODE = input.permissionMode;

    const child = spawn(this.command, args, {
      cwd: canonicalCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      env: baseEnv,
    });
    child.stdin.end();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let buffer = "";
    let stderr = "";
    let totalBytes = 0;
    let outputError: Error | undefined;
    let boundaryError: WorkspaceBoundaryError | undefined;
    let sessionId: string | undefined = input.sessionId?.trim() || undefined;
    let accumulatedText = "";
    let finalText: string | undefined;
    let terminalError: { code?: string; message: string } | undefined;
    let sideEffectToolObserved = false;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalReasoningTokens = 0;
    let totalTokensSum = 0;
    let sawUsage = false;

    const toolNamesByCallId = new Map<string, { toolName: string; writes: boolean }>();

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
      if (type === "session") {
        if (typeof event.sessionId === "string" && event.sessionId.trim()) {
          sessionId = event.sessionId.trim();
        }
        return;
      }
      if (type === "text") {
        if (typeof event.text === "string") {
          accumulatedText += event.text;
        }
        return;
      }
      if (type === "tool_call") {
        const callId = typeof event.callId === "string" && event.callId.trim()
          ? event.callId.trim()
          : `dsh-tool-${Date.now()}`;
        const toolName = typeof event.tool === "string" && event.tool.trim()
          ? event.tool.trim()
          : "unknown";
        const writes = isWriteOrShellToolName(toolName);
        if (writes) sideEffectToolObserved = true;
        toolNamesByCallId.set(callId, { toolName, writes });

        try {
          assertToolArgumentsWithinWorkspace({
            cwd: canonicalCwd,
            additionalAllowedDirs: canonicalAddDirs,
            toolName,
            args: event.input,
            readOnly,
            allowShellInWriteMode: true,
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
          args: event.input,
          writes,
        });
        return;
      }
      if (type === "tool_result") {
        const callId = typeof event.callId === "string" && event.callId.trim()
          ? event.callId.trim()
          : `dsh-tool-${Date.now()}`;
        const tracked = toolNamesByCallId.get(callId);
        const toolName = tracked?.toolName ?? "unknown";
        const writes = tracked?.writes ?? isWriteOrShellToolName(toolName);
        const isError = event.status === "error" || event.error !== undefined;
        input.onToolEvent?.({
          event: "completed",
          callId,
          toolName,
          result: event.result ?? event.error,
          isError,
          writes,
        });
        return;
      }
      if (type === "status") {
        if (event.phase === "step_end") {
          const usage = asObject(event.usage);
          if (usage) {
            const inTok = Number(usage.inputTokens ?? 0);
            const outTok = Number(usage.outputTokens ?? 0);
            const cacheR = Number(usage.cacheReadTokens ?? 0);
            const cacheW = Number(usage.cacheWriteTokens ?? 0);
            const reasTok = Number(usage.reasoningTokens ?? 0);
            const totTok = Number(usage.totalTokens ?? (inTok + outTok + cacheR + cacheW));
            if (Number.isFinite(totTok) && totTok > 0) {
              sawUsage = true;
              totalInputTokens += Number.isFinite(inTok) && inTok > 0 ? inTok : 0;
              totalOutputTokens += Number.isFinite(outTok) && outTok > 0 ? outTok : 0;
              totalCacheReadTokens += Number.isFinite(cacheR) && cacheR > 0 ? cacheR : 0;
              totalCacheWriteTokens += Number.isFinite(cacheW) && cacheW > 0 ? cacheW : 0;
              totalReasoningTokens += Number.isFinite(reasTok) && reasTok > 0 ? reasTok : 0;
              totalTokensSum += totTok;
            }
          }
        } else if (event.phase === "turn_end") {
          const reason = asObject(event.reason);
          if (reason?.kind === "error") {
            const errObj = asObject(reason.error);
            terminalError = {
              ...(typeof errObj?.code === "string" ? { code: errObj.code } : {}),
              message: typeof errObj?.message === "string" ? errObj.message : "DeepSeek Harness turn failed",
            };
          }
        }
        return;
      }
      if (type === "final") {
        if (typeof event.sessionId === "string" && event.sessionId.trim()) {
          sessionId = event.sessionId.trim();
        }
        if (typeof event.text === "string") {
          finalText = event.text;
        }
        const reason = asObject(event.reason);
        if (reason?.kind === "error") {
          const errObj = asObject(reason.error);
          terminalError = {
            ...(typeof errObj?.code === "string" ? { code: errObj.code } : {}),
            message: typeof errObj?.message === "string" ? errObj.message : "DeepSeek Harness run failed",
          };
        }
      }
    };

    child.stdout.on("data", (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > this.maxOutputBytes) {
        outputError = Error(`DeepSeek Harness output exceeded ${this.maxOutputBytes} bytes`);
        killProcessTree(child);
        return;
      }
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleRecord(line);
        idx = buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 32_768) stderr += chunk.slice(0, 32_768 - stderr.length);
    });

    return await new Promise<DeepSeekHarnessTurnResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      const cleanupPatch = () => {
        try {
          if (existsSync(patchPath)) rmSync(patchPath, { force: true });
        } catch {}
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        cleanupPatch();
        fn();
      };

      const onAbort = () => {
        killProcessTree(child);
        finish(() => {
          rejectPromise(
            Object.assign(Error("DeepSeek Harness task aborted"), {
              sideEffectToolObserved,
            }),
          );
        });
      };

      input.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            killProcessTree(child);
            finish(() => {
              rejectPromise(
                Object.assign(Error(`DeepSeek Harness turn timed out after ${input.timeoutMs}ms`), {
                  code: "MODEL_TIMEOUT",
                  sideEffectToolObserved,
                }),
              );
            });
          }, input.timeoutMs)
        : undefined;
      timer?.unref?.();

      child.on("error", (error) => {
        finish(() => {
          rejectPromise(Object.assign(error, { sideEffectToolObserved }));
        });
      });

      child.on("close", (code, signal) => {
        if (buffer.trim()) {
          handleRecord(buffer);
          buffer = "";
        }
        finish(() => {
          if (boundaryError) {
            rejectPromise(Object.assign(boundaryError, { sideEffectToolObserved }));
            return;
          }
          if (outputError) {
            rejectPromise(Object.assign(outputError, { sideEffectToolObserved }));
            return;
          }
          if (terminalError || code !== 0) {
            const detail = terminalError
              ? `${terminalError.code ? `${terminalError.code}: ` : ""}${terminalError.message}`
              : (stderr.trim() || `dsh exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
            const err = Error(`DeepSeek Harness turn failed: ${detail}`) as Error & {
              code?: string;
              sideEffectToolObserved?: boolean;
            };
            if (/429|rate.?limit/i.test(detail)) err.code = "PROVIDER_RATE_LIMIT";
            else if (/quota|insufficient|balance|credit|ACCOUNT_QUOTA_EXCEEDED|QUOTA_EXCEEDED/i.test(detail)) err.code = "PROVIDER_QUOTA";
            else if (/timeout|timed out|ETIMEDOUT/i.test(detail)) err.code = "MODEL_TIMEOUT";
            err.sideEffectToolObserved = sideEffectToolObserved;
            rejectPromise(err);
            return;
          }
          const resolvedText = (finalText ?? accumulatedText).trim();
          if (!resolvedText) {
            rejectPromise(
              Object.assign(Error("DeepSeek Harness completed without an assistant response"), {
                sideEffectToolObserved,
              }),
            );
            return;
          }
          if (!sessionId) {
            rejectPromise(
              Object.assign(Error("DeepSeek Harness completed without reporting a sessionId"), {
                sideEffectToolObserved,
              }),
            );
            return;
          }
          resolvePromise({
            sessionId,
            text: resolvedText,
            authRoute,
            ...(sawUsage
              ? {
                  usage: {
                    inputTokens: totalInputTokens,
                    cachedInputTokens: totalCacheReadTokens,
                    cacheWriteInputTokens: totalCacheWriteTokens,
                    outputTokens: totalOutputTokens,
                    reasoningOutputTokens: totalReasoningTokens,
                    totalTokens: totalTokensSum,
                  },
                }
              : {}),
            sideEffectToolObserved,
          });
        });
      });
    });
  }
}
