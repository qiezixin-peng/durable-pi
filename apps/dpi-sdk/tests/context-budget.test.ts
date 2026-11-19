import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleContext, contextRelevance, estimateTokens } from "../src/context-budget.js";

test("context relevance ranks matching English and Chinese facts without exceeding its bound", () => {
  assert.ok(
    contextRelevance("debug the SQLite lease failure", "debugging.root_cause SQLite lease expired") >
      contextRelevance("debug the SQLite lease failure", "frontend colors and typography"),
  );
  assert.ok(contextRelevance("修复音频打标错误", "音频打标模型的错误处理") > 0);
  assert.equal(contextRelevance("", "anything"), 0);
  assert.ok(contextRelevance("same same", "same") <= 100);
});

test("context budget protects required work and records lower-priority truncation", () => {
  assert.ok(estimateTokens("中文 context") >= 3);
  const result = assembleContext(
    [
      { id: "task", content: "[Current task]\n实现功能", priority: 1000, required: true, truncatable: false },
      { id: "architecture", content: `architecture ${"A".repeat(120)}`, priority: 100 },
      { id: "notes", content: `notes ${"B".repeat(500)}`, priority: 10 },
    ],
    { maxContextTokens: 100, reservedOutputTokens: 20, reservedToolTokens: 20 },
  );
  assert.ok(result.report.included.includes("task"));
  assert.ok(result.report.included.includes("architecture"));
  assert.ok(result.report.truncated.length + result.report.excluded.length > 0);
  assert.ok(result.report.estimatedPromptTokens <= result.report.promptBudgetTokens);
});

test("context budget refuses to silently truncate an oversized required task", () => {
  assert.throws(
    () =>
      assembleContext(
        [{ id: "task", content: "x".repeat(1_000), priority: 1, required: true, truncatable: false }],
        { maxContextTokens: 50, reservedOutputTokens: 10, reservedToolTokens: 10 },
      ),
    /Required context section exceeds/,
  );
});
