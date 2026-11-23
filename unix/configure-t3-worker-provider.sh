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
model = os.environ.get("DPI_COORDINATOR_MODEL", "gpt-5.6-sol")
reasoning = os.environ.get("DPI_CODEX_REASONING_EFFORT", "medium")
service_tier = os.environ.get("DPI_CODEX_SERVICE_TIER", "fast")
subagent_model = os.environ.get("DPI_CODEX_SUBAGENT_MODEL", model)
subagent_reasoning = os.environ.get("DPI_CODEX_SUBAGENT_REASONING_EFFORT", reasoning)
for value in (model, reasoning, service_tier, subagent_model, subagent_reasoning):
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", value):
        raise SystemExit("Durable Pi model, reasoning and service-tier values must be simple identifiers")
model_args = " ".join((
    f"-c model_reasoning_effort={reasoning}",
    f"-c service_tier={service_tier}",
    f"-c agents.default_subagent_model={subagent_model}",
    f"-c agents.default_subagent_reasoning_effort={subagent_reasoning}",
))
launch_args = " ".join(filter(None, [
    model_args,
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
pi_instance_id = os.environ.get("DPI_T3_PI_WORKER_PROVIDER_INSTANCE", "pi_durable_worker").strip() or "pi_durable_worker"
if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", pi_instance_id):
    raise SystemExit("DPI_T3_PI_WORKER_PROVIDER_INSTANCE is invalid")
pi_agent_dir = os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent"))
pi_auth_providers = set()
try:
    with open(os.path.join(pi_agent_dir, "auth.json"), "r", encoding="utf-8") as fh:
        auth_doc = json.load(fh)
        if isinstance(auth_doc, dict):
            for k, v in auth_doc.items():
                if isinstance(v, dict) and (v.get("key") or v.get("access")):
                    pi_auth_providers.add(str(k).strip().lower())
except (FileNotFoundError, json.JSONDecodeError):
    pass
pi_flag = os.environ.get("DPI_T3_PI_RUNTIME", "").strip()
pi_has_creds = bool(
    os.environ.get("DEEPSEEK_API_KEY", "").strip()
    or ("deepseek" in pi_auth_providers)
)
pi_binary = os.path.join(pi_agent_dir, "bin", "pi")
pi_installed = os.path.isfile(pi_binary) or any(
    os.path.isfile(os.path.join(p, "pi")) for p in os.environ.get("PATH", "").split(os.pathsep) if p
)
if pi_flag != "0" and pi_installed and (pi_flag == "1" or pi_has_creds):
    providers[pi_instance_id] = {
        "driver": "pi",
        "displayName": "Pi · Durable Worker (DeepSeek)",
        "enabled": True,
        "config": {"launchArgs": "--no-mcp"},
    }
settings["defaultModelSelection"] = {
    "instanceId": "codex_durable_coordinator",
    "model": model,
    "options": [
        {"id": "reasoningEffort", "value": reasoning},
        {"id": "serviceTier", "value": "priority" if service_tier == "fast" else service_tier},
        {"id": "cyberAccessProgram", "value": "standard"},
    ],
}
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
