import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectArtifactStore } from "../src/node/artifacts.js";
import { ProjectRegistry } from "../src/node/projects.js";

test("artifacts are project-scoped, checksummed and metadata-only in SQLite", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "durable-pi-artifact-"));
  const database = join(root, "projects.sqlite");
  const files = join(root, "artifacts");
  const projects = new ProjectRegistry(database);
  const artifacts = new ProjectArtifactStore(database, files, 1_024);
  try {
    projects.create({ id: "alpha", name: "Alpha" });
    projects.create({ id: "beta", name: "Beta" });
    const artifact = artifacts.put("alpha", {
      id: "report-1",
      taskId: "task-1",
      name: "report.md",
      kind: "test-report",
      mimeType: "text/markdown; charset=utf-8",
      content: "# Passed\n",
      includeInHandoff: true,
    });
    assert.equal(artifact.sizeBytes, 9);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(artifacts.list("alpha").length, 1);
    assert.equal(artifacts.list("beta").length, 0);
    assert.equal(artifacts.read("alpha", artifact.id).content.toString("utf8"), "# Passed\n");
    assert.throws(() => artifacts.read("beta", artifact.id), /not found/);
    assert.equal(artifacts.expire("alpha", artifact.id, 1_000).status, "EXPIRED");
    assert.equal(artifacts.list("alpha").length, 0);
    assert.equal(artifacts.list("alpha", "EXPIRED").length, 1);
    assert.deepEqual(artifacts.purgeExpired(2_000, 100, 3_000), {
      purged: 1,
      bytes: 9,
      missing: 0,
      orphanedTombstones: 0,
    });
    assert.equal(artifacts.list("alpha", "EXPIRED").length, 0);
    const streamed = await artifacts.putStream(
      "alpha",
      { id: "audio", name: "sample.bin", mimeType: "application/octet-stream" },
      (async function* () {
        yield Buffer.from([0, 1, 2]);
        yield Buffer.from([3, 4, 5]);
      })(),
    );
    assert.equal(streamed.sizeBytes, 6);
    assert.deepEqual([...artifacts.read("alpha", streamed.id).content], [0, 1, 2, 3, 4, 5]);
    await assert.rejects(
      artifacts.putStream(
        "alpha",
        { id: "too-large-stream", name: "too-large.bin" },
        (async function* () { yield new Uint8Array(1_025); })(),
      ),
      /exceeds/,
    );
    assert.equal((await readdir(join(files, "alpha"))).some((name) => name.includes("too-large-stream")), false);
    assert.equal(artifacts.get("alpha", "too-large-stream"), undefined);
    assert.throws(
      () => artifacts.put("alpha", { name: "large.bin", content: new Uint8Array(1_025) }),
      /exceeds/,
    );

    const expiryBase = Date.now();
    const expiring = artifacts.put("beta", {
      id: "short-lived",
      name: "temporary.txt",
      content: "temporary",
      expiresAt: expiryBase + 10_000,
    }, expiryBase);
    assert.deepEqual(artifacts.expireDue(expiryBase + 9_999), { expired: 0, remaining: 0 });
    assert.equal(artifacts.read("beta", expiring.id).content.toString(), "temporary");
    assert.deepEqual(artifacts.expireDue(expiryBase + 10_000), { expired: 1, remaining: 0 });
    assert.equal(artifacts.get("beta", expiring.id)?.status, "EXPIRED");
    assert.throws(() => artifacts.read("beta", expiring.id), /not found/);
    assert.deepEqual(artifacts.expireDue(expiryBase + 10_000), { expired: 0, remaining: 0 });
    assert.equal((artifacts.db.prepare(
      "SELECT COUNT(*) AS count FROM project_events WHERE project_id='beta' AND kind='artifact.expired'",
    ).get() as { count: number }).count, 1);

    const second = artifacts.put("alpha", { id: "checksum", name: "checksum.txt", content: "original" });
    const stored = (await readdir(join(files, "alpha"))).find((name) => name.startsWith("checksum-"));
    assert.ok(stored);
    await writeFile(join(files, "alpha", stored), "tampered");
    assert.throws(() => artifacts.read("alpha", second.id), /checksum/);
    assert.equal(artifacts.count("alpha"), 2);
    assert.equal(artifacts.list("alpha", "ACTIVE", 1).length, 1);
    assert.equal(artifacts.purgeProject("alpha"), 2);
    assert.equal(artifacts.list("alpha", "ALL").length, 0);
  } finally {
    artifacts.close();
    projects.close();
    await rm(root, { recursive: true, force: true });
  }
});
