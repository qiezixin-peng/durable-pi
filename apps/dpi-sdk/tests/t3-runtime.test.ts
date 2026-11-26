import assert from "node:assert/strict";
import { test } from "node:test";

import { T3RuntimeGateway } from "../src/node/t3-runtime.js";
import type { T3LaunchThreadInput } from "../src/node/t3-mcp.js";

test("T3 runtime resolves the project, launches, waits, reads, and closes", async () => {
  const calls: string[] = [];
  const session = {
    initialize: async () => { calls.push("initialize"); },
    listProjects: async () => {
      calls.push("projects");
      return [{ id: "project-1", title: "Demo", workspaceRoot: process.cwd() }];
    },
    launchThread: async (input: T3LaunchThreadInput) => {
      calls.push(`launch:${input.runtimeMode}`);
      return { threadId: "thread-1", projectId: "project-1", runId: "run-1", status: "running", link: null };
    },
    sendThread: async () => { throw Error("not used"); },
    waitThread: async () => {
      calls.push("wait");
      return { threadId: "thread-1", runId: "run-1", status: "completed", timedOut: false, next: null };
    },
    interruptThread: async () => { throw Error("not used"); },
    readThread: async () => {
      calls.push("read");
      return { items: [
        { runId: "old-run", type: "assistant_message", createdBy: "agent", text: "old answer" },
        { runId: "run-1", type: "assistant_message", createdBy: "agent", text: "I will call the tool." },
        { runId: "run-1", type: "mcp_tool_call", createdBy: "agent", tool: "test" },
        { runId: "run-1", type: "assistant_message", createdBy: "agent", text: "done" },
      ] };
    },
    environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
    close: async () => { calls.push("close"); },
  };
  const gateway = new T3RuntimeGateway({ connect: async () => session });
  const result = await gateway.run({
    cwd: process.cwd(),
    title: "Task",
    message: "Do it",
    clientRequestId: "request-1",
    model: "gpt-6-astra",
    runtimeMode: "approval-required",
  });
  assert.equal(result.text, "done");
  assert.equal(result.waitingForUser, false);
  assert.deepEqual(calls, ["initialize", "projects", "launch:approval-required", "wait", "read", "close"]);
});

test("T3 runtime never substitutes an older run when the activity window is truncated", async () => {
  const reads: string[] = [];
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [{ id: "project-1", title: "Demo", workspaceRoot: process.cwd() }],
      launchThread: async () => ({
        threadId: "thread-long", projectId: "project-1", runId: "run-current", status: "running", link: null,
      }),
      sendThread: async () => { throw Error("not used"); },
      waitThread: async () => ({
        threadId: "thread-long", runId: "run-current", status: "completed", timedOut: false, next: null,
      }),
      interruptThread: async () => { throw Error("not used"); },
      readThread: async (input: { view?: string }) => {
        reads.push(input.view ?? "messages");
        return input.view === "activity"
          ? { thread: { projectId: "project-1" }, items: [
              { runId: "run-old", type: "assistant_message", createdBy: "agent", text: "stale answer" },
            ] }
          : { thread: { projectId: "project-1" }, items: [
              { runId: "run-current", type: "assistant_message", createdBy: "agent", text: "exact answer" },
            ] };
      },
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => undefined,
    }),
  });
  const result = await gateway.run({
    cwd: process.cwd(), title: "Long task", message: "Continue", clientRequestId: "request-long",
    model: "gpt-5.6-sol", runtimeMode: "auto",
  });
  assert.equal(result.text, "exact answer");
  assert.deepEqual(reads, ["activity", "messages"]);
});

test("T3 runtime resumes an existing thread and reports a user wait", async () => {
  let closed = false;
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [{ id: "project-1", title: "Demo", workspaceRoot: process.cwd() }],
      launchThread: async () => { throw Error("not used"); },
      sendThread: async () => ({ threadId: "thread-1", messageId: "message-2", runId: "run-2", status: "waiting", delivery: "started" }),
      waitThread: async () => { throw Error("not used"); },
      interruptThread: async () => { throw Error("not used"); },
      readThread: async () => ({ items: [] }),
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { closed = true; },
    }),
  });
  const result = await gateway.run({
    cwd: process.cwd(), title: "Task", message: "Continue", clientRequestId: "request-2",
    model: "gpt-6-astra", runtimeMode: "approval-required", existingThreadId: "thread-1",
  });
  assert.equal(result.waitingForUser, true);
  assert.equal(closed, true);
});

