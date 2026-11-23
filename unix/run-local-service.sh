#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
dpi_root=${DPI_HOME:-$HOME/.dpi}
backend_env=${DPI_ENV_FILE:-$dpi_root/backend.env}
network_file=${DPI_NETWORK_FILE:-$repo_root/dpi-network.yaml}
# Service managers provide a deliberately small PATH. T3 and Codex are
# commonly installed in ~/.local/bin on Linux and Homebrew on macOS.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
[[ -f $backend_env ]] || { echo 'Run bash ./unix/setup.sh first.' >&2; exit 1; }
mkdir -p -- "$dpi_root/logs"

global_instructions=$repo_root/scripts/configure-codex-global-instructions.mjs
if [[ -f $global_instructions ]]; then
  node "$global_instructions" >>"$dpi_root/logs/codex-global-instructions.log" 2>&1
fi

# T3 0.1.x rejects an entire filesystem.browse response when one immediate
# child has a whitespace-only/control-character name. Repair only those
# unrepresentable names in the visible roots, preserve their contents in place,
# and retain a permission-restricted audit record.
browse_repair=$repo_root/scripts/repair-t3-browse-names.mjs
if [[ -f $browse_repair ]]; then
  repair_args=(--repair --root "$HOME")
  [[ ! -d $HOME/DurablePiProjects ]] || repair_args+=(--root "$HOME/DurablePiProjects")
  [[ ! -d $HOME/Projects ]] || repair_args+=(--root "$HOME/Projects")
  node "$browse_repair" "${repair_args[@]}" >>"$dpi_root/logs/t3-browse-name-check.log" 2>&1 || true
fi

while IFS='=' read -r key value; do
  [[ -z $key || $key == \#* ]] && continue
  [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid environment key: $key" >&2; exit 1; }
  export "$key=$value"
done < "$backend_env"

# Keep Codex on the compact production MCP bundles. This is idempotent and
# also repairs configs left by older source/tsx based releases.
if [[ -f $repo_root/apps/dpi-playground/dist/mcp/main.mjs ]]; then
  python3 "$repo_root/unix/configure-codex-durable-mcp.py" "$repo_root" >/dev/null
fi

# Sync local Pi DeepSeek definitions when Pi and credentials are present.
if [[ -f $repo_root/unix/configure-pi-providers.sh ]]; then
  if [[ ${DPI_T3_PI_RUNTIME:-} == "1" || -n ${DEEPSEEK_API_KEY:-} ]]; then
    if command -v pi >/dev/null 2>&1 || [[ -x $HOME/.pi/agent/bin/pi ]]; then
      bash "$repo_root/unix/configure-pi-providers.sh" >/dev/null || true
    fi
  fi
fi

# Keep T3's folder picker focused on this machine's normal project root. This
# is only an initial directory; it does not restrict browsing outside it.
if [[ -x $repo_root/unix/configure-t3-worker-provider.sh ]]; then
  "$repo_root/unix/configure-t3-worker-provider.sh"
fi

# Reconcile idle legacy projects with this device's configured Codex model and
# current on-demand team plan. Active projects are skipped transactionally.
project_defaults_reconcile=$repo_root/scripts/reconcile-durable-project-defaults.mjs
projects_database=$dpi_root/projects.sqlite
if [[ -f $project_defaults_reconcile && -f $projects_database ]]; then
  node "$project_defaults_reconcile" "$projects_database" "${DPI_COORDINATOR_MODEL:-gpt-5.6-sol}" \
    >>"$dpi_root/logs/project-defaults-reconcile.log" 2>&1 ||
    printf '%s\n' 'Project-default reconciliation failed; platform startup continues without mutating busy projects.' \
      >>"$dpi_root/logs/project-defaults-reconcile.log"
fi
export DPI_HOME=$dpi_root DPI_ENV_FILE=$backend_env DPI_NETWORK_FILE=$network_file DPI_LOCAL_TOKEN=$DPI_TOKEN
run_dir=$dpi_root/run
log_dir=$dpi_root/logs
mkdir -p -- "$run_dir" "$log_dir"

# Bound long-running append-only service logs without losing the most recent
# diagnostic generation.
for log in dpi-backend.log dpi-backend-error.log dpi-hub.log dpi-hub-error.log; do
  path=$log_dir/$log
  [[ ! -f $path ]] || [[ $(wc -c <"$path") -lt 10485760 ]] || {
    mv -f -- "$path" "$path.1"
  }
done

backend_pid=''
hub_pid=''
cleanup() {
  trap - EXIT INT TERM
  [[ -z $hub_pid ]] || kill "$hub_pid" 2>/dev/null || true
  [[ -z $backend_pid ]] || kill "$backend_pid" 2>/dev/null || true
  [[ -z $hub_pid ]] || wait "$hub_pid" 2>/dev/null || true
  [[ -z $backend_pid ]] || wait "$backend_pid" 2>/dev/null || true
  rm -f -- "$run_dir/dpi-backend.pid" "$run_dir/dpi-hub.pid"
}
trap cleanup EXIT INT TERM

cd "$repo_root/apps/dpi-backend"
node --disable-warning=ExperimentalWarning --import tsx src/main.ts >>"$log_dir/dpi-backend.log" 2>>"$log_dir/dpi-backend-error.log" &
backend_pid=$!
printf '%s\n' "$backend_pid" > "$run_dir/dpi-backend.pid"

cd "$repo_root/apps/dpi-playground"
node --disable-warning=ExperimentalWarning --import tsx apps/dpi-playground-hub/src/main.ts >>"$log_dir/dpi-hub.log" 2>>"$log_dir/dpi-hub-error.log" &
hub_pid=$!
printf '%s\n' "$hub_pid" > "$run_dir/dpi-hub.pid"

# A service manager restarts the pair if either half exits. Keeping the pair
# together prevents a healthy UI from masking a dead task worker. macOS still
# ships Bash 3.2, which does not provide `wait -n`, so use a portable monitor.
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$hub_pid" 2>/dev/null; do
  sleep 2
done
exit 1
