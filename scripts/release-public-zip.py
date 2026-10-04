"""Stream-check the original Actions ZIP against anonymous public asset records.

No extraction, application launch, credentials or network access is performed.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile


def checked(condition, message):
    if not condition:
        raise ValueError(message)


def verify_archive(archive_path, assets, expected_digest):
    checked(re.fullmatch(r'sha256:[a-f0-9]{64}', expected_digest), 'Invalid ZIP digest.')
    checked(isinstance(assets, list) and 0 < len(assets) <= 100, 'Invalid public asset list.')
    expected = {}
    for item in assets:
        checked(isinstance(item, dict) and set(item) == {'name', 'size', 'sha256'}, 'Invalid asset fields.')
        name = item['name']
        checked(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name)
                and name not in {'.', '..'} and PurePosixPath(name).name == name
                and name not in expected, 'Invalid or duplicate public asset name.')
        checked(type(item['size']) is int and 0 < item['size'] <= 256 * 1024 * 1024
                and re.fullmatch(r'[a-f0-9]{64}', item['sha256']), 'Invalid public asset size/hash.')
        expected[name] = item
    total = sum(item['size'] for item in assets)
    checked(total <= 512 * 1024 * 1024, 'Public asset total exceeds its bound.')
    # Retain one opened descriptor for hashing and ZIP reads, avoiding a path swap.
    with Path(archive_path).open('rb') as raw:
        raw.seek(0, 2)
        zip_bytes = raw.tell()
        checked(0 < zip_bytes <= total + 1024 * 1024, 'ZIP exceeds its byte bound.')
        raw.seek(0)
        actual = 'sha256:' + hashlib.file_digest(raw, 'sha256').hexdigest()
        checked(actual == expected_digest, 'Actions ZIP digest differs from release marker.')
        raw.seek(0)
        with zipfile.ZipFile(raw) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            checked(len(names) == len(set(names)) == len(expected) and set(names) == set(expected),
                    'ZIP has duplicate, missing or unexpected paths.')
            for entry in entries:
                checked(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16)
                        and not entry.flag_bits & 1
                        and entry.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                        'ZIP directories, links, encryption or unsupported compression are forbidden.')
                item = expected[entry.filename]
                checked(entry.file_size == item['size'], 'ZIP entry size differs from public asset.')
                digest = hashlib.sha256()
                size = 0
                with archive.open(entry) as content:
                    while chunk := content.read(1024 * 1024):
                        size += len(chunk)
                        checked(size <= item['size'], 'ZIP entry exceeds its public byte bound.')
                        digest.update(chunk)
                checked(size == item['size'] and digest.hexdigest() == item['sha256'],
                        'ZIP entry differs from anonymous public bytes.')
    return {'zipBytes': zip_bytes, 'zipDigest': actual, 'publicAssetCount': len(expected),
            'proof': 'Original Actions ZIP digest and every entry hash/size equal anonymous public assets'}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: release-public-zip.py <artifact.zip> <public-assets.json> <sha256:digest>')
    try:
        result = verify_archive(sys.argv[1], json.loads(Path(sys.argv[2]).read_text()), sys.argv[3])
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from None
