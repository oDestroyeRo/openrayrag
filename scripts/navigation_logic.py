"""Deterministic scene policy and collision-grid transformations."""
import base64
from collections import Counter
import re


def validate_inventory(sources, portals):
    if len({row['map'] for row in sources}) != len(sources):
        raise ValueError('Duplicate source map')
    if set(portals) != {row['map'] for row in sources}:
        raise ValueError('Every source map must have an explicit portal list')


def scene_url(source):
    code = source['map']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', code):
        raise ValueError('Invalid map code')
    expected = ('https://websea01.rayrag.com/StreamingAssets/aa/WebGL/'
                f'scenes_scenes_assets_scenes_maps_{code}.unity.bundle')
    if source['sourceUrl'] != expected:
        raise ValueError('Unexpected scene URL')
    return expected


def reviewed_bundle_matches(source, size, digest):
    return size == source['bundleBytes'] and digest == source['sourceSha256']


def validate_type_tree_header(version, size, stamped_version):
    if version != 23:
        raise ValueError(f"Unverified serialized file version: {version}")
    if size == 0 or stamped_version != 23:
        raise ValueError("Expected inline v23 TypeTree")


def build_grid(tree, map_code, source_url, source_hash):
    width, height, cells = tree["Width"], tree["Height"], tree["Cells"]
    if not 0 < width <= 32767 or not 0 < height <= 32767 or len(cells) != width * height:
        raise ValueError("Invalid map dimensions or cell count")
    bits = bytearray((len(cells) + 7) // 8)
    snipable = bytearray(len(bits))
    for index, cell in enumerate(cells):
        # Walkable=1; water=2 is an additional flag and remains walkable.
        if cell["Type"] & 1:
            bits[index // 8] |= 1 << (index % 8)
        elif cell["Type"] & 4:
            # LOS is (Type & 5) != 0; retain only the additional nonwalking cells.
            snipable[index // 8] |= 1 << (index % 8)
    return {
        "map": map_code,
        "width": width,
        "height": height,
        "walkableBitsBase64": base64.b64encode(bits).decode("ascii"),
        "snipableOnlyBitsBase64": base64.b64encode(snipable).decode("ascii"),
        "bitOrder": "lsb-first",
        "index": "x+y*width",
        "sourceUrl": source_url,
        "sourceSha256": source_hash,
    }


def grid_summary(tree, grid, output_path):
    cells = tree['Cells']
    return {'map': grid['map'], 'width': grid['width'], 'height': grid['height'],
            'walkable': sum(bool(c['Type'] & 1) for c in cells),
            'snipableOnly': sum(bool(c['Type'] & 4) and not bool(c['Type'] & 1) for c in cells),
            'cellTypes': dict(Counter(c['Type'] for c in cells)),
            'sourceSha256': grid['sourceSha256'], 'output': output_path}


def validate_grid(source, grid, portals):
    map_code = source['map']
    width, height = grid['width'], grid['height']
    if not all(type(v) is int and 1 <= v <= 512 for v in (width, height)):
        raise ValueError(f'{map_code}: unsupported dimensions')
    if (width, height) != (source['width'], source['height']):
        raise ValueError(f'{map_code}: dimensions differ from the reviewed source')
    bits = base64.b64decode(grid['walkableBitsBase64'], validate=True)
    sight = base64.b64decode(grid['snipableOnlyBitsBase64'], validate=True)
    if len(bits) != (width * height + 7) // 8 or len(sight) != len(bits):
        raise ValueError('Invalid bitset size')
    if any(walk & snipable for walk, snipable in zip(bits, sight)):
        raise ValueError('Snipable-only cells overlap walking cells')
    if width * height % 8 and (bits[-1] | sight[-1]) >> (width * height % 8):
        raise ValueError('Nonzero trailing bits')
    walkable = sum(byte.bit_count() for byte in bits)
    blocked = width * height - walkable
    if not walkable or (walkable, blocked) != (source['walkableCount'], source['blockedCount']):
        raise ValueError(f'{map_code}: cell counts differ from the reviewed source')
    for portal in portals:
        if any(type(portal[k]) is not int for k in ('x', 'y', 'halfWidth', 'halfHeight')):
            raise ValueError('Invalid portal values')
        if not (0 <= portal['x'] < width and 0 <= portal['y'] < height):
            raise ValueError(f'{map_code}: portal center outside map')
        if not (0 <= portal['halfWidth'] <= width and 0 <= portal['halfHeight'] <= height):
            raise ValueError(f'{map_code}: invalid portal extent')
    return {
        **grid, 'walkableCount': walkable, 'blockedCount': blocked, 'portals': portals,
    }
