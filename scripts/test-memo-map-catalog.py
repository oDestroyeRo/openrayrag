#!/usr/bin/env python3
"""Reproduce exact server CanMemo flags, independently of navigation/map modes."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

root = Path(__file__).resolve().parent.parent
repo = Path(sys.argv[1])


class MemoMapCatalogTest(unittest.TestCase):
    def test_exact_pinned_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'memo.json'
            subprocess.run([sys.executable, str(root / 'scripts/build-memo-map-catalog.py'), str(repo), str(output)], check=True, capture_output=True)
            self.assertEqual(output.read_bytes(), (root / 'src/data/memo-map-catalog.json').read_bytes())
            data = json.loads(output.read_bytes())
            self.assertEqual(data['sourcePin'], '4099e2c000c3c550516760b9c1241595aac9aceb')
            self.assertEqual(len(data['source']['sha256']), 64)
            items = {item['map']: item['canMemo'] for item in data['items']}
            self.assertEqual(len(items), 272)
            self.assertEqual(sum(items.values()), 111)
            self.assertTrue(items['prontera'])  # Town mode alone does not forbid memo.
            self.assertTrue(items['prt_fild08'])
            self.assertFalse(items['pay_dun00'])


unittest.main(argv=[sys.argv[0]])