test("T3 runtime maps a pending command approval to a user wait instead of timing out", async () => {
  const calls: string[] = [];
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [{ id: "project-1", title: "Demo", workspaceRoot: process.cwd() }],
      launchThread: async () => ({
        threadId: "thread-approval", projectId: "project-1", runId: "run-approval", status: "running", link: null,
      }),
      sendThread: async () => { throw Error("not used"); },
      waitThread: async () => {
        calls.push("wait");
        return { threadId: "thread-approval", runId: "run-approval", status: "running", timedOut: true, next: null };
      },
      interruptThread: async () => { throw Error("not used"); },
      readThread: async () => {
        calls.push("read");
        return {
          thread: { projectId: "project-1" },
          items: [{
            runId: "run-approval", type: "approval_request", status: "waiting",
            text: "Approve git commit?",
          }],
        };
      },
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { calls.push("close"); },
    }),
  });
  const result = await gateway.run({
    cwd: process.cwd(), title: "Task", message: "Commit", clientRequestId: "request-approval",
    model: "gpt-6-astra", runtimeMode: "auto-accept-edits",
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.waitingForUser, true);
  assert.deepEqual(calls, ["wait", "read", "close"]);
});

test("T3 runtime always closes when the workspace is not registered", async () => {
  let closed = false;
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [],
      launchThread: async () => { throw Error("not used"); },
      sendThread: async () => { throw Error("not used"); },
      waitThread: async () => { throw Error("not used"); },
      interruptThread: async () => { throw Error("not used"); },
      readThread: async () => ({ items: [] }),
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { closed = true; },
    }),
  });
  await assert.rejects(gateway.run({
    cwd: process.cwd(), title: "Task", message: "Do it", clientRequestId: "request-3",
    model: "gpt-6-astra", runtimeMode: "approval-required",
  }), /no registered project/);
  assert.equal(closed, true);
});

test("T3 runtime explicitly registers an existing linked workspace when requested", async () => {
  const calls: string[] = [];
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [],
      createProject: async (input) => {
        calls.push(`create:${input.environmentId}:${input.title}:${input.workspaceRoot}`);
        return { id: "remote-project", title: input.title, workspaceRoot: input.workspaceRoot };
      },
      launchThread: async (input) => {
        calls.push(`launch:${input.projectId}`);
        return { threadId: "thread-remote", projectId: input.projectId, runId: "run-remote", status: "completed", link: null };
      },
      sendThread: async () => { throw Error("not used"); },
      waitThread: async () => { throw Error("not used"); },
      interruptThread: async () => { throw Error("not used"); },
      readThread: async () => ({
        thread: { projectId: "remote-project" },
        items: [{ runId: "run-remote", type: "assistant_message", text: "registered" }],
      }),
      environmentLinks: async () => ({
        environmentId: "env-a",
        links: [{ environmentId: "env-b", label: "Linux B", status: "reachable", access: "auto" }],
        notListed: "",
      }),
      close: async () => { calls.push("close"); },
    }),
  });
  const result = await gateway.run({
    cwd: "/srv/remote",
    title: "Task",
    projectTitle: "Durable project",
    message: "Run",
    clientRequestId: "register-remote",
    model: "gpt-6-astra",
    runtimeMode: "auto",
    environmentId: "env-b",
    registerProjectIfMissing: true,
  });
  assert.equal(result.text, "registered");
  assert.deepEqual(calls, [
    "create:env-b:Durable project:/srv/remote",
    "launch:remote-project",
    "close",
  ]);
});

test("T3 runtime recovers an existing run without launching or sending again", async () => {
  let launched = false;
  let closed = false;
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [],
      launchThread: async () => { launched = true; throw Error("must not launch"); },
      sendThread: async () => { launched = true; throw Error("must not send"); },
      waitThread: async () => ({
        threadId: "thread-existing", runId: "run-existing", status: "completed", timedOut: false, next: null,
      }),
      interruptThread: async () => { throw Error("not used"); },
      readThread: async () => ({
        thread: { projectId: "project-existing" },
        items: [{ runId: "run-existing", type: "assistant_message", createdBy: "agent", text: "recovered" }],
      }),
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { closed = true; },
    }),
  });
  const result = await gateway.recover({
    threadId: "thread-existing",
    runId: "run-existing",
    runtimeMode: "auto",
  });
  assert.equal(result.text, "recovered");
  assert.equal(result.projectId, "project-existing");
  assert.equal(launched, false);
  assert.equal(closed, true);
});

test("T3 runtime status poll inspects but never interrupts a still-running turn", async () => {
  const calls: string[] = [];
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => { calls.push("initialize"); },
      listProjects: async () => { throw Error("not used"); },
      launchThread: async () => { throw Error("not used"); },
      sendThread: async () => { throw Error("not used"); },
      waitThread: async (input) => {
        calls.push(`wait:${input.timeoutMs}`);
        return { threadId: input.threadId, runId: input.runId ?? null, status: "running", timedOut: true, next: null };
      },
      interruptThread: async () => { calls.push("interrupt"); throw Error("must not interrupt"); },
      readThread: async () => { calls.push("read"); return { items: [] }; },
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { calls.push("close"); },
    }),
  });
  const result = await gateway.status({
    threadId: "thread-waiting", runId: "run-waiting", runtimeMode: "approval-required",
  }, 50);
  assert.deepEqual(result, {
    threadId: "thread-waiting", runId: "run-waiting", status: "running", timedOut: true,
  });
  assert.deepEqual(calls, ["initialize", "wait:50", "read", "close"]);
});

