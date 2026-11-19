import { T3RuntimeGateway } from "../../dpi-sdk/src/node/t3-runtime.js";

const cwd = process.argv[2] ?? "D:\\三喜\\Agent工具\\Pi协作平台\\durable-pi";
const providerInstanceId = process.argv[3] ?? "codex_durable_coordinator";
const model = process.argv[4] ?? "gpt-6.1-sol";
const marker = "THREE_DEVICE_DATA_ROUNDTRIP_OK";
const result = await new T3RuntimeGateway().run({
  cwd,
  title: "Durable Pi · mounted data source validation",
  message: [
    "This is a read-only data-source check.",
    "Call list_data_sources and list_data_directory on windows-workspace root to verify AGENTS.md is listed.",
    "Then call search_data_text within .dpi/remote-validation for LINUX_SOURCE_CONTENT_OK on linux-home and MACOS_SOURCE_CONTENT_OK on macos-home, followed by read_data_text on both matched files.",
    "Also read .dpi/remote-validation/agent-roundtrip.txt from linux-home and macos-home.",
    `If and only if the source markers are LINUX_SOURCE_CONTENT_OK and MACOS_SOURCE_CONTENT_OK, the roundtrip files are LINUX_AGENT_WRITE_OK and MACOS_AGENT_WRITE_OK, and Windows AGENTS.md exists, reply with exactly ${marker}.`,
    "Do not call shell or ordinary filesystem tools and do not create, edit, move, or delete any file.",
  ].join(" "),
  clientRequestId: `durable-pi-mounted-data-${Date.now()}`,
  providerInstanceId,
  model,
  runtimeMode: "approval-required",
  timeoutMs: 180_000,
});

if (result.status !== "completed")
  throw Error(`Mounted data-source run ended in ${result.status}: ${JSON.stringify(result.activity.slice(-10))}`);
if (result.text.trim() !== marker)
  throw Error(
    `Mounted data-source Agent returned ${JSON.stringify(result.text.trim())}; expected ${marker}; activity=${JSON.stringify(result.activity.slice(-20))}`,
  );

process.stdout.write(`${JSON.stringify({
  ok: true,
  model,
  providerInstanceId,
  projectId: result.projectId,
  threadId: result.threadId,
  runId: result.runId,
  answer: result.text.trim(),
})}\n`);
