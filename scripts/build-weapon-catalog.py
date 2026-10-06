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
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json, csv_rows, source_record

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
BASE = 'RoRebuildServer/GameConfig/ServerData/Db/'
SOURCE_NAMES = ('ItemsWeapons', 'WeaponClass', 'Jobs', 'EquipmentGroups', 'ItemsAmmo', 'ItemsEquipment')


def build_catalog(blobs, raw):
    sources = {'items': {'url': 'https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/items.json',
                         'sha256': hashlib.sha256(raw).hexdigest()}}
    for name in SOURCE_NAMES:
        path = BASE + name + '.csv'
        sources[name] = source_record(blobs[path], PIN, path)
    published = json.loads(raw)['Items']
    weapons = csv_rows(blobs[BASE + 'ItemsWeapons.csv'])
    classes = {row['WeaponClass']: int(row['Id']) for row in csv_rows(blobs[BASE + 'WeaponClass.csv'])}
    jobs = {row['Class']: int(row['Id']) for row in csv_rows(blobs[BASE + 'Jobs.csv'])}
    # Equipment groups are ordered, headerless rows. New groups are published only
    # after the row: a self reference must still resolve through the job lookup.
    group_raw = blobs[BASE + 'EquipmentGroups.csv']
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
    ammo_rows = {int(row['Id']): row for row in csv_rows(blobs[BASE + 'ItemsAmmo.csv'])}
    armor_rows = {int(row['Id']): row for row in csv_rows(blobs[BASE + 'ItemsEquipment.csv'])}
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
    return result


def main(argv=None):
    repo, published_path, output_path = map(Path, sys.argv[1:] if argv is None else argv)
    raw = published_path.read_bytes()
    blobs = load_pinned_blobs(repo, PIN, [BASE + name + '.csv' for name in SOURCE_NAMES])
    result = build_catalog(blobs, raw)
    write_catalog(output_path, catalog_json(result))
    print(json.dumps({'verifiedWeapons': len(result['items']), 'unknownWeapons': len(result['unknown']),
                      'verifiedAmmo': len(result['ammo']), 'verifiedEquipment': len(result['equipment'])}))


if __name__ == '__main__':
    main()
