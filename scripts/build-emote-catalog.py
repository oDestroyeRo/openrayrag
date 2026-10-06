#!/usr/bin/env python3
"""Generate player emote IDs from the protocol pin, never checkout HEAD."""
import json
from pathlib import Path
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json, csv_rows, source_record

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
SOURCE = 'RoRebuildServer/GameConfig/ServerData/Db/Emotes.csv'


def build_catalog(raw):
    rows = csv_rows(raw)
    items = [{'id': int(row['Id']), 'label': row['Commands']} for row in rows]
    if len(items) != 59 or len({item['id'] for item in items}) != 59:
        raise ValueError('Unexpected emote whitelist')
    if not all(0 <= item['id'] <= 100 and item['label'] for item in items):
        raise ValueError('Invalid emote metadata')
    if [item['id'] for item in items if 58 <= item['id'] <= 63] != [58]:
        raise ValueError('Only canonical dice is exposed')
    result = {'sourcePin': PIN, 'source': source_record(raw, PIN, SOURCE), 'items': sorted(items, key=lambda item: item['id'])}
    return result


def main(argv=None):
    repo, output = map(Path, sys.argv[1:] if argv is None else argv)
    raw = load_pinned_blobs(repo, PIN, [SOURCE])[SOURCE]
    result = build_catalog(raw)
    write_catalog(output, catalog_json(result))
    print(json.dumps({'emotes': len(result['items'])}))


if __name__ == '__main__':
    main()
