#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
dpi_root=${DPI_HOME:-$HOME/.dpi}
run_dir=$dpi_root/run

for name in dpi-hub dpi-backend; do
  pid_file=$run_dir/$name.pid
  [[ -f $pid_file ]] || continue
  pid=$(cat "$pid_file")
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  if [[ -n $command && $command == *"$repo_root"* ]]; then
    kill "$pid"
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    printf 'Stopped %s (PID %s).\n' "$name" "$pid"
  elif [[ -n $command ]]; then
    echo "PID $pid no longer belongs to this checkout; it was not stopped." >&2
  fi
  rm -f -- "$pid_file"
done
