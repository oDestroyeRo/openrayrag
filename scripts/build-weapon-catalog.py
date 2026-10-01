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
jobs = {row['Class']: int(row['Id']) for row in pinned_csv('Jobs')}
# Equipment groups are ordered, headerless rows. New groups are published only
# after the row: a self reference must still resolve through the job lookup.
path = 'RoRebuildServer/GameConfig/ServerData/Db/EquipmentGroups.csv'
group_raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{path}'])
sources['EquipmentGroups'] = {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{path}', 'sha256': hashlib.sha256(group_raw).hexdigest()}
groups = {}
for row in csv.reader(io.StringIO(group_raw.decode('utf-8-sig'))):
    if not row: continue
    members = set(groups.get(row[0], []))
    for name in row[2:]:
        if name in groups: members.update(groups[name])
        elif name in jobs: members.add(jobs[name])
    groups[row[0]] = sorted(members)
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
        'minLevel': int(row['MinLvl']), 'jobs': groups.get(row['EquipGroup']),
        'twoHanded': row['Position'] == 'BothHands',
    }
ammo_types = {'Arrow': 0, 'ThrowingDagger': 1, 'Bullet': 2, 'Grenade': 3, 'Shuriken': 4, 'Kunai': 5}
ammo_rows = {int(row['Id']): row for row in pinned_csv('ItemsAmmo')}
armor_rows = {int(row['Id']): row for row in pinned_csv('ItemsEquipment')}
ammo, equipment = {}, {}
for item in published:
    item_id = item['Id']
    if item['ItemClass'] == 4:
        row = ammo_rows.get(item_id)
        if row is None or row['Code'] != item['Code']: raise ValueError(f'{item_id}: published ammo ID/code mismatch')
        if row['Type'] not in ammo_types: raise ValueError(f'{item_id}: unknown ammo type')
        # Public ammo SubType is zero for every type; it is not authoritative.
        ammo[str(item_id)] = {'code': row['Code'], 'ammoType': ammo_types[row['Type']], 'minLevel': int(row['MinLvl']), 'attack': int(row['Attack']), 'property': row['Property']}
    elif item['ItemClass'] == 3:
        row = armor_rows.get(item_id)
        if row is None: continue
        if row['Code'] != item['Code']: raise ValueError(f'{item_id}: published equipment ID/code mismatch')
        equipment[str(item_id)] = {'code': row['Code'], 'position': row['Type'], 'headPosition': row['Position'], 'minLevel': int(row['MinLvl']), 'jobs': groups.get(row['EquipGroup'])}
result = {'sourcePin': PIN, 'sources': sources, 'items': items, 'unknown': unknown, 'ammo': ammo, 'equipment': equipment}
output_path.write_text(json.dumps(result, separators=(',', ':')) + '\n')
print(json.dumps({'verifiedWeapons': len(items), 'unknownWeapons': len(unknown), 'verifiedAmmo': len(ammo), 'verifiedEquipment': len(equipment)}))
