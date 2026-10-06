#!/usr/bin/env python3
"""Extract walking and projectile visibility from a public RayRag scene bundle.

Requires UnityPy==1.25.3. Never executes bundle code.
Usage: python scripts/catalogs/extract-navigation.py BUNDLE MAP OUTPUT_JSON SOURCE_URL
"""
import hashlib
import json
from pathlib import Path
import sys

from navigation_logic import build_grid, grid_summary, validate_type_tree_header


def load_walk_tree(bundle_path, map_code):
    """Load the asset with a scoped UnityPy v23 compatibility adapter."""
    import UnityPy
    from UnityPy.helpers.TypeTreeNode import TypeTreeNode

    # SerializedFile v23 adds hash, size, CRC and version before inline data.
    original_descriptor = TypeTreeNode.__dict__['parse_blob']
    original_parse_blob = TypeTreeNode.parse_blob

    @classmethod
    def parse_blob(cls, reader, version):
        if version >= 23:
            if version != 23:
                validate_type_tree_header(version, None, None)
            reader.read_bytes(16)
            size = reader.read_u_int()
            reader.read_u_int()  # CRC
            stamped_version = reader.read_u_int()
            validate_type_tree_header(version, size, stamped_version)
        return original_parse_blob(reader, version)

    TypeTreeNode.parse_blob = parse_blob
    try:
        environment = UnityPy.load(str(bundle_path))
        matches = []
        for obj in environment.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            tree = obj.read_typetree()
            if tree.get("m_Name") == f"{map_code}_walkdata":
                matches.append(tree)
        if len(matches) != 1:
            raise ValueError(f"Expected one map walk asset, found {len(matches)}")
        return matches[0]
    finally:
        TypeTreeNode.parse_blob = original_descriptor


def main(argv=None):
    bundle_path, map_code, output_path, source_url = sys.argv[1:] if argv is None else argv
    tree = load_walk_tree(bundle_path, map_code)
    with Path(bundle_path).open('rb') as handle:
        source_hash = hashlib.file_digest(handle, 'sha256').hexdigest()
    output = build_grid(tree, map_code, source_url, source_hash)
    with Path(output_path).open('w', encoding='utf-8') as handle:
        json.dump(output, handle)
    print(json.dumps(grid_summary(tree, output, output_path)))


if __name__ == '__main__':
    main()
