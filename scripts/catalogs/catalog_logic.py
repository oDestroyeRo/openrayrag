"""Deterministic decoding, provenance and serialization shared by catalog tools."""
import csv
from dataclasses import dataclass
import hashlib
import io
import json


@dataclass(frozen=True, slots=True, kw_only=True)
class RecoveryResources:
    """Named independent HP/SP effects retained after reviewing a source body."""
    hp: bool
    sp: bool

    def __post_init__(self):
        if type(self.hp) is not bool or type(self.sp) is not bool:
            raise ValueError('Invalid recovery resources')


@dataclass(frozen=True, slots=True, kw_only=True)
class RefineRule:
    """A verified rank and ten sequential starting-refine success thresholds."""
    rank: int
    thresholds: tuple[int, ...]

    def __post_init__(self):
        if type(self.rank) is not int or not 0 <= self.rank <= 4:
            raise ValueError('Invalid refine rank')
        if (type(self.thresholds) is not tuple or len(self.thresholds) != 10
                or any(type(value) is not int or not 0 <= value <= 100 for value in self.thresholds)):
            raise ValueError('Invalid sequential refine thresholds')

    @classmethod
    def from_sequential_rows(cls, rank, rows):
        if type(rank) is not int or not 0 <= rank <= 4:
            raise ValueError('Invalid refine rank')
        column = rank - 1 if rank else 4
        return cls(rank=rank, thresholds=tuple(row[column] for row in rows[:10]))

    @property
    def materials(self):
        return {0: (985, 2000), 1: (1010, 200), 2: (1011, 1000), 3: (984, 5000), 4: (984, 10000)}[self.rank]

    def to_json(self):
        ore, cost = self.materials
        return {'rank': self.rank, 'oreItemId': ore, 'zenyCost': cost, 'thresholds': list(self.thresholds)}


def csv_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def source_record(raw, pin, path):
    return {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{pin}/{path}',
            'sha256': hashlib.sha256(raw).hexdigest()}


def catalog_json(catalog, *, ensure_ascii=True, indent=None, compact=True):
    separators = (',', ':') if compact else None
    return json.dumps(catalog, ensure_ascii=ensure_ascii, indent=indent, separators=separators) + '\n'
