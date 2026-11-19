const args = process.argv.slice(2);
const has = (value) => args.includes(value);
const after = (value) => args[args.indexOf(value) + 1];

if (has("FAIL")) {
  console.error("synthetic failure");
  process.exit(7);
}

if (args[0] === "project" && args[1] === "add") {
  const path = args.at(-1);
  console.log(`Added project project-1 (${after("--title") || "Project"}) at ${path}.`);
} else if (args[0] === "thread" && args[1] === "list") {
  console.log(JSON.stringify([{ threadId: "thread-1", projectId: "project-1", title: "One", status: "completed", providerInstanceId: "codex", model: "model-1", branch: "main" }]));
} else if (args[0] === "thread" && args[1] === "start") {
  if (after("--provider") !== "codex" || after("--model") !== "model-1") process.exit(9);
  if (after("--worktree") !== "main" || after("--branch") !== "feature/test") process.exit(10);
  console.log(JSON.stringify({ threadId: "thread-2", runId: "run-2", status: "completed", reply: "ok", error: null }));
} else if (args[0] === "thread" && args[1] === "send") {
  console.log(JSON.stringify({ threadId: args.at(-2), runId: "run-3", status: "completed", reply: "continued", error: null }));
} else if (args[0] === "thread" && args[1] === "show") {
  console.log(JSON.stringify({ thread: { threadId: args.at(-1), projectId: "project-1", title: "One", status: "completed", providerInstanceId: "codex", model: "model-1", branch: "main" }, messages: [{ role: "assistant", text: "ok" }] }));
} else if (args[0] === "environment" && args[1] === "list") {
  console.log(JSON.stringify([{ environmentId: "env-1", name: "Linux B", status: "online" }]));
} else if (args[0] === "auth" && args[1] === "pairing" && args[2] === "create") {
  console.log(JSON.stringify({
    id: "pairing-1",
    credential: "one-use-secret",
    label: after("--label") || null,
    scopes: args.flatMap((arg, index) => arg === "--scope" ? [args[index + 1]] : []),
    expiresAt: "2030-01-01T00:00:00.000Z",
  }));
} else if (args[0] === "auth" && args[1] === "pairing" && args[2] === "revoke") {
  console.log(`Revoked pairing credential ${args.at(-1)}.`);
} else if (args[0] === "auth" && args[1] === "session" && args[2] === "revoke") {
  console.log(`Revoked session ${args.at(-1)}.`);
} else {
  console.error(`unknown args: ${JSON.stringify(args)}`);
  process.exit(11);
}
