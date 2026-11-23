import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { killProcessTree } from "./process-tree.js";
import {
  assertToolArgumentsWithinWorkspace,
  isWriteOrShellToolName,
  resolvePhysicalDirectory,
  WorkspaceBoundaryError,
} from "./workspace-confinement.js";

export type AntigravityCliMode = "plan" | "accept-edits";

export interface AntigravityToolEvent {
  event: "started" | "completed";
  callId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  writes: boolean;
}

export interface AntigravityUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface AntigravityTurnInput {
  cwd: string;
  prompt: string;
  modelId: string;
  sessionId?: string | null;
  /** When true, runs with `--mode plan --sandbox` and blocks any write/shell tool.
   * When false, runs with `--mode accept-edits --sandbox` (never `--dangerously-skip-permissions`). */
  readOnly?: boolean;
  /** Additional directories explicitly allowed via `--add-dir` (e.g. git common dir for worktrees). */
  additionalAllowedDirs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: AntigravityToolEvent) => void;
}

export interface AntigravityTurnResult {
  text: string;
  sessionId: string | null;
  usage: AntigravityUsage;
  toolEvents: AntigravityToolEvent[];
}

export interface AntigravityClientOptions {
  /** Override `agy` CLI executable path. */
  executablePath?: string;
  /** Optional arguments prepended before `agy` CLI flags (useful for test harnesses). */
  argsPrefix?: string[];
  /** Override `~/.gemini` home directory (CLI state lives under `<geminiHome>/antigravity-cli`,
   * strictly isolated from Desktop Antigravity's `<geminiHome>/antigravity`). */
  geminiHome?: string;
  /** Override T3 userdata directory (`~/.t3/userdata`) for inspecting T3-managed Antigravity CLI profiles. */
  t3UserDataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AntigravityCliInstallationStatus {
  runtimeInstalled: boolean;
  executablePath: string | null;
  authenticated: boolean;
  authSource: "antigravity-cli-account" | "none";
  cliStateDir: string;
  profileDirs: string[];
}

/**
 * Environment variables that could cause Google / Gemini tools to use API key billing.
 * Durable Pi strips all of these before launching Antigravity CLI so only the CLI's own
 * Google account OAuth session is ever used.
 */
export const FORBIDDEN_GEMINI_API_KEY_ENV_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
] as const;

export function buildOAuthOnlyAntigravityEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };
  const forbiddenUpper = new Set<string>(FORBIDDEN_GEMINI_API_KEY_ENV_VARS);
  for (const key of Object.keys(merged)) {
    if (forbiddenUpper.has(key.toUpperCase())) {
      delete merged[key];
    }
  }
  return merged;
}

export function resolveGeminiHomeDir(
  explicitGeminiHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = explicitGeminiHome?.trim() || env.DPI_GEMINI_HOME?.trim() || env.GEMINI_HOME?.trim();
  return raw ? resolve(raw) : join(homedir(), ".gemini");
}

export function resolveT3UserDataDir(
  explicitT3Dir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = explicitT3Dir?.trim() || env.DPI_T3_USERDATA_DIR?.trim();
  return raw ? resolve(raw) : join(homedir(), ".t3", "userdata");
}

/**
 * Locate the standalone Antigravity CLI (`agy.exe` / `agy`), strictly separate from
 * Desktop Antigravity (`Antigravity.exe` / `language_server.exe`).
 */
