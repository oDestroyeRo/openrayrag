#!/usr/bin/env python3
"""Build compact collision grids from the pinned official scene inventory.

Requires UnityPy==1.25.3. No assets are fetched and no bundle code is executed.
Usage: python scripts/build-navigation-catalog.py BUNDLE_DIR OUTPUT_JSON
Use fetch-navigation.py to populate BUNDLE_DIR with SHA-256 verified bundles.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

scripts = Path(__file__).resolve().parent
bundle_dir, output_path = map(Path, sys.argv[1:])
portals = json.loads((scripts / 'navigation-portals.json').read_text())
sources = json.loads((scripts / 'navigation-sources.json').read_text())['maps']
if len({row['map'] for row in sources}) != len(sources):
    raise ValueError('Duplicate source map')
if set(portals) != {row['map'] for row in sources}:
    raise ValueError('Every source map must have an explicit portal list')


def extract(source, temp):
    map_code = source['map']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', map_code):
        raise ValueError('Invalid map key')
    bundle = bundle_dir / f'rayrag-{map_code}-scene.bundle'
    with bundle.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if bundle.stat().st_size != source['bundleBytes'] or digest != source['sourceSha256']:
        raise ValueError(f'{map_code}: bundle differs from the reviewed source')
    output = Path(temp) / f'{map_code}.json'
    subprocess.run([
        sys.executable, str(scripts / 'extract-navigation.py'),
        str(bundle), map_code, str(output), source['sourceUrl'],
    ], check=True, stdout=subprocess.DEVNULL)
    grid = json.loads(output.read_text())
    width, height = grid['width'], grid['height']
    if not all(type(v) is int and 1 <= v <= 512 for v in (width, height)):
        raise ValueError(f'{map_code}: unsupported dimensions')
    if (width, height) != (source['width'], source['height']):
        raise ValueError(f'{map_code}: dimensions differ from the reviewed source')
    bits = base64.b64decode(grid['walkableBitsBase64'], validate=True)
    if len(bits) != (width * height + 7) // 8:
        raise ValueError('Invalid bitset size')
    if width * height % 8 and bits[-1] >> (width * height % 8):
        raise ValueError('Nonzero trailing bits')
    walkable = sum(byte.bit_count() for byte in bits)
    blocked = width * height - walkable
    if not walkable or (walkable, blocked) != (source['walkableCount'], source['blockedCount']):
        raise ValueError(f'{map_code}: cell counts differ from the reviewed source')
    for portal in portals[map_code]:
        if any(type(portal[k]) is not int for k in ('x', 'y', 'halfWidth', 'halfHeight')):
            raise ValueError('Invalid portal values')
        if not (0 <= portal['x'] < width and 0 <= portal['y'] < height):
            raise ValueError(f'{map_code}: portal center outside map')
        if not (0 <= portal['halfWidth'] <= width and 0 <= portal['halfHeight'] <= height):
            raise ValueError(f'{map_code}: invalid portal extent')
    return map_code, {
        **grid, 'walkableCount': walkable, 'blockedCount': blocked, 'portals': portals[map_code],
    }


with tempfile.TemporaryDirectory(prefix='rayrag-grid-catalog-') as temp:
    with ThreadPoolExecutor(max_workers=4) as pool:
        catalog = dict(sorted(pool.map(lambda row: extract(row, temp), sources)))
# Preserve the prior catalog if any source fails. Replace only a complete result.
with tempfile.NamedTemporaryFile(mode='w', dir=output_path.parent, delete=False) as handle:
    json.dump(catalog, handle, separators=(',', ':'))
    handle.write('\n')
    temporary = Path(handle.name)
temporary.replace(output_path)
print(json.dumps({'maps': len(catalog), 'jsonBytes': output_path.stat().st_size}))
