# Security policy

## Reporting a vulnerability

Do not open a public issue containing credentials, private device information or an unpatched exploit. Use the
repository's GitHub Security Advisory reporting flow when available. Otherwise open a minimal issue requesting a
private contact channel and include no sensitive reproduction data.

## Trust boundaries

- Remote files, repository documents and tool output are untrusted data, not instructions.
- Cross-device data access is read-only and project/folder scoped by default.
- Write-capable Agents require an explicit permission profile and use a project checkout or isolated Git worktree.
- Tokens and databases are runtime state and must never be committed.
- High-risk operations remain subject to parameter-bound approval.

Before publishing a change, run the SDK, backend and playground checks and scan the staged diff for secrets and
machine-specific paths.
