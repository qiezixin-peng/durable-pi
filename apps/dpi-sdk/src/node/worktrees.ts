import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectWorktree } from "../api.js";
import { dpiHome } from "./registry.js";

type WorktreeRow = {
  id: string;
  project_id: string;
  label: string;
  repository_root: string;
  path: string;
  branch: string;
  base_revision: string;
  state: ProjectWorktree["state"];
  error: string | null;
  created_at: number;
  checked_at: number | null;
};

const clean = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`${label} is required`);
  const result = value.trim();
  if (result.length > max) throw Error(`${label} must be at most ${max} characters`);
  return result;
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "worktree";

function git(cwd: string, args: string[]): string;
function git(cwd: string, args: string[], allowFailure: true): string | undefined;
function git(cwd: string, args: string[], allowFailure = false): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    const detail = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw Error(detail ? `Git command failed: ${detail}` : "Git command failed");
  }
}

const repositoryRoot = (input: string) => {
  const root = resolve(input);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory())
    throw Error("Repository root is missing, unsafe or not a directory");
  const actual = resolve(git(root, ["rev-parse", "--show-toplevel"]));
  if (actual !== root) throw Error("Repository root must be the Git top-level directory");
  return root;
};

export type WorktreeReadiness =
  | { eligible: true; repositoryRoot: string; baseRevision: string }
  | { eligible: false; reason: "UNSAFE_DIRECTORY" | "NOT_GIT_TOP_LEVEL" | "NO_COMMIT" | "DIRTY_WORKTREE" };

/** Conservative probe used by automatic team materialization; it never changes Git state. */
export const assessWorktreeReadiness = (input: string): WorktreeReadiness => {
  const root = resolve(input);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory())
    return { eligible: false, reason: "UNSAFE_DIRECTORY" };
  const actual = git(root, ["rev-parse", "--show-toplevel"], true);
  if (!actual || resolve(actual) !== root) return { eligible: false, reason: "NOT_GIT_TOP_LEVEL" };
  const baseRevision = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], true);
  if (!baseRevision || !/^[a-f0-9]{40,64}$/.test(baseRevision)) return { eligible: false, reason: "NO_COMMIT" };
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]))
    return { eligible: false, reason: "DIRTY_WORKTREE" };
  return { eligible: true, repositoryRoot: root, baseRevision };
};

export class ProjectWorktreeStore {
  readonly db: DatabaseSync;
  readonly root: string;

