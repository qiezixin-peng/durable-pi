# CLAUDE.md

<!-- AEG:START -->
## AI Engineering Guard (`aeg`) — Shared Quality Gate

After modifying code and before finishing or committing, run:
- `node "D:/三喜/Agent工具/ai-engineering-guard/bin/aeg.js" check --format agent-summary`
- For PR/delivery checks: `--mode deep --policy delivery --format agent-summary`

Follow the deterministic `outcome`, `workflow_action`, and exit code (`0`–`5`):
- `0` (`passed` + `continue`): safe to finish.
- `0` (`passed` + `require_approval`): tests passed, but L4/policy change requires human approval.
- `1` / `2` (`failed`): inspect failures via `aeg inspect failure --format json` and `aeg inspect log <id> --lines 80`.
- `3` (`CONFIG_ERROR`): fix `.engineering-guard/*.yaml` (`aeg config validate`).
- `5` (`incomplete`): do NOT treat as passed; resolve unknowns, missing coverage, or blocked platforms.
- NEVER edit `.engineering-guard/*.yaml` to weaken tests, risk rules, or gates.
<!-- AEG:END -->
