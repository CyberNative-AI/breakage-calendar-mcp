#!/usr/bin/env python3
"""Build dist/breakage-calendar-mcp-<version>.mcpb from the committed tree, byte for byte reproducible.

The bundle is a zip: manifest.json at the top, the server under server/. Every entry has the same fixed time
and mode, in sorted order, so the same commit always gives the same sha256 (server.json's fileSha256).
Usage: python3 scripts/build-mcpb.py [REV]   (default HEAD; reads files with git show, not the working tree)
"""
import hashlib, io, json, subprocess, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REV = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
SERVER_FILES = ["package.json", "LICENSE", "README.md"]
SERVER_DIRS = ["bin", "src"]

def git(*a):
    return subprocess.run(["git", "-C", str(ROOT), *a], check=True, capture_output=True).stdout

def files():
    listed = git("ls-tree", "-r", "--name-only", REV).decode().splitlines()
    out = [("manifest.json", "manifest.json")]
    for p in listed:
        if p in SERVER_FILES or p.split("/")[0] in SERVER_DIRS:
            out.append((p, f"server/{p}"))
    return sorted(out, key=lambda x: x[1])

manifest = json.loads(git("show", f"{REV}:manifest.json"))
pkg = json.loads(git("show", f"{REV}:package.json"))
assert manifest["version"] == pkg["version"], "manifest.json and package.json versions differ"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for src, dst in files():
        info = zipfile.ZipInfo(dst, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if dst.endswith("breakage-calendar-mcp.mjs") else 0o100644) << 16
        info.create_system = 3
        z.writestr(info, git("show", f"{REV}:{src}"))
data = buf.getvalue()
out = ROOT / "dist" / f"breakage-calendar-mcp-{pkg['version']}.mcpb"
out.parent.mkdir(exist_ok=True)
out.write_bytes(data)
print(f"{out.relative_to(ROOT)} {len(data)} bytes sha256 {hashlib.sha256(data).hexdigest()}")
