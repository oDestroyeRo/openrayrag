#!/usr/bin/env python3
"""Build directed fixed warp edges from reviewed areas and pinned server source.

Usage: python scripts/build-travel-catalog.py PORTAL_REPORT SOURCE_GIT OUTPUT_JSON
The report establishes excluded trigger rectangles. Every included edge is read
again at the protocol pin, and must be a direct top-level Warp/HiddenWarp call
with literal coordinates and one fixed arrival. Conditional NPC touch scripts,
event-gated files, random arrival areas, missing grids and invalid cells are
excluded. No downloaded script is executed. HiddenWarp differs only in display
in ScriptTreeWalker.EnterWarpStatement at the pinned revision.
The reviewed report must retain alsoPinnedAt evidence for the compatible pin;
a report without pinned evidence is rejected before replacing any catalog.
"""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'


def validate_report(report):
    if report['sources']['pinned'] != PIN:
        raise ValueError('Portal report uses a different protocol source')
    if not any(
        source['kind'] in ('Warp', 'HiddenWarp') and (
            source['commit'] == PIN or any(s['commit'] == PIN for s in source.get('alsoPinnedAt', []))
        )
        for areas in report['perMapEvidence'].values() for area in areas for source in area['sources']
    ):
        raise ValueError('Portal report lacks pinned warp evidence; retain the reviewed alsoPinnedAt source records')


def validate_source_path(path):
    if not path.startswith('RoRebuildServer/GameConfig/ServerData/Script/') or '..' in Path(path).parts:
        raise ValueError('Invalid source path')
    return path


def required_source_paths(report, grids):
    paths = {}
    for from_map, areas in sorted(report['perMapEvidence'].items()):
        if from_map not in grids:
            continue
        for area in areas:
            for evidence in area['sources']:
                if evidence['kind'] not in ('Warp', 'HiddenWarp'):
                    continue
                pinned = [s for s in evidence.get('alsoPinnedAt', []) if s['commit'] == PIN]
                if evidence['commit'] == PIN:
                    pinned.append(evidence)
                if pinned:
                    paths[validate_source_path(pinned[0]['path'])] = None
    return list(paths)


def parse_source(text):
    # Mask comments and strings while retaining newlines and braces. Brace
    # depth proves the call is top-level; strings remain in the parsed line.
    masked = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/',
                    lambda m: re.sub(r'[^\n]', ' ', m[0]), text)
    depths = []
    depth = 0
    for line in masked.splitlines():
        depths.append(depth)
        depth += line.count('{') - line.count('}')
    gated = bool(re.search(r'\bServerEvent\b|(?m:^\s*#event\b)', masked))
    return text.splitlines(), depths, gated


def walkable(grid, bits, x, y):
    index = x + y * grid['width']
    return (0 <= x < grid['width'] and 0 <= y < grid['height']
            and bool(bits[index >> 3] & (1 << (index & 7))))


