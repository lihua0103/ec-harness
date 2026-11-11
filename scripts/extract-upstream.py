"""Safely extract an official source archive without executing downloaded code.
Run from outside the archive directory with python -I and explicit paths.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("archive", type=Path)
parser.add_argument("destination", type=Path)
parser.add_argument("commit")
args = parser.parse_args()
archive = args.archive.resolve(strict=True)
destination = args.destination.resolve()
if destination.exists():
    raise SystemExit("Destination must not exist; refusing to overwrite.")
root_name = "deepseek-harness-" + args.commit
max_total = 1024 * 1024 * 1024
reserved = {"CON", "PRN", "AUX", "NUL"} | {f"{p}{n}" for p in ("COM", "LPT") for n in range(1, 10)}
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    seen = set()
    total = 0
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or not path.parts or path.parts[0] != root_name:
            raise SystemExit("Unexpected archive root/path.")
        for part in path.parts:
            if part in (".", "..") or "\\" in part or ":" in part or part.endswith((".", " ")):
                raise SystemExit("Unsafe archive path.")
            if part.split(".")[0].upper() in reserved:
                raise SystemExit("Reserved Windows filename.")
        if not (member.isfile() or member.isdir()):
            raise SystemExit("Links and special entries are not allowed.")
        relative = Path(*path.parts[1:])
        key = str(relative).casefold()
        if key in seen:
            raise SystemExit("Duplicate/case-colliding archive path.")
        seen.add(key)
        if member.size < 0:
            raise SystemExit("Invalid member size.")
        total += member.size
        if total > max_total or len(members) > 100000:
            raise SystemExit("Archive resource limit exceeded.")
    destination.mkdir(parents=True, exist_ok=False)
    files = 0
    for member in members:
        relative = Path(*PurePosixPath(member.name).parts[1:])
        target = destination / relative
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("Missing archive member content.")
            with source, target.open("xb") as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RuntimeError("Truncated member.")
                    output.write(chunk)
                    remaining -= len(chunk)
            files += 1
sha = hashlib.sha256()
with archive.open("rb") as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        sha.update(block)
print(json.dumps({"archive": str(archive), "archiveBytes": archive.stat().st_size,
                  "sha256": sha.hexdigest(), "commit": args.commit,
                  "destination": str(destination), "files": files,
                  "unpackedBytes": total, "executedUpstreamCode": False}, indent=2))
