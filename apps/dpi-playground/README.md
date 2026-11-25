# Durable Pi Playground: hub + web client

The web interface of the Durable Agent Network. It runs no agents. The **hub** (Node, Express) keeps the device registry and tokens, proxies REST calls to each device's [`dpi-backend`](../dpi-backend), and multiplexes every device, session and agent stream into one SSE connection per browser tab. The **FE** (Vue 3, Vite 8) renders those streams through the SDK models in [`../dpi-sdk`](../dpi-sdk).

See the [repository README](../../README.md) for screenshots, the network setup and the demo.

## Run

```bash
just install                         # once, from the repo root: the hub loads apps/dpi-sdk and the tests use apps/dpi-backend
just hub build                       # from the repo root: type-check and build the web UI the hub serves (again after FE changes)
just hub start                       # from the repo root: http://localhost:4781 (stops whatever already holds the port)
# or, from this directory after just install:
npm run build && npm start
npm run dev                          # Vite middleware with hot reload (no build needed)
```

| Option | Default | Meaning |
|---|---|---|
| `--port` / `DPI_HUB_PORT` | `4781` | hub port |
| `--host` / `DPI_HUB_HOST` | `127.0.0.1` | bind address. Anything else lets the network drive every device the hub holds tokens for |
| `DPI_HOME` | `~/.dpi` | where `network.sqlite` lives |
| `DPI_NETWORK_FILE` | `dpi-network.yaml`, found by walking up from the app | devices seeded into the registry at boot |
| `DPI_TASK_WORKER` | `1` | set to `0` to disable automatic `agent.message` task dispatch |
| `DPI_T3_RUNTIME` | unset (`windows/start-local.ps1` defaults to `1`) | set to `1` to route write-capable, non-Coordinator Codex members through T3 with an autonomy-bounded runtime mode; set to `0` to disable |
| `DPI_T3_WORKER_PROVIDER_INSTANCE` | `codex` | built-in T3 Codex Provider reused for worker Agents; the isolated Durable Coordinator remains a separate Provider |
| `DPI_T3_COORDINATOR_PROVIDER_INSTANCE` | `codex_durable_coordinator` | read-only T3 Codex Provider for visible Coordinator result handling; retains Durable Pi coordination tools |

T3 exposes two deliberately isolated orchestration domains. Codex/DeepSeek projects use Durable Pi for task records,
leases, permissions, cross-device routing and visible child sessions; children inherit their parent/template model unless
the user selects another Durable-eligible Provider. Antigravity is a protected interactive Provider: open it directly
in T3 and let its official runtime perform native task splitting and child-Agent management. Durable Pi never invokes
Antigravity, never selects it as a fallback, and never sends it work from Codex, DeepSeek or a remote scheduler.

The device backend supports `DPI_PROVIDER=faux`, `openrouter`, or `openai`. `openai` uses Pi's OAuth credential at `~/.pi/agent/auth.json` by default (`DPI_AUTH_FILE` overrides it), so Sign in with ChatGPT tokens can be shared with the embedded Pi Durable runtime without copying a token into project files. Authenticate through Pi's `/login openai`; never paste the token into the Hub UI or commit `auth.json`.

For the already signed-in local Codex, the conservative execution path uses `CodexAppServerClient` instead of copying credentials into Pi. It launches `codex app-server --stdio`, performs JSON-RPC initialization and model discovery, and leaves token storage and refresh owned by Codex. The preferred control-plane integration is the typed T3 boundary (`T3CodeClient`, `T3McpClient`, `T3RuntimeGateway`): T3 owns provider lifecycle, durable threads, worktrees, remote clients and linked environments, while this Hub retains project policy, memory, task admission, evidence and handoff data. Pi and Codex remain separate selectable T3 providers.

The `DPI_T3_RUNTIME=1` gateway uses one-use pairing, two orchestration scopes, an explicit mode ceiling, durable thread
continuation and immediate credential revocation. Supervised work uses T3's approval UI, authorized autonomy accepts
edits, and restricted unattended work uses automatic mode. Read-only tasks remain on the sandboxed direct Codex path.
Worker threads use a dedicated Provider with the Durable Pi coordination MCP disabled; Provider ownership is persisted
with each thread so an older default-Provider thread cannot be resumed as a worker thread.
Cancellation and timeout are propagated to the exact T3 thread/run with `t3_thread_interrupt`; the gateway waits for
a durable terminal state instead of treating an accepted interrupt request as proof that remote work has stopped.
If T3 needs a human answer, the durable task pauses with `USER_INPUT_REQUIRED` without consuming a failure attempt.
Answer in T3 Code; a background status monitor automatically resumes the durable task and the worker recovers the
stored run instead of sending the task a second time.

