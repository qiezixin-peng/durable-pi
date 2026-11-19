import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, createReadStream, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

export interface DataSourceDefinition {
  id: string;
  label: string;
  root: string;
  device: string;
  environmentId?: string;
  sshHost?: string;
  remoteRoot?: string;
  remotePlatform?: "posix" | "windows";
  /** Models proven usable through this specific T3 Environment. */
  verifiedModels?: string[];
  projectIds?: string[];
  /** Project-specific folders, relative to this source root. An empty list grants no file access. */
  projectPaths?: Record<string, string[]>;
  readOnly: true;
}

export interface DataSourceCatalogFile {
  version: 1;
  sources: DataSourceDefinition[];
}

export interface DataSourceDirectoryResult {
  sourceId: string;
  path: string;
  entries: Array<{ name: string; kind: "directory" | "file" | "other" }>;
  truncated: boolean;
}

export interface DataSourceTextResult {
  sourceId: string;
  path: string;
  sizeBytes: number;
  returnedBytes: number;
  returnedSha256: string;
  modifiedAtMs: number;
  truncated: boolean;
  text: string;
}

export interface DataSourceSearchResult {
  sourceId: string;
  query: string;
  matches: Array<{ path: string; kind: "file" | "directory" }>;
  visited: number;
  truncated: boolean;
}

export interface DataSourceTextSearchResult {
  sourceId: string;
  query: string;
  path: string;
  matches: Array<{ path: string; line: number; excerpt: string }>;
  filesVisited: number;
  entriesVisited: number;
  truncated: boolean;
}

export interface DataSourceBinaryStream {
  sourceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  content: AsyncIterable<Uint8Array>;
}

const normalized = (value: string) => {
  const path = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

const validId = (value: string) => /^[a-z][a-z0-9-]{0,63}$/.test(value);

const normalizeProjectPath = (value: string) => {
  if (typeof value !== "string" || value.length > 2_000 || value.includes("\0"))
    throw Error("Invalid project data folder");
  const clean = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw Error("Project data folder cannot escape its source root");
  if (sensitiveParts(parts)) throw Error("Sensitive credential paths cannot be granted to a project");
  return parts.join("/");
};

const BLOCKED_DIRECTORY_NAME_VALUES = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store",
  ".config", ".local", ".cache", ".var", "library", ".trash", ".git", ".dpi", ".durable-pi", ".pi",
  ".agents", ".codex-leader", ".codex", ".t3", ".claude",
  ".anthropic", ".openai", ".grok", ".gemini", ".cursor", ".vscode", ".continue",
  ".aider", ".oci", ".digitalocean", ".terraform.d", ".pulumi", ".mozilla",
  ".thunderbird", ".chrome", ".chromium", ".npm", ".yarn", ".pnpm-store", ".cargo",
  ".huggingface", ".ollama",
] as const;
const BLOCKED_DIRECTORY_NAMES = new Set<string>(BLOCKED_DIRECTORY_NAME_VALUES);
const SENSITIVE_FILE_NAME_VALUES = [
  "auth.json", "credentials", "credentials.json", "token.json", "tokens.json", "secrets.json",
  ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".gitconfig",
  ".bash_history", ".zsh_history", ".python_history", ".node_repl_history",
  ".psql_history", ".mysql_history", ".sqlite_history", ".rediscli_history", ".lesshst",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
] as const;
const SENSITIVE_FILE_NAMES = new Set<string>(SENSITIVE_FILE_NAME_VALUES);

const sensitiveParts = (parts: readonly string[]) => {
  const lowered = parts.map((part) => part.toLowerCase());
  if (lowered.some((part) => BLOCKED_DIRECTORY_NAMES.has(part))) return true;
  const leaf = lowered.at(-1);
  return Boolean(leaf && (
    leaf === ".env" || leaf.startsWith(".env.") ||
    SENSITIVE_FILE_NAMES.has(leaf) ||
    [".pem", ".p12", ".pfx", ".key"].some((extension) => leaf.endsWith(extension))
  ));
};

const remoteErrorDetail = (value: string) =>
  value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 500) || "remote command failed";

