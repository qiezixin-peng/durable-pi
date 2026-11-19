#!/usr/bin/env python3
import base64
import json
import os
import pathlib
import re
import sys
import tempfile

if len(sys.argv) != 2:
    raise SystemExit("usage: configure-data-catalog.py <base64-json-sources>")
sources = json.loads(base64.b64decode(sys.argv[1], validate=True).decode("utf-8"))
if not isinstance(sources, list) or not 1 <= len(sources) <= 16:
    raise SystemExit("sources must contain 1 to 16 entries")
ids = set()
for source in sources:
    required = ("id", "label", "root", "device", "readOnly")
    if not isinstance(source, dict) or any(key not in source for key in required):
        raise SystemExit("invalid data source")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", source["id"]) or source["id"] in ids:
        raise SystemExit("invalid or duplicate data-source id")
    ids.add(source["id"])
    if source["readOnly"] is not True or not os.path.isabs(source["root"]):
        raise SystemExit("data sources must be read-only and use absolute roots")
    if bool(source.get("sshHost")) != bool(source.get("remoteRoot")):
        raise SystemExit("sshHost and remoteRoot must be configured together")
    if source.get("sshHost") and not re.fullmatch(r"[A-Za-z0-9._-]+", source["sshHost"]):
        raise SystemExit("invalid SSH alias")
    platform = source.get("remotePlatform", "posix")
    if platform not in ("posix", "windows"):
        raise SystemExit("invalid remote platform")
    if source.get("remoteRoot") and (not re.match(r"^[A-Za-z]:[\\/]", source["remoteRoot"])
                                     if platform == "windows" else not source["remoteRoot"].startswith("/")):
        raise SystemExit("remoteRoot must be absolute")

catalog = pathlib.Path(os.environ.get("DPI_DATA_SOURCE_CATALOG", "~/.dpi/data-sources.json")).expanduser()
catalog.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
old_sources = {}
if catalog.exists():
    try:
        old = json.loads(catalog.read_text(encoding="utf-8"))
        old_sources = {source["id"]: source for source in old.get("sources", []) if isinstance(source, dict)}
    except (json.JSONDecodeError, OSError):
        pass
for source in sources:
    previous = old_sources.get(source["id"], {})
    for key in ("projectIds", "projectPaths"):
        if key in previous:
            source[key] = previous[key]
next_value = {"version": 1, "sources": sources}
fd, temporary = tempfile.mkstemp(prefix=".data-sources.", suffix=".tmp", dir=catalog.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(next_value, target, ensure_ascii=False, indent=2)
        target.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, catalog)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(catalog)
