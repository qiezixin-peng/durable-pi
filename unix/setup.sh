#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

# Parse the repository config as data, never as shell code. Explicitly exported
# environment variables retain precedence over values in `.env`.
if [[ -f $repo_root/.env ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    key=${line%%=*}
    value=${line#*=}
    [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid config key: $key" >&2; exit 2; }
    printenv "$key" >/dev/null 2>&1 || export "$key=$value"
  done < "$repo_root/.env"
fi

start_dir=${DPI_WORKSPACE_ROOT:-${HOME}/dpi-work}
provider=${DPI_PROVIDER:-faux}
hub_host=${DPI_HUB_HOST:-127.0.0.1}
backend_host=${DPI_HOST:-127.0.0.1}
backend_port=${DPI_PORT:-4780}
hub_port=${DPI_HUB_PORT:-4781}
skip_install=0
network_file=${DPI_NETWORK_FILE:-$repo_root/dpi-network.yaml}
dpi_root=${DPI_HOME:-$HOME/.dpi}

while (($#)); do
  case "$1" in
    --start-dir) start_dir=$2; shift 2 ;;
    --provider) provider=$2; shift 2 ;;
    --hub-host) hub_host=$2; shift 2 ;;
    --network-file) network_file=$2; shift 2 ;;
    --dpi-home) dpi_root=$2; shift 2 ;;
    --skip-install) skip_install=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$provider" in faux|openrouter|openai) ;; *) echo 'Provider must be faux, openrouter or openai.' >&2; exit 2 ;; esac
case "$hub_host" in 127.0.0.1|0.0.0.0) ;; *) echo 'Hub host must be 127.0.0.1 or 0.0.0.0.' >&2; exit 2 ;; esac
command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
node_version=$(node -p "process.versions.node.split('.').map(Number).join(' ')")
read -r node_major node_minor node_patch <<<"$node_version"
if ((node_major < 22 || (node_major == 22 && node_minor < 19))); then
  echo 'Node.js 22.19 or newer is required.' >&2
  exit 1
fi

mkdir -p -- "$dpi_root/logs" "$dpi_root/run" "$start_dir" "$(dirname -- "$network_file")"
backend_env=$dpi_root/backend.env
read_env() {
  local name=$1
  [[ -f $backend_env ]] || return 0
  while IFS='=' read -r key value; do
    [[ $key == "$name" ]] && { printf '%s' "$value"; return 0; }
  done < "$backend_env"
}
new_token() { node -e "console.log('dpi_'+require('node:crypto').randomBytes(32).toString('base64url'))"; }
token=$(read_env DPI_TOKEN)
hub_token=$(read_env DPI_HUB_TOKEN)
[[ -n $token ]] || token=$(new_token)
[[ -n $hub_token ]] || hub_token=$(new_token)
device_name=$(hostname -s 2>/dev/null || hostname)
device_name=$(printf '%s' "$device_name" | tr '[:upper:]' '[:lower:]')
start_dir=$(CDPATH= cd -- "$start_dir" && pwd)
dpi_root=$(CDPATH= cd -- "$dpi_root" && pwd)

{
  printf 'DPI_TOKEN=%s\n' "$token"
  printf 'DPI_HUB_DEVICE_TOKEN=%s\n' "$token"
  printf 'DPI_DEVICE_NAME=%s\n' "$device_name"
  printf 'DPI_PORT=%s\nDPI_HOST=%s\n' "$backend_port" "$backend_host"
  printf 'DPI_HUB_HOST=%s\n' "$hub_host"
  printf 'DPI_HUB_PORT=%s\n' "$hub_port"
  printf 'DPI_START_DIRS=%s\n' "$start_dir"
  printf 'DPI_PROVIDER=%s\n' "$provider"
  # Durable Agent turns run through the local T3 runtime so they inherit the
  # signed-in account, appear in T3, and use the same approval surface.
  printf 'DPI_T3_RUNTIME=1\n'
  printf 'DPI_T3_WORKSPACE_BASE=%s\n' "$start_dir"
  printf 'DPI_HUB_URL=http://127.0.0.1:%s\n' "$hub_port"
  printf 'DPI_HUB_TOKEN=%s\n' "$hub_token"
  printf 'DPI_NETWORK_DEVICE_ID=local\n'
  for name in DPI_DATA_ROOT_MAPPINGS_JSON DPI_T3_WAITING_INTERVAL_MS DPI_T3_PROJECT_INTERVAL_MS DPI_T3_ENVIRONMENT_INTERVAL_MS; do
    [[ -z ${!name:-} ]] || printf '%s=%s\n' "$name" "${!name}"
  done
  if [[ $provider == openrouter ]]; then
    key=${OPENROUTER_API_KEY:-$(read_env OPENROUTER_API_KEY)}
    [[ -n $key ]] || { echo 'Set OPENROUTER_API_KEY before selecting openrouter.' >&2; exit 1; }
    printf 'OPENROUTER_API_KEY=%s\n' "$key"
  fi
} > "$backend_env"
chmod 600 "$backend_env"

yaml_path=${start_dir//\'/\'\'}
cat > "$network_file" <<EOF
defaults:
  port: $backend_port
  start_dirs: ['$yaml_path']

devices:
  local:
    name: $device_name
    kind: local
    token_env: DPI_LOCAL_TOKEN
EOF

if ((skip_install == 0)); then
  for relative in apps/dpi-sdk apps/dpi-backend apps/dpi-playground; do
    (cd "$repo_root/$relative" && npm ci --no-audit --no-fund)
  done
fi
(cd "$repo_root/apps/dpi-playground" && npm run build)

printf '\nPOSIX local setup complete.\nDevice: %s\nWorkspace root: %s\nProvider: %s\nStart with: bash ./unix/start-local.sh\n' \
  "$device_name" "$start_dir" "$provider"
if [[ $provider == faux ]]; then
  echo 'The faux provider is only a deterministic validation model.'
fi
