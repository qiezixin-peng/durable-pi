import { join } from "node:path";

import { DurableProjectMcpServer } from "../../dpi-sdk/src/node/project-mcp.js";
import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { dpiHome } from "../../dpi-sdk/src/node/registry.js";

const projectId = "cross-device-data-validation";
const databasePath = join(dpiHome(), "projects.sqlite");
const registry = new ProjectRegistry(databasePath);
const project = registry.get(projectId);
const coordinator = project?.members.find((member) => member.role.trim().toLowerCase() === "coordinator");
registry.close();
if (!project || !coordinator) throw Error("Cross-device validation project or Coordinator is missing");

const server = new DurableProjectMcpServer({
  projectId,
  memberId: coordinator.id,
  databasePath,
});

const stage = async (sourceId: string, path: string, requestId: string) => {
  const response = await server.handle({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: "stage_data_artifact",
      arguments: {
        request_id: requestId,
        source_id: sourceId,
        path,
        kind: "cross-device-validation",
        mime_type: "text/plain",
      },
    },
  });
  const result = response?.result as {
    isError?: boolean;
    content?: Array<{ text: string }>;
    structuredContent?: { artifact: { id: string; sha256: string; sizeBytes: number }; replayed: boolean };
  } | undefined;
  if (!result || result.isError || !result.structuredContent)
    throw Error(result?.content?.[0]?.text ?? `Failed to stage ${sourceId}:${path}`);
  return result.structuredContent;
};

try {
  const linux = await stage("linux-home", ".dpi/remote-validation/agent-roundtrip.txt", "verify-linux-artifact-v2");
  const macos = await stage("macos-home", ".dpi/remote-validation/agent-roundtrip.txt", "verify-macos-artifact-v2");
  if (!linux.artifact.sizeBytes || !macos.artifact.sizeBytes) throw Error("A staged artifact was empty");
  if (!/^[a-f0-9]{64}$/.test(linux.artifact.sha256) || !/^[a-f0-9]{64}$/.test(macos.artifact.sha256))
    throw Error("A staged artifact has an invalid SHA-256");
  process.stdout.write(`${JSON.stringify({ ok: true, projectId, linux, macos })}\n`);
} finally {
  server.close();
}
