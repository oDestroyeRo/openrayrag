#!/usr/bin/env python3
"""Generate player emote IDs from the protocol pin, never checkout HEAD."""
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
SOURCE = 'RoRebuildServer/GameConfig/ServerData/Db/Emotes.csv'
repo, output = map(Path, sys.argv[1:])
raw = subprocess.check_output(['git', '-C', str(repo), 'show', f'{PIN}:{SOURCE}'])
rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
items = [{'id': int(row['Id']), 'label': row['Commands']} for row in rows]
if len(items) != 59 or len({item['id'] for item in items}) != 59:
    raise ValueError('Unexpected emote whitelist')
if not all(0 <= item['id'] <= 100 and item['label'] for item in items):
    raise ValueError('Invalid emote metadata')
if [item['id'] for item in items if 58 <= item['id'] <= 63] != [58]:
    raise ValueError('Only canonical dice is exposed')
result = {'sourcePin': PIN, 'source': {
    'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{PIN}/{SOURCE}',
    'sha256': hashlib.sha256(raw).hexdigest(),
}, 'items': sorted(items, key=lambda item: item['id'])}
output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
print(json.dumps({'emotes': len(items)}))
