import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DeepSeekHarnessClient,
  findDeepSeekHarnessLaunchSpec,
  inspectDshCredentialsFile,
  type DeepSeekHarnessToolEvent,
} from "../src/node/deepseek-harness-client.js";

test("DeepSeekHarnessClient reuses desktop .dsh/.credentials.yaml login, maps permission-mode/approval-policy/add-dir/session-id, and parses NDJSON events", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-dsh-client-"));
  try {
    const dshHome = join(root, ".dsh");
    const workspace = join(root, "workspace");
    const sharedGit = join(root, "repo-git");
    await mkdir(dshHome, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(sharedGit, { recursive: true });

    await writeFile(
      join(dshHome, ".credentials.yaml"),
      [
        "version: 1",
        "records:",
        "  - kind: deepseek-account",
        "    payload:",
        "      version: 1",
        "      token: dsh-desktop-oauth-token",
        "      issuer: https://chat.deepseek.com",
      ].join("\n"),
      "utf8",
    );

    const credInfo = inspectDshCredentialsFile(dshHome);
    assert.equal(credInfo.hasAccountToken, true);

    const fakeScript = join(root, "fake-dsh.mjs");
    await writeFile(
      fakeScript,
      `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const patchIdx = args.indexOf("--patch");
const patchContent = patchIdx >= 0 ? readFileSync(args[patchIdx + 1], "utf8") : "";
const permIdx = args.indexOf("--permission-mode");
const permMode = permIdx >= 0 ? args[permIdx + 1] : "";
const approvalIdx = args.indexOf("--approval-policy");
const approval = approvalIdx >= 0 ? args[approvalIdx + 1] : "";
const sessionIdx = args.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : "session-new-123";
const addDirIdx = args.indexOf("--add-dir");
const addDir = addDirIdx >= 0 ? args[addDirIdx + 1] : "";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "session", sessionId, cwd: process.cwd() });
emit({ type: "status", phase: "turn_start", turn: 1 });
emit({ type: "status", phase: "step_start", turn: 1, step: 1 });
emit({
  type: "tool_call",
  callId: "call-1",
  tool: "read",
  input: { path: "README.md" },
});
emit({
  type: "tool_result",
  callId: "call-1",
  status: "completed",
  result: "file content",
});
const hasAccountPatch = patchContent.includes('"deepseek-account"') && patchContent.includes("id: deepseek-account");
const summary = [
  "DSH_HEADLESS_OK",
  "perm=" + permMode,
  "approval=" + approval,
  "accountPatch=" + hasAccountPatch,
  "hasAddDir=" + Boolean(addDir),
].join("|");
emit({ type: "text", text: summary });
emit({
  type: "status",
  phase: "step_end",
  turn: 1,
  step: 1,
  usage: {
    inputTokens: 500,
    outputTokens: 40,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    reasoningTokens: 15,
    totalTokens: 640,
  },
});
emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
emit({
  type: "final",
  sessionId,
  reason: { kind: "completed" },
  text: summary,
});
`,
      "utf8",
    );

    const client = new DeepSeekHarnessClient({
      command: process.execPath,
      commandArgs: [fakeScript],
      dshHome,
      env: {},
    });

    const toolEvents: DeepSeekHarnessToolEvent[] = [];
    const result = await client.runTurn({
      cwd: workspace,
      modelId: "deepseek-flash",
      prompt: "inspect workspace",
      permissionMode: "workspace-write",
      approvalPolicy: "never",
      sessionId: "session-resume-42",
      additionalWritableDirs: [sharedGit],
      onToolEvent: (ev) => toolEvents.push(ev),
    });

    assert.equal(result.sessionId, "session-resume-42");
    assert.equal(result.authRoute, "deepseek-account");
    assert.equal(
      result.text,
      "DSH_HEADLESS_OK|perm=workspace-write|approval=never|accountPatch=true|hasAddDir=true",
    );
    assert.equal(result.sideEffectToolObserved, false);
    assert.deepEqual(result.usage, {
      inputTokens: 500,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      reasoningOutputTokens: 15,
      totalTokens: 640,
    });
    assert.equal(toolEvents.length, 2);
    assert.equal(toolEvents[0]?.event, "started");
    assert.equal(toolEvents[0]?.toolName, "read");
    assert.equal(toolEvents[1]?.event, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DeepSeekHarnessClient enforces workspace confinement, blocks write tools in read-only mode, and terminates descendant process tree on abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-dsh-boundary-"));
  try {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });

    const escapeScript = join(root, "escape-dsh.mjs");
    await writeFile(
      escapeScript,
      `
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "session", sessionId: "session-escape", cwd: process.cwd() });
emit({
  type: "tool_call",
  callId: "escape-1",
  tool: "write",
  input: { path: "../outside/pwned.txt", content: "bad" },
});
setTimeout(() => {}, 10000);
`,
      "utf8",
    );

    const client = new DeepSeekHarnessClient({
      command: process.execPath,
      commandArgs: [escapeScript],
      dshHome: root,
    });

    await assert.rejects(
      () =>
        client.runTurn({
          cwd: workspace,
          modelId: "deepseek-flash",
          prompt: "attempt escape",
          permissionMode: "workspace-write",
        }),
      /resolves outside allowed workspace roots/,
    );

    await assert.rejects(
      () =>
        client.runTurn({
          cwd: workspace,
          modelId: "deepseek-flash",
          prompt: "attempt write in read-only",
          permissionMode: "read-only",
        }),
      /Read-only task forbade side-effect tool/,
    );

    // Verify process tree cancellation kills grandchild process
    const grandchildPidFile = join(root, "grandchild.pid");
    const treeScript = join(root, "tree-dsh.mjs");
    await writeFile(
      treeScript,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");
process.stdout.write(JSON.stringify({ type: "session", sessionId: "session-tree", cwd: process.cwd() }) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const treeClient = new DeepSeekHarnessClient({
      command: process.execPath,
      commandArgs: [treeScript],
      dshHome: root,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);

    await assert.rejects(
      () =>
        treeClient.runTurn({
          cwd: workspace,
          modelId: "deepseek-flash",
          prompt: "hang until abort",
          permissionMode: "read-only",
          signal: controller.signal,
        }),
      /aborted/,
    );
    if (existsSync(grandchildPidFile)) {
      const grandchildPid = Number((await import("node:fs")).readFileSync(grandchildPidFile, "utf8").trim());
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Real desktop DeepSeek Harness (dsh headless --json) executes a read-only turn when installed and authenticated", async (t) => {
  const spec = findDeepSeekHarnessLaunchSpec();
  const creds = inspectDshCredentialsFile(join(process.env.USERPROFILE || process.env.HOME || "", ".dsh"));
  if (!spec.installed || (!creds.hasAccountToken && !creds.hasStoredSecret && !process.env.DEEPSEEK_API_KEY)) {
    t.skip("Desktop DeepSeek Harness is not installed or authenticated on this machine");
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "dpi-dsh-live-"));
  try {
    const client = new DeepSeekHarnessClient();
    const result = await client.runTurn({
      cwd: workspace,
      modelId: "deepseek-flash",
      prompt: "Reply with the exact token DSH_LIVE_VERIFIED and do not call any tools.",
      permissionMode: "read-only",
      approvalPolicy: "never",
      timeoutMs: 30_000,
    });
    assert.ok(result.sessionId.startsWith("session-"));
    assert.match(result.text, /DSH_LIVE_VERIFIED/);
    assert.equal(result.sideEffectToolObserved, false);
    assert.ok((result.usage?.totalTokens ?? 0) > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
