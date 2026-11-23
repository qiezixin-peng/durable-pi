import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiLocalClient, type PiLocalToolEvent } from "../src/node/pi-local-client.js";

test("PiLocalClient enforces read-only tools, parses LF JSONL stream, records tool calls and token usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-pi-local-"));
  const fakePi = join(dir, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `
const args = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "session", version: 3, id: "pi-sess-123", timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } });
emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "ARGS=" + JSON.stringify(args) }],
    usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 0, totalTokens: 175 },
  },
});
emit({ type: "agent_settled" });
`,
    "utf8",
  );

  try {
    const client = new PiLocalClient({
      command: process.execPath,
      commandArgs: [fakePi],
      sessionDir: join(dir, "sessions"),
    });
    const events: PiLocalToolEvent[] = [];
    const result = await client.runTurn({
      cwd: dir,
      provider: "deepseek",
      modelId: "deepseek-reasoner",
      prompt: "Review README.md",
      readOnly: true,
      onToolEvent: (event) => events.push(event),
    });

    assert.equal(result.sessionId, "pi-sess-123");
    assert.equal(result.sideEffectToolObserved, false);
    assert.deepEqual(result.usage, {
      inputTokens: 120,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 45,
      reasoningOutputTokens: 0,
      totalTokens: 175,
    });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "started");
    assert.equal(events[0]?.toolName, "read");
    assert.equal(events[1]?.event, "completed");

    const parsedArgs = JSON.parse(result.text.replace(/^ARGS=/, "")) as string[];
    assert.equal(parsedArgs.includes("--no-mcp"), true);
    assert.equal(parsedArgs[parsedArgs.indexOf("--provider") + 1], "deepseek");
    assert.equal(parsedArgs[parsedArgs.indexOf("--model") + 1], "deepseek-reasoner");
    assert.equal(parsedArgs[parsedArgs.indexOf("--tools") + 1], "read,grep,find,ls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiLocalClient rejects write mode and forbids side-effect tool execution in read-only mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-pi-local-err-"));
  const fakePi = join(dir, "fake-pi-fail.mjs");
  writeFileSync(
    fakePi,
    `
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "w-1", toolName: "write", args: { path: "a.txt" } }) + "\\n");
setTimeout(() => {}, 10000);
`,
    "utf8",
  );

  try {
    const client = new PiLocalClient({ command: process.execPath, commandArgs: [fakePi] });
    await assert.rejects(
      () => client.runTurn({
        cwd: dir,
        provider: "deepseek",
        modelId: "deepseek-flash",
        prompt: "Edit a.txt",
        readOnly: false,
      }),
      /only supports hard read-only execution/,
    );

    await assert.rejects(
      () => client.runTurn({
        cwd: dir,
        provider: "deepseek",
        modelId: "deepseek-flash",
        prompt: "Attempt write in readOnly mode",
        readOnly: true,
      }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /Read-only task forbade side-effect tool/);
        assert.equal((error as { sideEffectToolObserved?: boolean }).sideEffectToolObserved, true);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
