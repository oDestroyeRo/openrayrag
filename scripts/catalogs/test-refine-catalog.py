#!/usr/bin/env python3
"""Independent pinned refine table oracle plus deterministic regeneration.
Usage: python3 scripts/catalogs/test-refine-catalog.py SOURCE_REPO ITEMS_JSON
"""
import csv
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PIN = '4099e2c000c3c550516760b9c1241595aac9aceb'
repo = items = None
root = Path(__file__).parents[2]


class RefineCatalogTest(unittest.TestCase):
    def test_exact_reproduction_and_independent_thresholds(self):
        if repo is None or items is None:
            self.skipTest('External pinned source inputs were not supplied')
        catalog = json.loads((root / 'src/data/socket-catalog.json').read_text())
        def rows(name):
            raw = subprocess.check_output(['git','-C',repo,'show',f'{PIN}:RoRebuildServer/GameConfig/ServerData/Db/{name}.csv'])
            return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        thresholds = rows('RefineSuccess')
        assert len(thresholds) == 20
        costs = {0:(985,2000),1:(1010,200),2:(1011,1000),3:(984,5000),4:(984,10000)}
        columns = {0:'Armor',1:'Level1',2:'Level2',3:'Level3',4:'Level4'}
        checked = 0
        for table, cls in [('ItemsWeapons',2),('ItemsEquipment',3)]:
            for row in rows(table):
                actual = catalog['items'].get(row['Id'])
                if actual is None: continue
                assert actual['itemClass'] == cls
                expected = None
                if row['Refinable'] == 'Yes':
                    rank = int(row['Rank']) if cls == 2 else 0
                    ore, cost = costs[rank]
                    expected = {'rank':rank,'oreItemId':ore,'zenyCost':cost,'thresholds':[int(r[columns[rank]]) for r in thresholds[:10]]}
                    checked += 1
                assert actual.get('refine') == expected, row['Id']
        assert checked > 100
        assert all('refine' not in v for v in catalog['items'].values() if v['itemClass'] == 5)
        with tempfile.TemporaryDirectory(prefix='rayrag-refine-catalog-') as temp:
            output=Path(temp)/'catalog.json'
            subprocess.run([sys.executable,str(root/'scripts/catalogs/build-socket-catalog.py'),repo,items,str(output)],check=True)
            assert output.read_bytes() == (root/'src/data/socket-catalog.json').read_bytes()
        print(json.dumps({'verifiedRefinableItems':checked,'sequentialStartingRefineRows':10,'deterministicRegeneration':True}))


def main(argv=None):
    global repo, items
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        repo, items = argv
    unittest.main(argv=[sys.argv[0]])


if __name__ == '__main__':
    main()
