#!/usr/bin/env bash
set -euo pipefail

settings_path="${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json"
workspace_base=${DPI_T3_WORKSPACE_BASE:-${1:-}}
mkdir -p "$(dirname "$settings_path")"

python3 - "$settings_path" "$workspace_base" <<'PY'
import json
import os
import re
import sys
import tempfile

path = sys.argv[1]
workspace_base = sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as source:
        settings = json.load(source)
except (FileNotFoundError, json.JSONDecodeError):
    settings = {}

disable_candidates = (
    "playwright",
    "rea",
    "windows_desktop",
    "windows_desktop_fast",
    "windows_files",
    "windows_playwright",
)
codex_config = os.path.join(os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex")), "config.toml")
try:
    with open(codex_config, "r", encoding="utf-8") as source:
        configured = set(re.findall(r"^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$", source.read(), re.MULTILINE))
except FileNotFoundError:
    configured = set()
disabled = [name for name in disable_candidates if name in configured]
launch_args = " ".join(filter(None, [
    "-c features.multi_agent=false -c features.multi_agent_v2=false",
    " ".join(f"-c mcp_servers.{name}.enabled=false" for name in disabled),
]))
providers = settings.setdefault("providerInstances", {})
providers["codex_durable_worker"] = {
    "driver": "codex",
    "displayName": "Codex · Durable Worker",
    "enabled": True,
    "config": {"launchArgs": launch_args},
}
providers["codex_durable_coordinator"] = {
    "driver": "codex",
    "displayName": "Codex · Durable Coordinator",
    "enabled": True,
    "config": {
        "launchArgs": " ".join(filter(None, [
            launch_args,
            "-c mcp_servers.durable-pi.enabled=false",
            "-c mcp_servers.durable-pi-auto.enabled=true",
            "-c mcp_servers.durable-data.enabled=false",
        ])),
    },
}
selection = settings.get("defaultModelSelection")
if not isinstance(selection, dict) or not isinstance(selection.get("model"), str) or not selection["model"].strip():
    selection = {"model": os.environ.get("DPI_COORDINATOR_MODEL", "gpt-5.6-sol")}
selection["instanceId"] = "codex_durable_coordinator"
settings["defaultModelSelection"] = selection
if workspace_base:
    workspace_base = os.path.abspath(os.path.expanduser(workspace_base))
    if not os.path.isdir(workspace_base):
        raise SystemExit(f"T3 workspace base directory does not exist: {workspace_base}")
    settings["addProjectBaseDirectory"] = workspace_base

directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".settings.durable-pi.", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(settings, target, ensure_ascii=False, indent=2)
        target.write("\n")
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