const REMOTE_HELPER = String.raw`
import base64,hashlib,json,os,stat,sys
p=json.loads(base64.urlsafe_b64decode(sys.argv[1]+'===').decode())
root=os.path.abspath(p['root'])
blocked_dirs=set(${JSON.stringify(BLOCKED_DIRECTORY_NAME_VALUES)})
sensitive_files=set(${JSON.stringify(SENSITIVE_FILE_NAME_VALUES)})
def sensitive(parts):
    lowered=[x.casefold() for x in parts]
    if any(x in blocked_dirs for x in lowered): return True
    if not lowered: return False
    leaf=lowered[-1]
    return leaf=='.env' or leaf.startswith('.env.') or leaf in sensitive_files or leaf.endswith(('.pem','.p12','.pfx','.key'))
def target(rel='', require=False):
    if not isinstance(rel,str) or len(rel)>2000 or '\0' in rel: raise ValueError('invalid path')
    rel=rel.replace('\\','/').strip('/')
    parts=[x for x in rel.split('/') if x and x!='.']
    if require and not parts: raise ValueError('file path required')
    if any(x=='..' for x in parts): raise ValueError('path escape rejected')
    if sensitive(parts): raise ValueError('sensitive credential paths are not exposed')
    value=os.path.abspath(os.path.join(root,*parts))
    if os.path.commonpath([root,value])!=root: raise ValueError('path escape rejected')
    current=root
    for part in parts:
        current=os.path.join(current,part)
        if os.path.lexists(current) and stat.S_ISLNK(os.lstat(current).st_mode): raise ValueError('symbolic links are not followed')
    return value
op=p['op']
if op=='ping':
    out={'reachable':os.path.isdir(root)}
elif op=='list':
    path=target(p.get('path',''))
    limit=p['limit']
    entries=[]
    for entry in sorted(os.scandir(path),key=lambda x:x.name.casefold()):
        if entry.is_symlink(): continue
        if sensitive([entry.name]): continue
        kind='directory' if entry.is_dir(follow_symlinks=False) else 'file' if entry.is_file(follow_symlinks=False) else 'other'
        entries.append({'name':entry.name,'kind':kind})
        if len(entries)>=limit: break
    out={'path':p.get('path',''),'entries':entries,'truncated':len(entries)==limit}
elif op=='read':
    path=target(p['path'],True)
    if not os.path.isfile(path): raise ValueError('path is not a regular file')
    size=os.path.getsize(path); max_bytes=p['maxBytes']
    with open(path,'rb') as f: data=f.read(max_bytes+1)
    if b'\0' in data[:8192]: raise ValueError('binary files cannot be returned as text')
    returned=data[:max_bytes]
    out={'path':p['path'],'sizeBytes':size,'returnedBytes':len(returned),'returnedSha256':hashlib.sha256(returned).hexdigest(),'modifiedAtMs':int(os.path.getmtime(path)*1000),'truncated':size>len(returned),'text':returned.decode('utf-8',errors='replace')}
elif op=='search':
    query=p['query'].casefold(); limit=p['limit']; max_depth=p['maxDepth']
    ignored={'.git','.cache','.cargo','.codex','.npm','.t3','node_modules'} | blocked_dirs
    start=target(p.get('path','')); pending=[(start,0)]; matches=[]; visited=0
    while pending and len(matches)<limit and visited<20000:
        directory,depth=pending.pop(0)
        try: entries=list(os.scandir(directory))
        except OSError: continue
        for entry in entries:
            visited+=1
            if visited>20000 or len(matches)>=limit: break
            if entry.is_symlink(): continue
            rel=os.path.relpath(entry.path,root).replace(os.sep,'/')
            if sensitive(rel.split('/')): continue
            is_dir=entry.is_dir(follow_symlinks=False)
            if query in entry.name.casefold(): matches.append({'path':rel,'kind':'directory' if is_dir else 'file'})
            if is_dir and depth<max_depth and entry.name.casefold() not in ignored: pending.append((entry.path,depth+1))
    out={'query':p['query'],'matches':matches,'visited':visited,'truncated':len(matches)==limit or visited>=20000}
elif op=='search_text':
    query=p['query'].casefold(); limit=p['limit']; max_depth=p['maxDepth']; max_file_bytes=p['maxFileBytes']
    start=target(p.get('path','')); ignored={'.git','.cache','.cargo','.codex','.npm','.t3','node_modules'} | blocked_dirs
    pending=[(start,0)]; matches=[]; files_visited=0; entries_visited=0
    while pending and len(matches)<limit and entries_visited<20000 and files_visited<5000:
        directory,depth=pending.pop(0)
        try: entries=list(os.scandir(directory))
        except OSError: continue
        for entry in entries:
            entries_visited+=1
            if entries_visited>20000 or len(matches)>=limit: break
            if entry.is_symlink(): continue
            rel=os.path.relpath(entry.path,root).replace(os.sep,'/')
            if sensitive(rel.split('/')): continue
            if entry.is_dir(follow_symlinks=False):
                if depth<max_depth and entry.name.casefold() not in ignored: pending.append((entry.path,depth+1))
                continue
            if not entry.is_file(follow_symlinks=False): continue
            try:
                if entry.stat(follow_symlinks=False).st_size>max_file_bytes: continue
                files_visited+=1
                with open(entry.path,'rb') as f: data=f.read(max_file_bytes+1)
                if len(data)>max_file_bytes or b'\0' in data[:8192]: continue
                value=data.decode('utf-8',errors='replace')
                for number,line in enumerate(value.splitlines(),1):
                    if query in line.casefold():
                        matches.append({'path':rel,'line':number,'excerpt':line[:500]})
                        break
            except OSError: continue
            if files_visited>=5000: break
    out={'query':p['query'],'path':p.get('path',''),'matches':matches,'filesVisited':files_visited,'entriesVisited':entries_visited,'truncated':len(matches)==limit or entries_visited>=20000 or files_visited>=5000}
elif op=='stat':
    path=target(p['path'],True)
    value=os.stat(path,follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode): raise ValueError('path is not a regular file')
    out={'path':p['path'],'sizeBytes':value.st_size,'modifiedAtNs':str(value.st_mtime_ns)}
elif op=='stream':
    path=target(p['path'],True)
    flags=os.O_RDONLY | getattr(os,'O_NOFOLLOW',0)
    fd=os.open(path,flags)
    try:
        value=os.fstat(fd)
        if not stat.S_ISREG(value.st_mode): raise ValueError('path is not a regular file')
        if value.st_size!=p['expectedSize'] or str(value.st_mtime_ns)!=p['expectedModifiedAtNs']: raise ValueError('source file changed before streaming')
        while True:
            data=os.read(fd,1024*1024)
            if not data: break
            sys.stdout.buffer.write(data)
        final=os.fstat(fd)
        if final.st_size!=p['expectedSize'] or str(final.st_mtime_ns)!=p['expectedModifiedAtNs']: raise ValueError('source file changed while streaming')
        sys.stdout.buffer.flush()
    finally: os.close(fd)
    sys.exit(0)
else: raise ValueError('unknown operation')
print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
`;

// Keep the fixed helper well below Windows/OpenSSH command-line limits as the policy grows.
const REMOTE_HELPER_BASE64 = gzipSync(Buffer.from(REMOTE_HELPER), { level: 9 }).toString("base64");

/** Read-only, bounded access to user-configured local or mounted data roots. */
export class ReadOnlyDataSourceCatalog {
  readonly sources: DataSourceDefinition[];

