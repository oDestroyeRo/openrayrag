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

from release_policy import (checked, compare_app_manifests, validate_app_archive,
                            validate_bundle_metadata, validate_workflow_zip)

LIMIT = 512 * 1024 * 1024
ASSET_LIMIT = 256 * 1024 * 1024
BUNDLE_LIMIT = 9 * ASSET_LIMIT
APP = 'Rayrag Companion.app'


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT)


def unpack_tar(archive, destination):
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        validate_app_archive(members, APP, LIMIT)
        directories = []
        for member in members:
            path = pathlib.PurePosixPath(member.name)
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
    compare_app_manifests(app_manifest(archive_app), app_manifest(dmg_app))


def verify_app(app, version):
    for directory in [app, app / 'Contents', app / 'Contents/MacOS']:
        mode = directory.lstat().st_mode
        checked(stat.S_ISDIR(mode) and mode & stat.S_IXUSR, 'App directories are not owner-searchable.')
    binary = app / 'Contents/MacOS/rayrag-companion'
    mode = binary.lstat().st_mode
    checked(stat.S_ISREG(mode) and mode & stat.S_IXUSR, 'App binary is not owner-executable.')
    with (app / 'Contents/Info.plist').open('rb') as source:
        info = plistlib.load(source)
    validate_bundle_metadata(info, version)
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
        validate_workflow_zip(members, names, ASSET_LIMIT, BUNDLE_LIMIT)
        for member in members:
            with source.open(member) as reader, (destination / member.filename).open('xb') as writer:
                shutil.copyfileobj(reader, writer)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[0] == 'verify':
        verify(pathlib.Path(argv[1]), argv[2])
    elif argv[0] == 'extract-zip':
        extract_zip(pathlib.Path(argv[1]), pathlib.Path(argv[2]), json.loads(argv[3]))
    else:
        raise ValueError('Unknown release verification command.')


if __name__ == '__main__':
    main()
