# Configuration

Durable Pi separates configuration from runtime state and secrets.

## Files

| File | Purpose | Commit it? |
| --- | --- | --- |
| `.env.example` | Complete scalar configuration template | Yes |
| `.env` | Local paths, ports, peers, limits and optional secrets | No |
| `dpi-network.example.yaml` | Structured legacy device-inventory template | Yes |
| `dpi-network.yaml` | Local legacy device inventory | No |
| `~/.dpi/backend.env` | Generated runtime values and bearer tokens | No |
| `~/.codex/config.toml` | Provider-owned Codex configuration | No |

Configuration precedence is: explicit command-line option, exported process environment, `.env`, built-in safe default.
Generated runtime credentials are preserved when setup is rerun.

## Main groups

- **Paths and listeners:** `DPI_HOME`, `DPI_WORKSPACE_ROOT`, `DPI_NETWORK_FILE`, `DPI_HOST`, `DPI_PORT`,
  `DPI_HUB_HOST`, `DPI_HUB_PORT`.
- **T3 routing:** `DPI_T3_LOCAL_PORT`, `DPI_T3_PEERS`, `DPI_TUNNEL_REMOTE_SSH_PORT`,
  `DPI_TUNNEL_REMOTE_T3_PORT`, `DPI_DATA_ROOT_MAPPINGS_JSON`.
- **Scheduler and context:** concurrency, coordination-depth, context-budget and polling variables documented in
  `.env.example`.
- **Providers:** provider instance names, Codex app-server overrides and optional OpenRouter settings.
  `DPI_COORDINATOR_MODEL`, `DPI_CODEX_REASONING_EFFORT`, `DPI_CODEX_SERVICE_TIER`,
  `DPI_CODEX_SUBAGENT_MODEL`, and `DPI_CODEX_SUBAGENT_REASONING_EFFORT` define the shared T3/Durable defaults.
- **Retention:** backup, Artifact and memory expiry intervals.

`DPI_DATA_ROOT_MAPPINGS_JSON` only generates routing guidance. It does not grant file access. Actual read access still
requires a data-source catalog entry plus a project-scoped folder binding.

## Secrets

Prefer provider-owned authentication such as the current Codex login. If an API key is required, keep it only in
`.env` or the provider's credential store. Never place tokens, passwords, private keys, pairing codes or real device
inventory in example files, documentation, Git commits or issue reports.