  constructor(readonly catalogPath: string) {
    const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as Partial<DataSourceCatalogFile>;
    if (raw.version !== 1 || !Array.isArray(raw.sources)) throw Error("Invalid data-source catalog");
    const ids = new Set<string>();
    this.sources = raw.sources.map((source) => {
      if (!source || typeof source !== "object") throw Error("Invalid data source");
      if (!validId(source.id) || ids.has(source.id)) throw Error(`Invalid or duplicate data-source ID: ${source.id}`);
      ids.add(source.id);
      if (typeof source.label !== "string" || !source.label.trim() || source.label.length > 120)
        throw Error(`Invalid data-source label: ${source.id}`);
      if (typeof source.device !== "string" || !source.device.trim() || source.device.length > 120)
        throw Error(`Invalid data-source device: ${source.id}`);
      if (typeof source.root !== "string" || !isAbsolute(source.root))
        throw Error(`Data-source root must be absolute: ${source.id}`);
      if (source.readOnly !== true) throw Error(`Data source must be read-only: ${source.id}`);
      if (source.environmentId !== undefined &&
          (typeof source.environmentId !== "string" || !source.environmentId.trim()))
        throw Error(`Invalid data-source environment: ${source.id}`);
      if (Boolean(source.sshHost) !== Boolean(source.remoteRoot))
        throw Error(`sshHost and remoteRoot must be configured together: ${source.id}`);
      if (source.sshHost && !/^[A-Za-z0-9._-]+$/.test(source.sshHost))
        throw Error(`Invalid data-source SSH host: ${source.id}`);
      if (source.remotePlatform !== undefined && !["posix", "windows"].includes(source.remotePlatform))
        throw Error(`Invalid remote data-source platform: ${source.id}`);
      if (source.remotePlatform !== undefined && !source.sshHost)
        throw Error(`Remote platform requires SSH transport: ${source.id}`);
      if (source.remoteRoot && (source.remotePlatform === "windows"
        ? !/^[A-Za-z]:[\\/]/.test(source.remoteRoot)
        : !source.remoteRoot.startsWith("/")))
        throw Error(`Remote data-source root must be absolute: ${source.id}`);
      if (source.verifiedModels !== undefined &&
          (!Array.isArray(source.verifiedModels) || source.verifiedModels.length > 20 ||
           source.verifiedModels.length === 0 ||
           new Set(source.verifiedModels).size !== source.verifiedModels.length ||
           source.verifiedModels.some((model) =>
             typeof model !== "string" || !model.trim() || model.length > 160)))
        throw Error(`Invalid verified model list: ${source.id}`);
      if (source.verifiedModels !== undefined && !source.environmentId)
        throw Error(`Verified models require a T3 environment: ${source.id}`);
      if (source.projectIds !== undefined &&
          (!Array.isArray(source.projectIds) || source.projectIds.length > 100 ||
           new Set(source.projectIds).size !== source.projectIds.length ||
           source.projectIds.some((id) => typeof id !== "string" || !validId(id))))
        throw Error(`Invalid data-source project bindings: ${source.id}`);
      if (source.projectPaths !== undefined) {
        if (!source.projectPaths || typeof source.projectPaths !== "object" || Array.isArray(source.projectPaths))
          throw Error(`Invalid data-source project paths: ${source.id}`);
        for (const [projectId, paths] of Object.entries(source.projectPaths)) {
          if (!validId(projectId) || !Array.isArray(paths) || paths.length > 32 ||
              paths.some((path) => typeof path !== "string") ||
              new Set(paths.map(normalizeProjectPath)).size !== paths.length)
            throw Error(`Invalid data-source project paths: ${source.id}`);
          if (!source.projectIds?.includes(projectId))
            throw Error(`Data-source project paths require a matching project binding: ${source.id}`);
        }
      }
      return { ...source, root: resolve(source.root) } as DataSourceDefinition;
    });
  }

  private allowed(source: DataSourceDefinition, projectId?: string) {
    return projectId === undefined || source.projectIds?.includes(projectId) === true;
  }

  /** Resolve the single source that owns a remote execution workspace.
   * Environment identity alone is insufficient because one device may expose
   * multiple roots with different project/model policy. */
  executionSource(projectId: string, environmentId: string, cwd: string) {
    const normalizeRemote = (value: string, label: string) => {
      if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0"))
        throw Error(`${label} must be an absolute remote path`);
      const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
      if (segments.some((segment) => segment === "." || segment === ".."))
        throw Error(`${label} contains an unsafe path segment`);
      return `/${segments.join("/")}`;
    };
    const workspace = normalizeRemote(cwd, "Remote member workspace");
    const matches = this.sources.filter((source) => {
      if (!source.projectIds?.includes(projectId) || source.environmentId !== environmentId || !source.remoteRoot)
        return false;
      const root = normalizeRemote(source.remoteRoot, `Data source ${source.id} remote root`);
      return root === "/" || workspace === root || workspace.startsWith(`${root}/`);
    });
    if (!matches.length)
      throw Error(`No project-bound data source owns ${environmentId}:${workspace}`);
    if (matches.length > 1)
      throw Error(`Ambiguous project-bound data sources own ${environmentId}:${workspace}`);
    return matches[0]!;
  }

