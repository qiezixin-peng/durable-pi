#!/usr/bin/env sh
set -eu

workspace=${1:-}
title=${2:-Durable Pi project}
if [ -z "$workspace" ] || [ ! -d "$workspace" ]; then
  echo "Usage: register-t3-project.sh <existing-workspace> [title]" >&2
  exit 2
fi
workspace=$(cd "$workspace" && pwd -P)

if command -v t3 >/dev/null 2>&1; then
  t3_bin=$(command -v t3)
else
  t3_bin=$(find "$HOME/.t3/runtime/versions" -mindepth 2 -maxdepth 2 -type f -name t3 2>/dev/null | sort -V | tail -n 1)
fi
if [ -z "${t3_bin:-}" ] || [ ! -x "$t3_bin" ]; then
  echo "T3 Code CLI was not found on this device." >&2
  exit 1
fi

set +e
output=$($t3_bin project add "$workspace" --title "$title" 2>&1)
status=$?
set -e
case "$output" in
  *"Added project "*|*"ProjectAlreadyExistsError"*)
    printf '%s\n' "$output"
    exit 0
    ;;
esac
printf '%s\n' "$output" >&2
exit "$status"