  constructor(databasePath: string, root = join(dpiHome(), "worktrees")) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw Error("Worktree root must not be a symbolic link");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_worktrees(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        checked_at INTEGER,
        UNIQUE(repository_root,branch));
      CREATE INDEX IF NOT EXISTS project_worktrees_scope
        ON project_worktrees(project_id,state,created_at DESC);`);
    this.recoverProvisioning();
  }

  private row(row: WorktreeRow): ProjectWorktree {
    return {
      id: row.id,
      projectId: row.project_id,
      label: row.label,
      repositoryRoot: row.repository_root,
      path: row.path,
      branch: row.branch,
      baseRevision: row.base_revision,
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
    };
  }

  private getRow(projectId: string, id: string) {
    return this.db.prepare("SELECT * FROM project_worktrees WHERE project_id=? AND id=?")
      .get(projectId, id) as WorktreeRow | undefined;
  }

  list(projectId: string, inspect = false): ProjectWorktree[] {
    const rows = this.db.prepare("SELECT * FROM project_worktrees WHERE project_id=? ORDER BY created_at DESC,id")
      .all(projectId) as WorktreeRow[];
    return rows.map((row) => {
      if (inspect && row.state === "PROVISIONING") {
        this.recoverRow(row);
        const recovered = this.getRow(projectId, row.id)!;
        return recovered.state === "ACTIVE" ? this.inspect(projectId, row.id) : this.row(recovered);
      }
      return inspect && row.state === "ACTIVE" ? this.inspect(projectId, row.id) : this.row(row);
    });
  }

  create(
    projectId: string,
    input: { id?: string; repositoryRoot: string; label: string; base?: string; branch?: string },
    now = Date.now(),
  ): ProjectWorktree {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw Error(`Unknown project: ${projectId}`);
    const repo = repositoryRoot(clean(input.repositoryRoot, "Repository root", 1_000));
    const label = clean(input.label, "Worktree label", 120);
    const base = clean(input.base ?? "HEAD", "Base revision", 240);
    const baseRevision = git(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
    if (!/^[a-f0-9]{40,64}$/.test(baseRevision)) throw Error("Base revision is not a valid commit");
    const id = input.id === undefined ? randomUUID() : clean(input.id, "Worktree id", 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw Error("Worktree id is invalid");
    const branch = input.branch?.trim()
      ? clean(input.branch, "Branch", 240)
      : `dpi/${slug(projectId)}/${slug(label)}-${id.slice(0, 8)}`;
    if (git(repo, ["check-ref-format", "--branch", branch], true) === undefined) throw Error("Branch name is invalid");
    const existing = this.getRow(projectId, id);
    if (existing) {
      if (existing.repository_root !== repo || existing.label !== label || existing.branch !== branch ||
          existing.base_revision !== baseRevision)
        throw Error("Worktree id was reused with different arguments");
      return existing.state === "ACTIVE" ? this.inspect(projectId, id, now) : this.row(existing);
    }
    const activeCount = Number((this.db.prepare(
      "SELECT COUNT(*) AS count FROM project_worktrees WHERE project_id=? AND state IN ('PROVISIONING','ACTIVE')",
    ).get(projectId) as { count: number }).count);
    if (activeCount >= 32) throw Error("A project can have at most 32 active managed worktrees");
    const projectRoot = resolve(this.root, slug(projectId));
    if (dirname(projectRoot) !== this.root) throw Error("Managed worktree project root escaped its boundary");
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(projectRoot).isSymbolicLink()) throw Error("Managed worktree project root must not be a symbolic link");
    const path = resolve(projectRoot, id);
    if (dirname(path) !== projectRoot || existsSync(path)) throw Error("Managed worktree path is unsafe or already exists");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO project_worktrees(
           id,project_id,label,repository_root,path,branch,base_revision,state,error,created_at,checked_at)
         VALUES(?,?,?,?,?,?,?,'PROVISIONING',NULL,?,NULL)`,
      ).run(id, projectId, label, repo, path, branch, baseRevision, now);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "worktree.provisioning", JSON.stringify({ worktreeId: id, label, repositoryRoot: repo, path, branch, baseRevision }), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      git(repo, ["worktree", "add", "-b", branch, path, baseRevision]);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      this.db.prepare("UPDATE project_worktrees SET state='FAILED',error=?,checked_at=? WHERE id=?").run(message, now, id);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "worktree.failed", JSON.stringify({ worktreeId: id, error: message }), now);
      throw error;
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE project_worktrees SET state='ACTIVE',error=NULL,checked_at=? WHERE id=?")
          .run(now, id);
        this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
          .run(projectId, "worktree.created", JSON.stringify({ worktreeId: id, branch, baseRevision, path }), now);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return this.inspect(projectId, id, now);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      try {
        const pending = this.getRow(projectId, id);
        if (pending?.state === "PROVISIONING") this.recoverRow(pending);
        const recovered = this.getRow(projectId, id);
        if (recovered?.state === "ACTIVE") return this.inspect(projectId, id, now);
        this.db.prepare("UPDATE project_worktrees SET error=?,checked_at=? WHERE id=?").run(message, now, id);
      } catch {}
      throw error;
    }
  }

  inspect(projectId: string, id: string, checkedAt = Date.now()): ProjectWorktree {
    const row = this.getRow(projectId, id);
    if (!row) throw Error(`Unknown managed worktree: ${id}`);
    const result = this.row(row);
    if (row.state !== "ACTIVE") return result;
    const path = resolve(row.path);
    const projectRoot = resolve(this.root, slug(projectId));
    if (dirname(path) !== projectRoot || !existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory())
      throw Error("Managed worktree is missing or unsafe");
    if (resolve(git(path, ["rev-parse", "--show-toplevel"])) !== path) throw Error("Managed worktree Git root mismatch");
    const branch = git(path, ["branch", "--show-current"]);
    if (branch !== row.branch) throw Error(`Managed worktree branch mismatch: expected ${row.branch}, found ${branch || "detached"}`);
    const headRevision = git(path, ["rev-parse", "--verify", "HEAD"]);
    const dirty = Boolean(git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]));
    const baseIsAncestor = git(path, ["merge-base", "--is-ancestor", row.base_revision, headRevision], true) !== undefined;
    this.db.prepare("UPDATE project_worktrees SET checked_at=?,error=NULL WHERE id=?").run(checkedAt, id);
    return { ...result, headRevision, dirty, baseIsAncestor, checkedAt };
  }

  remove(projectId: string, id: string, removedAt = Date.now()) {
    const row = this.getRow(projectId, id);
    if (!row) throw Error(`Unknown managed worktree: ${id}`);
    if (row.state === "REMOVED") return this.row(row);
    if (row.state === "ACTIVE") {
      const current = this.inspect(projectId, id, removedAt);
      if (current.dirty) throw Error("Managed worktree has uncommitted changes and cannot be removed");
      git(row.repository_root, ["worktree", "remove", row.path]);
    } else if (existsSync(row.path)) {
      throw Error("Non-active managed worktree still has files; refusing automatic removal");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE project_worktrees SET state='REMOVED',error=NULL,checked_at=? WHERE id=?")
        .run(removedAt, id);
      this.db.prepare("INSERT INTO project_events(project_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
        .run(projectId, "worktree.removed", JSON.stringify({ worktreeId: id, branchRetained: row.branch }), removedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.row(this.getRow(projectId, id)!);
  }

  purgeProject(projectId: string, removedAt = Date.now()) {
    const active = this.list(projectId, true).filter((worktree) => worktree.state === "ACTIVE");
    const dirty = active.find((worktree) => worktree.dirty);
    if (dirty) throw Error(`Managed worktree ${dirty.label} has uncommitted changes; commit or remove them before deleting the project`);
    for (const worktree of active) this.remove(projectId, worktree.id, removedAt);
    return active.length;
  }

  private recoverProvisioning() {
    const rows = this.db.prepare("SELECT * FROM project_worktrees WHERE state='PROVISIONING'").all() as WorktreeRow[];
    for (const row of rows) this.recoverRow(row);
  }

  private recoverRow(row: WorktreeRow) {
    try {
      const path = resolve(row.path);
      const valid = existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory() &&
        resolve(git(path, ["rev-parse", "--show-toplevel"])) === path &&
        git(path, ["branch", "--show-current"]) === row.branch;
      this.db.prepare("UPDATE project_worktrees SET state=?,error=?,checked_at=? WHERE id=?")
        .run(valid ? "ACTIVE" : "FAILED", valid ? null : "Provisioning was interrupted before the worktree became valid", Date.now(), row.id);
    } catch (error) {
      this.db.prepare("UPDATE project_worktrees SET state='FAILED',error=?,checked_at=? WHERE id=?")
        .run(error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000), Date.now(), row.id);
    }
  }

  close() {
    this.db.close();
  }
}