  list(projectId?: string, includeProjectBindings = false) {
    return this.sources.filter((source) => this.allowed(source, projectId)).map((source) => {
      const { projectIds, projectPaths, ...publicSource } = source;
      const visiblePaths = projectId === undefined ? undefined : projectPaths?.[projectId];
      const visibleSource = includeProjectBindings ? source : publicSource;
      try {
        return {
          ...visibleSource,
          ...(visiblePaths !== undefined ? { folders: visiblePaths } : {}),
          reachable: source.sshHost ? this.remote(source, "ping", {}).reachable === true : existsSync(source.root),
          error: null,
        };
      } catch (error) {
        return {
          ...visibleSource,
          ...(visiblePaths !== undefined ? { folders: visiblePaths } : {}),
          reachable: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
    });
  }

  async listAsync(projectId?: string, includeProjectBindings = false) {
    return Promise.all(this.sources.filter((source) => this.allowed(source, projectId)).map(async (source) => {
      const { projectIds, projectPaths, ...publicSource } = source;
      const visiblePaths = projectId === undefined ? undefined : projectPaths?.[projectId];
      const visibleSource = includeProjectBindings ? source : publicSource;
      try {
        const reachable = source.sshHost
          ? (await this.remoteAsync(source, "ping", {})).reachable === true
          : existsSync(source.root);
        return { ...visibleSource, ...(visiblePaths !== undefined ? { folders: visiblePaths } : {}), reachable, error: null };
      } catch (error) {
        return {
          ...visibleSource,
          ...(visiblePaths !== undefined ? { folders: visiblePaths } : {}),
          reachable: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
    }));
  }

  private remote(source: DataSourceDefinition, op: string, input: Record<string, unknown>) {
    if (!source.sshHost || !source.remoteRoot) throw Error("Data source has no SSH transport");
    const payload = Buffer.from(JSON.stringify({ op, root: source.remoteRoot, ...input })).toString("base64url");
    const command = this.remoteCommand(source, payload);
    const result = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", source.sshHost, command],
      { encoding: "utf8", timeout: 45_000, maxBuffer: 2_000_000, windowsHide: true },
    );
    if (result.error) throw Error(`Data-source SSH failed: ${result.error.message}`);
    if (result.status !== 0)
      throw Error(`Data-source SSH failed: ${remoteErrorDetail(result.stderr || result.stdout)}`);
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw Error("Data-source SSH returned invalid JSON");
    }
  }

  private remoteAsync(source: DataSourceDefinition, op: string, input: Record<string, unknown>) {
    if (!source.sshHost || !source.remoteRoot) return Promise.reject(Error("Data source has no SSH transport"));
    const payload = Buffer.from(JSON.stringify({ op, root: source.remoteRoot, ...input })).toString("base64url");
    const command = this.remoteCommand(source, payload);
    return new Promise<Record<string, unknown>>((resolveResult, reject) => {
      const child = spawn(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", source.sshHost!, command],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolveResult(value!);
      };
      const append = (current: string, chunk: Buffer) => {
        const value = current + chunk.toString("utf8");
        if (Buffer.byteLength(value) > 2_000_000) {
          child.kill();
          finish(Error("Data-source SSH response exceeded 2000000 bytes"));
        }
        return value;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => finish(Error(`Data-source SSH failed: ${error.message}`)));
      child.once("close", (status) => {
        if (settled) return;
        if (status !== 0) return finish(Error(`Data-source SSH failed: ${remoteErrorDetail(stderr || stdout)}`));
        try {
          finish(undefined, JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          finish(Error("Data-source SSH returned invalid JSON"));
        }
      });
      const timeout = setTimeout(() => {
        child.kill();
        finish(Error("Data-source SSH failed: operation timed out"));
      }, 45_000);
    });
  }

  private remoteBinary(
    source: DataSourceDefinition,
    requested: string,
    expectedSize: number,
    expectedModifiedAtNs: string,
  ): AsyncIterable<Uint8Array> {
    if (!source.sshHost || !source.remoteRoot) throw Error("Data source has no SSH transport");
    const payload = Buffer.from(JSON.stringify({
      op: "stream", root: source.remoteRoot, path: requested, expectedSize, expectedModifiedAtNs,
    })).toString("base64url");
    const command = this.remoteCommand(source, payload);
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", source.sshHost, command],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    return (async function* () {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
      const timeout = setTimeout(() => child.kill(), 15 * 60_000);
      const completion = new Promise<number | null>((resolveStatus, reject) => {
        child.once("error", reject);
        child.once("close", resolveStatus);
      });
      try {
        for await (const chunk of child.stdout) yield Buffer.from(chunk);
        const status = await completion;
        if (status !== 0) throw Error(`Data-source SSH stream failed: ${remoteErrorDetail(stderr)}`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
      }
    })();
  }

  private remoteCommand(source: DataSourceDefinition, payload: string) {
    const interpreter = source.remotePlatform === "windows" ? "py.exe -3 -X utf8" : "python3";
    const argument = source.remotePlatform === "windows" ? payload : `'${payload}'`;
    return `${interpreter} -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${REMOTE_HELPER_BASE64}'),31))" ${argument}`;
  }

  private source(id: string, projectId?: string) {
    const source = this.sources.find((candidate) => candidate.id === id && this.allowed(candidate, projectId));
    if (!source) throw Error(`Unknown data source: ${id}`);
    if (!source.sshHost && !existsSync(source.root)) throw Error(`Data source is currently unreachable: ${source.label}`);
    return source;
  }

  private projectFolders(source: DataSourceDefinition, projectId?: string) {
    if (projectId === undefined) return undefined;
    return source.projectPaths?.[projectId]?.map(normalizeProjectPath);
  }

  private assertProjectPath(source: DataSourceDefinition, requested: string, projectId?: string) {
    const folders = this.projectFolders(source, projectId);
    if (folders === undefined) return;
    if (!folders.length) throw Error("No data folders are authorized for this project and source");
    const clean = normalizeProjectPath(requested);
    if (!folders.some((folder) => folder === "" || clean === folder || clean.startsWith(`${folder}/`)))
      throw Error("Data-source path is outside this project's authorized folders");
  }

  private searchFolders(source: DataSourceDefinition, requested: string | undefined, projectId?: string) {
    if (requested !== undefined && requested.trim()) {
      this.assertProjectPath(source, requested, projectId);
      return [normalizeProjectPath(requested)];
    }
    const folders = this.projectFolders(source, projectId);
    if (folders === undefined) return [""];
    if (!folders.length) throw Error("No data folders are authorized for this project and source");
    return folders;
  }

  private safePath(source: DataSourceDefinition, requested: string, allowRoot = true) {
    if (typeof requested !== "string" || requested.length > 2_000 || requested.includes("\0"))
      throw Error("Invalid data-source path");
    const clean = requested.trim().replaceAll("\\", "/");
    if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith("//"))
      throw Error("Data-source paths must be relative");
    const parts = clean.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === "..")) throw Error("Data-source path cannot escape its root");
    if (sensitiveParts(parts)) throw Error("Sensitive credential paths are not exposed by data sources");
    if (!allowRoot && parts.length === 0) throw Error("A file path is required");
    const root = normalized(source.root);
    const target = resolve(source.root, ...parts);
    if (!inside(normalized(target), root)) throw Error("Data-source path cannot escape its root");
    let current = source.root;
    for (const part of parts) {
      current = resolve(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw Error("Data-source symbolic links are not followed");
    }
    return target;
  }

