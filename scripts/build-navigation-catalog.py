#!/usr/bin/env python3
"""Build compact collision grids from the pinned official scene inventory.

Requires UnityPy==1.25.3. No assets are fetched and no bundle code is executed.
Usage: python scripts/build-navigation-catalog.py BUNDLE_DIR OUTPUT_JSON
Use fetch-navigation.py to populate BUNDLE_DIR with SHA-256 verified bundles.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from catalog_effects import write_catalog
from catalog_logic import catalog_json
from navigation_logic import reviewed_bundle_matches, validate_grid, validate_inventory


def extract_grid(source, bundle_dir, temp, scripts):
    """Read and verify one bundle, then invoke the owning extractor."""
    map_code = source['map']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', map_code):
        raise ValueError('Invalid map key')
    bundle = bundle_dir / f'rayrag-{map_code}-scene.bundle'
    with bundle.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if not reviewed_bundle_matches(source, bundle.stat().st_size, digest):
        raise ValueError(f'{map_code}: bundle differs from the reviewed source')
    output = Path(temp) / f'{map_code}.json'
    subprocess.run([
        sys.executable, str(scripts / 'extract-navigation.py'),
        str(bundle), map_code, str(output), source['sourceUrl'],
    ], check=True, stdout=subprocess.DEVNULL)
    return json.loads(output.read_text())


def main(argv=None):
    bundle_dir, output_path = map(Path, sys.argv[1:] if argv is None else argv)
    scripts = Path(__file__).resolve().parent
    portals = json.loads((scripts / 'navigation-portals.json').read_text())
    sources = json.loads((scripts / 'navigation-sources.json').read_text())['maps']
    validate_inventory(sources, portals)

    with tempfile.TemporaryDirectory(prefix='rayrag-grid-catalog-') as temp:
        def extract(source):
            grid = extract_grid(source, bundle_dir, temp, scripts)
            return source['map'], validate_grid(source, grid, portals[source['map']])

        with ThreadPoolExecutor(max_workers=4) as pool:
            catalog = dict(sorted(pool.map(extract, sources)))
    # Preserve the prior catalog if any source fails. Replace only a complete result.
    write_catalog(output_path, catalog_json(catalog), atomic=True)
    print(json.dumps({'maps': len(catalog), 'jsonBytes': output_path.stat().st_size}))


if __name__ == '__main__':
    main()
