import type { SharedState } from "./shared-state.js";
import { Type } from "@earendil-works/pi-ai";
import { isAbsolute, resolve } from "node:path";
import { readState, type AppState } from "../../dpi-sdk/src/app-state.js";
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { jobRunDone, type JobRun } from "../../dpi-sdk/src/jobs.js";
import {
  defineDoc,
  defineTool,
  defineExtension,
  section,
  configure,
  AssistantEntry,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { JobRuns, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { searchHistory } from "./history.js";

export const Workspace = defineDoc<AppState>({
  kind: "demo.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
});
const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
});
/** ping_on_call_engineer pages once per agent; this records the page. */
const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;

export function createPlayground(
  shared: SharedState,
  sessionId: string,
  spawn: SpawnSession,
  jobs: Jobs,
  collaboration: { hubUrl?: string; hubToken?: string; deviceId?: string } = {},
) {
  const readAppState = defineTool({
    name: "read_state",
    description:
      "Read the shared App State object used by every session, conversation and fork, or a field at a JSON Pointer path. Empty path reads the whole object.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description:
      'CRUD the same shared App State for every agent and fork in this demo. create adds a new field, update replaces an existing value, delete removes it, increment adds a signed number. value_json must be JSON-encoded text: 3 for a number, true for a boolean, "hello" (including quotes) for a string, {"enabled":true} for an object, or [1,2] for an array. Omit value_json for delete. Use JSON Pointer paths: /counter, /settings/enabled, /notes/- to append. Escape ~ as ~0 and / as ~1. Empty path with update replaces the whole root object, with delete clears it. Read first with read_state. UI controls update live. Changes are atomic and replay-safe.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("increment"),
      ]),
      path: Type.String(),
      value_json: Type.Optional(
        Type.String({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { content: [{ type: "text", text: value }] };
    },
  });
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description:
      "List the durable jobs you can start with run_durable_job: each job's id, what it does, its named phases, the inputs it takes (type, default, limits), whether it waits for a person's approval, the App State path where every run saves its result, and its recent runs in this conversation with their task ids for check_durable_job.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description:
      'Start a durable job: a repeatable workflow with named phases that runs as one checkpointed task and shows live in the chat. Call list_durable_jobs first for ids and inputs. It runs in the background: you get its task id at once, the conversation owns the run, and you check it with check_durable_job. Set wait true only when the user wants you to wait for the result; then the call owns the run, an interrupt stops it, and you get the outcome of every phase. Example: {"job":"workspace-snapshot","input":{"path":"."}}.',
    parameters: Type.Object({
      job: Type.String({ description: "Job id from list_durable_jobs." }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          content: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        content: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description:
      "Check durable job runs in this conversation. With task_id, one run in full: status, current phase, every phase's outcome and steps (commands, the subagent's tool calls, App State writes), approval, result or error. With job, that job's latest run. With neither, a short list of recent runs. Task ids come from run_durable_job and list_durable_jobs.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.Integer({ minimum: 1, description: "The run's task id." })),
      job: Type.Optional(Type.String({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return { content: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }] };
    },
  });
  const searchHistoryTool = defineTool({
    name: "search_history",
    description:
      "Search your own full stored history, including entries from before a reset, handoff or compaction that you can no longer see. Filter by words (query), by tool name (tool), by entry kind, or by entry number range (from_entry, to_entry). Pass entry to read one entry in full by its number. Results come newest first (order oldest to reverse) and are paged with limit and offset; use next_offset for the next page. Each result says whether the entry is active, compacted or before reset.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words that must all appear, case-insensitive." })),
      tool: Type.Optional(Type.String({ description: "Only calls to and results from this tool, for example bash." })),
      entry: Type.Optional(Type.Integer({ minimum: 1, description: "Read this one entry in full." })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result"),
          Type.Literal("event"),
        ]),
      ),
      from_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Newest entry number to include." })),
      order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        let page = await tx.scanEntries({ conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description:
      "Page the human on-call engineer with a short summary. A real side effect: it is not replay-safe, so a crash returns an interrupted result instead of paging again, and it works once per agent. Only use it when the user asks you to page someone.",
    parameters: Type.Object({
      summary: Type.String({ description: "What the engineer needs to know, one or two sentences." }),
      severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("critical")])),
    }),
    execute: async (args, api, ctx) => {
      const prior = await api.snapshot(Pager, api.conversationId, ctx);
      if (prior?.paged)
        throw Error(
          `Already paged at ${new Date(prior.at).toISOString()} (${prior.page}). ping_on_call_engineer works once per agent.`,
        );
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      api.output("Dialing the on-call engineer…\n");
      await pause(1500);
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        if (pager.paged) throw Error(`Already paged (${pager.page}).`);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      api.output(`Paged on-call, ${severity} severity: ${page}\nWaiting for acknowledgement…\n`);
      await pause(1500);
      api.output("Acknowledged.\n");
      return {
        content: [
          {
            type: "text",
            text: `Paged the on-call engineer (${page}, ${severity}). They acknowledged. Do not page again for this.`,
          },
        ],
      };
    },
  });
  const subagent = defineTool({
    name: "subagent",
    description:
      "Delegate a self-contained task to an owned child conversation. Parent interruption also interrupts the child.",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const id = await api.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (found) return found.id;
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, { tools: { remove: [subagent] } });
        return child.id;
      }, ctx);
      await api.details({ conversationId: id }, ctx);
      const child = await api.conversation(id, ctx);
      if (!child) throw Error("Child missing");
      const result = await (
        await child.submit(
          { type: "input", content: args.task, requestId: `child:${api.taskId}` },
          ctx,
        )
      ).wait(ctx);
      const answer =
        result.status === "done" && result.type === "input"
          ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
          : undefined;
      return {
        content: [
          { type: "text", text: answer ? JSON.stringify(answer.model) : JSON.stringify(result) },
        ],
        details: { conversationId: id },
      };
    },
  });
  const startSession = defineTool({
    name: "start_session",
    description:
      "Start a new session on this device: its own harness, database and working directory, independent of this one. It keeps running if you are interrupted. Returns immediately; you do not wait for it.",
    parameters: Type.Object({
      name: Type.String({ description: "Session name shown in the network tree." }),
      cwd: Type.String({
        description: "Existing folder on this device. Relative paths resolve against your working directory.",
      }),
      model: Type.Optional(
        Type.String({ description: "Model id from this device's model list. Default: your current model." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "First message for the new session. Default: none, the session starts idle." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const parent = await api.agent(ctx);
      if (!parent.model) throw Error("This agent has no model to copy");
      const cwd = args.cwd.startsWith("~") || isAbsolute(args.cwd) ? args.cwd : resolve(parent.cwd ?? ".", args.cwd);
      const thinking = THINKING_LEVELS.find((level) => level === parent.thinkingLevel);
      const { session, submissionId } = await spawn({
        key: `start_session:${sessionId}:${api.taskId}`,
        name: args.name,
        cwd,
        model: { provider: parent.model.provider, modelId: args.model ?? parent.model.modelId },
        thinkingLevel: thinking,
        prompt: args.prompt?.trim() || undefined,
      });
      const sent =
        submissionId === undefined
          ? "It has no prompt yet."
          : `Sent its first message as submission #${submissionId}. It runs on its own.`;
      return {
        content: [
          {
            type: "text",
            text: `Started session "${session.name}" (${session.id}) in ${session.cwd} with ${session.model}. ${sent}`,
          },
        ],
        details: { sessionId: session.id, ...(submissionId === undefined ? {} : { submissionId }) },
      };
    },
  });
  const handoff = defineTool({
    name: "handoff",
    description:
      "Start a fresh model context with a concise handoff note. Old transcript stays stored.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => ({
      content: [{ type: "text", text: "Context handed off." }],
      control: { handoff: args.note },
    }),
  });
  const membershipUrl = (agentId: number) => {
    if (!collaboration.hubUrl || !collaboration.deviceId)
      throw Error("Project collaboration is not configured on this device");
    const query = new URLSearchParams({
      deviceId: collaboration.deviceId,
      sessionId,
      agentId: String(agentId),
    });
    return `${collaboration.hubUrl}/api/project-memberships?${query}`;
  };
  const collaborationHeaders = () => ({
    ...(collaboration.hubToken ? { authorization: `Bearer ${collaboration.hubToken}` } : {}),
    ...(collaboration.deviceId ? { "x-dpi-device-id": collaboration.deviceId } : {}),
  });
  const memberships = async (agentId: number) => {
    const response = await fetch(membershipUrl(agentId), {
      headers: collaborationHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { memberships?: Array<{ project: { id: string; name: string; members: Array<{ id: string; name: string; role: string; executor: string; temporary?: boolean }> }; self: { id: string; role: string } }> }
      | { error?: { message?: string } }
      | undefined;
    if (!response.ok)
      throw Error(
        (body && "error" in body ? body.error?.message : undefined) ??
          `Project hub returned ${response.status}`,
      );
    return body && "memberships" in body ? (body.memberships ?? []) : [];
  };
  const listProjectAgents = defineTool({
    name: "list_project_agents",
    description:
      "List the projects this agent belongs to and every agent address inside those project boundaries. Use this before asking an agent on another device for information or help.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => ({
      content: [{ type: "text", text: JSON.stringify(await memberships(api.conversationId)) }],
    }),
  });
  const listProjectMemories = defineTool({
    name: "list_project_memories",
    description:
      "List this agent's trusted project memory: shared project facts plus only this agent's private facts. Other agents' private memory is never returned.",
    parameters: Type.Object({ project_id: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      if (!collaboration.hubUrl || !collaboration.deviceId)
        throw Error("Project collaboration is not configured on this device");
      const membership = (await memberships(api.conversationId)).find(
        (item) => item.project.id === args.project_id,
      );
      if (!membership) throw Error(`This agent does not belong to project ${args.project_id}`);
      const query = new URLSearchParams({
        deviceId: collaboration.deviceId,
        sessionId,
        agentId: String(api.conversationId),
      });
      const response = await fetch(
        `${collaboration.hubUrl}/api/projects/${encodeURIComponent(args.project_id)}/agent-memories?${query}`,
        {
          headers: collaborationHeaders(),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const result = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | unknown;
      if (!response.ok)
        throw Error(
          (result && typeof result === "object" && "error" in result
            ? (result as { error?: { message?: string } }).error?.message
            : undefined) ?? `Project hub returned ${response.status}`,
        );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const rememberProjectFact = defineTool({
    name: "remember_project_fact",
    description:
      "Save a durable project fact. Private is the safe default and is visible only to this agent. Only a project Coordinator may choose shared. Read current memories first and pass expected_version when updating an existing fact.",
    parameters: Type.Object({
      project_id: Type.String(),
      key: Type.String({ description: "Stable dotted key, for example debugging.root_cause." }),
      value: Type.String({ description: "Plain text, or JSON text for a structured value." }),
      scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared")])),
      expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (args, api) => {
      const membership = (await memberships(api.conversationId)).find(
        (item) => item.project.id === args.project_id,
      );
      if (!membership) throw Error(`This agent does not belong to project ${args.project_id}`);
      let value: unknown = args.value;
      try {
        value = JSON.parse(args.value);
      } catch {
        // Plain text is also a valid durable fact.
      }
      const result = await projectPost(
        `/api/projects/${encodeURIComponent(args.project_id)}/agent-memories`,
        {
          deviceId: collaboration.deviceId,
          sessionId,
          agentId: String(api.conversationId),
          key: args.key,
          value,
          scope: args.scope ?? "private",
          expectedVersion: args.expected_version,
          requestId: `project-memory:${sessionId}:${api.taskId}`,
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const sendProjectMessage = defineTool({
    name: "send_project_message",
    description:
      "Send a task or question to an agent that belongs to the same project, including an agent on another device. Call list_project_agents first and use its project id and target member id. The target may inspect its own local files and reply through its durable conversation.",
    parameters: Type.Object({
      project_id: Type.String(),
      target_member_id: Type.String(),
      message: Type.String(),
      message_type: Type.Optional(
        Type.Union([
          Type.Literal("task_assignment"), Type.Literal("task_result"), Type.Literal("task_failed"),
          Type.Literal("task_blocked"), Type.Literal("question"), Type.Literal("approval_request"),
          Type.Literal("progress_update"), Type.Literal("context_update"),
        ]),
      ),
      correlation_id: Type.Optional(Type.String()),
      timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 86400000 })),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait up to five minutes for the target's answer. Default true." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api) => {
      if (!collaboration.hubUrl) throw Error("Project collaboration is not configured on this device");
      const mine = await memberships(api.conversationId);
      const membership = mine.find((item) => item.project.id === args.project_id);
      if (!membership) throw Error(`This agent does not belong to project ${args.project_id}`);
      const response = await fetch(
        `${collaboration.hubUrl}/api/projects/${encodeURIComponent(args.project_id)}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...collaborationHeaders(),
          },
          body: JSON.stringify({
            fromMemberId: membership.self.id,
            toMemberId: args.target_member_id,
            content: args.message,
            messageType: args.message_type ?? "task_assignment",
            correlationId: args.correlation_id,
            timeoutMs: args.timeout_ms,
            whenBusy: "followUp",
            requestId: `project:${sessionId}:${api.taskId}`,
            waitMs: args.wait === false ? undefined : 300_000,
          }),
          signal: AbortSignal.timeout(args.wait === false ? 20_000 : 320_000),
        },
      );
      const result = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | unknown;
      if (!response.ok)
        throw Error(
          (result && typeof result === "object" && "error" in result
            ? (result as { error?: { message?: string } }).error?.message
            : undefined) ?? `Project hub returned ${response.status}`,
        );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const projectPost = async (path: string, body: unknown) => {
    if (!collaboration.hubUrl) throw Error("Project collaboration is not configured on this device");
    const response = await fetch(`${collaboration.hubUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...collaborationHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const result = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | unknown;
    if (!response.ok)
      throw Error(
        (result && typeof result === "object" && "error" in result
          ? (result as { error?: { message?: string } }).error?.message
          : undefined) ?? `Project hub returned ${response.status}`,
      );
    return result;
  };
  const createProjectAgent = defineTool({
    name: "create_project_agent",
    description:
      "Create a temporary local Codex agent inside a project. Only a Coordinator may call this. The new agent safely clones the model and working directory of an existing local Codex template member; it cannot choose an arbitrary filesystem path. Archive it when its scoped work is complete.",
    parameters: Type.Object({
      project_id: Type.String(),
      template_member_id: Type.String(),
      role: Type.String(),
      permission_profile: Type.Optional(
        Type.Union([Type.Literal("ROLE_DEFAULT"), Type.Literal("READ_ONLY"), Type.Literal("WORKSPACE_WRITE")]),
      ),
      name: Type.Optional(Type.String()),
      scope_task_id: Type.Optional(Type.String()),
    }),
    execute: async (args, api) => {
      const membership = (await memberships(api.conversationId)).find((item) => item.project.id === args.project_id);
      if (!membership) throw Error(`This agent does not belong to project ${args.project_id}`);
      if (membership.self.role.toLowerCase() !== "coordinator") throw Error("Only a project Coordinator can create temporary agents");
      const result = await projectPost(
        `/api/projects/${encodeURIComponent(args.project_id)}/members/spawn-temporary`,
        {
          requestedByMemberId: membership.self.id,
          templateMemberId: args.template_member_id,
          role: args.role,
          permissionProfile: args.permission_profile,
          name: args.name,
          scopeTaskId: args.scope_task_id,
          requestId: `project-agent:${sessionId}:${api.taskId}`,
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const archiveProjectAgent = defineTool({
    name: "archive_project_agent",
    description: "Archive a temporary project agent after its scoped work is complete. Its history remains auditable, but it can no longer receive tasks.",
    parameters: Type.Object({ project_id: Type.String(), member_id: Type.String() }),
    execute: async (args, api) => {
      const membership = (await memberships(api.conversationId)).find((item) => item.project.id === args.project_id);
      if (!membership) throw Error(`This agent does not belong to project ${args.project_id}`);
      const result = await projectPost(
        `/api/projects/${encodeURIComponent(args.project_id)}/members/${encodeURIComponent(args.member_id)}/archive-temporary`,
        { requestedByMemberId: membership.self.id },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  return defineExtension({
    name: "playground",
    tasks: jobs.tasks,
    tools: [
      readAppState,
      updateState,
      listJobs,
      runJob,
      checkJob,
      searchHistoryTool,
      pingOnCall,
      subagent,
      startSession,
      ...(collaboration.hubUrl && collaboration.deviceId
        ? [
            listProjectAgents,
            listProjectMemories,
            rememberProjectFact,
            sendProjectMessage,
            createProjectAgent,
            archiveProjectAgent,
          ]
        : []),
      handoff,
    ],
    sections: [
      section(
        "playground",
        () =>
          `You are a concise coding agent in the Durable Pi playground. Explain only what matters. Use only the tools you are offered; read only agents get no tools that write. Use read_state to inspect App State and update_state to create, update, delete, or increment any field. App State is shared across all agents, sessions, conversations and forks in this demo. It survives browser closure, interrupted agents, and backend restarts. Forks use the current shared object rather than a historical copy. Read before writing because other agents and humans can change it. Use only read_state and update_state for this object, never inspect or edit its database files. App State is a flexible JSON object: numbers, booleans, strings, arrays, nested objects, and null all render as live controls in the UI. Read before editing. Use list_durable_jobs and run_durable_job to run a repeatable durable job (a named workflow with checkpointed phases) when asked; pass only the inputs list_durable_jobs documents. Runs continue in the background: check them with check_durable_job, and wait only when asked. Use search_history to look back at earlier messages, tool calls or entries by number, including what came before a reset, handoff or compaction. Use ping_on_call_engineer only when asked to page someone; it works once. Use subagent only when explicitly asked to delegate. Use start_session only when asked to start a new session; it runs on its own. When project collaboration tools are available, use list_project_agents to discover agents inside your project and send_project_message to ask them for work. Use list_project_memories before updating durable facts; remember_project_fact defaults to private, and only a Coordinator may publish shared memory. A Coordinator may use create_project_agent to create a scoped temporary agent from an approved local Codex template and must use archive_project_agent after that agent finishes. Never claim an action happened without using its tool. Background runs finish independently; do not wait in bash. A browser disconnect does not stop your work.`,
        { tag: false },
      ),
    ],
  });
}
