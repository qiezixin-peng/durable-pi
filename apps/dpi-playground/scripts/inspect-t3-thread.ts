import { T3CodeClient } from "../../dpi-sdk/src/node/t3-code.js";
import { T3McpClient } from "../../dpi-sdk/src/node/t3-mcp.js";

const environmentId = process.argv[2];
const threadId = process.argv[3];
if (!threadId) throw Error("Usage: inspect-t3-thread.ts <environment-id-or-dash> <thread-id>");

const client = await T3McpClient.pair(new T3CodeClient(), {
  access: "read-only",
  ttl: "5m",
  label: "Durable Pi thread inspection",
});
try {
  await client.initialize();
  const result = await client.readThread({
    ...(environmentId && environmentId !== "-" ? { environmentId } : {}),
    threadId,
    view: "activity",
    limit: 100,
    runLimit: 10,
    maxCharsPerItem: 20_000,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
