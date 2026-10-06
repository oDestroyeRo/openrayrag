#!/usr/bin/env python3
"""Download the reviewed public scene inventory into a local cache.

Usage: python scripts/catalogs/fetch-navigation.py BUNDLE_DIR
Downloads require curl 8.4+. Existing bundles are reused only when size and SHA-256 match.
"""
from concurrent.futures import ThreadPoolExecutor
from functools import cache
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from navigation_logic import SceneMapCode, reviewed_bundle_matches, scene_url


def matches(path, source):
    if not path.exists() or path.stat().st_size != source['bundleBytes']:
        return False
    with path.open('rb') as handle:
        return reviewed_bundle_matches(source, path.stat().st_size, hashlib.file_digest(handle, 'sha256').hexdigest())


@cache
def require_bounded_curl():
    version = subprocess.run(['curl', '--version'], check=True, capture_output=True, text=True, timeout=10)
    parsed = re.match(r'^curl (\d+)\.(\d+)\.(\d+)(?:[\s-]|$)', version.stdout)
    # Earlier curl versions ignore max-filesize when Content-Length is absent.
    if parsed is None or tuple(map(int, parsed.groups())) < (8, 4, 0):
        raise ValueError('Navigation downloads require curl 8.4+ for streamed byte bounds')


def fetch(source, destination):
    expected = scene_url(source)
    code = SceneMapCode(source['map'])
    if type(source['bundleBytes']) is not int or source['bundleBytes'] <= 0:
        raise ValueError(f'{code.value}: invalid reviewed bundle byte bound')
    output = destination / code.bundle_filename
    if matches(output, source):
        return False
    require_bounded_curl()
    with tempfile.NamedTemporaryFile(dir=destination, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        subprocess.run([
            'curl', '--fail', '--silent', '--show-error', '--proto', '=https',
            '--retry', '1', '--max-time', '120', '--max-filesize', str(source['bundleBytes']),
            '--output', str(temporary), expected,
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