## Hub API

| Route | Purpose |
|---|---|
| `GET /api/network` | devices with live status, device info and the last known tree (never tokens), plus `configFile`, the loaded `dpi-network.yaml` |
| `GET /api/t3/environments` | local T3 identity and reachable/unreachable linked environments; returns `linksEnabled:false` when the T3 feature is disabled |
| `POST /api/devices/:id/check` | probe a device now. There are no device write routes: devices come from `dpi-network.yaml` and `just net register` |
| `GET`/`POST /api/projects` | list or create isolated projects |
| `GET`/`PATCH`/`DELETE /api/projects/:id` | inspect, update or remove one project |
| `GET`/`POST /api/projects/:id/memories` | list current versioned project facts or create/update one with optional optimistic version |
| `GET /api/projects/:id/memories/:memoryId/history` | immutable revision history for one project fact |
| `DELETE /api/projects/:id/memories/:memoryId` | expire a fact without deleting its history |
| `GET`/`POST /api/projects/:id/approvals` | list or request parameter-bound, expiring project approvals |
| `POST /api/projects/:id/approvals/:approvalId/decision` | approve or deny a pending operation |
| `POST /api/projects/:id/approvals/:approvalId/revoke` | revoke an unused approved operation |
| `POST /api/projects/:id/approvals/:approvalId/consume` | atomically consume approval only when the exact operation hash matches |
| `GET`/`POST /api/projects/:id/tasks` | list or enqueue durable project tasks |
| `GET /api/projects/:id/tasks/:taskId/attempts` | inspect every execution attempt, worker, heartbeat, fence and terminal result |
| `POST /api/projects/:id/tasks/claim` | atomically claim the highest-priority available task with `{workerId,leaseMs?,maxGlobalRunning?,maxProjectRunning?,maxWorkerRunning?}`; returns a lease and fencing epoch, or 204 |
| `POST /api/projects/:id/tasks/:taskId/heartbeat` | extend the matching live lease with `{workerId,fenceEpoch,leaseMs?}` |
| `POST /api/projects/:id/tasks/:taskId/complete` | commit `result` only when worker and fencing epoch still own an unexpired lease |
| `POST /api/projects/:id/tasks/:taskId/fail` | record `error` and retry after `retryDelayMs`, up to `maxAttempts` |
| `POST /api/projects/:id/tasks/:taskId/cancel` | cancel the task and advance its fence so a previous worker cannot commit |
| `POST /api/projects/:id/tasks/:taskId/pause` | pause a queued/retrying/dependency-waiting task; running tasks must be cancelled |
| `POST /api/projects/:id/tasks/:taskId/resume` | resume to `QUEUED` or `WAITING_DEPENDENCY` after rechecking dependencies |
| `GET`/`PUT /api/ui-state/:key` | selection, panel layout and tree width |
| `GET /api/stream` | the tab's SSE connection. The first frame carries its `streamId` |
| `PUT /api/stream/:streamId {subs}` | `<dev>/device?docs=…`, `<dev>/session/<sid>`, `<dev>/agent/<sid>/<aid>?docs=…`. Up to 20 keys. `network` is always on |
| `ALL /api/devices/:id/v1/*` | REST proxy with the device token injected. Answers 503 while the device is not online and 502 when it does not answer. Paths ending in `/events` answer 400: streams go through `/api/stream` |

The Project Agent forms use the T3 environment endpoint to bind a Codex Agent to this computer or to one reachable
linked environment. A remote working directory is stored exactly as entered and is validated by the target runtime;
the Windows Hub only resolves and checks paths for local execution. Existing Agents can update the environment and
working directory together, preventing an accidental Linux/macOS run with a Windows path (or the reverse). Scheduler
write locks are scoped by Environment plus target-native path. Unreachable linked machines enter `WAITING_DEVICE`
without spending a failure attempt; the monitor resumes the exact bound T3 run when that Environment becomes reachable.

`guard.ts` rejects unknown Host headers (DNS rebinding), cross-origin requests and non-JSON writes.

Project tasks live in the Hub's `projects.sqlite`, not in a Pi session database. Claim, attempt creation and `task.claimed` event insertion share one SQLite transaction. Every worker write is checked against `workerId + fenceEpoch + leaseUntil`; a worker that resumes after its lease was replaced cannot overwrite the new result. Pi's internal model/tool tasks remain owned by Pi Durable and are not duplicated in this queue.

