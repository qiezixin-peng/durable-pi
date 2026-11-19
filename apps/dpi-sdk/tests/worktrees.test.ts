import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectRegistry } from "../src/node/projects.js";
import { assessWorktreeReadiness, ProjectWorktreeStore } from "../src/node/worktrees.js";

test("managed Git worktrees isolate branches, report dirtiness and preserve committed branches on removal", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-worktrees-"));
  const repo = join(root, "repo");
  const database = join(root, "projects.sqlite");
  await mkdir(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true,
  }).trim();
  git(repo, "init");
  git(repo, "config", "user.name", "Durable Pi Test");
  git(repo, "config", "user.email", "durable-pi@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  assert.deepEqual(assessWorktreeReadiness(repo), { eligible: true, repositoryRoot: repo, baseRevision: base });
  await writeFile(join(repo, "uncommitted.txt"), "local only\n");
  assert.deepEqual(assessWorktreeReadiness(repo), { eligible: false, reason: "DIRTY_WORKTREE" });
  await unlink(join(repo, "uncommitted.txt"));
  const projects = new ProjectRegistry(database);
  projects.create({ id: "alpha", name: "Alpha" });
  let worktrees = new ProjectWorktreeStore(database, join(root, "managed"));
  try {
    const created = worktrees.create("alpha", {
      id: "coder-one", repositoryRoot: repo, label: "Coder one", branch: "dpi/coder-one",
    }, 1_700_000_000_000);
    assert.equal(created.state, "ACTIVE");
    assert.equal(created.baseRevision, base);
    assert.equal(created.headRevision, base);
    assert.equal(created.dirty, false);
    assert.equal(created.baseIsAncestor, true);
    assert.equal(git(created.path, "branch", "--show-current"), created.branch);
    assert.equal(worktrees.create("alpha", {
      id: "coder-one", repositoryRoot: repo, label: "Coder one", branch: "dpi/coder-one",
    }, 1_700_000_000_100).id, created.id);
    assert.throws(() => worktrees.create("alpha", {
      id: "coder-one", repositoryRoot: repo, label: "Changed", branch: "dpi/coder-one",
    }), /reused with different arguments/);
    worktrees.db.prepare("UPDATE project_worktrees SET state='PROVISIONING' WHERE id=?").run(created.id);
    worktrees.close();
    worktrees = new ProjectWorktreeStore(database, join(root, "managed"));
    assert.equal(worktrees.list("alpha", true).find((item) => item.id === created.id)?.state, "ACTIVE");
    await writeFile(join(created.path, "feature.txt"), "uncommitted\n");
    assert.equal(worktrees.inspect("alpha", created.id).dirty, true);
    assert.throws(() => worktrees.remove("alpha", created.id), /uncommitted changes/);
    assert.throws(() => worktrees.purgeProject("alpha"), /uncommitted changes/);
    git(created.path, "add", "feature.txt");
    git(created.path, "commit", "-m", "feature");
    const checked = worktrees.inspect("alpha", created.id);
    assert.equal(checked.dirty, false);
    assert.notEqual(checked.headRevision, base);
    assert.equal(checked.baseIsAncestor, true);
    const removed = worktrees.remove("alpha", created.id, 1_700_000_001_000);
    assert.equal(removed.state, "REMOVED");
    assert.equal(git(repo, "show-ref", "--verify", `refs/heads/${created.branch}`).length > 0, true, "committed branch is retained");
    const second = worktrees.create("alpha", { repositoryRoot: repo, label: "Coder two", base }, 1_700_000_002_000);
    assert.equal(worktrees.purgeProject("alpha", 1_700_000_003_000), 1);
    assert.equal(worktrees.list("alpha").find((item) => item.id === second.id)?.state, "REMOVED");
    assert.equal(projects.events("alpha").some((event) => event.kind === "worktree.created"), true);
    assert.equal(projects.events("alpha").some((event) => event.kind === "worktree.removed"), true);
  } finally {
    worktrees.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worktrees reject nested repositories, invalid branches and unknown projects", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-worktrees-invalid-"));
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  await mkdir(nested, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init");
  git("config", "user.name", "Durable Pi Test");
  git("config", "user.email", "durable-pi@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-m", "base");
  const database = join(root, "projects.sqlite");
  const projects = new ProjectRegistry(database);
  projects.create({ id: "alpha", name: "Alpha" });
  const worktrees = new ProjectWorktreeStore(database, join(root, "managed"));
  try {
    assert.throws(() => worktrees.create("missing", { repositoryRoot: repo, label: "No project" }), /Unknown project/);
    assert.throws(() => worktrees.create("alpha", { repositoryRoot: nested, label: "Nested" }), /top-level/);
    assert.throws(() => worktrees.create("alpha", { repositoryRoot: repo, label: "Bad", branch: "bad branch" }), /invalid/);
  } finally {
    worktrees.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
