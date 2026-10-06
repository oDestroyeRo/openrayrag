#!/usr/bin/env python3
"""Download the reviewed public scene inventory into a local cache.

Usage: python scripts/fetch-navigation.py BUNDLE_DIR
Requires curl. Existing bundles are reused only when size and SHA-256 match.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from navigation_logic import SceneMapCode, reviewed_bundle_matches, scene_url


def matches(path, source):
    if not path.exists() or path.stat().st_size != source['bundleBytes']:
        return False
    with path.open('rb') as handle:
        return reviewed_bundle_matches(source, path.stat().st_size, hashlib.file_digest(handle, 'sha256').hexdigest())


def fetch(source, destination):
    expected = scene_url(source)
    code = SceneMapCode(source['map'])
    output = destination / code.bundle_filename
    if matches(output, source):
        return False
    with tempfile.NamedTemporaryFile(dir=destination, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        subprocess.run([
            'curl', '--fail', '--silent', '--show-error', '--proto', '=https',
            '--retry', '1', '--max-time', '120', '--output', str(temporary), expected,
        ], check=True)
        if not matches(temporary, source):
            raise ValueError(f'{code.value}: downloaded asset differs from the reviewed source')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def main(argv=None):
    destination, = map(Path, sys.argv[1:] if argv is None else argv)
    sources = json.loads((Path(__file__).resolve().parent / 'navigation-sources.json').read_text())['maps']
    destination.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        fetched = sum(pool.map(lambda source: fetch(source, destination), sources))
    print(json.dumps({'maps': len(sources), 'downloaded': fetched, 'cached': len(sources) - fetched}))


if __name__ == '__main__':
    main()
