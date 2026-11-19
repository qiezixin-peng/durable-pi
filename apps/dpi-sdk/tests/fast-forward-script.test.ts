import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const run = (command: string, args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(Error(stderr || stdout || `exit ${code}`)));
});

test("fast-forward script applies a frozen plan idempotently without running repository hooks", async () => {
  const root = await mkdtemp(join(process.env.DPI_TEST_TEMP ?? tmpdir(), "dpi-fast-forward-"));
  const repository = join(root, "repository");
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  await writeFile(join(repository, "README.md"), "# Base\n");
  execFileSync("git", ["-C", repository, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "base"], { stdio: "ignore" });
  const targetBranch = execFileSync("git", ["-C", repository, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const baseRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repository, "checkout", "-b", "remote"], { stdio: "ignore" });
  await writeFile(join(repository, "remote.txt"), "remote change\n");
  execFileSync("git", ["-C", repository, "add", "remote.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "-c", "user.name=Durable Pi", "-c", "user.email=durable@example.invalid", "commit", "-m", "remote"], { stdio: "ignore" });
  const remoteRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repository, "checkout", targetBranch], { stdio: "ignore" });
  const managedRef = "refs/dpi/remotes/linux-home/test-project";
  execFileSync("git", ["-C", repository, "update-ref", managedRef, remoteRevision], { stdio: "ignore" });
  const marker = join(root, "hook-ran.txt");
  const hook = join(repository, ".git", "hooks", "post-merge");
  await writeFile(hook, `#!/bin/sh\necho unsafe > '${marker.replaceAll("\\", "/")}'\n`);
  await chmod(hook, 0o755);

  const planId = `integration-plan-${"a".repeat(40)}`;
  const plan = {
    id: planId,
    projectId: "alpha",
    sourceId: "linux-home",
    repository,
    managedRef,
    targetBranch,
    baseRevision,
    remoteRevision,
    status: "PLANNED",
  };
  const receipts: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === `/api/projects/alpha/integrations/plans/${planId}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(plan));
      return;
    }
    if (request.method === "POST" && request.url === "/api/projects/alpha/integrations/receipt") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        receipts.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "integration-receipt" }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Mock Hub did not bind a TCP port");
    const script = fileURLToPath(new URL("../../../windows/apply-fast-forward.ps1", import.meta.url));
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-PlanId", planId, "-ProjectId", "alpha", "-SourceId", "linux-home",
      "-Repository", repository, "-HubUrl", `http://127.0.0.1:${address.port}`,
    ];
    await run("powershell.exe", args);
    assert.equal(execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), remoteRevision);
    assert.equal(execFileSync("git", ["-C", repository, "branch", "--show-current"], { encoding: "utf8" }).trim(), targetBranch);
    assert.equal(execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(marker)), false);
    await run("powershell.exe", args);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.deepEqual(receipts[0], {
      planId,
      sourceId: "linux-home",
      targetBranch,
      previousRevision: baseRevision,
      appliedRevision: remoteRevision,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