def build_catalog(report_raw, grids, source_blobs):
    report = json.loads(report_raw)
    validate_report(report)
    bits = {name: base64.b64decode(g['walkableBitsBase64'], validate=True) for name, g in grids.items()}
    source_cache = {}
    excluded = {}

    def skip(reason):
        excluded[reason] = excluded.get(reason, 0) + 1

    def source_lines(path):
        validate_source_path(path)
        if path not in source_cache:
            source_cache[path] = parse_source(source_blobs[path].decode('utf-8-sig'))
        return source_cache[path]

    def can_walk(name, x, y):
        return walkable(grids[name], bits[name], x, y)

    edges = {}
    for from_map, areas in sorted(report['perMapEvidence'].items()):
        if from_map not in grids:
            continue
        for area in areas:
            rectangle = {key: area[key] for key in ('x', 'y', 'halfWidth', 'halfHeight')}
            if rectangle not in grids[from_map]['portals']:
                raise ValueError('Reviewed rectangle differs from collision catalog')
            for evidence in area['sources']:
                if evidence['kind'] not in ('Warp', 'HiddenWarp'):
                    skip('scriptedNpcTouch')
                    continue
                pinned = [s for s in evidence.get('alsoPinnedAt', []) if s['commit'] == PIN]
                if evidence['commit'] == PIN:
                    pinned.append(evidence)
                if not pinned:
                    skip('notInProtocolPin')
                    continue
                s = pinned[0]
                lines, depths, gated = source_lines(s['path'])
                line = s['line']
                if gated or not 1 <= line <= len(lines) or depths[line - 1] != 0:
                    skip('conditionalRegistration')
                    continue
                match = re.fullmatch(r'\s*(Warp|HiddenWarp)\((.*)\);\s*(?://.*)?', lines[line - 1])
                if not match:
                    skip('nonLiteralRegistration')
                    continue
                args = next(csv.reader(io.StringIO(match[2]), skipinitialspace=True))
                # Optional display name before the six source/destination values.
                offset = 3 if len(args) in (10, 12) else 2
                if len(args) not in (9, 10, 11, 12):
                    skip('unsupportedSignature')
                    continue
                try:
                    x, y, w, h = map(int, args[offset:offset + 4])
                    to_map = args[offset + 4]
                    ax, ay = map(int, args[offset + 5:offset + 7])
                    spread = list(map(int, args[offset + 7:]))
                except ValueError:
                    skip('nonLiteralRegistration')
                    continue
                # Duplicate declarations can share a rectangle/destination and the
                # report then lists both pinned declarations for either source.
                if args[0] != from_map or (x, y, w, h) != tuple(rectangle.values()):
                    raise ValueError(f'{s["path"]}:{line}: report/source mismatch')
                if [to_map, ax, ay] not in evidence['destinations']:
                    raise ValueError(f'{s["path"]}:{line}: destination mismatch')
                if any(spread):
                    skip('randomArrival')
                    continue
                if to_map not in grids:
                    skip('missingDestinationGrid')
                    continue
                if not can_walk(to_map, ax, ay):
                    skip('blockedArrival')
                    continue
                if not any(can_walk(from_map, px, py) for py in range(y - h, y + h + 1)
                           for px in range(x - w, x + w + 1)):
                    skip('blockedTrigger')
                    continue
                key = (from_map, x, y, w, h, to_map, ax, ay)
                edges.setdefault(key, {
                    'id': f'{from_map}:{x},{y},{w},{h}:{to_map}:{ax},{ay}', 'fromMap': from_map, 'toMap': to_map,
                    'area': rectangle, 'arrival': {'x': ax, 'y': ay},
                    'source': {'kind': match[1], 'commit': PIN, 'path': s['path'], 'line': line},
                })

    catalog = {
        'sourceCommit': PIN,
        'sourceRepository': 'https://github.com/Doddler/RagnarokRebuildTcp',
        'reportSha256': hashlib.sha256(report_raw).hexdigest(),
        'policy': 'Direct unconditional top-level Warp/HiddenWarp with fixed walkable arrival; other portal areas stay excluded.',
        'excluded': excluded,
        'edges': sorted(edges.values(), key=lambda e: e['id']),
    }
    if not edges:
        raise ValueError('No verified travel edges; refusing to replace the existing catalog')
    if len({e['id'] for e in catalog['edges']}) != len(catalog['edges']):
        raise ValueError('Duplicate edge identity')
    return catalog


def main(argv=None):
    report_path, source_git, output_path = map(Path, sys.argv[1:] if argv is None else argv)
    report_raw = report_path.read_bytes()
    report = json.loads(report_raw)
    validate_report(report)
    grids = json.loads((Path(__file__).resolve().parent.parent / 'src/data/navigation-maps.json').read_text())
    blobs = load_pinned_blobs(source_git, PIN, required_source_paths(report, grids))
    catalog = build_catalog(report_raw, grids, blobs)
    write_catalog(output_path, catalog_json(catalog), atomic=True, create_parent=True)
    print(json.dumps({'edges': len(catalog['edges']),
                      'sameMap': sum(e['fromMap'] == e['toMap'] for e in catalog['edges']),
                      'jsonBytes': output_path.stat().st_size, 'excluded': catalog['excluded']}))


if __name__ == '__main__':
    main()
