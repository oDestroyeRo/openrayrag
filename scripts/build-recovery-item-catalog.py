#!/usr/bin/env python3
"""Classify direct HP/SP recovery from pinned Rebuild scripts and client identities.

Usage: build-recovery-item-catalog.py SOURCE_REPO GAME_CATALOG_JSON OUTPUT_JSON
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
repo, client_path, output_path = map(Path, sys.argv[1:])
sources = {}


def blob(path):
    raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{path}'])
    sources[path] = {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{path}',
                     'sha256': hashlib.sha256(raw).hexdigest()}
    return raw.decode('utf-8-sig')


effects = blob('RoRebuildServer/GameConfig/ServerData/Script/Items/ItemEffects.txt')
usable = blob('RoRebuildServer/GameConfig/ServerData/Db/ItemsUsable.csv')
# This compiler defines RecoveryItem's HP-min/max, SP-min/max parameter order.
blob('RoRebuildServer/RoRebuildServer/ScriptSystem/ScriptTreeWalker.cs')
client = json.loads(client_path.read_bytes())
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
output_path.write_text(json.dumps(result, indent=2) + '\n')
print(f'Classified {len(hp_ids)} HP and {len(sp_ids)} SP recovery items')
