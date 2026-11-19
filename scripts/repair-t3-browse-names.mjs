#!/usr/bin/env node
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const usage = () => {
  throw Error("usage: repair-t3-browse-names.mjs [--repair] [--root <absolute-path>]... [--audit <absolute-path>]");
};

const args = process.argv.slice(2);
const roots = [];
let repair = false;
let auditPath = join(homedir(), ".dpi", "logs", "t3-browse-name-repairs.jsonl");
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--repair") repair = true;
  else if (argument === "--root") {
    const value = args[++index];
    if (!value) usage();
    roots.push(value);
  } else if (argument === "--audit") {
    const value = args[++index];
    if (!value) usage();
    auditPath = value;
  } else usage();
}
if (!roots.length) roots.push(homedir());
if (!isAbsolute(auditPath)) usage();

const incompatibleName = (name) => !name.trim() || /[\u0000-\u001f\u007f]/u.test(name);
const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const summaries = [];
const audit = [];

for (const requestedRoot of [...new Set(roots.map((root) => resolve(root)))]) {
  const summary = { root: requestedRoot, status: "OK", incompatible: 0, repaired: 0, entries: [] };
  summaries.push(summary);
  if (!isAbsolute(requestedRoot) || !existsSync(requestedRoot)) {
    summary.status = "MISSING";
    continue;
  }
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    summary.status = "UNSAFE_ROOT";
    continue;
  }
  const canonicalRoot = realpathSync(requestedRoot);
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!incompatibleName(entry.name)) continue;
    summary.incompatible += 1;
    const source = join(canonicalRoot, entry.name);
    const sourceStat = lstatSync(source);
    const record = {
      originalNameBase64: Buffer.from(entry.name, "utf8").toString("base64"),
      kind: sourceStat.isSymbolicLink() ? "symlink" : sourceStat.isDirectory() ? "directory" : "file",
      repaired: false,
    };
    summary.entries.push(record);
    if (!repair) continue;
    const digest = createHash("sha256").update(`${canonicalRoot}\0${entry.name}`).digest("hex").slice(0, 10);
    const prefix = `RecoveredT3Entry-${timestamp()}-${digest}`;
    let target = join(canonicalRoot, prefix);
    let suffix = 1;
    while (existsSync(target)) target = join(canonicalRoot, `${prefix}-${suffix++}`);
    renameSync(source, target);
    record.repaired = true;
    record.recoveredName = target.slice(canonicalRoot.length + 1);
    summary.repaired += 1;
    audit.push({
      at: new Date().toISOString(),
      device: hostname(),
      root: canonicalRoot,
      ...record,
    });
  }
  if (summary.incompatible && !repair) summary.status = "INCOMPATIBLE_NAMES_FOUND";
  else if (summary.repaired) summary.status = "REPAIRED";
}

if (audit.length) {
  mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
  appendFileSync(auditPath, `${audit.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(auditPath, 0o600); } catch {}
}
process.stdout.write(`${JSON.stringify({ repair, roots: summaries, auditPath })}\n`);
