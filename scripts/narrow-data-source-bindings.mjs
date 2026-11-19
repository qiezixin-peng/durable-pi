#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const argument = process.argv.indexOf("--catalog");
const catalogPath = resolve(argument >= 0 ? process.argv[argument + 1] : join(homedir(), ".dpi", "data-sources.json"));
const dryRun = process.argv.includes("--dry-run");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
if (catalog.version !== 1 || !Array.isArray(catalog.sources)) throw Error("Invalid data-source catalog");

let changed = 0;
for (const source of catalog.sources) {
  const paths = { ...(source.projectPaths ?? {}) };
  for (const projectId of source.projectIds ?? []) {
    if (!Object.prototype.hasOwnProperty.call(paths, projectId)) {
      paths[projectId] = [];
      changed += 1;
    }
  }
  if (Object.keys(paths).length) source.projectPaths = paths;
}

if (!dryRun && changed) {
  const temporary = `${catalogPath}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, catalogPath);
  chmodSync(catalogPath, 0o600);
}
process.stdout.write(`${JSON.stringify({ catalogPath, changed, dryRun })}\n`);
