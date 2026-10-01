#!/usr/bin/env python3
"""Audit pinned public skill/SP contracts and build bounded metadata, without executing scripts.
Usage: python3 scripts/build-cast-policy.py PUBLIC_GIT_DIRECTORY [OUTPUT]
"""
import csv
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
root = pathlib.Path(__file__).resolve().parents[1]
repo = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'src/data/cast-policy.json'
base = 'RoRebuildServer/GameConfig/ServerData/'
sources = {}
def read(path):
    raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{path}'])
    sources[path] = hashlib.sha256(raw).hexdigest()
    return raw.decode('utf-8-sig')

published = json.loads((root / 'src/data/game-catalog.json').read_text())['items']
items = {}
codes = {}
for file in ('ItemsWeapons', 'ItemsEquipment', 'ItemsCards', 'ItemsAmmo'):
    for row in csv.reader(io.StringIO(read(base + f'Db/{file}.csv'))):
        if not row or not row[0].isdigit():
            continue
        item_id, code, name = int(row[0]), row[1], row[2]
        if code in codes or str(item_id) in items:
            raise ValueError('Duplicate metadata identity')
        codes[code] = item_id
        # Only current public identities with matching names may be known.
        if published.get(str(item_id), {}).get('name') == name:
            items[str(item_id)] = {'name': name, 'card': file == 'ItemsCards'}

expected = {
    'CardEffects.txt': [r'Item\("Vitata_Card"\).*AddStat\(SpConsumption, 15\)',
                        r'Item\("Golden_Thief_Bug_Card"\).*AddStat\(SpConsumption, 100\)',
                        r'Item\("Pharaoh_Card"\).*AddStat\(SpConsumption, -30\)'],
    'ComboEffects.txt': [r'ComboItem\("ShinobiSashSet", "Ninja_Suit", "Shinobi_Sash"\).*AddStat\(SpConsumption, -30\)',
                        r'ComboItem\("ShinobiSashSet2", "Ninja_Suit_", "Shinobi_Sash"\).*AddStat\(SpConsumption, -30\)'],
    'EquipmentEffects.txt': [r'Item\("Staff_of_Destruction"\).*AddStat\(SpConsumption, Refine \* 2\)'],
}
audit = subprocess.check_output(['git', '-C', str(repo), 'grep', '-n', 'SpConsumption', PIN, '--', base + 'Script']).decode().splitlines()
if len(audit) != 6 or any(not any('Script/Items/' + file + ':' in line for file in expected) for line in audit):
    raise ValueError('Unsupported SP modifier declaration outside the bounded catalog')
for file, patterns in expected.items():
    text = read(base + 'Script/Items/' + file)
    lines = [line for line in text.splitlines() if 'SpConsumption' in line]
    if len(lines) != len(patterns) or any(not re.search(pattern, line) for pattern, line in zip(patterns, lines)):
        raise ValueError('SP modifier source changed: ' + file)
for code, modifier in [('Vitata_Card', 15), ('Golden_Thief_Bug_Card', 100), ('Pharaoh_Card', -30)]:
    items[str(codes[code])]['percent'] = modifier
items[str(codes['Staff_of_Destruction'])]['refinePercent'] = 2
combos = [{'items': [codes[suit], codes['Shinobi_Sash']], 'percent': -30}
          for suit in ('Ninja_Suit', 'Ninja_Suit_')]
# Provenance also covers the scalar formula, canonical equipment slots and skill geometry.
for path in ('EntityComponents/Player.cs', 'EntityComponents/Items/ItemEquipState.cs',
             'Simulation/Skills/SkillHandlerAttribute.cs', 'Simulation/Skills/SkillHandler.cs',
             'Simulation/Skills/SkillHandlers/Mage/TargetedSpellBase.cs',
             'Simulation/Skills/SkillHandlers/Mage/ThunderStormHandler.cs'):
    read('RoRebuildServer/RoRebuildServer/' + path)
result = {'pin': PIN, 'sources': sources, 'items': dict(sorted(items.items(), key=lambda pair: int(pair[0]))), 'combos': combos}
out.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'Built {len(items)} verified equipment/card/ammo identities and {len(combos)} SP combos')
