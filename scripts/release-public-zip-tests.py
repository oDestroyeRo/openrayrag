import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('public_zip', Path(__file__).with_name('release-public-zip.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rayrag-zip-proof-test-')
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / 'artifact.zip'
        self.assets = [{'name': 'asset.bin', 'size': 5, 'sha256': hashlib.sha256(b'proof').hexdigest()}]

    def write_zip(self, entries):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in entries:
                archive.writestr(name, data)
        return 'sha256:' + hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_dynamic_valid_asset_set(self):
        digest = self.write_zip([('asset.bin', b'proof')])
        result = module.verify_archive(self.archive, self.assets, digest)
        self.assertEqual(result['publicAssetCount'], 1)
        self.assertEqual(result['zipDigest'], digest)

    def test_duplicate_traversal_directory_and_foreign_entries(self):
        for entries in [[('../asset.bin', b'proof')], [('/asset.bin', b'proof')],
                        [('asset.bin', b'proof'), ('asset.bin', b'proof')],
                        [('asset.bin/', b'proof')], [('other.bin', b'proof')]]:
            with self.subTest(entries=entries):
                digest = self.write_zip(entries)
                with self.assertRaises(ValueError):
                    module.verify_archive(self.archive, self.assets, digest)

    def test_symlink_and_unsupported_compression(self):
        info = zipfile.ZipInfo('asset.bin')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        digest = self.write_zip([(info, b'proof')])
        with self.assertRaisesRegex(ValueError, 'links'):
            module.verify_archive(self.archive, self.assets, digest)
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_BZIP2) as archive:
            archive.writestr('asset.bin', b'proof')
        digest = 'sha256:' + hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'compression'):
            module.verify_archive(self.archive, self.assets, digest)

    def test_digest_entry_hash_and_size_mismatch(self):
        digest = self.write_zip([('asset.bin', b'wrong')])
        with self.assertRaisesRegex(ValueError, 'digest'):
            module.verify_archive(self.archive, self.assets, 'sha256:' + '0' * 64)
        with self.assertRaisesRegex(ValueError, 'anonymous public'):
            module.verify_archive(self.archive, self.assets, digest)
        digest = self.write_zip([('asset.bin', b'too long')])
        with self.assertRaisesRegex(ValueError, 'size'):
            module.verify_archive(self.archive, self.assets, digest)

    def test_asset_list_bounds_and_duplicate_names(self):
        digest = self.write_zip([('asset.bin', b'proof')])
        for assets in [[], self.assets * 2, [{**self.assets[0], 'name': '../escape'}],
                       [{**self.assets[0], 'size': 0}], [{**self.assets[0], 'size': 2**30}]]:
            with self.subTest(assets=assets):
                with self.assertRaises(ValueError):
                    module.verify_archive(self.archive, assets, digest)


if __name__ == '__main__':
    unittest.main()
