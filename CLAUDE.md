# CLAUDE.md

<!-- AEG:START -->
## AI Engineering Guard (`aeg`) — Built-in Quality & Handoff Protocol

### 1. On Starting Work (Relay / Handoff Pickup)
- Read `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (and `HANDOFF.md` / `.env.example` if present) to understand module boundaries, dependencies, public APIs, and required env vars.
- Verify the current baseline state before major edits if needed (`aeg check --format agent-summary` or `node "D:/三喜/Agent工具/ai-engineering-guard/bin/aeg.js" check --format agent-summary`).

### 2. During Development (Keep Project Map Synced & Prevent Spaghetti Debt)
- Whenever you add or restructure modules, cross-module imports, public interfaces, tests, or environment variables, update `.engineering-guard/modules.yaml` (`paths`, `depends_on`, `public_api_paths`, `contracts`), `.engineering-guard/tests.yaml` (`covers`, `environment_allowlist`), and `.env.example` / `HANDOFF.md` (if used) so the next agent or merge step has accurate metadata.
- Do NOT pile hacks onto oversized files or bypass module boundaries; prefer clean declarative/framework patterns over ad-hoc patches.
- NEVER edit `.engineering-guard/*.yaml` to delete existing suites, lower risk overrides, or weaken gates.

### 3. Before Finishing / Handing Off (Mandatory Gate & Architecture Reflection)
- Always run `node "D:/三喜/Agent工具/ai-engineering-guard/bin/aeg.js" check --format agent-summary` (or `aeg.cmd check --format agent-summary` on Windows) and resolve failures before concluding:
- For PR/delivery checks: `--mode deep --policy delivery --format agent-summary`.
- If `architecture_hints` appear in the summary (or when asked to review architecture via `aeg audit --format json`), actively evaluate whether a cleaner modular/declarative/framework approach exists, refactor if appropriate, and re-verify with `aeg check`.
- `0` (`passed` + `continue`): safe to finish; include a brief handoff note (what changed, any new env vars, next TODOs).
- `0` (`passed` + `require_approval`): tests passed, but L4/policy change requires human approval — stop and ask.
- `1` / `2` (`failed`): inspect failures via `aeg inspect failure --format json` and `aeg inspect log <id> --lines 80`, then fix.
- `3` (`CONFIG_ERROR`): fix `.engineering-guard/*.yaml` (`aeg config validate`).
- `5` (`incomplete`): do NOT treat as passed; resolve unknowns, missing coverage, or blocked platforms.
<!-- AEG:END -->
