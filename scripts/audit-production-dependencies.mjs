import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const policy = JSON.parse(readFileSync(resolve(root, "supply-chain-policy.json"), "utf8"));
const applications = ["apps/dpi-backend", "apps/dpi-sdk", "apps/dpi-playground"];
const severities = ["info", "low", "moderate", "high", "critical"];
if (!policy.productionAuditMaximum || severities.some((severity) =>
  !Number.isSafeInteger(policy.productionAuditMaximum[severity]) || policy.productionAuditMaximum[severity] < 0))
  throw Error("supply-chain-policy.json has no valid productionAuditMaximum policy");

const bundledNpmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCommand = existsSync(bundledNpmCli) ? process.execPath : "npm";
const npmPrefix = existsSync(bundledNpmCli) ? [bundledNpmCli] : [];
const results = [];
for (const application of applications) {
  const run = spawnSync(npmCommand, [...npmPrefix, "audit", "--omit=dev", "--json"], {
    cwd: resolve(root, application),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error) throw Error(`${application}: npm audit could not run: ${run.error.message}`);
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw Error(`${application}: npm audit returned no valid JSON${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`);
  }
  if (report.error) throw Error(`${application}: npm audit service failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
  const counts = report.metadata?.vulnerabilities;
  if (!counts || severities.some((severity) => !Number.isSafeInteger(counts[severity])))
    throw Error(`${application}: npm audit response omitted vulnerability counts`);
  const violations = severities.filter((severity) => counts[severity] > policy.productionAuditMaximum[severity]);
  if (violations.length)
    throw Error(`${application}: production dependency audit exceeded policy (${violations.map((severity) => `${severity}=${counts[severity]}`).join(", ")})`);
  results.push({ application, vulnerabilities: Object.fromEntries(severities.map((severity) => [severity, counts[severity]])) });
}
process.stdout.write(`${JSON.stringify({ ok: true, scope: "production", results })}\n`);
