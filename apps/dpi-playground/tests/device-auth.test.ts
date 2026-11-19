import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { authenticateRemoteDevice } from "../apps/dpi-playground-hub/src/device-auth.js";

test("remote device authentication is identity-bound, rotatable and individually revocable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-device-auth-"));
  const registry = new NetworkRegistry(join(root, "network.sqlite"));
  const tokenB = `dpi_${"b".repeat(40)}`;
  const tokenC = `dpi_${"c".repeat(40)}`;
  try {
    registry.upsert({ id: "worker-b", url: "http://127.0.0.1:4901", token: tokenB });
    registry.upsert({ id: "worker-c", url: "http://127.0.0.1:4902", token: tokenC });
    assert.equal(authenticateRemoteDevice(registry, "worker-b", `Bearer ${tokenB}`), true);
    assert.equal(authenticateRemoteDevice(registry, "worker-b", `Bearer ${tokenC}`), false);
    assert.equal(authenticateRemoteDevice(registry, "worker-c", `Bearer ${tokenB}`), false);
    assert.equal(authenticateRemoteDevice(registry, undefined, `Bearer ${tokenB}`), false);
    assert.equal(authenticateRemoteDevice(registry, "worker-b", tokenB), false);

    const rotated = `dpi_${"r".repeat(40)}`;
    registry.setToken("worker-b", rotated);
    assert.equal(authenticateRemoteDevice(registry, "worker-b", `Bearer ${tokenB}`), false);
    assert.equal(authenticateRemoteDevice(registry, "worker-b", `Bearer ${rotated}`), true);
    assert.equal(authenticateRemoteDevice(registry, "worker-c", `Bearer ${tokenC}`), true);

    registry.setToken("worker-b", null);
    assert.equal(authenticateRemoteDevice(registry, "worker-b", `Bearer ${rotated}`), false);
    assert.equal(authenticateRemoteDevice(registry, "worker-c", `Bearer ${tokenC}`), true);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
