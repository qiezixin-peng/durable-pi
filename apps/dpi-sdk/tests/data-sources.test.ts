import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DataSourceBindingStore, ReadOnlyDataSourceCatalog } from "../src/node/data-sources.js";

test("data sources list, search and read text without allowing path or symlink escape", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-data-source-"));
  try {
    const root = join(temporary, "source");
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, ".ssh"), { recursive: true });
    mkdirSync(join(root, ".grok"), { recursive: true });
    mkdirSync(join(root, ".dpi"), { recursive: true });
    writeFileSync(join(root, "notes", "music-plan.md"), "hello data source");
    writeFileSync(join(root, "notes", "large.txt"), "x".repeat(1_000_100));
    writeFileSync(join(root, ".ssh", "id_ed25519"), "PRIVATE KEY MATERIAL");
    writeFileSync(join(root, ".env"), "API_KEY=PRIVATE VALUE");
    writeFileSync(join(root, ".npmrc"), "//registry.example/:_authToken=PRIVATE VALUE");
    writeFileSync(join(root, ".grok", "README.md"), "CLI PRIVATE AREA");
    writeFileSync(join(root, ".dpi", "projects.sqlite"), "RUNTIME PRIVATE AREA");
    writeFileSync(join(root, "notes", "client.pem"), "PRIVATE CERTIFICATE MATERIAL");
    writeFileSync(join(temporary, "outside.txt"), "secret");
    let symlinkCreated = false;
    try {
      symlinkSync(join(temporary, "outside.txt"), join(root, "outside-link.txt"));
      symlinkCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    const catalogPath = join(temporary, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [{ id: "device-b", label: "Device B", root, device: "linux", readOnly: true }],
    }));
    const catalog = new ReadOnlyDataSourceCatalog(catalogPath);

    assert.equal(catalog.list()[0]?.reachable, true);
    assert.equal(catalog.listDirectory("device-b", "notes").entries.some((entry) => entry.name === "music-plan.md"), true);
    assert.equal(catalog.readText("device-b", "notes/music-plan.md").text, "hello data source");
    const boundedLarge = catalog.readText("device-b", "notes/large.txt", 100);
    assert.equal(boundedLarge.sizeBytes, 1_000_100);
    assert.equal(boundedLarge.returnedBytes, 100);
    assert.equal(boundedLarge.truncated, true);
    assert.equal(
      catalog.readText("device-b", "notes/music-plan.md").returnedSha256,
      "02218570a9bc5a775dd60f83a030a3bd6b2e54828b5a9a4ae0aa1374ce115bb9",
    );
    assert.equal(Number.isSafeInteger(catalog.readText("device-b", "notes/music-plan.md").modifiedAtMs), true);
    assert.equal(catalog.searchFiles("device-b", "music").matches[0]?.path, "notes/music-plan.md");
    assert.equal(catalog.searchText("device-b", "hello").matches[0]?.path, "notes/music-plan.md");
    assert.equal(catalog.listDirectory("device-b").entries.some((entry) =>
      [".ssh", ".grok", ".dpi", ".env", ".npmrc"].includes(entry.name)), false);
    assert.equal(catalog.listDirectory("device-b", "notes").entries.some((entry) => entry.name === "client.pem"), false);
    assert.deepEqual(catalog.searchFiles("device-b", "id_ed25519").matches, []);
    assert.deepEqual(catalog.searchText("device-b", "PRIVATE").matches, []);
    assert.throws(() => catalog.readText("device-b", ".ssh/id_ed25519"), /Sensitive credential/);
    assert.throws(() => catalog.readText("device-b", ".env"), /Sensitive credential/);
    assert.throws(() => catalog.readText("device-b", ".npmrc"), /Sensitive credential/);
    assert.throws(() => catalog.readText("device-b", ".grok/README.md"), /Sensitive credential/);
    assert.throws(() => catalog.readText("device-b", ".dpi/projects.sqlite"), /Sensitive credential/);
    assert.throws(() => catalog.openBinary("device-b", "notes/client.pem"), /Sensitive credential/);
    assert.throws(() => catalog.readText("device-b", "../outside.txt"), /escape/);
    if (symlinkCreated)
      assert.throws(() => catalog.readText("device-b", "outside-link.txt"), /symbolic links/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("data-source project bindings update atomically without exposing sources to other projects", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-data-binding-"));
  try {
    const first = join(temporary, "first");
    const second = join(temporary, "second");
    mkdirSync(first);
    mkdirSync(second);
    const catalogPath = join(temporary, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [
        { id: "device-a", label: "Device A", root: first, device: "windows", readOnly: true },
        { id: "device-b", label: "Device B", root: second, device: "linux", projectIds: ["other"], readOnly: true },
      ],
    }));
    const store = new DataSourceBindingStore(catalogPath);
    const updated = store.setProjectSources("alpha", ["device-a"]);
    assert.equal(updated.find((source) => source.id === "device-a")?.bound, true);
    assert.equal(updated.find((source) => source.id === "device-b")?.bound, false);
    assert.deepEqual(store.boundSourceIds("alpha"), ["device-a"]);
    assert.equal(store.boundSource("alpha", "device-a")?.label, "Device A");
    assert.equal(store.boundSource("other", "device-a"), undefined);
    assert.equal(store.list("alpha").find((source) => source.id === "device-a")?.error, null);
    const catalog = new ReadOnlyDataSourceCatalog(catalogPath);
    assert.deepEqual(catalog.list("alpha").map((source) => source.id), ["device-a"]);
    assert.deepEqual(catalog.list("other").map((source) => source.id), ["device-b"]);
    assert.throws(() => store.setProjectSources("alpha", ["missing"]), /Unknown data source/);

    const abandonedLock = `${catalogPath}.bindings.lock`;
    writeFileSync(abandonedLock, "terminated-owner");
    const stale = new Date(Date.now() - 31_000);
    utimesSync(abandonedLock, stale, stale);
    store.setProjectSources("alpha", ["device-b"]);
    assert.equal(existsSync(abandonedLock), false);
    assert.deepEqual(new ReadOnlyDataSourceCatalog(catalogPath).list("alpha").map((source) => source.id), ["device-b"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("project data-folder grants prevent root-wide browsing and support multiple exact folders", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-data-folders-"));
  try {
    const root = join(temporary, "source");
    mkdirSync(join(root, "music", "models"), { recursive: true });
    mkdirSync(join(root, "design", "notes"), { recursive: true });
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(join(root, "music", "models", "labels.md"), "genre label model");
    writeFileSync(join(root, "design", "notes", "ui.md"), "project user interface");
    writeFileSync(join(root, "private", "secret.txt"), "not authorized");
    const catalogPath = join(temporary, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [{
        id: "device-b", label: "Device B", root, device: "linux", readOnly: true,
        projectIds: ["alpha"], projectPaths: { alpha: [] },
      }],
    }));
    const store = new DataSourceBindingStore(catalogPath);
    assert.throws(() => new ReadOnlyDataSourceCatalog(catalogPath).listDirectory("device-b", "", 20, "alpha"), /No data folders/);
    assert.deepEqual(store.grantProjectFolder("alpha", "device-b", "music/models"), ["music/models"]);
    assert.deepEqual(store.grantProjectFolder("alpha", "device-b", "design/notes"), ["music/models", "design/notes"]);

    const catalog = new ReadOnlyDataSourceCatalog(catalogPath);
    assert.deepEqual(catalog.list("alpha")[0]?.folders, ["music/models", "design/notes"]);
    assert.deepEqual(catalog.listDirectory("device-b", "", 20, "alpha").entries.map((entry) => entry.name), ["design", "music"]);
    assert.equal(catalog.readText("device-b", "music/models/labels.md", 1000, "alpha").text, "genre label model");
    assert.throws(() => catalog.readText("device-b", "private/secret.txt", 1000, "alpha"), /outside this project's authorized folders/);
    assert.deepEqual(catalog.searchFiles("device-b", "ui", {}, "alpha").matches.map((match) => match.path), ["design/notes/ui.md"]);
    assert.deepEqual(catalog.searchText("device-b", "label", {}, "alpha").matches.map((match) => match.path), ["music/models/labels.md"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("remote data sources bind model evidence to one T3 environment", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-data-models-"));
  try {
    const root = join(temporary, "remote-mount");
    mkdirSync(root);
    const catalogPath = join(temporary, "catalog.json");
    const source = {
      id: "device-b", label: "Device B", root, device: "linux", readOnly: true,
      environmentId: "env-b", sshHost: "device-b", remoteRoot: "/home/test",
      verifiedModels: ["gpt-5.6-sol"], projectIds: ["alpha"],
    };
    writeFileSync(catalogPath, JSON.stringify({ version: 1, sources: [source] }));
    const catalog = new ReadOnlyDataSourceCatalog(catalogPath);
    assert.deepEqual(catalog.sources[0]?.verifiedModels, ["gpt-5.6-sol"]);
    assert.equal(
      catalog.executionSource("alpha", "env-b", "/home/test/DurablePiProjects/music-app").id,
      "device-b",
    );
    assert.throws(
      () => catalog.executionSource("alpha", "env-b", "/srv/other/music-app"),
      /No project-bound data source/,
    );
    assert.throws(
      () => catalog.executionSource("other", "env-b", "/home/test/DurablePiProjects/music-app"),
      /No project-bound data source/,
    );

    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [
        { ...source, projectIds: ["alpha"] },
        { ...source, id: "device-b-duplicate", projectIds: ["alpha"] },
      ],
    }));
    assert.throws(
      () => new ReadOnlyDataSourceCatalog(catalogPath)
        .executionSource("alpha", "env-b", "/home/test/DurablePiProjects/music-app"),
      /Ambiguous project-bound data sources/,
    );

    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [{ ...source, environmentId: undefined }],
    }));
    assert.throws(() => new ReadOnlyDataSourceCatalog(catalogPath), /require a T3 environment/);

    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [{ ...source, verifiedModels: ["gpt-5.6-sol", "gpt-5.6-sol"] }],
    }));
    assert.throws(() => new ReadOnlyDataSourceCatalog(catalogPath), /Invalid verified model list/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows SSH data sources accept drive roots only with an explicit remote platform", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-windows-data-source-"));
  try {
    const root = join(temporary, "placeholder");
    mkdirSync(root);
    const catalogPath = join(temporary, "catalog.json");
    const source = {
      id: "windows-data", label: "Windows data", root, device: "windows", readOnly: true,
      sshHost: "durable-windows", remoteRoot: "D:\\Workspace", remotePlatform: "windows",
    };
    writeFileSync(catalogPath, JSON.stringify({ version: 1, sources: [source] }));
    assert.equal(new ReadOnlyDataSourceCatalog(catalogPath).sources[0]?.remotePlatform, "windows");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1, sources: [{ ...source, remotePlatform: undefined }],
    }));
    assert.throws(() => new ReadOnlyDataSourceCatalog(catalogPath), /root must be absolute/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("data-source binding limits fail before writing an unreadable catalog", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dpi-data-binding-limit-"));
  try {
    const root = join(temporary, "source");
    mkdirSync(root);
    const catalogPath = join(temporary, "catalog.json");
    const projectIds = Array.from({ length: 100 }, (_, index) => `project-${index}`);
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      sources: [{ id: "device-a", label: "Device A", root, device: "windows", projectIds, readOnly: true }],
    }));
    const store = new DataSourceBindingStore(catalogPath);
    assert.throws(() => store.setProjectSources("overflow", ["device-a"]), /more than 100 projects/);
    assert.equal(new ReadOnlyDataSourceCatalog(catalogPath).sources[0]?.projectIds?.length, 100);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
