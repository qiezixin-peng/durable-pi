import { createInterface } from "node:readline";

import { ReadOnlyDataSourceMcpServer } from "../../../../dpi-sdk/src/node/data-source-mcp.js";

const server = new ReadOnlyDataSourceMcpServer({
  catalogPath: process.env.DPI_DATA_SOURCE_CATALOG,
  databasePath: process.env.DPI_PROJECT_DATABASE,
  cwd: process.cwd(),
  projectId: process.env.DPI_PROJECT_ID,
  memberId: process.env.DPI_MEMBER_ID,
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const response = await server.handle(JSON.parse(line) as unknown);
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
