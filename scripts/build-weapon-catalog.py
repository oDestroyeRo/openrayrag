#!/usr/bin/env python3
"""Match pinned weapon range/type to the official published item IDs.

Usage: python3 scripts/build-weapon-catalog.py SOURCE_REPO ITEMS_JSON OUTPUT_JSON
Reads Git blobs at the protocol pin; never uses the source checkout's HEAD.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
repo, published_path, output_path = map(Path, sys.argv[1:])
sources = {}


def pinned_csv(name):
    path = f'RoRebuildServer/GameConfig/ServerData/Db/{name}.csv'
    raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{path}'])
    sources[name] = {
        'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{path}',
        'sha256': hashlib.sha256(raw).hexdigest(),
    }
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


raw = published_path.read_bytes()
sources['items'] = {
    'url': 'https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/items.json',
    'sha256': hashlib.sha256(raw).hexdigest(),
}
published = json.loads(raw)['Items']
weapons = pinned_csv('ItemsWeapons')
classes = {row['WeaponClass']: int(row['Id']) for row in pinned_csv('WeaponClass')}
by_id = {int(row['Id']): row for row in weapons}
if len(by_id) != len(weapons):
    raise ValueError('Duplicate source weapon ID')
items = {}
unknown = {}
for item in published:
    if item['ItemClass'] != 2:
        continue
    item_id = item['Id']
    row = by_id.get(item_id)
    if row is None:
        unknown[str(item_id)] = 'Weapon ID absent from pinned source'
        continue
    if row['Code'] != item['Code']:
        raise ValueError(f'{item_id}: published ID/code mismatch')
    weapon_class = classes.get(row['Type'])
    if weapon_class is None:
        # The source calls ten pistols Handgun, absent from WeaponClass.csv.
        unknown[str(item_id)] = f"Unresolved source weapon class: {row['Type']}"
        continue
    if weapon_class != item['SubType']:
        raise ValueError(f'{item_id}: published ID/code/subtype mismatch')
    attack_range = int(row['Range'])
    if not 1 <= attack_range <= 512:
        raise ValueError(f'{item_id}: invalid source range')
    items[str(item_id)] = {
        'code': row['Code'], 'range': attack_range, 'weaponClass': weapon_class,
    }
result = {'sourcePin': PIN, 'sources': sources, 'items': items, 'unknown': unknown}
output_path.write_text(json.dumps(result, separators=(',', ':')) + '\n')
print(json.dumps({'verifiedWeapons': len(items), 'unknownWeapons': len(unknown)}))