Global, project and worker concurrency limits are evaluated inside that same claim transaction and count only live leases. The built-in Hub worker defaults to 4 globally, 1 per project and 4 for its worker identity. These are scheduler admission limits, separate from model-provider rate limits.

One worker tick attempts projects concurrently, so a slow Agent in project A does not block project B. The transactional global/project/worker admission limits still decide which claims are allowed; task execution within one project remains one-at-a-time by default.

Enqueue accepts `dependsOn: string[]`. Such a task remains `WAITING_DEPENDENCY` and cannot be claimed until every parent completes. Completing the last parent atomically queues it; a failed or cancelled parent marks downstream tasks `FAILED` with `DEPENDENCY_FAILED`, including transitive descendants.

The Hub worker currently executes one deliberately narrow task kind: `{kind:"agent.message",memberId,content,whenBusy?,waitMs?}`. It claims the task, heartbeats its lease, resolves the member inside the same project, sends through `DpiClient`, and commits the answer. Retries reuse a stable Pi `requestId`, so a lost HTTP response cannot submit the prompt twice. Unsupported input and missing project members fail without retry; temporary device failures follow the task retry policy.

Agent-to-Agent `POST /api/projects/:id/messages` uses the same queue rather than calling a target device directly. Its caller request id deterministically maps to one task id, so transport retries do not create duplicate work. `waitMs: 0` returns the queued task immediately; a positive wait polls the durable task and may return the completed answer without owning the execution lifecycle.

Before dispatch, the trusted Hub prepends the project's active versioned facts to the task prompt, followed by the current task. Expired facts and other projects' facts are excluded. Remote collaboration uses the independently registered token of each device plus `X-DPI-Device-Id`; the Hub binds that authenticated device to the project member identity before returning or changing Agent-visible memory. The legacy shared Hub token is disabled unless explicitly enabled for migration.

## Layout

```text
apps/dpi-playground-hub/src/   main (routes, options), monitor (status machine per device), proxy, mux, guard, seed
apps/dpi-playground-fe/src/
  App.vue                       top bar; network tree | inspector | agent view; help and path dialogs
  client/                       stream.ts (one EventSource, named slots), hub.ts, composables.ts, store.ts,
                                commands.ts (slash commands), jobs.ts (durable job runs),
                                signature.ts (tool parameters as a TypeScript declaration), markdown.ts, ids.ts
  components/                   NetworkSidebar + TreeRow + DeviceIcon, OfflinePanel,
                                Inspector tabs: Session (ContextBar), State (StateEditor), Tasks (TasksPanel),
                                  Tools, Extend (ExtensionsPanel),
                                AgentView + TranscriptItem + JobCard + Composer,
                                NewSessionDialog + DirBrowser, PromptDialog, ModelPicker
  style.css, network.css, jobs.css, extensions.css
tests/                          hub.test.ts, network-ui.mjs, device-ui.mjs, agent-features.mjs,
                                browser-close.mjs, e2e-network.mjs
```

## Tests

```bash
npm run build && npm run lint && npm test     # types, Vite build, Oxlint, hub test (faux devices)
node tests/network-ui.mjs                     # 28 browser checks against two faux devices (after npm run build)
DPI_DEVICE=<id> node tests/device-ui.mjs       # the web UI on one real device: turns, tools, model, App State, jobs, read only, fork, /compact, /reset
DPI_DEVICE=<id> node tests/agent-features.mjs  # steer, dedupe, withdraw, reject, read only, subagent, job, compact, reset
DPI_DEVICE=<id> node tests/browser-close.mjs   # quit Chrome mid-tool; the device finishes; a new browser reattaches
DPI_DEVICE=<id> node tests/e2e-network.mjs     # TUI + web + restart mid-tool + fork + reattach (needs a device that runs as a service)
```

The device suites need the hub running (`DPI_URL`, default `http://localhost:4781`). `DPI_DEVICE` defaults to `local`, except in `e2e-network.mjs`, which requires it and also drives the TUI in tmux. The browser suites use the installed Google Chrome; `HEADED=1` shows the window. Run them one device at a time, because they share the hub's persisted selection.

From the repo root, `just hub check` runs the first line, and `just test ui`, `just test device <id>` (device-ui, agent-features and browser-close), `just test devices` and `just test e2e <id>` run the rest. Build the web UI (`just hub build`) before the browser suites.
