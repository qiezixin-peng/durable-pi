import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AntigravityClient,
  buildOAuthOnlyAntigravityEnv,
  inspectAntigravityCliInstallation,
} from "../src/node/antigravity-client.js";
import { WorkspaceBoundaryError } from "../src/node/workspace-confinement.js";

test("buildOAuthOnlyAntigravityEnv strips Gemini and Google API keys so Antigravity CLI uses Google account OAuth only", () => {
  const sanitized = buildOAuthOnlyAntigravityEnv({
    PATH: "/usr/bin",
    GEMINI_API_KEY: "AIza-secret",
    gemini_api_key: "AIza-lower",
    GOOGLE_API_KEY: "AIza-google",
    GOOGLE_GENAI_API_KEY: "AIza-genai",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    SAFE_VAR: "keep-me",
  });
  assert.equal(sanitized.GEMINI_API_KEY, undefined);
  assert.equal(sanitized.gemini_api_key, undefined);
  assert.equal(sanitized.GOOGLE_API_KEY, undefined);
  assert.equal(sanitized.GOOGLE_GENAI_API_KEY, undefined);
  assert.equal(sanitized.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(sanitized.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(sanitized.SAFE_VAR, "keep-me");
});

test("inspectAntigravityCliInstallation isolates CLI/T3 account from Desktop Antigravity", () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-agy-iso-"));
  const geminiHome = join(root, ".gemini");
  const t3UserDataDir = join(root, ".t3", "userdata");
  const env = { ...process.env, DPI_ANTIGRAVITY_APP_DATA_DIR: "antigravity-cli-isolated" };
  try {
    // Populate Desktop Antigravity state ONLY — CLI must stay unauthenticated!
    mkdirSync(join(geminiHome, "antigravity", "conversations"), { recursive: true });
    writeFileSync(
      join(geminiHome, "antigravity", "antigravity_state.pbtxt"),
      "agent_onboarding_completed:  AGENT_ONBOARDING_STATE_COMPLETED\n",
      "utf8",
    );
    writeFileSync(join(geminiHome, "antigravity", "conversations", "desktop-only.db"), "dummy", "utf8");

    const beforeCliLogin = inspectAntigravityCliInstallation(geminiHome, env, t3UserDataDir);
    assert.equal(beforeCliLogin.authenticated, false);
    assert.equal(beforeCliLogin.authSource, "none");

    // Once the real CLI OAuth token shape exists in the isolated CLI home, CLI becomes authenticated.
    mkdirSync(join(geminiHome, "antigravity-cli-isolated"), { recursive: true });
    writeFileSync(
      join(geminiHome, "antigravity-cli-isolated", "antigravity-oauth-token"),
      JSON.stringify({
        token: { refresh_token: "cli-only-refresh-token", access_token: "cli-only-access-token" },
        auth_method: "oauth",
        id_token_email: "cli@example.invalid",
      }),
      "utf8",
    );
    const afterCliLogin = inspectAntigravityCliInstallation(geminiHome, env, t3UserDataDir);
    assert.equal(afterCliLogin.authenticated, true);
    assert.equal(afterCliLogin.authSource, "antigravity-cli-account");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AntigravityClient runs agy CLI in sandboxed plan/accept-edits mode, strips API keys, resumes --conversation, and parses stream-json", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-agy-cli-test-"));
  const geminiHome = join(root, ".gemini");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  try {
    const fakeAgyJs = join(root, "fake-agy.mjs");
    writeFileSync(
      fakeAgyJs,
      `
import { join } from "node:path";

if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY) {
  console.error("API KEY LEAKED INTO AGY CLI");
  process.exit(99);
}

const args = process.argv.slice(2);
if (!args.includes("--print") || !args.includes("--sandbox") || !args.includes("--disable-slash-commands")) {
  console.error("Missing required flags: " + args.join(" "));
  process.exit(98);
}
if (args.includes("--dangerously-skip-permissions")) {
  console.error("Forbidden --dangerously-skip-permissions flag");
  process.exit(97);
}

const convIdx = args.indexOf("--conversation");
const isResume = convIdx >= 0;
const convId = isResume ? args[convIdx + 1] : "agy-cli-conv-001";

const readmePath = join(process.cwd(), "README.md");
if (!isResume) {
  if (args[args.indexOf("--mode") + 1] !== "plan") {
    console.error("Expected --mode plan for read-only turn");
    process.exit(96);
  }
  console.log(JSON.stringify({ type: "tool_use", conversation_id: convId, tool_id: "call-1", tool_name: "read_file", parameters: { path: readmePath } }));
  console.log(JSON.stringify({ type: "tool_result", conversation_id: convId, tool_id: "call-1", status: "ok", output: "# Durable Pi" }));
  console.log(JSON.stringify({ type: "message", conversation_id: convId, role: "assistant", content: "AGY_CLI_READ_ONLY_OK" }));
  console.log(JSON.stringify({ type: "result", conversation_id: convId, status: "success", stats: { input_tokens: 120, cached_tokens: 30, output_tokens: 25, total_tokens: 175 } }));
} else {
  console.log(JSON.stringify({ type: "message", conversation_id: convId, role: "assistant", content: "AGY_CLI_RESUMED_OK" }));
  console.log(JSON.stringify({ type: "result", conversation_id: convId, status: "success", stats: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } }));
}
`,
      "utf8",
    );

    const client = new AntigravityClient({
      executablePath: process.execPath,
      argsPrefix: [fakeAgyJs],
      geminiHome,
      appDataDirName: "antigravity-cli-isolated",
      env: {
        ...process.env,
        GEMINI_API_KEY: "should-be-stripped",
        GOOGLE_API_KEY: "should-be-stripped",
      },
    });

    const first = await client.runTurn({
      cwd: workspace,
      modelId: "google/gemini-4-neon",
      prompt: "Read README.md",
      readOnly: true,
    });

    assert.equal(first.sessionId, "agy-cli-conv-001");
    assert.equal(first.text, "AGY_CLI_READ_ONLY_OK");
    assert.equal(first.toolEvents.length, 2);
    assert.equal(first.toolEvents[0]?.event, "started");
    assert.equal(first.toolEvents[0]?.toolName, "read_file");
    assert.equal(first.toolEvents[1]?.event, "completed");
    assert.equal(first.usage.inputTokens, 120);
    assert.equal(first.usage.cachedInputTokens, 30);
    assert.equal(first.usage.outputTokens, 25);

    const resumed = await client.runTurn({
      cwd: workspace,
      modelId: "google/gemini-4-neon",
      sessionId: first.sessionId,
      prompt: "Follow up question",
      readOnly: true,
    });
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.text, "AGY_CLI_RESUMED_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AntigravityClient enforces workspace path confinement, rejects unsandboxed shell tools, and flags side-effect write failure cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-agy-cli-boundary-"));
  const geminiHome = join(root, ".gemini");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });

  try {
    const fakeAgyJs = join(root, "fake-agy-boundary.mjs");
    writeFileSync(
      fakeAgyJs,
      `
import { join } from "node:path";

const mode = process.env.TEST_BOUNDARY_MODE || "outside-write";
const outsideFile = process.env.TEST_OUTSIDE_FILE;
const insideFile = join(process.cwd(), "src", "ok.ts");

if (mode === "outside-write") {
  console.log(JSON.stringify({ type: "tool_use", tool_id: "escape-1", tool_name: "write_file", parameters: { path: outsideFile, content: "pwn" } }));
} else if (mode === "shell-tool") {
  console.log(JSON.stringify({ type: "tool_use", tool_id: "shell-1", tool_name: "run_command", parameters: { CommandLine: "whoami" } }));
} else if (mode === "fail-after-valid-write") {
  console.log(JSON.stringify({ type: "tool_use", tool_id: "write-ok", tool_name: "write_file", parameters: { path: insideFile, content: "export const ok = 1;" } }));
  console.log(JSON.stringify({ type: "tool_result", tool_id: "write-ok", status: "ok", output: "Created file." }));
  console.error("Simulated crash after write tool");
  process.exit(1);
}
`,
      "utf8",
    );

    const outsideClient = new AntigravityClient({
      executablePath: process.execPath,
      argsPrefix: [fakeAgyJs],
      geminiHome,
      env: {
        ...process.env,
        TEST_BOUNDARY_MODE: "outside-write",
        TEST_OUTSIDE_FILE: join(outside, "pwn.txt"),
      },
    });
    await assert.rejects(
      () =>
        outsideClient.runTurn({
          cwd: workspace,
          modelId: "gemini-4-neon",
          prompt: "attempt escape",
          readOnly: false,
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceBoundaryError);
        assert.match(err.message, /resolves outside allowed workspace roots/);
        assert.equal((err as { sideEffectToolObserved?: boolean }).sideEffectToolObserved, undefined);
        return true;
      },
    );

    const shellClient = new AntigravityClient({
      executablePath: process.execPath,
      argsPrefix: [fakeAgyJs],
      geminiHome,
      env: {
        ...process.env,
        TEST_BOUNDARY_MODE: "shell-tool",
      },
    });
    await assert.rejects(
      () =>
        shellClient.runTurn({
          cwd: workspace,
          modelId: "gemini-4-neon",
          prompt: "attempt shell",
          readOnly: false,
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceBoundaryError);
        assert.match(err.message, /forbade unsandboxed shell tool/i);
        return true;
      },
    );

    const validWriteThenFailClient = new AntigravityClient({
      executablePath: process.execPath,
      argsPrefix: [fakeAgyJs],
      geminiHome,
      env: {
        ...process.env,
        TEST_BOUNDARY_MODE: "fail-after-valid-write",
      },
    });
    await assert.rejects(
      () =>
        validWriteThenFailClient.runTurn({
          cwd: workspace,
          modelId: "gemini-4-neon",
          prompt: "write inside workspace then fail",
          readOnly: false,
        }),
      (err: unknown) => {
        assert.equal((err as { sideEffectToolObserved?: boolean }).sideEffectToolObserved, true);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
