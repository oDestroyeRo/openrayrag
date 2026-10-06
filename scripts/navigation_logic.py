"""Deterministic scene policy and collision-grid transformations."""
import base64
from collections import Counter
from dataclasses import dataclass
import re


@dataclass(frozen=True, slots=True)
class SceneMapCode:
    """A lowercase public scene key that confines both its URL and cache name."""
    value: str

    def __post_init__(self):
        if not isinstance(self.value, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', self.value):
            raise ValueError('Invalid map code')

    @property
    def source_url(self):
        return ('https://websea01.rayrag.com/StreamingAssets/aa/WebGL/'
                f'scenes_scenes_assets_scenes_maps_{self.value}.unity.bundle')

    @property
    def bundle_filename(self):
        return f'rayrag-{self.value}-scene.bundle'


@dataclass(frozen=True, slots=True)
class GridDimensions:
    """Reviewed collision dimensions, bounded by the catalog's cell policy."""
    width: int
    height: int

    def __post_init__(self):
        if not all(type(value) is int and 1 <= value <= 512 for value in (self.width, self.height)):
            raise ValueError('Invalid grid dimensions')

    @classmethod
    def from_export(cls, grid, map_code):
        width, height = grid['width'], grid['height']
        if not all(type(value) is int and 1 <= value <= 512 for value in (width, height)):
            raise ValueError(f'{map_code}: unsupported dimensions')
        return cls(width, height)

    @property
    def cell_count(self):
        return self.width * self.height

    @property
    def bitset_bytes(self):
        return (self.cell_count + 7) // 8

    def contains(self, x, y):
        return 0 <= x < self.width and 0 <= y < self.height


@dataclass(frozen=True, slots=True)
class MapPosition:
    """An integer cell whose owning dimensions establish its index and bounds."""
    dimensions: GridDimensions
    x: int
    y: int

    def __post_init__(self):
        if (not isinstance(self.dimensions, GridDimensions)
                or type(self.x) is not int or type(self.y) is not int
                or not self.dimensions.contains(self.x, self.y)):
            raise ValueError('Invalid map position')

    @property
    def index(self):
        return self.x + self.y * self.dimensions.width

    def to_json(self):
        return {'x': self.x, 'y': self.y}


@dataclass(frozen=True, slots=True)
class PortalArea:
    """A reviewed trigger center and its bounded, inclusive half extents."""
    center: MapPosition
    half_width: int
    half_height: int

    def __post_init__(self):
        if (not isinstance(self.center, MapPosition)
                or type(self.half_width) is not int or type(self.half_height) is not int
                or not 0 <= self.half_width <= self.center.dimensions.width
                or not 0 <= self.half_height <= self.center.dimensions.height):
            raise ValueError('Invalid portal extent')

    @classmethod
    def from_export(cls, portal, dimensions, map_code):
        if any(type(portal[key]) is not int for key in ('x', 'y', 'halfWidth', 'halfHeight')):
            raise ValueError('Invalid portal values')
        if not dimensions.contains(portal['x'], portal['y']):
            raise ValueError(f'{map_code}: portal center outside map')
        if not (0 <= portal['halfWidth'] <= dimensions.width
                and 0 <= portal['halfHeight'] <= dimensions.height):
            raise ValueError(f'{map_code}: invalid portal extent')
        return cls(MapPosition(dimensions, portal['x'], portal['y']), portal['halfWidth'], portal['halfHeight'])

    def to_json(self):
        return {**self.center.to_json(), 'halfWidth': self.half_width, 'halfHeight': self.half_height}

    def cells(self):
        return ((x, y) for y in range(self.center.y - self.half_height, self.center.y + self.half_height + 1)
                for x in range(self.center.x - self.half_width, self.center.x + self.half_width + 1))


def validate_inventory(sources, portals):
    if len({row['map'] for row in sources}) != len(sources):
        raise ValueError('Duplicate source map')
    if set(portals) != {row['map'] for row in sources}:
        raise ValueError('Every source map must have an explicit portal list')


def scene_url(source):
    code = source['map']
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', code):
        raise ValueError('Invalid map code')
    expected = SceneMapCode(code).source_url
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
    dimensions = GridDimensions.from_export(grid, map_code)
    if (dimensions.width, dimensions.height) != (source['width'], source['height']):
        raise ValueError(f'{map_code}: dimensions differ from the reviewed source')
    bits = base64.b64decode(grid['walkableBitsBase64'], validate=True)
    sight = base64.b64decode(grid['snipableOnlyBitsBase64'], validate=True)
    if len(bits) != dimensions.bitset_bytes or len(sight) != len(bits):
        raise ValueError('Invalid bitset size')
    if any(walk & snipable for walk, snipable in zip(bits, sight)):
        raise ValueError('Snipable-only cells overlap walking cells')
    if dimensions.cell_count % 8 and (bits[-1] | sight[-1]) >> (dimensions.cell_count % 8):
        raise ValueError('Nonzero trailing bits')
    walkable = sum(byte.bit_count() for byte in bits)
    blocked = dimensions.cell_count - walkable
    if not walkable or (walkable, blocked) != (source['walkableCount'], source['blockedCount']):
        raise ValueError(f'{map_code}: cell counts differ from the reviewed source')
    reviewed_portals = []
    for portal in portals:
        area = PortalArea.from_export(portal, dimensions, map_code)
        # Preserve extension fields and insertion order at the wire boundary.
        reviewed_portals.append({**portal, **area.to_json()})
    return {
        **grid, 'walkableCount': walkable, 'blockedCount': blocked, 'portals': reviewed_portals,
    }
