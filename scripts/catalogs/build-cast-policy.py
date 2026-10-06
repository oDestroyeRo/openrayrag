#!/usr/bin/env python3
"""Audit pinned public skill/SP contracts and build bounded metadata, without executing scripts.
Usage: python3 scripts/catalogs/build-cast-policy.py PUBLIC_GIT_DIRECTORY [OUTPUT]
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys

from catalog_effects import load_pinned_blobs, write_catalog
from catalog_logic import catalog_json

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
BASE = 'RoRebuildServer/GameConfig/ServerData/'
SOURCE_PATHS = (
    'RoRebuildServer/GameConfig/ServerData/Db/ItemsWeapons.csv',
    'RoRebuildServer/GameConfig/ServerData/Db/ItemsEquipment.csv',
    'RoRebuildServer/GameConfig/ServerData/Db/ItemsCards.csv',
    'RoRebuildServer/GameConfig/ServerData/Db/ItemsAmmo.csv',
    'RoRebuildServer/GameConfig/ServerData/Script/Items/CardEffects.txt',
    'RoRebuildServer/GameConfig/ServerData/Script/Items/ComboEffects.txt',
    'RoRebuildServer/GameConfig/ServerData/Script/Items/EquipmentEffects.txt',
    'RoRebuildServer/RoRebuildServer/EntityComponents/Player.cs',
    'RoRebuildServer/RoRebuildServer/EntityComponents/Items/ItemEquipState.cs',
    'RoRebuildServer/RoRebuildServer/Simulation/Skills/SkillHandlerAttribute.cs',
    'RoRebuildServer/RoRebuildServer/Simulation/Skills/SkillHandler.cs',
    'RoRebuildServer/RoRebuildServer/Simulation/Skills/SkillHandlers/Mage/TargetedSpellBase.cs',
    'RoRebuildServer/RoRebuildServer/Simulation/Skills/SkillHandlers/Mage/ThunderStormHandler.cs',
)


def build_catalog(blobs, published, audit):
    sources = {}

    def read(path):
        raw = blobs[path]
        sources[path] = hashlib.sha256(raw).hexdigest()
        return raw.decode('utf-8-sig')

    items = {}
    codes = {}
    for file in ('ItemsWeapons', 'ItemsEquipment', 'ItemsCards', 'ItemsAmmo'):
        for row in csv.reader(io.StringIO(read(BASE + f'Db/{file}.csv'))):
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
    if len(audit) != 6 or any(not any('Script/Items/' + file + ':' in line for file in expected) for line in audit):
        raise ValueError('Unsupported SP modifier declaration outside the bounded catalog')
    for file, patterns in expected.items():
        text = read(BASE + 'Script/Items/' + file)
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
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    root = Path(__file__).resolve().parents[1]
    repo = Path(argv[0])
    out = Path(argv[1]) if len(argv) > 1 else root / 'src/data/cast-policy.json'
    published = json.loads((root / 'src/data/game-catalog.json').read_text())['items']
    blobs = load_pinned_blobs(repo, PIN, SOURCE_PATHS)
    audit = subprocess.check_output(['git', '-C', str(repo), 'grep', '-n', 'SpConsumption', PIN, '--', BASE + 'Script']).decode().splitlines()
    result = build_catalog(blobs, published, audit)
    write_catalog(out, catalog_json(result, ensure_ascii=False))
    print(f"Built {len(result['items'])} verified equipment/card/ammo identities and {len(result['combos'])} SP combos")


if __name__ == '__main__':
    main()