test("T3 runtime status keeps a pending approval in waiting state", async () => {
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [],
      launchThread: async () => { throw Error("not used"); },
      sendThread: async () => { throw Error("not used"); },
      waitThread: async () => ({
        threadId: "thread-approval", runId: "run-approval", status: "running", timedOut: true, next: null,
      }),
      interruptThread: async () => { throw Error("must not interrupt"); },
      readThread: async () => ({ items: [{
        runId: "run-approval", type: "approval_request", status: "waiting", text: "Approve?",
      }] }),
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => undefined,
    }),
  });
  const result = await gateway.status({
    threadId: "thread-approval", runId: "run-approval", runtimeMode: "auto-accept-edits",
  }, 50);
  assert.deepEqual(result, {
    threadId: "thread-approval", runId: "run-approval", status: "waiting", timedOut: false,
  });
});

test("T3 runtime cancellation interrupts and confirms the exact active run", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      listProjects: async () => [{ id: "project-1", title: "Demo", workspaceRoot: process.cwd() }],
      launchThread: async () => ({
        threadId: "thread-cancel", projectId: "project-1", runId: "run-cancel", status: "running", link: null,
      }),
      sendThread: async () => { throw Error("not used"); },
      waitThread: async (input) => {
        calls.push(`wait:${input.threadId}:${input.runId}`);
        return { threadId: input.threadId, runId: input.runId ?? null, status: "interrupted", timedOut: false, next: null };
      },
      interruptThread: async (input) => {
        calls.push(`interrupt:${input.threadId}:${input.runId}:${input.reason}`);
        return { threadId: input.threadId, runId: input.runId ?? null, status: "interrupt_requested" };
      },
      readThread: async () => ({ items: [] }),
      environmentLinks: async () => ({ environmentId: "env-a", links: [], notListed: "" }),
      close: async () => { calls.push("close"); },
    }),
  });
  await assert.rejects(gateway.run({
    cwd: process.cwd(), title: "Task", message: "Keep working", clientRequestId: "request-cancel",
    model: "gpt-6-astra", runtimeMode: "auto", signal: controller.signal,
    onStarted: () => controller.abort(),
  }), /aborted after interrupting/);
  assert.deepEqual(calls, [
    "interrupt:thread-cancel:run-cancel:Durable Pi task was cancelled",
    "wait:thread-cancel:run-cancel",
    "close",
  ]);
});

test("T3 runtime can cancel a previously paused remote run", async () => {
  const calls: string[] = [];
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => { calls.push("initialize"); },
      listProjects: async () => [],
      launchThread: async () => { throw Error("not used"); },
      sendThread: async () => { throw Error("not used"); },
      waitThread: async (input) => {
        calls.push(`wait:${input.threadId}:${input.runId}`);
        return { threadId: input.threadId, runId: input.runId ?? null, status: "cancelled", timedOut: false, next: null };
      },
      interruptThread: async (input) => {
        calls.push(`interrupt:${input.threadId}:${input.runId}:${input.reason}`);
        return { threadId: input.threadId, runId: input.runId ?? null, status: "interrupt_requested" };
      },
      readThread: async () => ({ items: [] }),
      environmentLinks: async () => ({
        environmentId: "env-a",
        links: [{ environmentId: "env-b", label: "Linux B", status: "reachable", access: "auto" }],
        notListed: "",
      }),
      close: async () => { calls.push("close"); },
    }),
  });
  const result = await gateway.cancel({
    threadId: "thread-paused", runId: "run-paused", runtimeMode: "auto-accept-edits", environmentId: "env-b",
  }, "Operator cancelled paused task");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, [
    "initialize",
    "interrupt:thread-paused:run-paused:Operator cancelled paused task",
    "wait:thread-paused:run-paused",
    "close",
  ]);
});

test("T3 runtime refuses an unreachable linked environment before launching", async () => {
  let launched = false;
  let closed = false;
  const gateway = new T3RuntimeGateway({
    connect: async () => ({
      initialize: async () => undefined,
      environmentLinks: async () => ({
        environmentId: "env-a",
        links: [{ environmentId: "env-linux-b", label: "Linux B", status: "unreachable", access: "auto" }],
        notListed: "",
      }),
      listProjects: async () => [],
      launchThread: async () => { launched = true; throw Error("must not launch"); },
      sendThread: async () => { throw Error("must not send"); },
      waitThread: async () => { throw Error("must not wait"); },
      interruptThread: async () => { throw Error("must not interrupt"); },
      readThread: async () => ({ items: [] }),
      close: async () => { closed = true; },
    }),
  });
  await assert.rejects(gateway.run({
    cwd: "/srv/project", title: "Remote", message: "work", clientRequestId: "remote-unreachable",
    model: "gpt-6-astra", runtimeMode: "auto", environmentId: "env-linux-b",
  }), /Linux B is unreachable/);
  assert.equal(launched, false);
  assert.equal(closed, true);
});
