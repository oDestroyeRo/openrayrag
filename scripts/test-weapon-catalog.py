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

repo, published = map(Path, sys.argv[1:])
root = Path(__file__).resolve().parent.parent


class WeaponCatalogTest(unittest.TestCase):
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

    def test_rejects_code_and_subtype_mismatch_without_replacing_catalog(self):
        for field, bad_value in [('Code', 'UnverifiedBow'), ('SubType', 13)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                document = json.loads(published.read_bytes())
                next(item for item in document['Items'] if item['Id'] == 1701)[field] = bad_value
                input_path = Path(directory) / 'items.json'
                input_path.write_text(json.dumps(document))
                output = Path(directory) / 'weapons.json'
                output.write_bytes(b'existing catalog\n')
                result = self.run_generator(input_path, output)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mismatch', result.stderr)
                self.assertEqual(output.read_bytes(), b'existing catalog\n')


unittest.main(argv=[sys.argv[0]])
