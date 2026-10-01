#!/usr/bin/env python3
"""Extract only walk flags from a downloaded public RayRag Unity scene bundle.

Requires UnityPy==1.25.3. Never executes bundle code.
Usage: python rayrag-extract-navigation.py BUNDLE MAP OUTPUT_JSON SOURCE_URL
"""
import base64
import hashlib
import json
import sys
from collections import Counter

import UnityPy
from UnityPy.helpers.TypeTreeNode import TypeTreeNode

# SerializedFile v23 adds content hash, size, CRC, and format version before
# inline TypeTree data. UnityPy 1.25.3 still expects the v22 inline prefix.
original_parse_blob = TypeTreeNode.parse_blob

@classmethod
def parse_blob(cls, reader, version):
    if version >= 23:
        if version != 23:
            raise ValueError(f"Unverified serialized file version: {version}")
        reader.read_bytes(16)
        size = reader.read_u_int()
        reader.read_u_int()  # CRC
        stamped_version = reader.read_u_int()
        if size == 0 or stamped_version != 23:
            raise ValueError("Expected inline v23 TypeTree")
    return original_parse_blob(reader, version)

TypeTreeNode.parse_blob = parse_blob

bundle_path, map_code, output_path, source_url = sys.argv[1:]
environment = UnityPy.load(bundle_path)
matches = []
for obj in environment.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    tree = obj.read_typetree()
    if tree.get("m_Name") == f"{map_code}_walkdata":
        matches.append(tree)
if len(matches) != 1:
    raise ValueError(f"Expected one map walk asset, found {len(matches)}")
tree = matches[0]
width, height, cells = tree["Width"], tree["Height"], tree["Cells"]
if not 0 < width <= 32767 or not 0 < height <= 32767 or len(cells) != width * height:
    raise ValueError("Invalid map dimensions or cell count")
bits = bytearray((len(cells) + 7) // 8)
for index, cell in enumerate(cells):
    # Walkable=1; water=2 is an additional flag and remains walkable.
    if cell["Type"] & 1:
        bits[index // 8] |= 1 << (index % 8)
with open(bundle_path, "rb") as handle:
    source_hash = hashlib.file_digest(handle, "sha256").hexdigest()
output = {
    "map": map_code,
    "width": width,
    "height": height,
    "walkableBitsBase64": base64.b64encode(bits).decode("ascii"),
    "bitOrder": "lsb-first",
    "index": "x+y*width",
    "sourceUrl": source_url,
    "sourceSha256": source_hash,
}
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(output, handle)
print(json.dumps({"map": map_code, "width": width, "height": height,
                  "walkable": sum(bool(c["Type"] & 1) for c in cells),
                  "cellTypes": dict(Counter(c["Type"] for c in cells)),
                  "sourceSha256": source_hash, "output": output_path}))
