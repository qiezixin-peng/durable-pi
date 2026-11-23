import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { ReadOnlyDataSourceCatalog, type DataSourceDefinition } from "./data-sources.js";

export interface RemoteSshExecInput {
  sshHost: string;
  remotePlatform?: "posix" | "windows";
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RemoteSshExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RemoteSshExecutor = (input: RemoteSshExecInput) => Promise<RemoteSshExecResult>;

export interface RemoteWriteFileInput {
  projectId: string;
  sourceId: string;
  path: string;
  content: string;
  expectedSha256?: string;
  createDirs?: boolean;
}

export interface RemoteWriteFileResult {
  sourceId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  created: boolean;
}

export interface RemotePatchHunk {
  target: string;
  replacement: string;
  replaceAll?: boolean;
}

export interface RemoteApplyPatchInput {
  projectId: string;
  sourceId: string;
  path: string;
  edits: RemotePatchHunk[];
  expectedSha256?: string;
}

export interface RemoteApplyPatchResult {
  sourceId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  replacementsApplied: number;
}

export interface RemoteRunCommandInput {
  projectId: string;
  sourceId: string;
  cwd?: string;
  command: string;
  readOnly: boolean;
  timeoutMs?: number;
}

export interface RemoteRunCommandResult {
  sourceId: string;
  cwd: string;
  command: string;
  readOnly: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export class RemoteCommandPolicyError extends Error {
  readonly code = "REMOTE_COMMAND_POLICY_VIOLATION";

  constructor(message: string) {
    super(message);
    this.name = "RemoteCommandPolicyError";
  }
}

const MAX_REMOTE_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_COMMAND_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_REMOTE_COMMAND_TIMEOUT_MS = 60_000;
const MAX_REMOTE_COMMAND_TIMEOUT_MS = 300_000;

const BLOCKED_REMOTE_DIR_NAMES = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store",
  ".config", ".local", ".cache", ".var", "library", ".trash", ".git", ".dpi", ".durable-pi", ".pi",
  ".agents", ".codex-leader", ".codex", ".t3", ".claude",
  ".anthropic", ".openai", ".grok", ".gemini", ".cursor", ".vscode", ".continue",
  ".aider", ".oci", ".digitalocean", ".terraform.d", ".pulumi",
] as const;

const SENSITIVE_REMOTE_FILE_NAMES = [
  "auth.json", "credentials", "credentials.json", "token.json", "tokens.json", "secrets.json",
  ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".gitconfig",
  ".bash_history", ".zsh_history", ".python_history", ".node_repl_history",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
] as const;

const READ_ONLY_COMMAND_PREFIXES = [
  /^git\s+(status|diff|log|show|branch|rev-parse)\b/,
  /^ls(\s|$)/,
  /^pwd$/,
  /^cat\s+/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^which\s+/,
  /^node\s+(-v|--version)$/,
  /^npm\s+(-v|--version)$/,
  /^python3?\s+--version$/,
  /^pytest\s+--collect-only(\s|$)/,
  /^cargo\s+--version$/,
] as const;

const DANGEROUS_COMMAND_PATTERNS = [
  /(^|\s)sudo\b/i,
  /(^|\s)su(\s|$)/i,
  /(^|\s)passwd\b/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$|\*)/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /(^|\s)(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bchown\s+-R\s+.*\s+\//i,
  /(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,
  /(~|\/home\/[^/\s]+|\/root)\/\.ssh\b/i,
  /\/etc\/(shadow|sudoers)\b/i,
  /\bSSH_AUTH_SOCK\b/,
] as const;

const SHELL_META_REGEX = /[;&|`$><\r\n]/;

export function evaluateRemoteCommandPolicy(command: string, readOnly: boolean): void {
  const trimmed = command.trim();
  if (!trimmed) throw new RemoteCommandPolicyError("Remote command must not be empty");
  if (trimmed.length > 2_000) throw new RemoteCommandPolicyError("Remote command exceeds 2000 characters");
  if (trimmed.includes("\0")) throw new RemoteCommandPolicyError("Remote command must not contain NUL bytes");

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new RemoteCommandPolicyError(`Blocked dangerous remote command matching ${pattern.source}`);
    }
  }

  if (readOnly) {
    if (SHELL_META_REGEX.test(trimmed)) {
      throw new RemoteCommandPolicyError("Read-only mode forbids shell chaining or redirection characters");
    }
    const allowed = READ_ONLY_COMMAND_PREFIXES.some((prefix) => prefix.test(trimmed));
    if (!allowed) {
      throw new RemoteCommandPolicyError(
        `Read-only mode forbids remote command "${trimmed}". Only safe read-only inspection commands (e.g. git status/diff/log, ls, cat, head, tail) are allowed.`,
      );
    }
  }
}

function normalizeRelativeRemotePath(raw: string, allowEmpty = false): string {
  if (typeof raw !== "string" || raw.length > 2_000 || raw.includes("\0")) {
    throw Error("Invalid remote workspace path");
  }
  const clean = raw.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!clean) {
    if (allowEmpty) return "";
    throw Error("Remote file path must not be empty");
  }
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    throw Error("Remote workspace path must be relative to the bound source root");
  }
  const parts = clean.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw Error("Remote workspace path cannot escape its configured root");
  }
  return parts.join("/");
}

function assertNotSensitiveRelativePath(relPath: string): void {
  const parts = relPath.split("/").filter(Boolean).map((p) => p.toLowerCase());
  const blockedDirs = new Set<string>(BLOCKED_REMOTE_DIR_NAMES);
  const sensitiveFiles = new Set<string>(SENSITIVE_REMOTE_FILE_NAMES);
  if (parts.some((part) => blockedDirs.has(part))) {
    throw Error(`Access to protected directory in "${relPath}" is forbidden`);
  }
  const leaf = parts.at(-1);
  if (
    leaf &&
    (leaf === ".env" ||
      leaf.startsWith(".env.") ||
      sensitiveFiles.has(leaf) ||
      [".pem", ".p12", ".pfx", ".key"].some((ext) => leaf.endsWith(ext)))
  ) {
    throw Error(`Access to sensitive credential file "${relPath}" is forbidden`);
  }
}

function isPathInsideGrant(relPath: string, grantedFolders: readonly string[]): boolean {
  if (grantedFolders.length === 0) return false;
  for (const rawFolder of grantedFolders) {
    const folder = rawFolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!folder) return true; // empty grant means entire source root
    if (relPath === folder || relPath.startsWith(`${folder}/`)) return true;
  }
  return false;
}

export function buildHardenedSshArgs(sshHost: string, remoteCommand: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    sshHost,
    remoteCommand,
  ];
}

export const REMOTE_WORKSPACE_HELPER = String.raw`
import base64,hashlib,json,os,subprocess,sys,tempfile
p=json.loads(base64.urlsafe_b64decode(sys.argv[1]+'===').decode())
root=os.path.realpath(p['root'])
blocked_dirs=set(${JSON.stringify(BLOCKED_REMOTE_DIR_NAMES)})
sensitive_files=set(${JSON.stringify(SENSITIVE_REMOTE_FILE_NAMES)})
def check_parts(parts):
    low=[x.casefold() for x in parts]
    if any(x in blocked_dirs for x in low): raise ValueError('protected directory forbidden')
    if low:
        leaf=low[-1]
        if leaf=='.env' or leaf.startswith('.env.') or leaf in sensitive_files or leaf.endswith(('.pem','.p12','.pfx','.key')):
            raise ValueError('sensitive file forbidden')
def resolve_confined(rel, allow_missing=False):
    rel=(rel or '').replace('\\','/').strip('/')
    parts=[x for x in rel.split('/') if x and x!='.']
    if any(x=='..' for x in parts): raise ValueError('path escape forbidden')
    if parts: check_parts(parts)
    cur=root
    for idx,seg in enumerate(parts):
        nxt=os.path.join(cur,seg)
        if os.path.islink(nxt): raise ValueError('symlink forbidden')
        if not os.path.exists(nxt):
            if not allow_missing: raise FileNotFoundError(rel)
            real_cur=os.path.realpath(cur)
            if os.path.commonpath([root,real_cur])!=root: raise ValueError('ancestor escape')
            return os.path.join(real_cur,*parts[idx:])
        cur=nxt
    real_t=os.path.realpath(cur)
    if os.path.commonpath([root,real_t])!=root: raise ValueError('target escape')
    return real_t
op=p['op']
if op=='write_file':
    t=resolve_confined(p['path'], allow_missing=True)
    parent=os.path.dirname(t)
    if not os.path.exists(parent):
        if p.get('createDirs', True): os.makedirs(parent, exist_ok=True)
        else: raise FileNotFoundError('parent directory missing')
    if os.path.isdir(t): raise IsADirectoryError('target is directory')
    existed=os.path.exists(t)
    exp=p.get('expectedSha256')
    if exp:
        if not existed: raise ValueError('expectedSha256 provided but file does not exist')
        cur_sha=hashlib.sha256(open(t,'rb').read()).hexdigest()
        if cur_sha!=exp: raise ValueError(f'sha256 mismatch: expected {exp}, got {cur_sha}')
    data=p['content'].encode('utf-8')
    fd,tmp=tempfile.mkstemp(prefix='.dpi-tmp-',dir=parent)
    try:
        with os.fdopen(fd,'wb') as f: f.write(data)
        os.replace(tmp,t)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(json.dumps({'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'created':not existed}))
elif op=='apply_patch':
    t=resolve_confined(p['path'], allow_missing=False)
    if not os.path.isfile(t): raise FileNotFoundError(p['path'])
    raw=open(t,'rb').read()
    exp=p.get('expectedSha256')
    if exp:
        cur_sha=hashlib.sha256(raw).hexdigest()
        if cur_sha!=exp: raise ValueError(f'sha256 mismatch: expected {exp}, got {cur_sha}')
    text=raw.decode('utf-8')
    applied=0
    for h in p['edits']:
        tgt=h['target']
        rep=h['replacement']
        if tgt not in text: raise ValueError('patch target not found: '+tgt[:80])
        if h.get('replaceAll'):
            cnt=text.count(tgt)
            text=text.replace(tgt,rep)
            applied+=cnt
        else:
            text=text.replace(tgt,rep,1)
            applied+=1
    data=text.encode('utf-8')
    fd,tmp=tempfile.mkstemp(prefix='.dpi-tmp-',dir=os.path.dirname(t))
    try:
        with os.fdopen(fd,'wb') as f: f.write(data)
        os.replace(tmp,t)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(json.dumps({'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'replacementsApplied':applied}))
elif op=='run_command':
    cwd=resolve_confined(p.get('cwd',''), allow_missing=False)
    if not os.path.isdir(cwd): raise NotADirectoryError('cwd is not a directory')
    env=dict(os.environ)
    env.pop('SSH_AUTH_SOCK', None)
    max_bytes=int(p.get('maxOutputBytes', 262144))
    timeout_sec=max(1.0, float(p.get('timeoutMs', 60000))/1000.0)
    try:
        proc=subprocess.run(p['command'], shell=True, cwd=cwd, env=env, capture_output=True, timeout=timeout_sec)
        out=proc.stdout[:max_bytes]
        err=proc.stderr[:max_bytes]
        trunc=len(proc.stdout)>max_bytes or len(proc.stderr)>max_bytes
        print(json.dumps({'exitCode':proc.returncode,'timedOut':False,'stdout':out.decode('utf-8','replace'),'stderr':err.decode('utf-8','replace'),'truncated':trunc}))
    except subprocess.TimeoutExpired as exc:
        out=(exc.stdout or b'')[:max_bytes]
        err=(exc.stderr or b'')[:max_bytes]
        print(json.dumps({'exitCode':-1,'timedOut':True,'stdout':out.decode('utf-8','replace'),'stderr':err.decode('utf-8','replace'),'truncated':True}))
else:
    raise ValueError('unknown op')
`;

const REMOTE_WORKSPACE_HELPER_BASE64 = gzipSync(Buffer.from(REMOTE_WORKSPACE_HELPER, "utf8")).toString("base64");

async function defaultSshExecutor(input: RemoteSshExecInput): Promise<RemoteSshExecResult> {
  const args = buildHardenedSshArgs(input.sshHost, input.command);
  return await new Promise<RemoteSshExecResult>((resolveExec, rejectExec) => {
    const child = spawn("ssh", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < input.maxOutputBytes) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < input.maxOutputBytes) {
        stderr += chunk.toString("utf8");
      }
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectExec(new Error(`Remote SSH transport failed: ${err.message}`));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExec({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export function buildRemoteWorkspacePythonCommand(
  remotePlatform: "posix" | "windows" | undefined,
  payloadBase64Url: string,
): string {
  const interpreter = remotePlatform === "windows" ? "py.exe -3 -X utf8" : "python3";
  const arg = remotePlatform === "windows" ? payloadBase64Url : `'${payloadBase64Url}'`;
  return `${interpreter} -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${REMOTE_WORKSPACE_HELPER_BASE64}'),31))" ${arg}`;
}

export class RemoteSshWorkspaceClient {
  private readonly catalogPath: string;
  private readonly sshExecutor: RemoteSshExecutor;

  constructor(options: { catalogPath: string; sshExecutor?: RemoteSshExecutor }) {
    this.catalogPath = options.catalogPath;
    this.sshExecutor = options.sshExecutor ?? defaultSshExecutor;
  }

  private resolveAuthorizedRemoteSource(
    projectId: string,
    sourceId: string,
    relPath: string,
  ): DataSourceDefinition {
    const catalog = new ReadOnlyDataSourceCatalog(this.catalogPath);
    const source = catalog.list(projectId).find((item) => item.id === sourceId);
    if (!source) {
      throw new Error(`Data source "${sourceId}" is not found or not bound to project "${projectId}"`);
    }
    if (!source.sshHost || !source.remoteRoot) {
      throw new Error(`Data source "${sourceId}" does not have an SSH remoteRoot configured`);
    }
    const grantedFolders = source.folders ?? [];
    if (!isPathInsideGrant(relPath, grantedFolders)) {
      throw new Error(
        `Path "${relPath || "."}" is outside the project's granted remote folders for "${sourceId}"`,
      );
    }
    return source;
  }

  private async invokeRemote(
    source: DataSourceDefinition,
    op: string,
    payloadBody: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const payload = Buffer.from(
      JSON.stringify({ op, root: source.remoteRoot, ...payloadBody }),
      "utf8",
    ).toString("base64url");
    const command = buildRemoteWorkspacePythonCommand(source.remotePlatform, payload);
    const res = await this.sshExecutor({
      sshHost: source.sshHost!,
      remotePlatform: source.remotePlatform,
      command,
      timeoutMs,
      maxOutputBytes: MAX_REMOTE_COMMAND_OUTPUT_BYTES * 2,
    });
    if (res.timedOut) {
      throw new Error(`Remote SSH ${op} timed out after ${timeoutMs}ms`);
    }
    if (res.exitCode !== 0) {
      const detail =
        res.stderr
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1)
          ?.slice(0, 500) || "remote helper failed";
      throw new Error(`Remote SSH ${op} failed: ${detail}`);
    }
    try {
      return JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`Remote SSH ${op} returned invalid JSON`);
    }
  }

  async writeFile(input: RemoteWriteFileInput): Promise<RemoteWriteFileResult> {
    const relPath = normalizeRelativeRemotePath(input.path, false);
    assertNotSensitiveRelativePath(relPath);
    if (Buffer.byteLength(input.content, "utf8") > MAX_REMOTE_WRITE_BYTES) {
      throw new Error(`Remote file content exceeds ${MAX_REMOTE_WRITE_BYTES} bytes limit`);
    }
    const source = this.resolveAuthorizedRemoteSource(input.projectId, input.sourceId, relPath);
    const out = await this.invokeRemote(
      source,
      "write_file",
      {
        path: relPath,
        content: input.content,
        createDirs: input.createDirs ?? true,
        ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
      },
      30_000,
    );
    return {
      sourceId: source.id,
      path: relPath,
      sizeBytes: Number(out.sizeBytes ?? 0),
      sha256: String(out.sha256 ?? createHash("sha256").update(input.content, "utf8").digest("hex")),
      created: Boolean(out.created),
    };
  }

  async applyPatch(input: RemoteApplyPatchInput): Promise<RemoteApplyPatchResult> {
    const relPath = normalizeRelativeRemotePath(input.path, false);
    assertNotSensitiveRelativePath(relPath);
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw new Error("remote_apply_patch requires at least one edit hunk");
    }
    const source = this.resolveAuthorizedRemoteSource(input.projectId, input.sourceId, relPath);
    const out = await this.invokeRemote(
      source,
      "apply_patch",
      {
        path: relPath,
        edits: input.edits,
        ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
      },
      30_000,
    );
    return {
      sourceId: source.id,
      path: relPath,
      sizeBytes: Number(out.sizeBytes ?? 0),
      sha256: String(out.sha256 ?? ""),
      replacementsApplied: Number(out.replacementsApplied ?? 0),
    };
  }

  async runCommand(input: RemoteRunCommandInput): Promise<RemoteRunCommandResult> {
    evaluateRemoteCommandPolicy(input.command, input.readOnly);
    let relCwd = normalizeRelativeRemotePath(input.cwd ?? "", true);
    if (!relCwd) {
      const catalog = new ReadOnlyDataSourceCatalog(this.catalogPath);
      const source = catalog.list(input.projectId).find((item) => item.id === input.sourceId);
      const grantedFolders = source?.folders ?? [];
      if (grantedFolders.length === 1 && grantedFolders[0]) {
        relCwd = normalizeRelativeRemotePath(grantedFolders[0], true);
      }
    }
    if (relCwd) assertNotSensitiveRelativePath(relCwd);
    const source = this.resolveAuthorizedRemoteSource(input.projectId, input.sourceId, relCwd);
    const timeoutMs = Math.min(
      MAX_REMOTE_COMMAND_TIMEOUT_MS,
      Math.max(1_000, input.timeoutMs ?? DEFAULT_REMOTE_COMMAND_TIMEOUT_MS),
    );
    const startedAt = Date.now();
    const out = await this.invokeRemote(
      source,
      "run_command",
      {
        cwd: relCwd,
        command: input.command.trim(),
        timeoutMs,
        maxOutputBytes: MAX_REMOTE_COMMAND_OUTPUT_BYTES,
      },
      timeoutMs + 10_000,
    );
    return {
      sourceId: source.id,
      cwd: relCwd || ".",
      command: input.command.trim(),
      readOnly: input.readOnly,
      exitCode: Number(out.exitCode ?? -1),
      timedOut: Boolean(out.timedOut),
      durationMs: Date.now() - startedAt,
      stdout: String(out.stdout ?? ""),
      stderr: String(out.stderr ?? ""),
      truncated: Boolean(out.truncated),
    };
  }
}
