#!/usr/bin/env bash
set -euo pipefail

proxy_url=${1:-}
no_proxy=${DPI_NO_PROXY:-127.0.0.1,localhost,.ts.net}
[[ $proxy_url =~ ^http://127\.0\.0\.1:[0-9]{2,5}$ ]] || {
  echo 'usage: configure-t3-proxy.sh http://127.0.0.1:<port>' >&2
  exit 2
}
curl --silent --show-error --fail --max-time 15 --proxy "$proxy_url" \
  https://downloads.claude.ai/claude-code-releases/latest >/dev/null

dropin_dir=$HOME/.config/systemd/user/t3code.service.d
dropin=$dropin_dir/20-durable-pi-proxy.conf
mkdir -p -- "$dropin_dir"
temporary=$(mktemp "$dropin_dir/.20-durable-pi-proxy.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
{
  printf '[Service]\n'
  printf 'Environment=HTTP_PROXY=%s\n' "$proxy_url"
  printf 'Environment=HTTPS_PROXY=%s\n' "$proxy_url"
  printf 'Environment=NO_PROXY=%s\n' "$no_proxy"
} > "$temporary"
chmod 600 "$temporary"
mv -f -- "$temporary" "$dropin"
trap - EXIT
systemctl --user daemon-reload
systemctl --user restart t3code.service
systemctl --user is-active --quiet t3code.service
printf 'T3 proxy configured: %s\n' "$proxy_url"
