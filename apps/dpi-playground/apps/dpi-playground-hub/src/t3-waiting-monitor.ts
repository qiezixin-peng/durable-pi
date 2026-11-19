import type { ProjectTask } from "../../../../dpi-sdk/src/api.js";
import { ProjectRegistry } from "../../../../dpi-sdk/src/node/projects.js";
import { ProjectTaskStore } from "../../../../dpi-sdk/src/node/tasks.js";
import type { T3RuntimeGateway } from "../../../../dpi-sdk/src/node/t3-runtime.js";
import { t3RuntimeModeFor } from "./task-worker.js";

type StatusGateway = Pick<T3RuntimeGateway, "status">;

const isUserWait = (task: ProjectTask) =>
  task.status === "PAUSED" && task.error && typeof task.error === "object" &&
  (task.error as { code?: unknown }).code === "USER_INPUT_REQUIRED";

/**
 * Makes T3 the only UI needed for user questions. Once T3 reports that the exact
 * waiting run changed state, the durable task is queued again and the worker
 * reattaches to that same run. No prompt is sent a second time.
 */
export class T3WaitingTaskMonitor {
  private readonly checking = new Set<string>();

  constructor(
    private readonly tasks: ProjectTaskStore,
    private readonly projects: ProjectRegistry,
    private readonly gateway: StatusGateway,
  ) {}

  async runOnce(): Promise<{ checked: number; resumed: number; errors: number }> {
    const candidates = this.tasks.paused().filter(isUserWait).filter((task) => !this.checking.has(task.id));
    let resumed = 0;
    let errors = 0;
    await Promise.all(candidates.map(async (task) => {
      this.checking.add(task.id);
      try {
        if (await this.check(task)) resumed += 1;
      } catch {
        errors += 1;
      } finally {
        this.checking.delete(task.id);
      }
    }));
    return { checked: candidates.length, resumed, errors };
  }

  private async check(task: ProjectTask) {
    const attempt = this.tasks.attempts(task.id)
      .filter((candidate) => candidate.status === "WAITING_USER" && candidate.runtime?.kind === "t3" && candidate.runtime.runId)
      .at(-1);
    if (!attempt?.runtime?.runId) return false;
    const input = task.input && typeof task.input === "object"
      ? task.input as { memberId?: unknown }
      : undefined;
    if (typeof input?.memberId !== "string") return false;
    const project = this.projects.get(task.projectId);
    const member = this.projects.getMember(task.projectId, input.memberId);
    if (!project || !member) return false;
    const runtimeMode = t3RuntimeModeFor(project.autonomyMode, member.role, member.permissionProfile) ?? "approval-required";
    const status = await this.gateway.status({
      threadId: attempt.runtime.threadId,
      runId: attempt.runtime.runId,
      runtimeMode,
      environmentId: attempt.runtime.environmentId,
    }, 100);
    if (status.status === "waiting") return false;
    const current = this.tasks.get(task.id);
    if (!current || !isUserWait(current)) return false;
    this.tasks.resume(task.id);
    this.projects.event(task.projectId, "t3.waiting.auto_resumed", {
      taskId: task.id,
      threadId: attempt.runtime.threadId,
      runId: attempt.runtime.runId,
      observedStatus: status.status,
      timedOut: status.timedOut,
    }, member.id, member.id);
    return true;
  }
}
