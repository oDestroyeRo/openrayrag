#!/usr/bin/env python3
"""Reproduce the weapon catalog and prove mismatched metadata is rejected.

Usage: python3 scripts/test-weapon-catalog.py SOURCE_REPO ITEMS_JSON
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

repo = published = None
root = Path(__file__).parent.parent


class WeaponCatalogTest(unittest.TestCase):
    def setUp(self):
        if repo is None or published is None:
            self.skipTest('External pinned source inputs were not supplied')

    def run_generator(self, input_path, output_path):
        return subprocess.run([
            sys.executable, str(root / 'scripts/build-weapon-catalog.py'),
            str(repo), str(input_path), str(output_path),
        ], capture_output=True, text=True)

    def test_exact_reproduction(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'weapons.json'
            result = self.run_generator(published, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_bytes(), (root / 'src/data/weapon-catalog.json').read_bytes())
            data = json.loads(output.read_bytes())
            self.assertEqual(len(data['items']), 493)
            self.assertEqual(len(data['unknown']), 10)
            self.assertEqual(len(data['ammo']), 40)
            self.assertEqual(data['ammo']['1750']['ammoType'], 0)
            self.assertEqual(data['ammo']['13200']['ammoType'], 2)
            self.assertEqual(data['items']['1701']['jobs'], [2,5,10,11,15,16,18])
            self.assertTrue(data['items']['1701']['twoHanded'])
            self.assertEqual(data['equipment']['2101']['position'], 'Shield')

    def test_rejects_code_and_subtype_mismatch_without_replacing_catalog(self):
        for item_id, field, bad_value in [(1701,'Code','UnverifiedBow'), (1701,'SubType',13), (1750,'Code','NotArrow'), (2101,'Code','NotGuard')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                document = json.loads(published.read_bytes())
                next(item for item in document['Items'] if item['Id'] == item_id)[field] = bad_value
                input_path = Path(directory) / 'items.json'
                input_path.write_text(json.dumps(document))
                output = Path(directory) / 'weapons.json'
                output.write_bytes(b'existing catalog\n')
                result = self.run_generator(input_path, output)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mismatch', result.stderr)
                self.assertEqual(output.read_bytes(), b'existing catalog\n')


def main(argv=None):
    global repo, published
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        repo, published = map(Path, argv)
    unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