export function findAntigravityCliExecutable(
  env: NodeJS.ProcessEnv = process.env,
  explicitT3Dir?: string,
): string | null {
  const explicit = env.DPI_ANTIGRAVITY_CLI_BIN?.trim() || env.DPI_ANTIGRAVITY_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const isWin = process.platform === "win32";
  const exeName = isWin ? "agy.exe" : "agy";

  // 1. User-local bin (e.g. ~/.local/bin/agy.exe)
  const localBinCandidate = join(homedir(), ".local", "bin", exeName);
  if (existsSync(localBinCandidate)) return localBinCandidate;

  // 2. T3-managed Antigravity ACP/CLI runtime under ~/.t3/userdata/tools/antigravity-acp/<platform>-<arch>
  const t3UserData = resolveT3UserDataDir(explicitT3Dir, env);
  const managedRoot = join(t3UserData, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const activeJson = join(managedRoot, "active.json");
  if (existsSync(activeJson)) {
    try {
      const parsed = JSON.parse(readFileSync(activeJson, "utf8")) as { releaseId?: string };
      if (typeof parsed.releaseId === "string" && parsed.releaseId.trim()) {
        const candidate = join(managedRoot, "versions", parsed.releaseId.trim(), isWin ? "agy.exe" : "antigravity");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore malformed active.json
    }
  }

  // 3. PATH lookup for `agy`
  const pathDirs = (env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const binNames = isWin ? ["agy.exe", "agy.cmd"] : ["agy"];
  for (const dir of pathDirs) {
    for (const name of binNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function hasValidOAuthTokenFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return (
      (typeof parsed.refresh_token === "string" && parsed.refresh_token.trim().length > 0) ||
      (typeof parsed.access_token === "string" && parsed.access_token.trim().length > 0)
    );
  } catch {
    return false;
  }
}

/**
 * Collect all Antigravity CLI / T3 Antigravity profile directories.
 * Strictly excludes Desktop Antigravity (`~/.gemini/antigravity`) so the CLI/T3 account
 * never shares credentials or conversation history with the Desktop Antigravity account.
 */
export function listAntigravityCliProfileDirs(
  explicitGeminiHome?: string,
  explicitT3Dir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const geminiHome = resolveGeminiHomeDir(explicitGeminiHome, env);
  const t3UserData = resolveT3UserDataDir(explicitT3Dir, env);
  const dirs: string[] = [];

  const cliDir = join(geminiHome, "antigravity-cli");
  dirs.push(cliDir);

  const acpDir = join(geminiHome, "antigravity-acp");
  if (existsSync(acpDir)) dirs.push(acpDir);

  const t3ProvidersRoot = join(t3UserData, "providers", "antigravity");
  if (existsSync(t3ProvidersRoot)) {
    try {
      for (const entry of readdirSync(t3ProvidersRoot)) {
        const acpSub = join(t3ProvidersRoot, entry, "antigravity-acp");
        if (existsSync(acpSub)) dirs.push(acpSub);
      }
    } catch {
      // ignore unreadable directory
    }
  }
  return dirs;
}

/**
 * Inspect Antigravity CLI / T3 Antigravity installation and authentication state.
 * Never reads Desktop Antigravity (`~/.gemini/antigravity`).
 */
export function inspectAntigravityCliInstallation(
  explicitGeminiHome?: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitT3Dir?: string,
): AntigravityCliInstallationStatus {
  const geminiHome = resolveGeminiHomeDir(explicitGeminiHome, env);
  const cliStateDir = join(geminiHome, "antigravity-cli");
  const executablePath = findAntigravityCliExecutable(env, explicitT3Dir);
  const runtimeInstalled = executablePath !== null;
  const profileDirs = listAntigravityCliProfileDirs(geminiHome, explicitT3Dir, env);

  let authenticated = false;
  for (const dir of profileDirs) {
    if (
      hasValidOAuthTokenFile(join(dir, "acp_token.json")) ||
      hasValidOAuthTokenFile(join(dir, "oauth_creds.json")) ||
      hasValidOAuthTokenFile(join(dir, "credentials.json"))
    ) {
      authenticated = true;
      break;
    }
    const convDir = join(dir, "conversations");
    if (existsSync(convDir)) {
      try {
        if (readdirSync(convDir).some((name) => name.endsWith(".db"))) {
          authenticated = true;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    runtimeInstalled,
    executablePath,
    authenticated,
    authSource: authenticated ? "antigravity-cli-account" : "none",
    cliStateDir,
    profileDirs,
  };
}

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export class AntigravityClient {
  private readonly executablePath: string;
  private readonly argsPrefix: string[];
  private readonly geminiHome: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options?: AntigravityClientOptions) {
    this.env = options?.env ?? process.env;
    this.geminiHome = resolveGeminiHomeDir(options?.geminiHome, this.env);
    const resolved =
      options?.executablePath?.trim() ||
      findAntigravityCliExecutable(this.env, options?.t3UserDataDir);
    if (!resolved) {
      throw new Error(
        "Google Antigravity CLI (agy) not found. Install agy (e.g. ~/.local/bin/agy.exe) or set DPI_ANTIGRAVITY_CLI_BIN.",
      );
    }
    this.executablePath = resolved;
    this.argsPrefix = options?.argsPrefix ?? [];
  }

  async runTurn(input: AntigravityTurnInput): Promise<AntigravityTurnResult> {
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
      throw new Error(`Antigravity CLI working directory does not exist: ${input.cwd}`);
    }
    const physicalCwd = resolvePhysicalDirectory(input.cwd);
    const readOnly = input.readOnly ?? true;
    const mode: AntigravityCliMode = readOnly ? "plan" : "accept-edits";
    const additionalAllowedDirs = (input.additionalAllowedDirs ?? [])
      .filter((dir) => typeof dir === "string" && dir.trim().length > 0)
      .map((dir) => resolvePhysicalDirectory(dir));

    const bareModel = input.modelId.replace(/^google\//i, "").trim();
    if (!bareModel || !/^[a-zA-Z0-9._-]+$/.test(bareModel)) {
      throw new Error(`Invalid Antigravity model identifier: ${input.modelId}`);
    }

    const args: string[] = [
      ...this.argsPrefix,
      "--print",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--sandbox",
      "--mode",
      mode,
      "--model",
      bareModel,
    ];
    for (const extraDir of additionalAllowedDirs) {
      args.push("--add-dir", extraDir);
    }
    const existingSessionId = input.sessionId?.trim() || null;
    if (existingSessionId) {
      args.push("--conversation", existingSessionId);
    }
    args.push(input.prompt);

    const childEnv = buildOAuthOnlyAntigravityEnv(this.env, {
      GEMINI_HOME: this.geminiHome,
    });

    return await new Promise<AntigravityTurnResult>((resolveTurn, rejectTurn) => {
      const child = spawn(this.executablePath, args, {
        cwd: physicalCwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
      child.stdin.end();

      let settled = false;
      let stdoutBuf = "";
      let stderrText = "";
      let sessionId: string | null = existingSessionId;
      let finalText = "";
      let streamedText = "";
      let sideEffectToolObserved = false;
      let timer: NodeJS.Timeout | null = null;
      const toolEvents: AntigravityToolEvent[] = [];
      const activeToolNames = new Map<string, { toolName: string; writes: boolean }>();

      const usage: AntigravityUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      };

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (input.signal) {
          input.signal.removeEventListener("abort", onAbort);
        }
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        killProcessTree(child);
        if (sideEffectToolObserved) {
          (err as { sideEffectToolObserved?: boolean }).sideEffectToolObserved = true;
        }
        rejectTurn(err);
      };

      const onAbort = () => {
        fail(new Error("Antigravity CLI turn aborted by signal."));
      };

      if (input.signal) {
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (input.timeoutMs && input.timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new Error(`Antigravity CLI timed out after ${input.timeoutMs}ms.`));
        }, input.timeoutMs);
      }

      const handleJsonLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) return;
        let obj: JsonObject | undefined;
        try {
          obj = asObject(JSON.parse(trimmed));
        } catch {
          return;
        }
        if (!obj) return;

        const cid =
          (typeof obj.conversation_id === "string" && obj.conversation_id.trim()) ||
          (typeof obj.conversationId === "string" && obj.conversationId.trim()) ||
          (typeof obj.session_id === "string" && obj.session_id.trim()) ||
          (typeof obj.sessionId === "string" && obj.sessionId.trim()) ||
          "";
        if (cid) sessionId = cid;

        const eventType = typeof obj.type === "string" ? obj.type.toLowerCase() : "";

        if (eventType === "tool_use" || eventType === "tool_call") {
          const toolName =
            (typeof obj.tool_name === "string" && obj.tool_name) ||
            (typeof obj.name === "string" && obj.name) ||
            "tool";
          const callId =
            (typeof obj.tool_id === "string" && obj.tool_id) ||
            (typeof obj.call_id === "string" && obj.call_id) ||
            (typeof obj.id === "string" && obj.id) ||
            `agy-call-${toolEvents.length + 1}`;
          const toolArgs = obj.parameters ?? obj.args ?? obj.input ?? {};
          const writes = isWriteOrShellToolName(toolName);

          try {
            assertToolArgumentsWithinWorkspace({
              cwd: physicalCwd,
              additionalAllowedDirs,
              readOnly,
              allowShellInWriteMode: false,
              toolName,
              args: toolArgs,
            });
          } catch (err) {
            const boundaryErr =
              err instanceof WorkspaceBoundaryError
                ? err
                : new WorkspaceBoundaryError(
                    "WORKSPACE_PATH_ESCAPE",
                    err instanceof Error ? err.message : String(err),
                  );
            const errorStart: AntigravityToolEvent = {
              event: "started",
              callId,
              toolName,
              args: toolArgs,
              writes,
            };
            const errorEnd: AntigravityToolEvent = {
              event: "completed",
              callId,
              toolName,
              args: toolArgs,
              result: boundaryErr.message,
              isError: true,
              writes,
            };
            toolEvents.push(errorStart, errorEnd);
            input.onToolEvent?.(errorStart);
            input.onToolEvent?.(errorEnd);
            fail(boundaryErr);
            return;
          }

          if (writes) sideEffectToolObserved = true;
          activeToolNames.set(callId, { toolName, writes });
          const startEvent: AntigravityToolEvent = {
            event: "started",
            callId,
            toolName,
            args: toolArgs,
            writes,
          };
          toolEvents.push(startEvent);
          input.onToolEvent?.(startEvent);
          return;
        }

        if (eventType === "tool_result") {
          const callId =
            (typeof obj.tool_id === "string" && obj.tool_id) ||
            (typeof obj.call_id === "string" && obj.call_id) ||
            (typeof obj.id === "string" && obj.id) ||
            `agy-call-${toolEvents.length + 1}`;
          const meta = activeToolNames.get(callId);
          const toolName =
            meta?.toolName ||
            (typeof obj.tool_name === "string" && obj.tool_name) ||
            "tool";
          const writes = meta?.writes ?? isWriteOrShellToolName(toolName);
          const isError =
            obj.status === "error" || obj.is_error === true || obj.isError === true;
          const endEvent: AntigravityToolEvent = {
            event: "completed",
            callId,
            toolName,
            result: obj.output ?? obj.result ?? obj.content ?? "",
            isError,
            writes,
          };
          toolEvents.push(endEvent);
          input.onToolEvent?.(endEvent);
          return;
        }

        if (eventType === "message" || eventType === "assistant" || eventType === "content_block_delta") {
          const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "assistant";
          if (role === "assistant" || eventType === "assistant" || eventType === "content_block_delta") {
            const delta =
              typeof obj.content === "string"
                ? obj.content
                : typeof obj.text === "string"
                  ? obj.text
                  : typeof obj.delta === "string"
                    ? obj.delta
                    : "";
            if (delta) {
              streamedText += delta;
              input.onTextDelta?.(delta);
            }
          }
          return;
        }

        if (eventType === "result") {
          if (obj.status === "error" || obj.is_error === true) {
            const msg =
              (typeof obj.error === "string" && obj.error) ||
              (typeof obj.message === "string" && obj.message) ||
              "Antigravity CLI returned an error result.";
            fail(new Error(msg));
            return;
          }
          if (typeof obj.result === "string" && obj.result.trim()) {
            finalText = obj.result.trim();
          } else if (typeof obj.content === "string" && obj.content.trim()) {
            finalText = obj.content.trim();
          }
          const stats = asObject(obj.stats) ?? asObject(obj.usage);
          if (stats) {
            usage.inputTokens = asNumber(stats.input_tokens ?? stats.inputTokens);
            usage.cachedInputTokens = asNumber(stats.cached_tokens ?? stats.cachedInputTokens ?? stats.cache_read_tokens);
            usage.cacheWriteInputTokens = asNumber(stats.cache_write_tokens ?? stats.cacheWriteInputTokens);
            usage.outputTokens = asNumber(stats.output_tokens ?? stats.outputTokens);
            usage.reasoningOutputTokens = asNumber(stats.reasoning_tokens ?? stats.reasoningOutputTokens);
            usage.totalTokens =
              asNumber(stats.total_tokens ?? stats.totalTokens) ||
              usage.inputTokens + usage.outputTokens + usage.cachedInputTokens;
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        stdoutBuf += chunk;
        let nl = stdoutBuf.indexOf("\n");
        while (nl >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleJsonLine(line);
          if (settled) return;
          nl = stdoutBuf.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });

      child.on("error", (err) => {
        fail(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        if (stdoutBuf.trim()) {
          handleJsonLine(stdoutBuf);
          stdoutBuf = "";
          if (settled) return;
        }
        settled = true;
        cleanup();
        if (code !== 0) {
          const err = new Error(
            `Antigravity CLI exited with code ${code ?? "null"}${stderrText.trim() ? `: ${stderrText.trim().slice(0, 600)}` : ""}`,
          );
          if (sideEffectToolObserved) {
            (err as { sideEffectToolObserved?: boolean }).sideEffectToolObserved = true;
          }
          rejectTurn(err);
          return;
        }
        resolveTurn({
          text: (finalText || streamedText).trim(),
          sessionId,
          usage,
          toolEvents,
        });
      });
    });
  }
}
