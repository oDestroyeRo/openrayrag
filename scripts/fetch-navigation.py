#!/usr/bin/env python3
"""Download the reviewed public scene inventory into a local cache.

Usage: python scripts/fetch-navigation.py BUNDLE_DIR
Requires curl. Existing bundles are reused only when size and SHA-256 match.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sources = json.loads((Path(__file__).resolve().parent / 'navigation-sources.json').read_text())['maps']
destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)


def matches(path, source):
    if not path.exists() or path.stat().st_size != source['bundleBytes']:
        return False
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest() == source['sourceSha256']


def fetch(source):
    code = source['map']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', code):
        raise ValueError('Invalid map code')
    expected = ('https://websea01.rayrag.com/StreamingAssets/aa/WebGL/'
                f'scenes_scenes_assets_scenes_maps_{code}.unity.bundle')
    if source['sourceUrl'] != expected:
        raise ValueError('Unexpected scene URL')
    output = destination / f'rayrag-{code}-scene.bundle'
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
            raise ValueError(f'{code}: downloaded asset differs from the reviewed source')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return True


with ThreadPoolExecutor(max_workers=4) as pool:
    fetched = sum(pool.map(fetch, sources))
print(json.dumps({'maps': len(sources), 'downloaded': fetched, 'cached': len(sources) - fetched}))
