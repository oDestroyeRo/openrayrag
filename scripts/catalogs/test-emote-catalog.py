#!/usr/bin/env python3
"""Prove deterministic pinned generation, canonical dice and whitelist gaps."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

root = Path(__file__).parents[2]
repo = None


class EmoteCatalogTest(unittest.TestCase):
    def setUp(self):
        if repo is None:
            self.skipTest('External pinned source inputs were not supplied')

    def test_exact_reproduction_and_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'emotes.json'
            subprocess.run([sys.executable, str(root / 'scripts/catalogs/build-emote-catalog.py'), str(repo), str(output)], check=True, capture_output=True)
            self.assertEqual(output.read_bytes(), (root / 'src/data/emote-catalog.json').read_bytes())
            data = json.loads(output.read_bytes())
            self.assertEqual(data['sourcePin'], '4099e2c000c3c550516760b9c1241595aac9aceb')
            self.assertEqual(len(data['source']['sha256']), 64)
            ids = {item['id'] for item in data['items']}
            self.assertEqual(len(ids), 59)
            self.assertIn(0, ids)
            self.assertIn(58, ids)
            self.assertFalse(ids & {13, 34, 35, 59, 60, 61, 62, 63, 200, 205})


def main(argv=None):
    global repo
    argv = sys.argv[1:] if argv is None else argv
    repo = Path(argv[0]) if argv else None
    unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
