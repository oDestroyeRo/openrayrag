#!/usr/bin/env python3
"""Generate socket permissions from fixed Git blobs and matching public IDs.

Usage: build-socket-catalog.py SOURCE_REPO ITEMS_JSON OUTPUT_JSON
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


def blob(path):
    raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{path}'])
    sources[path] = {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{path}',
                     'sha256': hashlib.sha256(raw).hexdigest()}
    return raw.decode('utf-8-sig')


# Resolve aliases in the owning enum rather than inferring masks from labels.
def enum_masks(raw, declaration):
    enum = raw.split(declaration)[1].split('}')[0]
    values = {}
    for line in enum.splitlines():
        line = line.split('//')[0].strip().rstrip(',')
        if '=' not in line:
            continue
        name, expression = map(str.strip, line.split('=', 1))
        name = name.split()[-1]  # Ignore the source's optional Name annotation.
        result = 0
        for part in expression.split('|'):
            part = part.strip()
            result |= values[part] if part in values else int(part)
        values[name] = result
    return values


masks = enum_masks(blob('RoRebuildServer/RebuildSharedData/Enum/ItemType.cs'), 'enum EquipPosition : short')
head_masks = enum_masks(blob('RoRebuildServer/RoRebuildServer/Data/CsvDataTypes/CsvItem.cs'), 'enum HeadgearPosition : byte')
blob('RoRebuildServer/RoRebuildServer/Data/DataLoader.cs')
blob('RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketSocketEquipment.cs')
raw = published_path.read_bytes()
sources['publishedItems'] = {'url': 'https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/items.json',
                              'sha256': hashlib.sha256(raw).hexdigest()}
published = json.loads(raw)['Items']
if len({item['Id'] for item in published}) != len(published):
    raise ValueError('Duplicate public ID')
items, unknown = {}, {}
for filename, item_class in [('ItemsWeapons', 2), ('ItemsEquipment', 3), ('ItemsCards', 5)]:
    rows = list(csv.DictReader(io.StringIO(blob(f'RoRebuildServer/GameConfig/ServerData/Db/{filename}.csv'))))
    by_id = {int(row['Id']): row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError('Duplicate source ID')
    for item in published:
        if item['ItemClass'] != item_class:
            continue
        row = by_id.get(item['Id'])
        if row is None:
            unknown[str(item['Id'])] = 'ID absent from pinned source'
            continue
        if (row['Code'], row['Name']) != (item['Code'], item['Name']):
            raise ValueError(f"{item['Id']}: source/public identity mismatch")
        mask = masks.get('Weapon' if item_class == 2 else row['Type'] if item_class == 3 else row['EquipableSlot'])
        capacity = 0 if item_class == 5 else int(row['Slot'])
        if mask is None or not 0 < mask <= 511 or not 0 <= capacity <= 4:
            unknown[str(item['Id'])] = 'Unsupported mask or capacity'
            continue
        # Public weapon Position may include both hands; handler uses Weapon.
        public_mask = head_masks.get(row.get('Position')) if item_class == 3 and row['Type'] == 'Headgear' else mask
        if item['IsUnique'] != (item_class != 5) or item['Slots'] != capacity or (item_class != 2 and item['Position'] != public_mask):
            raise ValueError(f"{item['Id']}: source/public socket metadata mismatch")
        items[str(item['Id'])] = {'code': row['Code'], 'name': item['Name'], 'itemClass': item_class,
                                 'mask': mask, 'capacity': capacity}
output_path.write_text(json.dumps({'sourcePin': PIN, 'sources': sources, 'items': items, 'unknown': unknown}, separators=(',', ':')) + '\n')
print(json.dumps({'verifiedItems': len(items), 'unknownItems': len(unknown)}))
