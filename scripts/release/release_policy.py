"""Pure release metadata and archive-entry policies; performs no file access."""
from dataclasses import dataclass
from pathlib import PurePosixPath
import re
import stat
from zipfile import ZIP_STORED, ZIP_DEFLATED


def checked(condition, message):
    if not condition:
        raise ValueError(message)


def valid_asset_name(name):
    return (isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name)
            and name not in {'.', '..'} and PurePosixPath(name).name == name)


@dataclass(frozen=True, slots=True)
class PublicAsset:
    """One flat public artifact identity with a bounded byte count and digest."""
    name: str
    size: int
    sha256: str

    def __post_init__(self):
        checked(valid_asset_name(self.name), 'Invalid or duplicate public asset name.')
        checked(type(self.size) is int and 0 < self.size <= 256 * 1024 * 1024
                and isinstance(self.sha256, str) and re.fullmatch(r'[a-f0-9]{64}', self.sha256),
                'Invalid public asset size/hash.')

    def to_json(self):
        return {'name': self.name, 'size': self.size, 'sha256': self.sha256}


@dataclass(frozen=True, slots=True)
class ArchiveDigest:
    """An Actions ZIP SHA-256 marker, including its algorithm prefix."""
    value: str

    def __post_init__(self):
        checked(isinstance(self.value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', self.value),
                'Invalid ZIP digest.')


def public_asset_index(assets, expected_digest):
    checked(re.fullmatch(r'sha256:[a-f0-9]{64}', expected_digest), 'Invalid ZIP digest.')
    checked(isinstance(assets, list) and 0 < len(assets) <= 100, 'Invalid public asset list.')
    expected = {}
    for item in assets:
        checked(isinstance(item, dict) and set(item) == {'name', 'size', 'sha256'}, 'Invalid asset fields.')
        name = item['name']
        checked(valid_asset_name(name) and name not in expected, 'Invalid or duplicate public asset name.')
        checked(type(item['size']) is int and 0 < item['size'] <= 256 * 1024 * 1024
                and re.fullmatch(r'[a-f0-9]{64}', item['sha256']), 'Invalid public asset size/hash.')
        expected[name] = PublicAsset(name, item['size'], item['sha256'])
    total = sum(item.size for item in expected.values())
    checked(total <= 512 * 1024 * 1024, 'Public asset total exceeds its bound.')
    return expected, total


def validate_public_zip_entries(entries, expected):
    names = [entry.filename for entry in entries]
    checked(len(names) == len(set(names)) == len(expected) and set(names) == set(expected),
            'ZIP has duplicate, missing or unexpected paths.')
    for entry in entries:
        checked(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16)
                and not entry.flag_bits & 1
                and entry.compress_type in {ZIP_STORED, ZIP_DEFLATED},
                'ZIP directories, links, encryption or unsupported compression are forbidden.')


def validate_app_archive(members, app, limit):
    checked(0 < len(members) <= 10000 and sum(m.size for m in members) <= limit, 'App archive exceeds bounds.')
    seen = set()
    for member in members:
        path = PurePosixPath(member.name)
        checked(not path.is_absolute() and '..' not in path.parts and path.parts and path.parts[0] == app, 'Unsafe app archive path.')
        checked(member.isdir() or member.isfile(), 'App archive links/devices are not supported.')
        checked(member.mode & 0o7000 == 0, 'Special app archive permissions are forbidden.')
        checked(str(path) not in seen, 'Duplicate app archive path.')
        seen.add(str(path))


def validate_workflow_zip(members, names, asset_limit, bundle_limit):
    layouts = names if names and isinstance(names[0], list) else [names]
    checked(any(sorted(m.filename for m in members) == sorted(layout) for layout in layouts), 'Workflow artifact has unexpected or duplicate paths.')
    checked(sum(m.file_size for m in members) <= bundle_limit and all(0 < m.file_size <= asset_limit for m in members), 'Workflow artifact exceeds bounds.')
    for member in members:
        checked(PurePosixPath(member.filename).name == member.filename and not member.is_dir(), 'Invalid workflow artifact path.')
        checked(not stat.S_ISLNK(member.external_attr >> 16), 'Workflow artifact links are forbidden.')


def validate_bundle_metadata(info, version):
    checked(info.get('CFBundleIdentifier') == 'com.rayrag.companion', 'Bundle identifier differs.')
    checked(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version, 'Bundle version differs.')
    checked(info.get('CFBundleExecutable') == 'rayrag-companion', 'Unexpected bundle executable.')


def compare_app_manifests(left, right):
    checked(left == right, 'DMG and updater archive contain different application bytes, paths or permissions.')
