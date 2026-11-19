import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PlatformObservabilityStore } from "../src/node/observability.js";

test("observability summarizes operational state without crossing into write logic", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-observability-"));
  const path = join(root, "projects.sqlite");
  const seed = new DatabaseSync(path);
  try {
    seed.exec(`
      CREATE TABLE projects(id TEXT); INSERT INTO projects VALUES('alpha');
      CREATE TABLE project_members(id TEXT,temporary INTEGER,lifecycle_state TEXT);
      INSERT INTO project_members VALUES('a',0,'ACTIVE'),('b',1,'ACTIVE'),('c',1,'ARCHIVED');
      CREATE TABLE project_tasks(id TEXT,status TEXT);
      INSERT INTO project_tasks VALUES('t1','RUNNING'),('t2','FAILED'),('t3','COMPLETED');
      CREATE TABLE project_approvals(id TEXT,status TEXT,expires_at INTEGER);
      INSERT INTO project_approvals VALUES('p','PENDING',2000);
      CREATE TABLE project_artifacts(id TEXT,status TEXT,size_bytes INTEGER);
      INSERT INTO project_artifacts VALUES('x','ACTIVE',123),('y','EXPIRED',50);
      CREATE TABLE project_handoffs(id TEXT,status TEXT); INSERT INTO project_handoffs VALUES('h','READY');
      CREATE TABLE project_worktrees(id TEXT,state TEXT); INSERT INTO project_worktrees VALUES('w','ACTIVE'),('f','FAILED');
      CREATE TABLE project_tool_calls(id TEXT,status TEXT,evidence_kind TEXT);
      INSERT INTO project_tool_calls VALUES
        ('running','STARTED','TOOL'),('test-ok','COMPLETED','TEST'),('test-bad','FAILED','TEST'),
        ('build-ok','COMPLETED','BUILD'),('build-bad','FAILED','BUILD'),('tool-ok','COMPLETED','TOOL');
      CREATE TABLE project_model_usage(id TEXT,total_tokens INTEGER,updated_at INTEGER);
      INSERT INTO project_model_usage VALUES('u',456,1500);
    `);
  } finally {
    seed.close();
  }
  const observability = new PlatformObservabilityStore(path);
  try {
    const summary = observability.summary(2_000);
    assert.equal(summary.projects, 1);
    assert.deepEqual(summary.agents, { active: 2, temporary: 1, archived: 1 });
    assert.equal(summary.tasks.RUNNING, 1);
    assert.equal(summary.tasks.FAILED, 1);
    assert.equal(summary.tasks.QUEUED, 0);
    assert.equal(summary.pendingApprovals, 0, "approval expiring exactly now is no longer pending");
    assert.deepEqual(summary.artifacts, { active: 1, expired: 1, activeBytes: 123 });
    assert.equal(summary.handoffs, 1);
    assert.deepEqual(summary.worktrees, { active: 1, failed: 1 });
    assert.deepEqual(summary.toolCalls, {
      started: 1, completed: 3, failed: 2,
      testsPassed: 1, testsFailed: 1, buildsPassed: 1, buildsFailed: 1,
    });
    assert.equal(summary.tokenUsage24h, 456);
  } finally {
    observability.close();
    await rm(root, { recursive: true, force: true });
  }
});
