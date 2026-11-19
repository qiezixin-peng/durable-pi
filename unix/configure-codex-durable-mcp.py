#!/usr/bin/env python3
import os
import pathlib
import re
import shutil
import sys
import tempfile

if len(sys.argv) not in (2, 3):
    raise SystemExit("usage: configure-codex-durable-mcp.py <runtime-root> [coordinator-model]")

runtime = pathlib.Path(sys.argv[1]).expanduser().resolve()
coordinator_model = (
    sys.argv[2] if len(sys.argv) == 3 else os.environ.get("DPI_COORDINATOR_MODEL", "")
).strip()
if coordinator_model and (len(coordinator_model) > 160 or any(c in coordinator_model for c in "\r\n\0\"")):
    raise SystemExit("invalid coordinator model")
entry = runtime / "apps/dpi-playground/dist/mcp/main.mjs"
data_entry = runtime / "apps/dpi-playground/dist/mcp/data-main.mjs"
node_override = os.environ.get("DPI_NODE", "").strip()
node_command = node_override or shutil.which("node")
if not node_command:
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if pathlib.Path(candidate).is_file():
            node_command = candidate
            break
if not node_command:
    raise SystemExit("Node.js executable was not found")
node_path = pathlib.Path(node_command).expanduser().resolve()
for path in (entry, data_entry):
    if not path.exists():
        raise SystemExit(f"missing Durable Pi runtime file: {path}")

config = pathlib.Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser() / "config.toml"
config.parent.mkdir(parents=True, exist_ok=True)
old = config.read_text(encoding="utf-8") if config.exists() else ""
begin = "# BEGIN DURABLE PI MANAGED MCP"
end = "# END DURABLE PI MANAGED MCP"
old = re.sub(rf"\n?{re.escape(begin)}.*?{re.escape(end)}\n?", "\n", old, flags=re.S).rstrip()

def quoted(value: pathlib.Path) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'

manual_model_line = (
    '\nDPI_COORDINATOR_MODEL = "' + coordinator_model + '"'
    if coordinator_model else ""
)
auto_model_line = (
    'DPI_COORDINATOR_MODEL = "' + coordinator_model + '"'
    if coordinator_model else ""
)
block = f'''{begin}
[mcp_servers.durable-pi]
command = {quoted(node_path)}
args = [{quoted(entry)}]

[mcp_servers.durable-pi.env]
NODE_OPTIONS = "--disable-warning=ExperimentalWarning"{manual_model_line}

[mcp_servers.durable-pi-auto]
command = {quoted(node_path)}
args = [{quoted(entry)}]
enabled = false

[mcp_servers.durable-pi-auto.env]
DPI_AUTO_INITIALIZE = "1"
NODE_OPTIONS = "--disable-warning=ExperimentalWarning"
{auto_model_line}

[mcp_servers.durable-data]
command = {quoted(node_path)}
args = [{quoted(data_entry)}]

[mcp_servers.durable-data.env]
NODE_OPTIONS = "--disable-warning=ExperimentalWarning"
{end}'''
next_value = f"{old}\n\n{block}\n" if old else f"{block}\n"
fd, temporary = tempfile.mkstemp(prefix=".config.durable-pi.", suffix=".tmp", dir=config.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        target.write(next_value)
    os.chmod(temporary, 0o600)
    os.replace(temporary, config)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(config)
