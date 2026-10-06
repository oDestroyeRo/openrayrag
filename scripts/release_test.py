import io
import importlib.util
import pathlib
import plistlib
import shutil
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

spec = importlib.util.spec_from_file_location('release_native', pathlib.Path(__file__).with_name('release-native.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ArchiveSafety(unittest.TestCase):
    def archive(self, folder, name, kind=tarfile.REGTYPE):
        path = folder / 'app.tar.gz'
        with tarfile.open(path, 'w:gz') as target:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.mode = 0o755
            entry.linkname = '/tmp/escape'
            entry.size = 1 if kind == tarfile.REGTYPE else 0
            target.addfile(entry, io.BytesIO(b'a') if entry.size else None)
        return path

    def test_regular_app_extraction_preserves_executable_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = self.archive(root, 'Rayrag Companion.app/Contents/MacOS/rayrag-companion')
            release.unpack_tar(archive, root / 'out')
            self.assertEqual((root / 'out/Rayrag Companion.app/Contents/MacOS/rayrag-companion').read_bytes(), b'a')
            self.assertEqual(stat.S_IMODE((root / 'out/Rayrag Companion.app/Contents/MacOS/rayrag-companion').stat().st_mode), 0o755)

    def test_rejects_traversal_links_devices_and_foreign_roots(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE), ('Other.app/file', tarfile.REGTYPE),
                           ('Rayrag Companion.app/link', tarfile.SYMTYPE), ('Rayrag Companion.app/link', tarfile.LNKTYPE),
                           ('Rayrag Companion.app/device', tarfile.CHRTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                with self.assertRaises(ValueError):
                    release.unpack_tar(self.archive(root, name, kind), root / 'out')

    def test_workflow_zip_requires_exact_flat_asset_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / 'artifact.zip'
            with zipfile.ZipFile(archive, 'w') as target:
                target.writestr('../payload', b'a')
            with self.assertRaises(ValueError):
                release.extract_zip(archive, root, ['payload'])
            with zipfile.ZipFile(archive, 'w') as target:
                target.writestr('payload', b'a')
            release.extract_zip(archive, root, ['payload'])
            self.assertEqual((root / 'payload').read_bytes(), b'a')

    def test_workflow_zip_supports_exact_legacy_and_multiplatform_layouts_only(self):
        layouts = [['mac', 'manifest'], ['mac', 'windows', 'linux', 'manifest']]
        for names in [layouts[0], layouts[1], ['mac', 'windows', 'manifest'], ['mac', 'mac', 'manifest']]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                archive = root / 'artifact.zip'
                with zipfile.ZipFile(archive, 'w') as target:
                    for name in names:
                        target.writestr(name, b'payload')
                if names in layouts:
                    release.extract_zip(archive, root, layouts)
                    self.assertEqual(sorted(p.name for p in root.iterdir() if p.name != 'artifact.zip'), sorted(names))
                else:
                    with self.assertRaisesRegex(ValueError, 'unexpected or duplicate'):
                        release.extract_zip(archive, root, layouts)

    def test_workflow_zip_rejects_oversized_or_empty_asset_before_extracting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / 'artifact.zip'
            with zipfile.ZipFile(archive, 'w') as target:
                target.writestr('payload', b'12345')
            with mock.patch.object(release, 'ASSET_LIMIT', 4), self.assertRaisesRegex(ValueError, 'bounds'):
                release.extract_zip(archive, root, ['payload'])
            self.assertFalse((root / 'payload').exists())
            with zipfile.ZipFile(archive, 'w') as target:
                target.writestr('payload', b'')
            with self.assertRaisesRegex(ValueError, 'bounds'):
                release.extract_zip(archive, root, ['payload'])

    def test_app_manifest_compares_bytes_modes_paths_and_link_targets(self):
        for mutation in ['bytes', 'mode', 'path', 'link']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                left, right = root / 'archive', root / 'dmg'
                left.mkdir()
                (left / 'binary').write_bytes(b'arm64 content')
                (left / 'binary').chmod(0o755)
                (left / 'link').symlink_to('binary')
                shutil.copytree(left, right, symlinks=True)
                release.compare_apps(left, right)
                if mutation == 'bytes':
                    (right / 'binary').write_bytes(b'different arm64 content')
                elif mutation == 'mode':
                    (right / 'binary').chmod(0o644)
                elif mutation == 'path':
                    (right / 'binary').rename(right / 'other')
                else:
                    (right / 'link').unlink()
                    (right / 'link').symlink_to('other')
                with self.assertRaisesRegex(ValueError, 'different application'):
                    release.compare_apps(left, right)

    def test_native_verification_rejects_unlaunchable_signed_bundle_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / release.APP
            binary = app / 'Contents/MacOS/rayrag-companion'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'synthetic signed ARM64')
            with (app / 'Contents/Info.plist').open('wb') as output:
                plistlib.dump({'CFBundleIdentifier':'com.rayrag.companion', 'CFBundleShortVersionString':'0.2.9', 'CFBundleVersion':'0.2.9', 'CFBundleExecutable':'rayrag-companion'}, output)
            with mock.patch.object(release, 'run', return_value=b'arm64') as native:
                binary.chmod(0o644)
                with self.assertRaisesRegex(ValueError,'owner-executable'):
                    release.verify_app(app, '0.2.9')
                native.assert_not_called()
                binary.chmod(0o755)
                release.verify_app(app, '0.2.9')
                binary.parent.chmod(0o644)
                try:
                    with self.assertRaisesRegex(ValueError,'owner-searchable'):
                        release.verify_app(app, '0.2.9')
                finally:
                    binary.parent.chmod(0o755)

    def test_native_verification_rejects_mixed_dmg_even_when_each_app_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = self.archive(root, 'Rayrag Companion.app/Contents/MacOS/rayrag-companion')
            archive.rename(root / 'Rayrag_Companion_0.2.2_aarch64.app.tar.gz')
            calls = []

            def native_command(*args):
                calls.append(args)
                if args[:2] == ('hdiutil', 'attach'):
                    mount = pathlib.Path(args[-1])
                    shutil.copytree(mount.parent / release.APP, mount / release.APP)
                    (mount / release.APP / 'Contents/MacOS/rayrag-companion').write_bytes(b'other signed app')
                return b''

            with mock.patch.object(release.sys, 'platform', 'darwin'), mock.patch.object(release, 'run', side_effect=native_command), mock.patch.object(release, 'verify_app') as app_check:
                with self.assertRaisesRegex(ValueError, 'different application'):
                    release.verify(root, '0.2.2')
                self.assertEqual(app_check.call_count, 2)
                self.assertEqual(calls[-1][:2], ('hdiutil', 'detach'))


if __name__ == '__main__':
    unittest.main()
