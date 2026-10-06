"""Stream-check the original Actions ZIP against anonymous public asset records.

No extraction, application launch, credentials or network access is performed.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

from release_policy import ArchiveDigest, checked, public_asset_index, validate_public_zip_entries


def verify_archive(archive_path, assets, expected_digest):
    expected, total = public_asset_index(assets, expected_digest)
    expected_digest = ArchiveDigest(expected_digest)
    # Retain one opened descriptor for hashing and ZIP reads, avoiding a path swap.
    with Path(archive_path).open('rb') as raw:
        raw.seek(0, 2)
        zip_bytes = raw.tell()
        checked(0 < zip_bytes <= total + 1024 * 1024, 'ZIP exceeds its byte bound.')
        raw.seek(0)
        actual = ArchiveDigest('sha256:' + hashlib.file_digest(raw, 'sha256').hexdigest())
        checked(actual == expected_digest, 'Actions ZIP digest differs from release marker.')
        raw.seek(0)
        with zipfile.ZipFile(raw) as archive:
            entries = archive.infolist()
            validate_public_zip_entries(entries, expected)
            for entry in entries:
                item = expected[entry.filename]
                checked(entry.file_size == item.size, 'ZIP entry size differs from public asset.')
                digest = hashlib.sha256()
                size = 0
                with archive.open(entry) as content:
                    while chunk := content.read(1024 * 1024):
                        size += len(chunk)
                        checked(size <= item.size, 'ZIP entry exceeds its public byte bound.')
                        digest.update(chunk)
                checked(size == item.size and digest.hexdigest() == item.sha256,
                        'ZIP entry differs from anonymous public bytes.')
    return {'zipBytes': zip_bytes, 'zipDigest': actual.value, 'publicAssetCount': len(expected),
            'proof': 'Original Actions ZIP digest and every entry hash/size equal anonymous public assets'}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 3:
        raise SystemExit('Usage: release-public-zip.py <artifact.zip> <public-assets.json> <sha256:digest>')
    try:
        result = verify_archive(argv[0], json.loads(Path(argv[1]).read_text()), argv[2])
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
