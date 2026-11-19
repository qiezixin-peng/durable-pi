#!/usr/bin/env python3
"""Create a bounded Git bundle for a Durable Pi remote-to-Windows return."""

import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


def fail(message: str) -> None:
    raise SystemExit(message)


def decode_payload(value: str) -> dict:
    try:
        padding = "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(value + padding).decode("utf-8"))
    except Exception as error:
        fail(f"invalid return payload: {error}")
    if not isinstance(payload, dict):
        fail("invalid return payload")
    return payload


def run_git(target: str, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", target, *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and result.returncode != 0:
        fail(result.stderr.strip() or "git command failed")
    return result.stdout.strip()


payload = decode_payload(sys.argv[1] if len(sys.argv) == 2 else "")
root = payload.get("root")
slug = payload.get("slug")
bundle_name = payload.get("bundleName")
if not isinstance(root, str) or not root.startswith("/") or not re.fullmatch(r"/[A-Za-z0-9._/-]+", root):
    fail("invalid remote root")
if not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", slug):
    fail("invalid project slug")
if not isinstance(bundle_name, str) or not re.fullmatch(r"return-[a-f0-9]{32}\.bundle", bundle_name):
    fail("invalid bundle name")

root = os.path.abspath(root)
target = os.path.abspath(os.path.join(root, "DurablePiProjects", slug))
inbox = os.path.abspath(os.path.join(root, ".dpi", "relay-inbox"))
if os.path.commonpath([root, target]) != root or os.path.commonpath([root, inbox]) != root:
    fail("path escapes remote root")
current = root
for part in os.path.relpath(target, root).split(os.sep):
    current = os.path.join(current, part)
    if os.path.lexists(current) and stat.S_ISLNK(os.lstat(current).st_mode):
        fail("symbolic links are not allowed in the remote project path")
if not os.path.isdir(target):
    fail("remote project does not exist")
if os.path.abspath(run_git(target, "rev-parse", "--show-toplevel")) != target:
    fail("remote project is not a Git top-level directory")
if run_git(target, "status", "--porcelain"):
    fail("remote project has uncommitted changes")
branch = run_git(target, "branch", "--show-current")
if not branch:
    fail("remote project must be on a named branch")
run_git(target, "check-ref-format", "--branch", branch)
revision = run_git(target, "rev-parse", "HEAD")
if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
    fail("invalid remote revision")

os.makedirs(inbox, mode=0o700, exist_ok=True)
os.chmod(inbox, 0o700)
bundle = os.path.join(inbox, bundle_name)
if os.path.lexists(bundle):
    fail("return bundle already exists")
run_git(target, "bundle", "create", bundle, "HEAD", f"refs/heads/{branch}")
digest = hashlib.sha256()
with open(bundle, "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
os.chmod(bundle, 0o600)
print(json.dumps({
    "target": target,
    "bundle": bundle,
    "bundleSha256": digest.hexdigest(),
    "revision": revision,
    "branch": branch,
}, separators=(",", ":")))
