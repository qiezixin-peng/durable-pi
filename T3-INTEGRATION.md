# T3 Code integration

## Decision

T3 Code is the primary agent control plane. Durable Pi is the project-governance and handoff layer built around it.
This avoids maintaining a second desktop/mobile client, provider manager, worktree UI, remote pairing system and basic
thread store.

```text
T3 Code
├── desktop / web / mobile
├── Codex / Pi / other ACP providers
├── durable threads and worktrees
├── background service and linked environments
└── remote pairing and approvals
        │
        ▼
Durable Pi project layer
├── project policy and autonomy modes
├── task admission, dependencies and budgets
├── project/private memory and context selection
├── evidence, artifacts, audit and backups
└── versioned cross-device handoff packages
```

Pi is not removed. It is an optional T3 provider and is useful when a project needs Pi's SDK, RPC protocol, extensions,
skills or native session behavior. Codex can remain the default provider when its existing subscription login is already
available.

## Verified on Windows

The following path was exercised end to end on 2026-11-17 with T3 Code 0.1.10:

1. Installed the signed Windows release and the `t3` CLI.
2. Installed T3 as a per-user background service.
3. Confirmed that T3 discovered the existing authenticated Codex CLI without copying its token.
4. Registered this repository as a T3 project.
5. Started a real Codex thread and received its completed response.
6. Stopped and restarted an isolated T3 server; the project, thread, run and messages survived.
7. Started a second thread in a T3-managed Git worktree and verified its independent branch and path.
8. Invoked the same running service through `T3CodeClient` and completed another real thread.
9. Completed the MCP OAuth pairing flow without displaying or persisting a token, with only
   `orchestration:read` and `orchestration:operate` scopes.
10. Launched, waited for and read a real Codex thread through `T3RuntimeGateway` under an explicit
    `approval-required` credential and request ceiling, then verified that the minted auth session was revoked.
11. Cancelled a real active run through `t3_thread_interrupt`, waited for its durable terminal state and verified
    that the short-lived cancellation-validation auth session was absent afterward.
12. Registered a project-scoped `durable-pi` MCP server in Codex and completed a real
    T3 → Codex → Durable Pi read/write round trip without copying the Codex login token.
13. Delegated a durable task from a real T3 Coordinator thread to a persistent Coder, executed it in a separate
    T3 thread, and correlated both T3 thread/run IDs with the fenced Durable Pi task attempt.
14. Created and archived a permission-bounded temporary Agent from a real T3 thread, preserving its lifecycle record.

The isolated recovery test also reported T3's V2 orchestration recovery on both shutdown and startup. Its database
migrations include scheduled-task, peer-link fencing, delegated recovery, provider-attempt and device-authentication
state. These capabilities must be reused rather than reimplemented without a proven semantic gap.

## Local commands

```powershell
t3 --version
t3 status
t3 service status
t3 project add --title "Durable Pi" "C:\Work\durable-pi"
t3 thread list --project "C:\Work\durable-pi" --json
```

