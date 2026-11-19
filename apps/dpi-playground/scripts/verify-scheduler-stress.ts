import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRegistry } from "../../dpi-sdk/src/node/projects.js";
import { ProjectTaskStore } from "../../dpi-sdk/src/node/tasks.js";

const taskCount = 400;
const workerCount = 6;
const tempParent = resolve(process.env.DPI_TEST_TEMP ?? tmpdir());
await mkdir(tempParent, { recursive: true });
const root = await mkdtemp(join(tempParent, "durable-pi-scheduler-stress-"));
const database = join(root, "projects.sqlite");
const projects = new ProjectRegistry(database);
projects.create({ id: "stress", name: "Scheduler stress" });
const workers = Array.from({ length: workerCount }, () => new ProjectTaskStore(database));
const abandoned = new Map<string, { workerId: string; fenceEpoch: number }>();
const retried = new Set<string>();
let now = 1_800_000_000_000;

try {
  for (let index = 0; index < taskCount; index++)
    workers[0]!.enqueue("stress", {
      id: `stress-${String(index).padStart(4, "0")}`,
      title: `Stress task ${index}`,
      input: { index },
      priority: index % 11,
      maxAttempts: 4,
    }, now + index);

  let completed = 0;
  let rounds = 0;
  while (completed < taskCount) {
    rounds += 1;
    assert.ok(rounds < taskCount * 5, "scheduler stress loop stopped making progress");
    now += 2_000;
    const leases = workers.map((store, index) => store.claim("stress", `worker-${index}`, {
      now,
      leaseMs: 1_000,
      maxGlobalRunning: workerCount,
      maxProjectRunning: workerCount,
      maxWorkerRunning: 1,
    })).filter((lease) => lease !== undefined);
    assert.equal(new Set(leases.map((lease) => lease.id)).size, leases.length, "one task was claimed twice in a round");
    for (const lease of leases) {
      const taskIndex = Number(lease.id.slice("stress-".length));
      if (taskIndex % 31 === 0 && lease.attemptNumber === 1) {
        abandoned.set(lease.id, { workerId: lease.leaseOwner, fenceEpoch: lease.fenceEpoch });
        continue;
      }
      const store = workers[Number(lease.leaseOwner.slice("worker-".length))]!;
      if (taskIndex % 29 === 0 && !retried.has(lease.id)) {
        retried.add(lease.id);
        store.fail(lease.id, lease.leaseOwner, lease.fenceEpoch, { code: "TRANSIENT_STRESS" }, { now, retryDelayMs: 0 });
        continue;
      }
      store.complete(lease.id, lease.leaseOwner, lease.fenceEpoch, { taskIndex, fenceEpoch: lease.fenceEpoch }, now);
      completed += 1;
    }
  }

  const tasks = workers[0]!.list("stress", taskCount + 1);
  assert.equal(tasks.length, taskCount);
  assert.equal(tasks.filter((task) => task.status === "COMPLETED").length, taskCount);
  assert.ok(abandoned.size > 0);
  assert.ok(retried.size > 0);
  for (const [taskId, stale] of abandoned) {
    assert.ok(workers[0]!.attempts(taskId).some((attempt) => attempt.status === "EXPIRED"));
    assert.throws(
      () => workers[0]!.complete(taskId, stale.workerId, stale.fenceEpoch, { stale: true }, now),
      /Stale or expired/,
    );
  }
  const integrity = workers[0]!.db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
  assert.equal(integrity.quick_check, "ok");
  const attempts = Number((workers[0]!.db.prepare("SELECT COUNT(*) AS count FROM task_attempts").get() as { count: number }).count);
  const events = Number((workers[0]!.db.prepare("SELECT COUNT(*) AS count FROM project_events WHERE project_id='stress'").get() as { count: number }).count);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tasks: taskCount,
    workers: workerCount,
    rounds,
    attempts,
    abandonedAndRecovered: abandoned.size,
    transientRetries: retried.size,
    events,
    sqliteQuickCheck: integrity.quick_check,
  })}\n`);
} finally {
  for (const worker of workers) worker.close();
  projects.close();
  await rm(root, { recursive: true, force: true });
}
