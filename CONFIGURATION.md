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
- **T3 routing:** `DPI_T3_LOCAL_PORT`, `DPI_T3_PEERS`, `DPI_T3_PEER_ACCESS`, `DPI_TUNNEL_REMOTE_SSH_PORT`,
  `DPI_TUNNEL_REMOTE_T3_PORT`, `DPI_DATA_ROOT_MAPPINGS_JSON`.
- **Scheduler and context:** concurrency, coordination-depth, context-budget and polling variables documented in
  `.env.example`.
- **T3 child-thread lifecycle:** `DPI_T3_THREAD_ARCHIVE_AFTER_MS` defaults to 24 hours of inactivity and
  `DPI_T3_THREAD_LIFECYCLE_INTERVAL_MS` controls the platform sweep interval. Archived child threads are restored
  automatically when their Durable project member receives new work.
- **Providers:** provider instance names, Codex app-server overrides and optional OpenRouter settings.
  `DPI_COORDINATOR_MODEL`, `DPI_CODEX_REASONING_EFFORT`, `DPI_CODEX_SERVICE_TIER`,
  `DPI_CODEX_SUBAGENT_MODEL`, and `DPI_CODEX_SUBAGENT_REASONING_EFFORT` define the shared T3/Durable defaults.
- **Local Google Antigravity & DeepSeek Harness:** Google Gemini (`google/*`) runs through the signed-in Antigravity CLI
  (OAuth only; API keys are disabled and stripped at launch), configured
  via `DPI_GEMINI_DEFAULT_MODEL`, `DPI_GEMINI_MODELS`, `DPI_ANTIGRAVITY_BIN`, and optional
  `DPI_T3_GEMINI_WORKER_PROVIDER_INSTANCE`. DeepSeek (`deepseek/*`) runs locally through DeepSeek Harness (`dsh headless --json`,
  reusing desktop `~/.dsh/.credentials.yaml` login or `DEEPSEEK_API_KEY`), configured via `DPI_DEEPSEEK_DEFAULT_MODEL`,
  `DPI_DEEPSEEK_MODELS`, `DPI_T3_PI_WORKER_PROVIDER_INSTANCE`, and optional local `DPI_ROLE_MODEL_MAP_JSON`.
  Remote Linux/macOS targets never use Gemini and only use DeepSeek when explicitly deployed and listed in `verifiedModels`.
  Unified execution policy uses Codex `gpt-5.6-sol` -> `gpt-6-astra` -> `gpt-6.1-sol`
  and DeepSeek Harness `deepseek/deepseek-flash` -> `deepseek/deepseek-v4-pro`. Codex runs with medium
  reasoning and fast service tier. Fallback never crosses Providers. Antigravity keeps its current interactive
  model and may delegate outward to Codex or DeepSeek; the selected Provider then owns the complete chain, and
  no Durable worker, fallback or remote scheduler may route back to Antigravity or access its OAuth/session.
  On Windows, `windows/sync-t3-antigravity-usage-token.ps1` mirrors only the existing refresh material needed by T3's
  isolated, read-only quota probe. It never signs in, signs out, deletes, or overwrites the CLI credential; startup
  repeats the sync so a later CLI re-authentication is reflected in T3 Usage.
- **Retention:** backup, Artifact and memory expiry intervals.

`DPI_DATA_ROOT_MAPPINGS_JSON` only generates routing guidance. It does not grant file access. Actual read access still
requires a data-source catalog entry plus a project-scoped folder binding.

## Secrets

Prefer provider-owned authentication such as the current Codex login. If an API key is required, keep it only in
`.env` or the provider's credential store. Never place tokens, passwords, private keys, pairing codes or real device
inventory in example files, documentation, Git commits or issue reports.