Remote Executors use authenticated T3 Environment links. In this three-device deployment, Windows exposes its
loopback-only T3 service to Linux and macOS through persistent SSH reverse tunnels; no T3 port is exposed directly to
the LAN or public Internet. `windows/ensure-t3-peer-link.ps1` uses T3's supported `pair` and `environment link`
commands to exchange a one-use token, verifies the Environment identity, and never stores the token. The scheduled
`DurablePi-T3-Peer-AutoLink` job checks every 30 minutes and renews links before expiry. Links retain
`approval-required` access and remain individually revocable in T3's Authorized clients settings. `GET
/api/t3/environments` is the local read-only source of truth for current reachability; a stored link is not treated as
runnable while T3 reports it offline.

Remote task recovery is bound to the recorded execution identity. An expired T3 run is resumed only when its provider,
selected model and Environment still match the newly validated dispatch identity. Any mismatch pauses the task as an
unknown-side-effect case instead of resuming or relaunching it under a different device/model identity.

## Pi provider

Pi 1.5.2 is installed at `%USERPROFILE%\.pi\agent\bin\pi.cmd`. T3 intentionally leaves Pi disabled until it is enabled
in Settings. Enabling it does not replace Codex. T3 can then preserve Pi models, authentication, extensions, skills,
context files and native sessions.

Pi still needs a configured model provider. Run `pi`, complete `/login`, then enable and refresh Pi in T3 Settings. A
human is required only if the provider opens an OAuth page, asks for MFA or otherwise needs account authorization.

## Code boundary

The T3 boundary has three layers:

- `T3CodeClient`: shell-free local CLI operations and one-use pairing credential issuance;
- `T3McpClient`: Streamable HTTP MCP, PKCE exchange, per-request mode ceiling, typed orchestration tools and session revocation;
- `T3RuntimeGateway`: project resolution plus launch/resume/wait/read lifecycle for one task turn.

Together they provide:

- project registration;
- thread listing;
- starting and continuing threads;
- explicit provider/model selection;
- T3-managed Git worktrees;
- thread state and message retrieval;
- linked-environment discovery;
- durable T3 thread continuation;
- fenced task-attempt correlation with T3 thread and run IDs;
- cancellation, timeout, bounded output and structured command failures.
- remote execution-environment binding per Codex Agent, with target-native workspace paths;
- restart recovery that reattaches an expired Durable Pi attempt to its existing T3 run;
- fenced command, file-change, dynamic-tool and web-search evidence mirrored into the project audit store.
- AbortSignal-aware MCP waits plus exact thread/run interruption and terminal-state confirmation on cancellation or
  timeout, so cancelling a Durable Pi task does not leave its T3 turn running remotely.
- a project-scoped MCP facade for policy, Agents, tasks and memory plus idempotent memory writes, bounded task
  delegation, permission-bounded temporary Agent creation, archival and cancellation.

Contract tests use a fake CLI process. A separate local integration check exercised the installed T3 executable and the
running background service.

## Migration rules

1. Do not add new duplicate UI features to the legacy Hub when T3 already exposes them.
2. Keep existing Pi Durable and direct Codex paths working until their T3 replacement has an end-to-end test.
3. Move provider lifecycle, thread persistence, worktrees and remote environment control behind the T3 boundary.
4. Keep project memory, policy, budgets, artifact evidence, handoff manifests and compatibility checks in Durable Pi.
5. Prefer T3's durable child-thread delegation over inventing another subagent process protocol.
6. Record the T3 thread/run IDs in Durable Pi task attempts so audit and recovery can correlate both systems.
7. Remove a legacy path only after recovery, cancellation, approval and restart tests prove semantic equivalence.

## Runtime rollout and remaining integration work

- Task attempts persist T3 thread/run IDs with fencing. Project members also persist the owning runtime, model and
  Provider instance; a thread with unknown or different Provider ownership is never resumed across that boundary.
- Project and Agent membership mutations now commit their current-state projection and immutable project event in the
  same `BEGIN IMMEDIATE` SQLite transaction. Workspace changes and explicit thread resets therefore cannot detach a
  T3/App-Server thread without also recording the matching audit event; injected event-store failures are covered by
  rollback tests.
- Online backups, isolated restore drills and the standalone database verifier now require both SQLite `quick_check`
  and an empty `foreign_key_check`. A snapshot that is structurally readable but contains orphaned references is
  rejected and its partial backup files are removed before retention accounting.
- Backup manifest v3 includes both ACTIVE files and EXPIRED files still inside their recovery window, with each
  lifecycle state bound to the database snapshot. It also hashes and preserves the non-secret `data-sources.json`,
  including project bindings, target T3 Environments and per-device verified models; credential files remain excluded.
  Restore rewrites both Artifact classes to the destination root, atomically restores the device configuration and
  preserves replaced data. Schema-v1 ACTIVE-only and schema-v2 Artifact-only snapshots remain readable.
- `DPI_T3_RUNTIME=1` routes non-Coordinator, write-capable Codex members through T3. `SUPERVISED` uses T3's
  `approval-required` mode, `AUTHORIZED_AUTONOMY` uses `auto-accept-edits`, and `RESTRICTED_UNATTENDED` uses `auto`.
  Read-only roles remain on the isolated direct path because T3 runtime modes do not currently express a hard
  read-only filesystem sandbox. The Windows launcher enables the T3 path unless explicitly set to `0`.
- T3 workers use the dedicated `codex_durable_worker` Provider. Its launch arguments disable the recursive
  `durable-pi` MCP plus unrelated local desktop/reverse-engineering/audio MCPs. Coordinator threads keep the default
  coordination capability through a separate `codex_durable_coordinator` Provider: T3 forces its turns into the
  read-only `approval-required` sandbox, keeps `durable-pi`, and disables unrelated side-effect MCPs. The Windows
  launcher idempotently creates both Providers and restarts T3 only when their definitions change.
- `unix/configure-t3-worker-provider.sh` creates the same Worker Provider on Linux/macOS. It disables only MCP servers
  actually present in that device's Codex configuration; inventing a disabled entry for a nonexistent MCP makes Codex
  reject the Provider configuration. Remote validation defaults to the account-supported `gpt-5.6-sol`, while callers
  can explicitly request a newer available model. The platform does not silently fall below the GPT-5.6 family.
- Successful and failed delegated-task notifications now run in the visible T3 Coordinator thread instead of an
  invisible direct Codex session. A real end-to-end run verified `codex_durable_worker` for the child and
  `codex_durable_coordinator` for the result synthesis, with both thread/run pairs persisted in fenced attempts.
- The Hub exposes linked environments through a short-lived read-only MCP session. Agent create, handoff binding and
  existing-Agent settings can bind a reachable environment without treating its Linux/macOS path as a Windows path.
- Expired task attempts reattach to their persisted T3 thread/run IDs. They do not launch a duplicate run.
- A T3 run waiting for a human answer becomes `PAUSED / USER_INPUT_REQUIRED` instead of a failed retry. The waiting
  attempt is excluded from the failure budget. A read-only status monitor notices when the exact run changes state
  after the answer is supplied in T3 Code, automatically requeues the durable task, and reattaches to that run without
  resending the prompt. The normal question-and-answer path therefore requires no legacy Hub interaction.
- Remote workspace locks are scoped by linked Environment plus target-native path: two different machines may work in
  parallel even when both use `/srv/project`, while two Agents writing the same path on one machine remain serialized.
- Unreachable linked environments enter `WAITING_DEVICE` without consuming the failure budget. A five-second monitor
  resumes them only after T3 reports that exact Environment reachable, and a bound in-flight run is recovered rather
  than relaunched.
- T3 command, file-change, dynamic-tool and web-search activity is mirrored into Durable Pi's fenced audit store.
- Direct Codex workers disable unrelated global local MCP servers (`anode`, recursive `durable-pi`, `rea`, `reaper`)
  by default. This prevents project workers from inheriting unrelated permissions and avoids one process tree per MCP
  per durable Agent. `DPI_CODEX_DISABLED_MCP_SERVERS` can override the list.
- Token usage remains on the direct Codex path until T3 exposes authoritative per-run usage through its public MCP
  contract; the platform does not estimate or invent it.
- Real cross-device checks now pass on both a Linux x64 executor and a macOS arm64 executor: local T3 launches the
  remote `codex_durable_worker`, the remote model returns the OS-specific marker, and the exact remote project/thread/
  run IDs are returned to the caller. `scripts/verify-t3-remote-environment.ts` is the repeatable smoke test.
- A Linux executor whose network cannot reach OpenAI may use the bounded reverse-proxy tunnel in
  `windows/keep-remote-proxy-tunnel.ps1`. `windows/install-remote-proxy-tunnel.ps1` installs its reconnect loop as a
  per-user scheduled task, and `unix/t3code-proxy.conf` persists the matching T3 service environment. This path keeps
  the proxy bound to loopback on both ends and uses SSH authentication; it is optional for devices with direct access.
- The Windows host exposes the Linux and macOS user-data roots to humans as persistent read-only SSHFS drives (`B:`
  and `M:`). Per-user scheduled tasks reconnect them after login; SSH keys, not stored passwords, authenticate both
  mounts.
- Agents do not depend on Windows drive-letter visibility. The standalone `durable-data` MCP reads the catalog at
  `%USERPROFILE%\.dpi\data-sources.json` and performs bounded, read-only SSH operations: source discovery, one-level
  directory listing, filename search, bounded UTF-8 content search, and UTF-8 text reads. Relative-path confinement, symlink refusal, binary refusal,
  byte/depth/result limits and fixed remote helper code prevent it from becoming a general remote shell. Credential
  locations and key-like files (`.ssh`, cloud/CLI credential roots, `.env*`, private-key/certificate formats and known
  auth files) are excluded from listing/search and rejected on direct read or artifact staging. Every data response is
  also labeled `UNTRUSTED_DATA` with `instructionAuthority: false`; tool descriptions state that filenames, excerpts and
  document text are evidence, not executable instructions. Text reads include the returned byte count, SHA-256 of the
  exact returned bytes, source modification time and truncation flag so later decisions can cite and revalidate the
  actual snapshot instead of treating mutable remote text as timeless.
- Binary/artifact streaming now binds the initial stat to the opened file descriptor. Local and remote readers verify
  regular-file type, size and modification time immediately after opening and again after the final byte; a source that
  changes before or during transfer fails instead of producing a silently mixed artifact. Fresh Linux/macOS staging
  created two verified 21-byte SHA-256 artifacts, and exact request replay reused them without re-copying.
- `durable-data` is available to the isolated Worker Provider even though `durable-pi` remains disabled there. The
  catalog presents Windows A, Linux B and macOS C through one interface. Workers can inspect shared device data without
  inheriting Coordinator task/memory mutations. A real T3 Worker run verified all three roots and returned
  `DATA_SOURCES_OK:A,B,C` after content-searching and reading markers on both remote devices, without shell or ordinary filesystem tools.
- Controlled writeback is deliberately not exposed through SSHFS or `durable-data`. A write-capable task is routed to
  the target device's Agent and its native workspace. Linux and macOS Agents each wrote and verified one scoped test
  file; the Windows Worker then read both results back through `durable-data` and returned
  `THREE_DEVICE_DATA_ROUNDTRIP_OK`. This is the supported A → B/C write → A readback pattern.
- The read-only provider also exposes `search_all_data_files` and `search_all_data_text`. They search every source bound
  to the current project (or an explicit bound subset), keep strict per-source traversal/result limits, tag every result
  with source/device identity, and isolate an offline device as a bounded error instead of discarding successful results
  from the other machines. One call is capped at eight sources; larger projects must name an explicit subset. A live federated name search reached Windows A, Linux and macOS in one call and found each
  remote `DurablePiProjects` directory while reporting no source errors. A real `gpt-6.1-sol` T3 Coordinator then used
  only these MCP tools to repeat the three-source search and verify that `.ssh/id_ed25519` is policy-rejected, returning
  `FEDERATED_DATA_POLICY_OK`; the repeatable check is `scripts/verify-t3-federated-data.ts`.
- The Durable Scheduler has also completed a real three-device dependency graph: Linux and macOS workers ran
  concurrently in their own native workspaces and returned `LINUX_DURABLE_OK` and `MACOS_DURABLE_OK`; a dependent
  Windows Coordinator read both persisted task results through the project MCP and returned
  `THREE_DEVICE_COORDINATION_OK`.
- A Durable project must own a unique Coordinator root/worktree. When two projects deliberately shared the same root,
  the project MCP withheld its tools instead of guessing an identity. Assigning a dedicated root removed the ambiguity
  and completed the coordination turn; this fail-closed rule prevents cross-project task or memory leakage.
- Every data source now carries an explicit Durable project allowlist. The standalone MCP resolves the caller from the
  unique project workspace (or explicit project/member identity), advertises no tools outside a managed project, and
  reloads the catalog on every call so binding changes take effect without restarting T3. The Hub exposes local-only
  GET/PUT project binding endpoints and records each change in the project event log. Agent-facing source records omit
  the binding list, so one project cannot infer the IDs of other projects sharing the same physical source.
- Binary data is not returned through model context. The Coordinator-only `stage_data_artifact` tool streams one exact
  project-bound source file into the project Artifact Store, enforces the store size limit, computes SHA-256, compares
  the transferred size with the source metadata and gives retries a stable request identity. Real Linux and macOS SSH
  transfers were staged and verified by `scripts/verify-remote-artifact-staging.ts`.
- A real disconnected Git relay has been verified in an isolated cross-device test repository: one baseline bundle was cloned on
  Linux and macOS, each T3 Agent created and tested only its platform record, both result bundles were verified and
  fetched on Windows, and their sibling commits merged cleanly. Windows then returned `CROSS_PLATFORM_RESULTS_OK`.
- T3 can keep a run marked `running` while a command approval is pending. The runtime gateway now inspects read-only
  activity after each bounded wait and converts a waiting approval/question into Durable Pi's resumable user-wait
  state instead of allowing a false RUNNING state to reach the task timeout. The waiting monitor performs the same
  check before auto-resume, preventing an approval-pending run from cycling PAUSED → RUNNING. A real Linux empty-commit
  probe remained PAUSED/WAITING_USER across a Hub restart and was then cancelled without creating a commit.
- Registering a new folder is a T3 environment-management operation, not an Agent runtime operation. The current linked
  environments deliberately cap Windows at `auto`, so the scheduler does not silently elevate that link to
  `full-access`. `unix/register-t3-project.sh` now performs the idempotent target-local registration after a repository
  is copied; it discovers the installed T3 runtime when `t3` is absent from a non-interactive SSH PATH. The helper is
  deployed and verified on both Linux and macOS.
- Cancelling a Durable task that is paused on a T3 request now interrupts and confirms the exact persisted remote
  Thread/Run before the member is reused. A live Linux probe cleared the old approval with no runtime cancellation
  error, and the next task completed in ordinal 4 of the same durable T3 thread instead of being trapped by ordinal 3.
- Conflict handling has a real add/add proof. Linux and macOS started from the same merged commit and independently
  added different `platforms/shared.json` files. Windows verified/fetched both bundles into separate refs and used
  non-mutating `git merge-tree --write-tree`; Git returned exit 1 and named the exact conflict, while `main` stayed
  clean and contained neither version. The evidence is in the validation repository's `CONFLICT-REPORT.md`.
- New projects are now self-service after the user adds their directory to T3. An unmanaged workspace exposes only
  the read-only `list_durable_data_source_options` onboarding query and `initialize_durable_project`; initialization
  deterministically creates one isolated Durable project and Coordinator for
  the current T3 root, freezes the selected team template, and optionally binds selected A/B/C read-only data sources.
  Device binding is deliberately separate from folder authorization: a newly initialized project receives empty
  per-source folder grants. The Coordinator calls `bind_durable_data_folder` only after the user or task identifies a
  concrete directory. `durable-data` then rejects reads and searches outside those exact folders; listing an ancestor
  returns only the synthetic path segments needed to reach authorized folders, never sibling directory names.
  It cannot enroll an arbitrary path. A live new-project run created `t3-3ea8179eaaaa8bd331f7` and then returned
  `THREE_DEVICE_DATA_ROUNDTRIP_OK` while reading all three bound sources.
- The onboarding source query returns only source ID, label, device, read-only flag and remote/local classification;
  it omits physical roots and other projects' bindings. A live T3 run discovered all three options before replaying
  initialization, so future users do not need to remember internal source IDs.
- Team templates no longer require manual Hub setup. A Coordinator can idempotently call
  `materialize_durable_agent` for one pre-authorized role; the role's permission cannot exceed the frozen template.
  Blank projects pre-authorize a minimal general-purpose Coder/Tester/Reviewer plan but materialize none of them at
  initialization. Runtime startup transactionally upgrades idle legacy Blank projects and active Codex member models;
  projects with unfinished tasks are skipped instead of being mutated under a live lease.
  A live cross-platform project materialized one `WORKSPACE_WRITE` Coder, delegated a durable task to its separate
  `codex_durable_worker` thread, and received the result through a `codex_durable_coordinator` thread. Shared-checkout
  writes remain scheduler-serialized until a managed worktree is assigned.
- `materialize_durable_agent` defaults to `workspace_strategy=auto`: a write-capable role receives a managed Git worktree when the Coordinator workspace is a clean committed Git root. Read-only roles and uncommitted/non-Git workspaces stay shared, with Scheduler serialization; callers may still request `shared` or `worktree` explicitly.
- `isolate_durable_agent_workspace` upgrades an already materialized, idle local planned write Agent from the shared
  checkout to its deterministic managed worktree once the repository becomes clean and committed. It refuses remote,
  temporary, read-only, unplanned or busy Agents and replays idempotently when isolation already succeeded.
  Changing a Codex member workspace now atomically detaches its old Thread binding, so the next task cannot resume a
  T3/App-Server Thread created for the previous checkout. The Thread history remains in T3 for audit.
  The scheduler resolves the owning T3 project from the repository root and launches the Worker with T3's
  `existing_worktree` strategy, so the external worktree does not need to be registered as a second user project.
  A live Tester task ran on branch `dpi/team-7959e16047432f3d162d9594669a1dbd`; T3 reported the exact managed
  worktree path and completed the delegated task through `codex_durable_worker`.
- Coordinators can now create and validate idempotent Git-aware handoffs directly from T3. Handoff request IDs are
  transactionally bound to their arguments, so a retry returns the same READY bundle instead of duplicating it. A
  live T3 run created handoff `2026-11-18T06-14-17.020Z-3b5cf683` for the self-service validation project and verified
  its manifest SHA-256.
- `windows/relay-project.ps1` and `unix/receive-project-relay.py` implement the controlled target copy. The sender
  requires a clean named branch and matching handoff baseline, bundles only HEAD plus that branch, derives the SSH
  target from the project's bound data-source catalog, and uploads into a fixed relay inbox. The receiver verifies
  SHA-256 and revision, refuses an existing mismatched directory, clones only under `~/DurablePiProjects`, and performs
  target-local T3 registration. Replaying the same relay returns `created:false` without overwriting the checkout.
- Relay completion is not inferred from console output. The Hub verifies source/environment binding and records an
  idempotent READY Relay Receipt plus its project event in one SQLite transaction. T3 can read receipts through
  `list_durable_relays`. Live receipts now exist for both Linux and macOS at the same source revision and `main` branch.
- Relay execution is now initiated through `plan_durable_relay`, not an Agent-authored SSH command. The durable plan
  freezes the handoff, bound source, Windows repository, target slug and title; request reuse with changed parameters is
  rejected. The tool returns a structured executable/argument vector and an exact PowerShell command, but does not run
  it, so T3's native command approval remains the user boundary. The relay script re-reads the frozen plan before any
  upload, and its receipt atomically changes that plan from `PLANNED` to `READY`. A live T3 thread created plan
  `relay-plan-f0f98d3ab0c54091cef673657397639f23e48d17` for Linux and
  `relay-plan-949d328e235c4b3b312a688a22df83273a04bb0e` for macOS; a deliberately changed title was rejected, and exact
  replays attached both existing READY receipts without overwriting either checkout.
- Remote adaptations now return through `plan_durable_return` and `windows/fetch-remote-project.ps1`. Planning requires
  a matching READY Relay Receipt and freezes the source, target slug, Windows Git root and original remote target. The
  approved command asks a target-side Python helper to reject symlinks, dirty worktrees and detached HEADs, then creates
  and checksums a branch-only bundle. Windows verifies and fetches it into `refs/dpi/remotes/<source>/<slug>` using a
  temporary ref and compare-and-swap update; it never checks out or merges, and rejects backward/divergent history.
  Return receipt and project event commit atomically. Live Linux and macOS returns both resolved to revision
  `2985f14cb9263139d22df409988d455f51cf3ac5`; Linux replay returned the same receipt without changing the worktree.
- `inspect_durable_return` gives the Coordinator a receipt-bound, non-checkout review step. It verifies that the managed
  ref still equals the recorded revision, classifies `SAME`, `REMOTE_AHEAD`, `LOCAL_AHEAD` or `DIVERGED`, reports a
  bounded name-status diff, and invokes Git's non-worktree merge-tree preview only for divergence. It reports dirty
  state, fast-forward eligibility and predicted conflicts without switching the current branch or changing files. A
  real T3 tool-only run inspected both Linux and macOS returns as `SAME`; an earlier model attempt that chose shell was
  stopped at T3 approval and interrupted, confirming that the read-only path does not silently bypass command policy.
- `plan_durable_fast_forward` is the direct integration path for non-divergent returns. It is available only when the clean named Windows
  branch is a strict ancestor of a receipt-verified remote ref. The plan freezes source, slug, return receipt, repository,
  branch, base HEAD, managed ref and target revision. `windows/apply-fast-forward.ps1` rechecks every field, disables
  repository Git hooks, and runs only `merge --ff-only`; a persisted APPLIED receipt makes crash/retry after the Git
  update idempotent. A local end-to-end repository test verified the file update, clean branch, repeat execution and that
  a deliberately installed `post-merge` hook never ran. The live T3 validation project currently has equal revisions,
  and T3 correctly rejected creation of an unnecessary plan. Diverged history must be resolved and tested in isolation
  before the separately frozen promotion path can run; conflicts are never resolved automatically on main.
- `prepare_durable_integration_agent` handles that review-only divergence without touching the main checkout. It
  requires a receipt-verified ref, clean Windows root, genuinely divergent ancestry and an active write-capable Codex
  template. A deterministic managed worktree is created at the current Windows HEAD, then a temporary Resolver Agent is
  bound to that exact path with the template's model and no permission increase. Replays reuse the same member/worktree;
  the returned structured task names the managed ref and forbids operations on the main worktree. Automated tests build
  real divergent commits, verify fast-forward rejection, create/replay the isolated Agent, and confirm main HEAD and
  status remain unchanged.
- `plan_durable_integration_promotion` closes the divergent-return path without granting the Resolver access to main.
  The Coordinator selects the exact temporary Resolver member (including the normal post-task archived state); Durable Pi verifies its managed worktree is active and
  clean, main is still at the worktree's frozen base, the integration branch is a strict fast-forward, and its history
  contains the receipt-verified remote commit. The resulting `WORKTREE_PROMOTION` plan freezes every revision and uses
  the same T3-approved, hook-disabled fast-forward executor. Automated tests create real divergent commits, merge them
  in the isolated worktree, replay the plan idempotently, and prove that planning leaves main unchanged.
- `finalize_durable_integration_agent` performs the bounded cleanup only after that plan has an APPLIED receipt. It
  requires clean main at the exact promoted revision, a clean Resolver worktree at the same commit, and matching
  managed branch/base metadata. Cleanup is rejected while that member has any non-terminal Durable task. It removes only the managed worktree and archives the temporary member; the branch,
  commit history, receipts and events are retained. Replays return the already-removed record without deleting more.
- Coordinator `cancel_durable_task` now also interrupts the exact persisted T3 Thread/Run when a task is paused for
  input or approval. The database cancellation fences the task first; runtime success/failure is returned and audited,
  preventing a cancelled task from leaving an executable approval request alive in T3.
- The three active Node applications now have a deterministic CycloneDX 1.5 inventory in `sbom.cdx.json`.
  `scripts/generate-sbom.mjs` refuses non-HTTPS/non-npm registries, missing lockfile integrity, undeclared or unapproved
  licenses, and install scripts outside the exact versioned allowlist in `supply-chain-policy.json`. It records all
  three lockfile SHA-256 values and currently inventories 323 deduplicated application/library components. Generating
  twice produces byte-identical output; the SDK contract test enforces that property and the four approved script users.
  `scripts/audit-production-dependencies.mjs` separately queries the registry and requires zero findings at every
  severity in all three production dependency graphs. The remaining development-only `picomatch <=4.0.7` ReDoS
  advisory has no published fixed release yet; it is not shipped at runtime, and the Vite development server is
  loopback-only until the upstream fix can replace it.
- `materialize_durable_remote_agent` verifies that the relayed target is a Git repository under the selected bound
  device root before adding a project member. The call must provide a model explicitly, and that model must occur in
  the data source's environment-bound verified-model list; it can no longer inherit the Windows Coordinator model.
  Linux and macOS are both explicitly bound to `gpt-5.6-sol`. Both remote Workers completed real durable tasks and returned their results to the Windows
  Coordinator through separate T3 Environment/Thread/Run identities.
- `list_durable_execution_targets` gives the Coordinator a bounded view of only this project's remote source IDs,
  T3 Environment IDs, device-verified models, and the current T3 control-plane reachability snapshot without probing
  SSH or exposing physical roots. Discovery failure keeps the static targets but explicitly marks live status
  unavailable instead of misreporting a device as offline. A real `gpt-5.6-sol` Coordinator turn verified the
  Linux/macOS model bindings through this tool before remote materialization.
- Remote-model evidence is revalidated again at every Scheduler dispatch, before a T3 run is created or resumed.
  Primary and explicitly allowed fallback candidates are filtered against the current project/environment binding;
  revoking a model or source therefore takes effect for existing members without silently inheriting a Windows model.
- Federated `durable-data` searches launch bound SSH sources concurrently and use the requested search itself as the
  reachability probe, instead of issuing a serial ping before every operation. Errors remain isolated per source and
  result order stays deterministic. A live Windows/Linux/macOS filename search completed in 566 ms with both remote
  matches present and no source errors.
- Local Windows workstations can now run **Google Gemini (`google/*`)** and **DeepSeek (`deepseek/*`)** alongside
  Codex (`gpt-5.6-sol`) with clear billing boundaries:
  - **Google Gemini (`google/*`)** runs strictly on the local workstation through your **Google Antigravity** desktop login
    (`~/.gemini/antigravity`). API keys are disabled and `GEMINI_API_KEY` / `GOOGLE_API_KEY`
    are stripped before launching `AntigravityClient` (runtime `"antigravity"`), so Gemini never falls back to per-token API billing. Read-only
    roles enforce `--profile=research`, and all turns enforce workspace path confinement, session resumption, tool-call auditing, and
    token usage telemetry. Remote Linux/macOS targets never use Gemini.
  - **DeepSeek (`deepseek/*`)** runs locally through **DeepSeek Harness** (`DeepSeekHarnessClient`, runtime `"deepseek-harness"`,
    `dsh --profile headless --json`), reusing the desktop DeepSeek Harness login (`~/.dsh/.credentials.yaml`) or `DEEPSEEK_API_KEY`,
    with `--session-id` resumption, `--permission-mode read-only|workspace-write`, NDJSON tool auditing, and process-tree cancellation.
    Remote Linux/macOS targets never implicitly inherit DeepSeek, but when deployed with one command via
    `windows/setup-remote-deepseek.ps1` and listed in that target's `verifiedModels`, remote tasks can run DeepSeek
    directly or automatically fail over from remote Codex (`gpt-5.6-sol`) when Codex quota or rate limits trip the
    provider circuit.
