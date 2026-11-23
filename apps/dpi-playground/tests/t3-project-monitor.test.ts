import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { T3ProjectMonitor } from "../apps/dpi-playground-hub/src/t3-project-monitor.js";

test("T3 project monitor durably registers every active local project without a model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-t3-project-monitor-"));
  try {
    const workspace = join(root, "ArtCooker");
    await mkdir(workspace);
    await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true }));
    const t3Database = join(root, "statev2.sqlite");
    const t3 = new DatabaseSync(t3Database);
    t3.exec("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, created_at TEXT, deleted_at TEXT)");
    t3.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, NULL)")
      .run("t3-artcooker", workspace, new Date().toISOString());
    t3.close();
    const durableDatabase = join(root, "projects.sqlite");
    const catalog = join(root, "data-sources.json");
    await writeFile(catalog, JSON.stringify({ version: 1, sources: [] }));
    const monitor = new T3ProjectMonitor({
      t3DatabasePath: t3Database,
      durableDatabasePath: durableDatabase,
      dataSourceCatalogPath: catalog,
    });

    assert.deepEqual(await monitor.runOnce(), { discovered: 1, initialized: 1, skipped: 0, errors: 0 });
    assert.deepEqual(await monitor.runOnce(), { discovered: 1, initialized: 0, skipped: 1, errors: 0 });
    const registry = new ProjectRegistry(durableDatabase);
    const project = registry.list().find((candidate) => candidate.name === "ArtCooker");
    assert.equal(project?.templateId, "web");
    assert.equal(project?.autonomyMode, "RESTRICTED_UNATTENDED");
    assert.equal(project?.members[0]?.role, "coordinator");
    assert.equal(project?.members[0]?.permissionProfile, "READ_ONLY");
    registry.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
