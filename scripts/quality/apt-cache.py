"""Validate cached APT archives against the current authenticated download plan."""

import hashlib
import json
from pathlib import Path
import re
import shlex
import sys


def download_manifest(source):
    manifest = {}
    for line in source.splitlines():
        if not line.startswith("'"):
            continue
        _, filename, size, digest = shlex.split(line)
        if (Path(filename).name != filename or not filename.endswith(".deb")
                or not size.isdecimal() or int(size) <= 0
                or not re.fullmatch(r"SHA256:[a-fA-F0-9]{64}", digest)):
            raise ValueError("APT returned an invalid SHA256 download record.")
        record = {"size": int(size), "sha256": digest[7:].lower()}
        if filename in manifest and manifest[filename] != record:
            raise ValueError("APT returned conflicting download records.")
        manifest[filename] = record
    return manifest


def verify_archives(manifest, directory):
    verified = discarded = 0
    for archive in sorted(directory.glob("*.deb")):
        expected = manifest.get(archive.name)
        valid = (not archive.is_symlink() and archive.is_file()
                 and expected is not None and archive.stat().st_size == expected["size"])
        if valid:
            digest = hashlib.sha256()
            with archive.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            valid = digest.hexdigest() == expected["sha256"]
        if valid:
            verified += 1
        else:
            archive.unlink()
            discarded += 1
    return {"verified": verified, "discarded": discarded}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "plan":
        print(json.dumps(download_manifest(Path(sys.argv[2]).read_text()), sort_keys=True))
    elif len(sys.argv) == 4 and sys.argv[1] == "verify":
        result = verify_archives(json.loads(Path(sys.argv[2]).read_text()), Path(sys.argv[3]))
        print(f"APT archives: {result['verified']} verified, {result['discarded']} discarded.")
    else:
        raise SystemExit("Usage: apt-cache.py plan DOWNLOADS | verify MANIFEST ARCHIVES")