  listDirectory(
    sourceId: string,
    requested = "",
    limit = 200,
    projectId?: string,
  ): DataSourceDirectoryResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error("limit must be from 1 to 500");
    const source = this.source(sourceId, projectId);
    const folders = this.projectFolders(source, projectId);
    if (folders !== undefined && !folders.length)
      throw Error("No data folders are authorized for this project and source");
    const cleanRequested = normalizeProjectPath(requested);
    if (folders !== undefined && !folders.some((folder) =>
      folder === "" || cleanRequested === folder || cleanRequested.startsWith(`${folder}/`))) {
      const children = [...new Set(folders.filter((folder) =>
        cleanRequested === "" || folder.startsWith(`${cleanRequested}/`)
      ).map((folder) => folder.slice(cleanRequested ? cleanRequested.length + 1 : 0).split("/")[0]).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit)
        .map((name) => ({ name, kind: "directory" as const }));
      if (children.length) return { sourceId, path: requested, entries: children, truncated: children.length === limit };
      throw Error("Data-source path is outside this project's authorized folders");
    }
    this.assertProjectPath(source, requested, projectId);
    if (source.sshHost) {
      const result = this.remote(source, "list", { path: requested, limit });
      return { sourceId, ...result } as unknown as DataSourceDirectoryResult;
    }
    const directory = this.safePath(source, requested);
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) throw Error("Data-source path is not a directory");
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => !sensitiveParts([...requested.replaceAll("\\", "/").split("/").filter(Boolean), entry.name]))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        kind: (entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other") as
          "directory" | "file" | "other",
      }));
    return { sourceId, path: requested, entries, truncated: entries.length === limit };
  }

  readText(sourceId: string, requested: string, maxBytes = 200_000, projectId?: string): DataSourceTextResult {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000)
      throw Error("maxBytes must be from 1 to 1000000");
    const source = this.source(sourceId, projectId);
    this.assertProjectPath(source, requested, projectId);
    if (source.sshHost) {
      const result = this.remote(source, "read", { path: requested, maxBytes });
      return { sourceId, ...result } as unknown as DataSourceTextResult;
    }
    const file = this.safePath(source, requested, false);
    const stat = lstatSync(file);
    if (!stat.isFile()) throw Error("Data-source path is not a regular file");
    const fd = openSync(file, "r");
    let content: Buffer;
    let opened;
    try {
      opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw Error("Data-source file changed before reading");
      const capacity = Math.min(opened.size, maxBytes + 1);
      content = Buffer.alloc(capacity);
      let offset = 0;
      while (offset < capacity) {
        const bytes = readSync(fd, content, offset, capacity - offset, offset);
        if (!bytes) break;
        offset += bytes;
      }
      content = content.subarray(0, offset);
      const final = fstatSync(fd);
      if (final.dev !== opened.dev || final.ino !== opened.ino ||
          final.size !== opened.size || final.mtimeMs !== opened.mtimeMs)
        throw Error("Data-source file changed while reading");
    } finally {
      closeSync(fd);
    }
    if (content.subarray(0, Math.min(content.length, 8_192)).includes(0))
      throw Error("Binary data-source files cannot be returned as text");
    const returned = content.subarray(0, maxBytes);
    return {
      sourceId,
      path: requested,
      sizeBytes: opened.size,
      returnedBytes: returned.length,
      returnedSha256: createHash("sha256").update(returned).digest("hex"),
      modifiedAtMs: Math.trunc(opened.mtimeMs),
      truncated: returned.length < opened.size,
      text: returned.toString("utf8"),
    };
  }

  openBinary(sourceId: string, requested: string, projectId?: string): DataSourceBinaryStream {
    const source = this.source(sourceId, projectId);
    this.assertProjectPath(source, requested, projectId);
    if (source.sshHost) {
      const result = this.remote(source, "stat", { path: requested });
      const sizeBytes = result.sizeBytes;
      if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)
        throw Error("Data-source SSH returned an invalid file size");
      const modifiedAtNs = result.modifiedAtNs;
      if (typeof modifiedAtNs !== "string" || !/^[0-9]{1,30}$/.test(modifiedAtNs))
        throw Error("Data-source SSH returned an invalid file modification time");
      return {
        sourceId,
        path: requested,
        name: basename(requested.replaceAll("\\", "/")),
        sizeBytes: sizeBytes as number,
        content: this.remoteBinary(source, requested, sizeBytes as number, modifiedAtNs),
      };
    }
    const file = this.safePath(source, requested, false);
    const stat = lstatSync(file);
    if (!stat.isFile()) throw Error("Data-source path is not a regular file");
    const content = (async function* () {
      const fd = openSync(file, "r");
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
            opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs)
          throw Error("Data-source file changed before streaming");
        const stream = createReadStream(file, { fd, autoClose: false });
        for await (const chunk of stream) yield Buffer.from(chunk);
        const final = fstatSync(fd);
        if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs)
          throw Error("Data-source file changed while streaming");
      } finally {
        closeSync(fd);
      }
    })();
    return {
      sourceId,
      path: requested,
      name: basename(file),
      sizeBytes: stat.size,
      content,
    };
  }

  searchFiles(
    sourceId: string,
    query: string,
    options: { path?: string; limit?: number; maxDepth?: number } = {},
    projectId?: string,
  ): DataSourceSearchResult {
    const clean = query.trim().toLowerCase();
    if (!clean || clean.length > 120) throw Error("query must be from 1 to 120 characters");
    const limit = options.limit ?? 50;
    const maxDepth = options.maxDepth ?? 6;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error("limit must be from 1 to 200");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 12)
      throw Error("maxDepth must be from 0 to 12");
    const source = this.source(sourceId, projectId);
    const starts = this.searchFolders(source, options.path, projectId);
    if (starts.length > 1) {
      const results = starts.map((path) => this.searchFiles(sourceId, query, { ...options, path }, projectId));
      return {
        sourceId,
        query,
        matches: results.flatMap((result) => result.matches).slice(0, limit),
        visited: results.reduce((sum, result) => sum + result.visited, 0),
        truncated: results.some((result) => result.truncated) || results.reduce((sum, result) => sum + result.matches.length, 0) > limit,
      };
    }
    const path = starts[0]!;
    if (source.sshHost) {
      const result = this.remote(source, "search", { path, query, limit, maxDepth });
      return { sourceId, ...result } as unknown as DataSourceSearchResult;
    }
    const ignored = new Set([".git", ".cache", ".cargo", ".codex", ".npm", ".t3", "node_modules", ...BLOCKED_DIRECTORY_NAMES]);
    const pending: Array<{ directory: string; depth: number }> = [{ directory: this.safePath(source, path), depth: 0 }];
    const matches: Array<{ path: string; kind: "file" | "directory" }> = [];
    let visited = 0;
    while (pending.length && matches.length < limit && visited < 20_000) {
      const current = pending.shift()!;
      let entries;
      try {
        entries = readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++visited > 20_000 || matches.length >= limit) break;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(current.directory, entry.name);
        const path = relative(source.root, full).replaceAll("\\", "/");
        if (sensitiveParts(path.split("/"))) continue;
        if (entry.name.toLowerCase().includes(clean))
          matches.push({ path, kind: entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory() && current.depth < maxDepth && !ignored.has(entry.name.toLowerCase()))
          pending.push({ directory: full, depth: current.depth + 1 });
      }
    }
    return {
      sourceId,
      query,
      matches,
      visited,
      truncated: matches.length === limit || visited >= 20_000,
    };
  }

  async searchFilesAsync(
    sourceId: string,
    query: string,
    options: { path?: string; limit?: number; maxDepth?: number } = {},
    projectId?: string,
  ): Promise<DataSourceSearchResult> {
    const clean = query.trim().toLowerCase();
    if (!clean || clean.length > 120) throw Error("query must be from 1 to 120 characters");
    const limit = options.limit ?? 50;
    const maxDepth = options.maxDepth ?? 6;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error("limit must be from 1 to 200");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 12)
      throw Error("maxDepth must be from 0 to 12");
    const source = this.source(sourceId, projectId);
    const starts = this.searchFolders(source, options.path, projectId);
    if (starts.length > 1) {
      const results = await Promise.all(starts.map((path) =>
        this.searchFilesAsync(sourceId, query, { ...options, path }, projectId)));
      return {
        sourceId,
        query,
        matches: results.flatMap((result) => result.matches).slice(0, limit),
        visited: results.reduce((sum, result) => sum + result.visited, 0),
        truncated: results.some((result) => result.truncated) || results.reduce((sum, result) => sum + result.matches.length, 0) > limit,
      };
    }
    const path = starts[0]!;
    if (!source.sshHost) {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      return this.searchFiles(sourceId, query, options, projectId);
    }
    const result = await this.remoteAsync(source, "search", { path, query, limit, maxDepth });
    return { sourceId, ...result } as unknown as DataSourceSearchResult;
  }

  searchText(
    sourceId: string,
    query: string,
    options: { path?: string; limit?: number; maxDepth?: number; maxFileBytes?: number } = {},
    projectId?: string,
  ): DataSourceTextSearchResult {
    const clean = query.trim();
    if (!clean || clean.length > 200) throw Error("query must be from 1 to 200 characters");
    const requestedPath = options.path;
    const limit = options.limit ?? 30;
    const maxDepth = options.maxDepth ?? 6;
    const maxFileBytes = options.maxFileBytes ?? 1_000_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("limit must be from 1 to 100");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 12)
      throw Error("maxDepth must be from 0 to 12");
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 5_000_000)
      throw Error("maxFileBytes must be from 1 to 5000000");
    const source = this.source(sourceId, projectId);
    const starts = this.searchFolders(source, requestedPath, projectId);
    if (starts.length > 1) {
      const results = starts.map((path) => this.searchText(sourceId, query, { ...options, path }, projectId));
      return {
        sourceId,
        query: clean,
        path: "",
        matches: results.flatMap((result) => result.matches).slice(0, limit),
        filesVisited: results.reduce((sum, result) => sum + result.filesVisited, 0),
        entriesVisited: results.reduce((sum, result) => sum + result.entriesVisited, 0),
        truncated: results.some((result) => result.truncated) || results.reduce((sum, result) => sum + result.matches.length, 0) > limit,
      };
    }
    const path = starts[0]!;
    if (source.sshHost) {
      const result = this.remote(source, "search_text", { path, query: clean, limit, maxDepth, maxFileBytes });
      return { sourceId, ...result } as unknown as DataSourceTextSearchResult;
    }
    const start = this.safePath(source, path);
    if (!lstatSync(start).isDirectory()) throw Error("Data-source search path is not a directory");
    const ignored = new Set([".git", ".cache", ".cargo", ".codex", ".npm", ".t3", "node_modules", ...BLOCKED_DIRECTORY_NAMES]);
    const pending: Array<{ directory: string; depth: number }> = [{ directory: start, depth: 0 }];
    const matches: Array<{ path: string; line: number; excerpt: string }> = [];
    let filesVisited = 0;
    let entriesVisited = 0;
    while (pending.length && matches.length < limit && entriesVisited < 20_000 && filesVisited < 5_000) {
      const current = pending.shift()!;
      let entries;
      try {
        entries = readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++entriesVisited > 20_000 || matches.length >= limit) break;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(current.directory, entry.name);
        const relativePath = relative(source.root, full).replaceAll("\\", "/");
        if (sensitiveParts(relativePath.split("/"))) continue;
        if (entry.isDirectory()) {
          if (current.depth < maxDepth && !ignored.has(entry.name.toLowerCase()))
            pending.push({ directory: full, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = lstatSync(full);
          if (stat.size > maxFileBytes) continue;
          filesVisited++;
          const content = readFileSync(full);
          if (content.length > maxFileBytes || content.subarray(0, Math.min(content.length, 8_192)).includes(0)) continue;
          const lines = content.toString("utf8").split(/\r?\n/);
          const line = lines.findIndex((value) => value.toLowerCase().includes(clean.toLowerCase()));
          if (line >= 0)
            matches.push({
              path: relativePath,
              line: line + 1,
              excerpt: lines[line]!.slice(0, 500),
            });
        } catch {
          continue;
        }
        if (filesVisited >= 5_000) break;
      }
    }
    return {
      sourceId,
      query: clean,
      path,
      matches,
      filesVisited,
      entriesVisited,
      truncated: matches.length === limit || entriesVisited >= 20_000 || filesVisited >= 5_000,
    };
  }

  async searchTextAsync(
    sourceId: string,
    query: string,
    options: { path?: string; limit?: number; maxDepth?: number; maxFileBytes?: number } = {},
    projectId?: string,
  ): Promise<DataSourceTextSearchResult> {
    const clean = query.trim();
    if (!clean || clean.length > 200) throw Error("query must be from 1 to 200 characters");
    const requestedPath = options.path;
    const limit = options.limit ?? 30;
    const maxDepth = options.maxDepth ?? 6;
    const maxFileBytes = options.maxFileBytes ?? 1_000_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("limit must be from 1 to 100");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 12)
      throw Error("maxDepth must be from 0 to 12");
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 5_000_000)
      throw Error("maxFileBytes must be from 1 to 5000000");
    const source = this.source(sourceId, projectId);
    const starts = this.searchFolders(source, requestedPath, projectId);
    if (starts.length > 1) {
      const results = await Promise.all(starts.map((path) =>
        this.searchTextAsync(sourceId, query, { ...options, path }, projectId)));
      return {
        sourceId,
        query: clean,
        path: "",
        matches: results.flatMap((result) => result.matches).slice(0, limit),
        filesVisited: results.reduce((sum, result) => sum + result.filesVisited, 0),
        entriesVisited: results.reduce((sum, result) => sum + result.entriesVisited, 0),
        truncated: results.some((result) => result.truncated) || results.reduce((sum, result) => sum + result.matches.length, 0) > limit,
      };
    }
    const path = starts[0]!;
    if (!source.sshHost) {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      return this.searchText(sourceId, query, options, projectId);
    }
    const result = await this.remoteAsync(source, "search_text", { path, query: clean, limit, maxDepth, maxFileBytes });
    return { sourceId, ...result } as unknown as DataSourceTextSearchResult;
  }
}

