import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { faux, tempStore } from "./helpers.js";

test("mandatory platform policy blocks destructive shell and file escapes before execution", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Policy", cwd: "project", model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    let request = 0;
    const turn = async (content: string) => {
      const submission = await store.send(c, { content, requestId: `policy-${++request}` });
      const result = await store.settled(h, submission.id as number, 20_000);
      assert.equal(result.status, "done");
    };

    await turn("write: safe.txt | allowed");
    assert.ok(existsSync(join(t.work, "project", "safe.txt")));

    const escaped = join(t.root, "escaped.txt");
    await turn(`write: ${escaped} | denied`);
    assert.equal(existsSync(escaped), false);
    assert.match(JSON.stringify((await store.entries(c, undefined, 6)).items), /path is outside the session root/);

    const doomed = join(t.work, "project", "doomed");
    await (await import("node:fs/promises")).mkdir(doomed);
    await turn("!rm -rf doomed");
    assert.ok(existsSync(doomed));
    assert.match(JSON.stringify((await store.entries(c, undefined, 6)).items), /destructive command requires approval/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
