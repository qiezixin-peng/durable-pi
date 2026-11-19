#!/usr/bin/env python3
import base64
import os
import pathlib
import re
import sys
import tempfile

if len(sys.argv) not in (5, 6):
    raise SystemExit("usage: configure-mesh-peer.py <alias> <host> <user> <peer-public-key-base64> [port]")
alias, host, user, encoded = sys.argv[1:5]
port = int(sys.argv[5]) if len(sys.argv) == 6 else 22
if not re.fullmatch(r"[A-Za-z0-9._-]+", alias + host + user) or not (1 <= port <= 65535):
    raise SystemExit("invalid SSH peer configuration")
public_key = base64.b64decode(encoded, validate=True).decode("utf-8").strip()
if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?", public_key):
    raise SystemExit("invalid Ed25519 public key")

ssh = pathlib.Path("~/.ssh").expanduser()
ssh.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(ssh, 0o700)
authorized = ssh / "authorized_keys"
keys = authorized.read_text(encoding="utf-8").splitlines() if authorized.exists() else []
identity = " ".join(public_key.split()[:2])
if not any(" ".join(line.split()[:2]) == identity for line in keys if line.strip()):
    keys.append(public_key)
authorized.write_text("\n".join(keys).rstrip() + "\n", encoding="utf-8")
os.chmod(authorized, 0o600)

config = ssh / "config"
old = config.read_text(encoding="utf-8") if config.exists() else ""
begin = f"# BEGIN DURABLE PI PEER {alias}"
end = f"# END DURABLE PI PEER {alias}"
old = re.sub(rf"\n?{re.escape(begin)}.*?{re.escape(end)}\n?", "\n", old, flags=re.S).rstrip()
block = f"""{begin}
Host {alias}
  HostName {host}
  User {user}
  Port {port}
  IdentityFile ~/.ssh/durable_pi_mesh_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
{end}"""
next_value = f"{old}\n\n{block}\n" if old else f"{block}\n"
fd, temporary = tempfile.mkstemp(prefix=".config.durable-pi.", suffix=".tmp", dir=ssh)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        target.write(next_value)
    os.chmod(temporary, 0o600)
    os.replace(temporary, config)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(alias)
