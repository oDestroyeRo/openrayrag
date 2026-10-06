#!/usr/bin/env python3
"""Classify direct HP/SP recovery from pinned Rebuild scripts and client identities.

Usage: build-recovery-item-catalog.py SOURCE_REPO GAME_CATALOG_JSON OUTPUT_JSON
"""
import csv
import io
import json
from pathlib import Path
import re
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json, source_record

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
SOURCE_PATHS = (
    'RoRebuildServer/GameConfig/ServerData/Script/Items/ItemEffects.txt',
    'RoRebuildServer/GameConfig/ServerData/Db/ItemsUsable.csv',
    # Defines RecoveryItem's HP-min/max, SP-min/max parameter order.
    'RoRebuildServer/RoRebuildServer/ScriptSystem/ScriptTreeWalker.cs',
)


def build_catalog(blobs, client):
    sources = {path: source_record(blobs[path], PIN, path) for path in SOURCE_PATHS}
    effects = blobs[SOURCE_PATHS[0]].decode('utf-8-sig')
    usable = blobs[SOURCE_PATHS[1]].decode('utf-8-sig')
    rows = {row['Code']: row for row in csv.DictReader(io.StringIO(usable))}
    healing = {}
    pattern = r'RecoveryItem\("([^"]+)",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\);'
    declarations = re.findall(pattern, effects)
    if len(declarations) != effects.count('RecoveryItem('):
        raise ValueError('Unrecognized recovery declaration')
    for code, *values in declarations:
        hp_min, hp_max, sp_min, sp_max = map(int, values)
        if code in healing or not 0 <= hp_min <= hp_max or not 0 <= sp_min <= sp_max:
            raise ValueError('Invalid or duplicate recovery declaration')
        healing[code] = (hp_min > 0, sp_min > 0)

    # These three reviewed direct-use bodies recover both resources. Never infer
    # effects from an item name, icon, category or an unimplemented food definition.
    direct = {
        'Royal_Jelly': ['HealRange(325, 405)', 'RecoverSpRange(40, 60)'],
        'Yggdrasil_Berry': ['HealHpPercent(100)', 'HealSpPercent(100)'],
        'Yggdrasil_Seed': ['HealHpPercent(50)', 'HealSpPercent(50)'],
    }
    seen = set()
    for code, body in re.findall(r'\bItem\("([^"]+)"\)\s*\{([^}]+)\}', effects):
        if not re.search(r'\b(?:HealRange|RecoverSpRange|HealHpPercent|HealSpPercent)\(', body):
            continue
        if code not in direct or any(effect not in body for effect in direct[code]) or 'OnValidate' in body or 'OnUseTargeted' in body:
            raise ValueError(f'Unreviewed direct healing body: {code}')
        healing[code] = (True, True)
        seen.add(code)
    if seen != set(direct):
        raise ValueError('Missing reviewed direct healing body')

    hp_ids, sp_ids = [], []
    for code, (hp, sp) in healing.items():
        row = rows[code]
        item_id = int(row['Id'])
        item = client['items'].get(str(item_id))
        if not item or item['name'] != row['Name'] or item['itemClass'] != 1 or item['useType'] != 1 or row['UseMode'] != 'Use':
            continue
        if hp:
            hp_ids.append(item_id)
        if sp:
            sp_ids.append(item_id)
    order = lambda item_id: (client['items'][str(item_id)]['price'], item_id)
    result = {'sourcePin': PIN, 'clientItemsSha256': client['sources']['items']['sha256'],
              'sources': sources, 'hpIds': sorted(hp_ids, key=order), 'spIds': sorted(sp_ids, key=order)}
    return result


def main(argv=None):
    repo, client_path, output_path = map(Path, sys.argv[1:] if argv is None else argv)
    blobs = load_pinned_blobs(repo, PIN, SOURCE_PATHS)
    client = json.loads(client_path.read_bytes())
    result = build_catalog(blobs, client)
    write_catalog(output_path, catalog_json(result, indent=2, compact=False))
    print(f"Classified {len(result['hpIds'])} HP and {len(result['spIds'])} SP recovery items")


if __name__ == '__main__':
    main()