/** Hub-side writer for project bindings. Source definitions remain administrator-managed. */
export class DataSourceBindingStore {
  constructor(readonly catalogPath: string) {}

  /**
   * The Hub and each project MCP provider are separate processes.  Binding
   * updates therefore need a filesystem transaction boundary; a temp-file
   * rename alone prevents torn JSON but does not prevent two writers from
   * reading the same old catalog and silently losing one another's changes.
   */
  private withCatalogLock<T>(operation: () => T): T {
    const lockPath = `${this.catalogPath}.bindings.lock`;
    const owner = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + 5_000;
    let acquired = false;
    while (!acquired) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, owner, "utf8");
        } finally {
          closeSync(fd);
        }
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          // A binding rewrite takes milliseconds. A lock this old belongs to
          // a terminated process; reclaiming it prevents permanent outage.
          if (Date.now() - lstatSync(lockPath).mtimeMs > 30_000) {
            // Rename the exact stale inode out of the lock namespace before
            // deleting it. A competing reclaimer can no longer unlink a new
            // owner's lock between our stat and cleanup.
            const abandoned = `${lockPath}.stale-${randomUUID()}`;
            renameSync(lockPath, abandoned);
            unlinkSync(abandoned);
            continue;
          }
        } catch (inspectError) {
          if ((inspectError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw inspectError;
        }
        if (Date.now() >= deadline)
          throw Object.assign(Error("Data-source bindings are busy; retry the operation"), { code: "EBUSY" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return operation();
    } finally {
      try {
        if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private catalog() {
    return new ReadOnlyDataSourceCatalog(this.catalogPath);
  }

  /** Read grants without probing local mounts or remote SSH endpoints. */
  boundSourceIds(projectId: string) {
    if (!validId(projectId)) throw Error("Invalid project id");
    return this.catalog().sources
      .filter((source) => source.projectIds?.includes(projectId) === true)
      .map((source) => source.id);
  }

  boundSource(projectId: string, sourceId: string) {
    if (!validId(projectId) || !validId(sourceId)) return undefined;
    return this.catalog().sources.find((source) =>
      source.id === sourceId && source.projectIds?.includes(projectId) === true);
  }

  boundFolders(projectId: string, sourceId: string) {
    const source = this.boundSource(projectId, sourceId);
    if (!source) throw Error(`Data source ${sourceId} is not bound to project ${projectId}`);
    return [...(source.projectPaths?.[projectId] ?? [""])];
  }

  list(projectId?: string) {
    const catalog = this.catalog();
    const statuses = new Map(catalog.list().map((source) => [source.id, source]));
    return catalog.sources.map((source) => {
      const status = statuses.get(source.id);
      return {
        ...source,
        reachable: status?.reachable ?? false,
        error: status ? status.error : "Data source status is unavailable",
        bound: projectId === undefined ? undefined : source.projectIds?.includes(projectId) === true,
      };
    });
  }

  async listAsync(projectId?: string) {
    const catalog = this.catalog();
    const statuses = new Map((await catalog.listAsync()).map((source) => [source.id, source]));
    return catalog.sources.map((source) => {
      const status = statuses.get(source.id);
      return {
        ...source,
        reachable: status?.reachable ?? false,
        error: status ? status.error : "Data source status is unavailable",
        bound: projectId === undefined ? undefined : source.projectIds?.includes(projectId) === true,
      };
    });
  }

  setProjectSources(projectId: string, sourceIds: readonly string[]) {
    if (!validId(projectId)) throw Error("Invalid project id");
    if (!Array.isArray(sourceIds) || sourceIds.length > 100 ||
        sourceIds.some((id) => typeof id !== "string" || !validId(id)) ||
        new Set(sourceIds).size !== sourceIds.length)
      throw Error("sourceIds must contain at most 100 unique data-source IDs");
    this.withCatalogLock(() => {
      // Load only after acquiring the cross-process lock.
      const catalog = this.catalog();
      const known = new Set(catalog.sources.map((source) => source.id));
      const unknown = sourceIds.find((id) => !known.has(id));
      if (unknown) throw Error(`Unknown data source: ${unknown}`);
      const selected = new Set(sourceIds);
      const next: DataSourceCatalogFile = {
        version: 1,
        sources: catalog.sources.map((source) => {
          const bindings = new Set(source.projectIds ?? []);
          const projectPaths = { ...(source.projectPaths ?? {}) };
          if (selected.has(source.id)) bindings.add(projectId);
          else {
            bindings.delete(projectId);
            delete projectPaths[projectId];
          }
          if (bindings.size > 100)
            throw Error(`Data source ${source.id} cannot be bound to more than 100 projects`);
          return {
            ...source,
            projectIds: [...bindings].sort(),
            ...(Object.keys(projectPaths).length ? { projectPaths } : { projectPaths: undefined }),
          };
        }),
      };
      const temporary = `${this.catalogPath}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, this.catalogPath);
        chmodSync(this.catalogPath, 0o600);
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
    });
    // Mutation stays synchronous and returns only the new grant projection;
    // callers that need reachability must use setProjectSourcesAsync so remote
    // SSH probes never block the Node event loop.
    return this.catalog().sources.map((source) => ({
      ...source,
      bound: source.projectIds?.includes(projectId) === true,
    }));
  }

  async setProjectSourcesAsync(projectId: string, sourceIds: readonly string[]) {
    this.setProjectSources(projectId, sourceIds);
    return this.listAsync(projectId);
  }

  /** Replace one project's folder grants for a bound source. Paths remain relative to the configured source root. */
  setProjectFolders(projectId: string, sourceId: string, folders: readonly string[]) {
    if (!validId(projectId) || !validId(sourceId)) throw Error("Invalid project or data-source ID");
    if (!Array.isArray(folders) || folders.length > 32 || folders.some((folder) => typeof folder !== "string"))
      throw Error("folders must contain at most 32 paths");
    const normalizedFolders = folders.map(normalizeProjectPath);
    if (new Set(normalizedFolders).size !== normalizedFolders.length)
      throw Error("folders must be unique");
    this.withCatalogLock(() => {
      const catalog = this.catalog();
      const source = catalog.sources.find((candidate) => candidate.id === sourceId);
      if (!source) throw Error(`Unknown data source: ${sourceId}`);
      if (!source.projectIds?.includes(projectId))
        throw Error(`Data source ${sourceId} is not bound to project ${projectId}`);
      const next: DataSourceCatalogFile = {
        version: 1,
        sources: catalog.sources.map((candidate) => candidate.id === sourceId ? {
          ...candidate,
          projectPaths: { ...(candidate.projectPaths ?? {}), [projectId]: normalizedFolders },
        } : candidate),
      };
      const temporary = `${this.catalogPath}.tmp-${randomUUID()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, this.catalogPath);
        chmodSync(this.catalogPath, 0o600);
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
    });
    return this.boundFolders(projectId, sourceId);
  }

  grantProjectFolder(projectId: string, sourceId: string, folder: string) {
    const current = this.boundFolders(projectId, sourceId);
    const normalizedFolder = normalizeProjectPath(folder);
    if (current.includes("")) {
      // A legacy whole-root grant is deliberately narrowed on the first explicit folder binding.
      return this.setProjectFolders(projectId, sourceId, [normalizedFolder]);
    }
    return this.setProjectFolders(projectId, sourceId, [...new Set([...current, normalizedFolder])]);
  }
}
