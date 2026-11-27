import type { ProjectRegistry } from "../../../../dpi-sdk/src/node/projects.js";
import type { ProjectTaskStore } from "../../../../dpi-sdk/src/node/tasks.js";
import type { T3RuntimeGateway } from "../../../../dpi-sdk/src/node/t3-runtime.js";

type LifecycleRuntime = Pick<T3RuntimeGateway, "inspectThread" | "organizeThread">;

export interface T3ThreadLifecycleResult {
  inspected: number;
  archived: number;
  errors: number;
}

const threadObject = (read: Record<string, unknown>) =>
  read.thread && typeof read.thread === "object" && !Array.isArray(read.thread)
    ? read.thread as Record<string, unknown>
    : undefined;

export class T3ThreadLifecycleMonitor {
  constructor(
    private readonly tasks: ProjectTaskStore,
    private readonly projects: ProjectRegistry,
    private readonly runtime: LifecycleRuntime,
    private readonly archiveAfterMs = 24 * 60 * 60_000,
    private readonly failureBackoffMs = 24 * 60 * 60_000,
  ) {
    if (!Number.isSafeInteger(archiveAfterMs) || archiveAfterMs < 60_000)
      throw Error("T3 thread archive delay must be at least one minute");
    if (!Number.isSafeInteger(failureBackoffMs) || failureBackoffMs < 60_000)
      throw Error("T3 thread archive failure backoff must be at least one minute");
  }

  async runOnce(now = Date.now()): Promise<T3ThreadLifecycleResult> {
    const result: T3ThreadLifecycleResult = { inspected: 0, archived: 0, errors: 0 };
    for (const project of this.projects.list()) {
      const recentFailures = new Set(
        this.projects.events(project.id, 500)
          .filter((event) => event.kind === "member.thread_auto_archive_failed"
            && now - event.createdAt < this.failureBackoffMs)
          .map((event) => {
            const detail = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
              ? event.detail as Record<string, unknown>
              : undefined;
            const environmentId = typeof detail?.environmentId === "string" ? detail.environmentId : "local";
            return typeof detail?.threadId === "string" ? `${environmentId}\0${detail.threadId}` : "";
          })
          .filter(Boolean),
      );
      const members = new Map(this.projects.members(project.id, true).map((member) => [member.id, member]));
      const candidates = new Map<string, { memberId: string; threadId: string; environmentId?: string }>();
      for (const member of members.values()) {
        if (member.threadRuntime !== "t3" || !member.threadId) continue;
        const candidate = {
          memberId: member.id,
          threadId: member.threadId,
          ...(member.t3EnvironmentId ? { environmentId: member.t3EnvironmentId } : {}),
        };
        candidates.set(`${candidate.environmentId ?? "local"}\0${candidate.threadId}`, candidate);
      }
      for (const candidate of this.tasks.t3ThreadHistory(project.id))
        candidates.set(`${candidate.environmentId ?? "local"}\0${candidate.threadId}`, candidate);
      for (const candidate of candidates.values()) {
        const candidateKey = `${candidate.environmentId ?? "local"}\0${candidate.threadId}`;
        if (recentFailures.has(candidateKey)) continue;
        const member = members.get(candidate.memberId);
        if (!member || member.role.toLowerCase() === "coordinator") continue;
        if (this.tasks.activeCountForMember(project.id, member.id) > 0) continue;
        result.inspected += 1;
        try {
          const read = await this.runtime.inspectThread({
            threadId: candidate.threadId,
            ...(candidate.environmentId ? { environmentId: candidate.environmentId } : {}),
          });
          const thread = threadObject(read);
          if (!thread || thread.archived === true || typeof thread.updatedAt !== "string") continue;
          if (typeof thread.activeRunId === "string" || thread.status === "running") continue;
          const updatedAt = Date.parse(thread.updatedAt);
          if (!Number.isFinite(updatedAt) || now - updatedAt < this.archiveAfterMs) continue;
          // Close the inspection/dispatch race: newly queued work always wins.
          if (this.tasks.activeCountForMember(project.id, member.id) > 0) continue;
          await this.runtime.organizeThread({
            threadId: candidate.threadId,
            action: "archive",
            ...(candidate.environmentId ? { environmentId: candidate.environmentId } : {}),
          });
          this.projects.event(project.id, "member.thread.auto_archived", {
            memberId: member.id,
            threadId: candidate.threadId,
            inactiveSince: thread.updatedAt,
            archiveAfterMs: this.archiveAfterMs,
          }, member.id);
          result.archived += 1;
        } catch (error) {
          this.projects.event(project.id, "member.thread_auto_archive_failed", {
            memberId: member.id,
            threadId: candidate.threadId,
            ...(candidate.environmentId ? { environmentId: candidate.environmentId } : {}),
            message: error instanceof Error ? error.message : String(error),
          }, member.id);
          result.errors += 1;
        }
      }
    }
    return result;
  }
}
