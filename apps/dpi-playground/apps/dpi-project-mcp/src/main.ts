import { createInterface } from "node:readline";

import { DurableProjectMcpServer } from "../../../../dpi-sdk/src/node/project-mcp.js";
import {
  ReadOnlyDataSourceMcpServer,
  READ_ONLY_DATA_SOURCE_TOOL_NAMES,
} from "../../../../dpi-sdk/src/node/data-source-mcp.js";
import { T3CodeClient } from "../../../../dpi-sdk/src/node/t3-code.js";

const t3 = new T3CodeClient({ timeoutMs: 10_000 });

const server = new DurableProjectMcpServer({
  cwd: process.cwd(),
  projectId: process.env.DPI_PROJECT_ID,
  memberId: process.env.DPI_MEMBER_ID,
  databasePath: process.env.DPI_PROJECT_DATABASE,
  dataSourceCatalogPath: process.env.DPI_DATA_SOURCE_CATALOG,
  artifactRoot: process.env.DPI_ARTIFACT_ROOT,
  relayScriptPath: process.env.DPI_RELAY_SCRIPT,
  returnScriptPath: process.env.DPI_RETURN_SCRIPT,
  integrationScriptPath: process.env.DPI_INTEGRATION_SCRIPT,
  autoInitialize: process.env.DPI_AUTO_INITIALIZE === "1",
  t3EnvironmentLister: () => t3.listEnvironments(),
});
const dataServer = new ReadOnlyDataSourceMcpServer({
  catalogPath: process.env.DPI_DATA_SOURCE_CATALOG,
  databasePath: process.env.DPI_PROJECT_DATABASE,
  cwd: process.cwd(),
  projectId: process.env.DPI_PROJECT_ID,
  memberId: process.env.DPI_MEMBER_ID,
});

const handle = async (message: unknown) => {
  const request = message && typeof message === "object" ? message as Record<string, unknown> : {};
  if (request.method === "tools/list") {
    // Project initialization must happen first so the data facade can resolve
    // the newly created project in this same request.
    const project = await server.handle(message) as { result?: { tools?: unknown[] } } | undefined;
    const data = await dataServer.handle(message) as { result?: { tools?: unknown[] } } | undefined;
    if (project?.result?.tools && data?.result?.tools)
      project.result.tools.push(...data.result.tools);
    return project;
  }
  if (request.method === "tools/call") {
    const params = request.params && typeof request.params === "object"
      ? request.params as { name?: unknown }
      : undefined;
    if (typeof params?.name === "string" && READ_ONLY_DATA_SOURCE_TOOL_NAMES.has(params.name))
      return dataServer.handle(message);
  }
  return server.handle(message);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const response = await handle(JSON.parse(line) as unknown);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
    })}\n`);
  }
}

server.close();
dataServer.close();
