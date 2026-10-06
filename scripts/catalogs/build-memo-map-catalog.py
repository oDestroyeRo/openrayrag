#!/usr/bin/env python3
"""Generate CanMemo permissions from exact pinned server flags, never checkout HEAD."""
import json
from pathlib import Path
import re
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json, csv_rows, source_record

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
SOURCE = 'RoRebuildServer/GameConfig/ServerData/Db/Maps.csv'
FLAGS = {'none', 'canmemo', 'noteleport', 'noteleportevenmonsters', 'nominimap', 'nologout', 'nowater', 'allwater'}


def build_catalog(raw):
    rows = csv_rows(raw)
    items = []
    for row in rows:
        code = row['Code']
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', code):
            raise ValueError('Invalid source map code')
        flags = {flag.strip().lower() for flag in row['Flags'].split(',') if flag.strip()}
        if not flags <= FLAGS:
            raise ValueError('Unknown map flag; review source parser before regenerating')
        items.append({'map': code, 'name': row['Name'], 'canMemo': 'canmemo' in flags})
    if not items or len({item['map'] for item in items}) != len(items):
        raise ValueError('Empty or duplicate map catalog')
    data = {'sourcePin': PIN, 'source': source_record(raw, PIN, SOURCE), 'items': sorted(items, key=lambda item: item['map'])}
    return data


def main(argv=None):
    repo, output = map(Path, sys.argv[1:] if argv is None else argv)
    raw = load_pinned_blobs(repo, PIN, [SOURCE])[SOURCE]
    result = build_catalog(raw)
    write_catalog(output, catalog_json(result))
    print(json.dumps({'maps': len(result['items']), 'canMemo': sum(item['canMemo'] for item in result['items'])}))


if __name__ == '__main__':
    main()
