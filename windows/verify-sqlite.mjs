import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw Error("SQLite path is required");
const db = new DatabaseSync(resolve(path), { readOnly: true });
try {
  const row = db.prepare("PRAGMA quick_check").get();
  if (row?.quick_check !== "ok") throw Error(`SQLite quick_check failed: ${row?.quick_check ?? "unknown"}`);
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length) throw Error(`SQLite foreign_key_check failed with ${foreignKeyErrors.length} violation(s)`);
  process.stdout.write("ok\n");
} finally {
  db.close();
}
