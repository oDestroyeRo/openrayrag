#!/usr/bin/env python3
"""Generate CanMemo permissions from exact pinned server flags, never checkout HEAD."""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
SOURCE = 'RoRebuildServer/GameConfig/ServerData/Db/Maps.csv'
FLAGS = {'none', 'canmemo', 'noteleport', 'noteleportevenmonsters', 'nominimap', 'nologout', 'nowater', 'allwater'}
repo, output = map(Path, sys.argv[1:])
raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{SOURCE}'])
rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
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
data = {'sourcePin': PIN, 'source': {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{SOURCE}',
    'sha256': hashlib.sha256(raw).hexdigest()}, 'items': sorted(items, key=lambda item: item['map'])}
output.write_text(json.dumps(data, separators=(',', ':')) + '\n')
print(json.dumps({'maps': len(items), 'canMemo': sum(item['canMemo'] for item in items)}))
