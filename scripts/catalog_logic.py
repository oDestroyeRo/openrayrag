"""Deterministic decoding, provenance and serialization shared by catalog tools."""
import csv
import hashlib
import io
import json


def csv_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def source_record(raw, pin, path):
    return {'url': f'https://github.com/Doddler/RagnarokRebuildTcp/blob/{pin}/{path}',
            'sha256': hashlib.sha256(raw).hexdigest()}


def catalog_json(catalog, *, ensure_ascii=True, indent=None, compact=True):
    separators = (',', ':') if compact else None
    return json.dumps(catalog, ensure_ascii=ensure_ascii, indent=indent, separators=separators) + '\n'
