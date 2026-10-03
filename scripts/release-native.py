"""Validate release containers without launching the app; reject unsafe archive entries."""
import json
import hashlib
import os
import pathlib
import plistlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

LIMIT = 512 * 1024 * 1024
ASSET_LIMIT = 256 * 1024 * 1024
BUNDLE_LIMIT = 9 * ASSET_LIMIT
APP = 'Rayrag Companion.app'


def checked(ok, message):
    if not ok:
        raise ValueError(message)


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT)


def unpack_tar(archive, destination):
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        checked(0 < len(members) <= 10000 and sum(m.size for m in members) <= LIMIT, 'App archive exceeds bounds.')
        seen = set()
        directories = []
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            checked(not path.is_absolute() and '..' not in path.parts and path.parts and path.parts[0] == APP, 'Unsafe app archive path.')
            checked(member.isdir() or member.isfile(), 'App archive links/devices are not supported.')
            checked(member.mode & 0o7000 == 0, 'Special app archive permissions are forbidden.')
            checked(str(path) not in seen, 'Duplicate app archive path.')
            seen.add(str(path))
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                directories.append((target, member.mode))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as reader, target.open('xb') as writer:
                    shutil.copyfileobj(reader, writer)
                target.chmod(member.mode & 0o777)
        for target, mode in reversed(directories):
            target.chmod(mode & 0o777)


def app_manifest(app):
    """Compare both containers' app content, including permissions and link targets."""
    records = []

    def visit(path):
        info = path.lstat()
        name = path.relative_to(app).as_posix()
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISLNK(info.st_mode):
            records.append((name, 'link', mode, os.readlink(path)))
        elif stat.S_ISDIR(info.st_mode):
            records.append((name, 'directory', mode))
            for child in sorted(path.iterdir()):
                visit(child)
        elif stat.S_ISREG(info.st_mode):
            with path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            records.append((name, 'file', mode, info.st_size, digest))
        else:
            raise ValueError('Unsupported application file type.')

    visit(app)
    return records


def compare_apps(archive_app, dmg_app):
    checked(app_manifest(archive_app) == app_manifest(dmg_app),
            'DMG and updater archive contain different application bytes, paths or permissions.')


def verify_app(app, version):
    for directory in [app, app / 'Contents', app / 'Contents/MacOS']:
        mode = directory.lstat().st_mode
        checked(stat.S_ISDIR(mode) and mode & stat.S_IXUSR, 'App directories are not owner-searchable.')
    binary = app / 'Contents/MacOS/rayrag-companion'
    mode = binary.lstat().st_mode
    checked(stat.S_ISREG(mode) and mode & stat.S_IXUSR, 'App binary is not owner-executable.')
    with (app / 'Contents/Info.plist').open('rb') as source:
        info = plistlib.load(source)
    checked(info.get('CFBundleIdentifier') == 'com.rayrag.companion', 'Bundle identifier differs.')
    checked(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version, 'Bundle version differs.')
    checked(info.get('CFBundleExecutable') == 'rayrag-companion', 'Unexpected bundle executable.')
    checked(run('lipo', '-archs', str(app / 'Contents/MacOS/rayrag-companion')).decode().strip() == 'arm64', 'App is not ARM64-only.')
    run('codesign', '--verify', '--deep', '--strict', str(app))


def verify(folder, version):
    checked(sys.platform == 'darwin', 'Native release verification requires macOS.')
    base = f'Rayrag_Companion_{version}_aarch64'
    with tempfile.TemporaryDirectory(prefix='rayrag-native-release-') as tmp:
        destination = pathlib.Path(tmp)
        unpack_tar(folder / f'{base}.app.tar.gz', destination)
        verify_app(destination / APP, version)
        dmg = folder / f'{base}.dmg'
        run('hdiutil', 'verify', str(dmg))
        mount = destination / 'disk'
        mount.mkdir()
        attached = False
        try:
            run('hdiutil', 'attach', str(dmg), '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount))
            attached = True
            checked([p.name for p in mount.glob('*.app')] == [APP], 'DMG app contents differ.')
            verify_app(mount / APP, version)
            compare_apps(destination / APP, mount / APP)
        finally:
            if attached:
                run('hdiutil', 'detach', str(mount))


def extract_zip(archive, destination, names):
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        layouts = names if names and isinstance(names[0], list) else [names]
        checked(any(sorted(m.filename for m in members) == sorted(layout) for layout in layouts), 'Workflow artifact has unexpected or duplicate paths.')
        checked(sum(m.file_size for m in members) <= BUNDLE_LIMIT and all(0 < m.file_size <= ASSET_LIMIT for m in members), 'Workflow artifact exceeds bounds.')
        for member in members:
            checked(pathlib.PurePosixPath(member.filename).name == member.filename and not member.is_dir(), 'Invalid workflow artifact path.')
            checked(not stat.S_ISLNK(member.external_attr >> 16), 'Workflow artifact links are forbidden.')
            with source.open(member) as reader, (destination / member.filename).open('xb') as writer:
                shutil.copyfileobj(reader, writer)


if __name__ == '__main__':
    if sys.argv[1] == 'verify':
        verify(pathlib.Path(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == 'extract-zip':
        extract_zip(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), json.loads(sys.argv[4]))
    else:
        raise ValueError('Unknown release verification command.')
