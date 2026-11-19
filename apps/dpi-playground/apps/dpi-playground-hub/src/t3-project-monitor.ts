import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DurableProjectMcpServer } from "../../../../dpi-sdk/src/node/project-mcp.js";

export interface T3ProjectMonitorOptions {
  t3DatabasePath?: string;
  durableDatabasePath?: string;
  dataSourceCatalogPath?: string;
}

type T3ProjectRow = { project_id: string; workspace_root: string };

/**
 * Registers local T3 projects independently of model behavior. A user opening a
 * project must not need to remember an initialization prompt or select a
 * special provider before Durable policy exists.
 */
export class T3ProjectMonitor {
  private readonly initialized = new Set<string>();
  private readonly t3DatabasePath: string;

  constructor(private readonly options: T3ProjectMonitorOptions = {}) {
    const t3Home = process.env.T3CODE_HOME || join(homedir(), ".t3");
    this.t3DatabasePath = options.t3DatabasePath ?? join(t3Home, "userdata", "statev2.sqlite");
  }

  async runOnce() {
    if (!existsSync(this.t3DatabasePath)) return { discovered: 0, initialized: 0, skipped: 0, errors: 0 };
    const database = new DatabaseSync(this.t3DatabasePath, { readOnly: true });
    let rows: T3ProjectRow[];
    try {
      rows = database.prepare(
        "SELECT project_id, workspace_root FROM projection_projects " +
        "WHERE deleted_at IS NULL ORDER BY created_at ASC",
      ).all() as unknown as T3ProjectRow[];
    } finally {
      database.close();
    }

    let initialized = 0;
    let skipped = 0;
    let errors = 0;
    for (const row of rows) {
      const workspace = resolve(row.workspace_root);
      const key = `${row.project_id}\0${workspace}`;
      if (this.initialized.has(key)) { skipped += 1; continue; }
      if (!existsSync(workspace)) { errors += 1; continue; }
      const server = new DurableProjectMcpServer({
        cwd: workspace,
        autoInitialize: true,
        exactWorkspaceInitialization: true,
        ...(this.options.durableDatabasePath ? { databasePath: this.options.durableDatabasePath } : {}),
        ...(this.options.dataSourceCatalogPath ? { dataSourceCatalogPath: this.options.dataSourceCatalogPath } : {}),
      });
      try {
        const response = await server.handle({ jsonrpc: "2.0", id: "t3-project-monitor", method: "tools/list", params: {} });
        if (response?.error) {
          const error = response.error as { message?: unknown };
          throw Error(typeof error.message === "string" ? error.message : "Durable project initialization failed");
        }
        const result = response?.result as { isError?: boolean; content?: Array<{ text?: unknown }> } | undefined;
        if (result?.isError) {
          const detail = result.content?.find((item) => typeof item.text === "string")?.text;
          throw Error(typeof detail === "string" ? detail : "Durable project initialization failed");
        }
        this.initialized.add(key);
        initialized += 1;
      } catch {
        errors += 1;
      } finally {
        server.close();
      }
    }
    return { discovered: rows.length, initialized, skipped, errors };
  }
}
