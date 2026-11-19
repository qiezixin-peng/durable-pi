#!/usr/bin/env python3
"""Verify a Durable Pi handoff ZIP, atomically stage it, and ask the Hub to import it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import urllib.error
import urllib.request
import uuid
import zipfile

MAX_ENTRIES = 10_002
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
BUNDLE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$")
PROJECT = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise RuntimeError(message)


def verify_checksum(archive: Path, checksum: Path) -> str:
    try:
        declaration = checksum.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        fail(f"Cannot read checksum file: {error}")
    match = re.fullmatch(r"([a-fA-F0-9]{64})  (.+)", declaration)
    if not match or match.group(2) != archive.name:
        fail("Checksum file has an invalid format or archive filename")
    actual = sha256(archive)
    if actual != match.group(1).lower():
        fail("Archive SHA-256 mismatch")
    return actual


def safe_parts(name: str) -> tuple[str, ...]:
    if not name or "\\" in name or ":" in name or any(ord(char) < 32 for char in name):
        fail(f"Unsafe ZIP entry: {name!r}")
    path = PurePosixPath(name)
    parts = tuple(part for part in path.parts if part not in ("", "/"))
    if path.is_absolute() or not parts or any(part in (".", "..") for part in parts):
        fail(f"Unsafe ZIP entry: {name}")
    return parts


def inspect(archive: Path) -> tuple[list[zipfile.ZipInfo], int]:
    with zipfile.ZipFile(archive, "r") as bundle:
        entries = bundle.infolist()
        if len(entries) > MAX_ENTRIES:
            fail("Archive contains too many entries")
        seen: set[str] = set()
        total = 0
        roots: set[str] = set()
        for entry in entries:
            parts = safe_parts(entry.filename)
            normalized = "/".join(parts).casefold()
            if normalized in seen:
                fail(f"Duplicate ZIP entry: {entry.filename}")
            seen.add(normalized)
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                fail(f"Symbolic links are not allowed: {entry.filename}")
            if entry.flag_bits & 1:
                fail(f"Encrypted ZIP entries are not allowed: {entry.filename}")
            total += entry.file_size
            if total > MAX_EXPANDED_BYTES:
                fail("Expanded archive exceeds the 512 MiB limit")
            if len(parts) == 1 and not entry.is_dir():
                roots.add(parts[0])
        if not {"manifest.json", "manifest.sha256"}.issubset(roots):
            fail("Archive is missing root manifest.json or manifest.sha256")
        return entries, total


def extract(archive: Path, staging: Path, entries: list[zipfile.ZipInfo]) -> int:
    written = 0
    staging.mkdir(mode=0o700)
    root = staging.resolve()
    with zipfile.ZipFile(archive, "r") as bundle:
        for entry in entries:
            parts = safe_parts(entry.filename)
            destination = staging.joinpath(*parts)
            resolved_parent = destination.parent.resolve()
            if root != resolved_parent and root not in resolved_parent.parents:
                fail(f"ZIP entry escaped staging: {entry.filename}")
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with bundle.open(entry, "r") as source, destination.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_EXPANDED_BYTES:
                        fail("Expanded archive exceeded the 512 MiB limit while reading")
                    output.write(chunk)
            os.chmod(destination, 0o600)
    return written


def hub_import(hub_url: str, bundle_name: str, target_project_id: str | None) -> dict:
    body: dict[str, str] = {"bundleName": bundle_name}
    if target_project_id:
        body["targetProjectId"] = target_project_id
    request = urllib.request.Request(
        f"{hub_url.rstrip('/')}/api/handoffs/import",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        fail(f"Hub import failed ({error.code}): {detail}")
    except (urllib.error.URLError, TimeoutError) as error:
        fail(f"Hub import failed: {error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--checksum", type=Path)
    parser.add_argument("--bundle-name")
    parser.add_argument("--target-project-id")
    parser.add_argument("--hub-url", default="http://127.0.0.1:4781")
    parser.add_argument("--inbox", type=Path, default=Path.home() / ".dpi" / "handoff-inbox")
    args = parser.parse_args()

    archive = args.archive.expanduser().resolve(strict=True)
    if not archive.is_file() or archive.suffix.lower() != ".zip":
        fail("Archive must be an existing .zip file")
    checksum = (args.checksum or Path(f"{archive}.sha256")).expanduser().resolve(strict=True)
    bundle_name = args.bundle_name or archive.stem
    if not BUNDLE.fullmatch(bundle_name):
        fail("Bundle name is invalid")
    if args.target_project_id and not PROJECT.fullmatch(args.target_project_id):
        fail("Target project ID is invalid")

    archive_hash = verify_checksum(archive, checksum)
    entries, declared_bytes = inspect(archive)
    inbox = args.inbox.expanduser().resolve()
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = inbox / bundle_name
    if target.exists():
        fail(f"Inbox bundle already exists: {target}")
    staging = inbox / f".{bundle_name}.importing-{uuid.uuid4().hex}"
    try:
        written = extract(archive, staging, entries)
        if written != declared_bytes:
            fail(f"Expanded byte count mismatch: expected {declared_bytes}, wrote {written}")
        staging.rename(target)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    try:
        result = hub_import(args.hub_url, bundle_name, args.target_project_id)
    except Exception:
        print(f"Verified bundle retained for retry: {target}", file=sys.stderr)
        raise
    print(
        json.dumps(
            {
                "bundleName": bundle_name,
                "inboxDirectory": str(target),
                "archiveSha256": archive_hash,
                "expandedBytes": written,
                "result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
