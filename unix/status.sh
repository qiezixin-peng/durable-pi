#!/usr/bin/env bash
set -u
dpi_root=${DPI_HOME:-$HOME/.dpi}
backend_env=${DPI_ENV_FILE:-$dpi_root/backend.env}
if [[ -f $backend_env ]]; then
  while IFS='=' read -r key value; do
    [[ -z $key || $key == \#* ]] && continue
    [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$backend_env"
fi
backend_port=${DPI_PORT:-4780}
hub_port=${DPI_HUB_PORT:-4781}
check() {
  local name=$1 url=$2 code
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)
  if [[ $code == 200 ]]; then printf '%s: online (200)\n' "$name"
  else printf '%s: offline\n' "$name"
  fi
}
check Backend "http://127.0.0.1:$backend_port/healthz"
check 'Project hub' "http://127.0.0.1:$hub_port/api/network"
