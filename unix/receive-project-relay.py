#!/usr/bin/env python3
"""Receive one verified Git bundle into ~/DurablePiProjects and register it with local T3."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


SAFE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
REVISION = re.compile(r"^[a-f0-9]{40,64}$")


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: receive-project-relay.py <base64url-json>")
    try:
        raw = sys.argv[1] + "=" * (-len(sys.argv[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(raw).decode("utf-8"))
    except Exception as error:
        fail(f"Invalid relay payload: {error}")

    slug = payload.get("slug")
    title = payload.get("title")
    bundle_name = payload.get("bundleName")
    bundle_sha256 = payload.get("bundleSha256")
    revision = payload.get("revision")
    branch = payload.get("branch")
    if not isinstance(slug, str) or not SAFE.fullmatch(slug):
        fail("Invalid project slug")
    if not isinstance(bundle_name, str) or not SAFE.fullmatch(bundle_name):
        fail("Invalid bundle name")
    if not isinstance(title, str) or not title.strip() or len(title) > 120:
        fail("Invalid project title")
    if not isinstance(bundle_sha256, str) or not SHA256.fullmatch(bundle_sha256):
        fail("Invalid bundle checksum")
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        fail("Invalid source revision")
    if not isinstance(branch, str) or not branch or len(branch) > 240 or branch.startswith("-"):
        fail("Invalid source branch")

    home = Path.home().resolve()
    inbox = (home / ".dpi" / "relay-inbox").resolve()
    projects = (home / "DurablePiProjects").resolve()
    bundle = (inbox / f"{bundle_name}.bundle").resolve()
    target = (projects / slug).resolve()
    if bundle.parent != inbox or target.parent != projects:
        fail("Relay path escaped its managed root")
    if not bundle.is_file() or bundle.is_symlink():
        fail("Relay bundle is missing or unsafe")
    hasher = hashlib.sha256()
    with bundle.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    if digest != bundle_sha256:
        fail("Relay bundle checksum mismatch")

    projects.mkdir(mode=0o700, parents=True, exist_ok=True)
    created = False
    if target.exists():
        if target.is_symlink() or not (target / ".git").is_dir():
            fail("Target already exists and is not the expected Git repository")
        current = subprocess.check_output(
            ["git", "-C", str(target), "rev-parse", "HEAD"], text=True
        ).strip()
        if current != revision:
            fail(f"Target already exists at a different revision: {current}")
        current_branch = subprocess.check_output(
            ["git", "-C", str(target), "branch", "--show-current"], text=True
        ).strip()
        if current_branch != branch:
            fail(f"Target already exists on a different branch: {current_branch}")
    else:
        staging = projects / f".{slug}.receiving-{uuid.uuid4().hex}"
        try:
            subprocess.run(["git", "clone", "--quiet", str(bundle), str(staging)], check=True)
            current = subprocess.check_output(
                ["git", "-C", str(staging), "rev-parse", "HEAD"], text=True
            ).strip()
            if current != revision:
                fail(f"Cloned revision mismatch: {current}")
            current_branch = subprocess.check_output(
                ["git", "-C", str(staging), "branch", "--show-current"], text=True
            ).strip()
            if current_branch != branch:
                fail(f"Cloned branch mismatch: {current_branch}")
            os.replace(staging, target)
            created = True
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    register = inbox / "register-t3-project.sh"
    if not register.is_file() or register.is_symlink():
        fail("T3 registration helper is missing")
    subprocess.run(["sh", str(register), str(target), title.strip()], check=True)
    bundle.unlink()
    print(json.dumps({
        "ok": True,
        "created": created,
        "target": str(target),
        "revision": revision,
        "branch": branch,
        "bundleSha256": bundle_sha256,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
