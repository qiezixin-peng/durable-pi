#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
dpi_root=${DPI_HOME:-$HOME/.dpi}
backend_env=${DPI_ENV_FILE:-$dpi_root/backend.env}
network_file=${DPI_NETWORK_FILE:-$repo_root/dpi-network.yaml}
open_browser=1
[[ ${1:-} == --no-open ]] && open_browser=0
[[ -f $backend_env ]] || { echo 'Run bash ./unix/setup.sh first.' >&2; exit 1; }

while IFS='=' read -r key value; do
  [[ -z $key || $key == \#* ]] && continue
  [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid environment key: $key" >&2; exit 1; }
  export "$key=$value"
done < "$backend_env"
export DPI_HOME=$dpi_root DPI_ENV_FILE=$backend_env DPI_NETWORK_FILE=$network_file DPI_LOCAL_TOKEN=$DPI_TOKEN
backend_port=${DPI_PORT:-4780}
hub_port=${DPI_HUB_PORT:-4781}
backend_url=http://127.0.0.1:$backend_port
hub_url=http://127.0.0.1:$hub_port
run_dir=$dpi_root/run
log_dir=$dpi_root/logs
mkdir -p -- "$run_dir" "$log_dir"

healthy() { curl --fail --silent --max-time 2 "$1" >/dev/null 2>&1; }
process_command() { ps -p "$1" -o command= 2>/dev/null || true; }
start_process() {
  local name=$1 workdir=$2 entry=$3 health=$4 pid_file=$run_dir/$1.pid
  if [[ -f $pid_file ]]; then
    local old_pid command
    old_pid=$(cat "$pid_file")
    command=$(process_command "$old_pid")
    if [[ -n $command ]]; then
      if [[ $command != *"$repo_root"* ]]; then
        healthy "$health" && { echo "$name health endpoint belongs to another process; refusing." >&2; exit 1; }
        # A reboot can reuse a stale PID. It is safe to discard it only while
        # the corresponding health endpoint is down.
        rm -f -- "$pid_file"
        command=''
      fi
    fi
    if [[ -n $command ]]; then
      healthy "$health" && { STARTED_PID=$old_pid; return; }
      echo "$name is running but unhealthy (PID $old_pid)." >&2
      exit 1
    fi
  fi
  local previous=$PWD pid
  cd "$workdir"
  nohup node --disable-warning=ExperimentalWarning --import tsx "$entry" </dev/null >"$log_dir/$name.log" 2>"$log_dir/$name-error.log" &
  pid=$!
  cd "$previous"
  printf '%s\n' "$pid" >"$pid_file"
  for _ in $(seq 1 80); do
    healthy "$health" && { STARTED_PID=$pid; return; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  echo "$name failed to become healthy; see $log_dir/$name-error.log" >&2
  exit 1
}

STARTED_PID=''
start_process dpi-backend "$repo_root/apps/dpi-backend" "$repo_root/apps/dpi-backend/src/main.ts" "$backend_url/healthz"
backend_pid=$STARTED_PID
start_process dpi-hub "$repo_root/apps/dpi-playground" "$repo_root/apps/dpi-playground/apps/dpi-playground-hub/src/main.ts" "$hub_url/api/network"
hub_pid=$STARTED_PID
printf 'Backend ready (PID %s): %s\nProject hub ready (PID %s): %s\n' "$backend_pid" "$backend_url" "$hub_pid" "$hub_url"
if ((open_browser)); then
  if command -v open >/dev/null; then open "$hub_url" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null; then xdg-open "$hub_url" >/dev/null 2>&1 &
  fi
fi
