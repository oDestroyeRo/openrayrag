#!/usr/bin/env python3
"""Prove the checked-in travel catalog is reproducible and fails closed.

Usage: python3 scripts/catalogs/test-travel-catalog.py /path/to/pinned-source-git
The Git checkout must contain the compatible source commit. Tests execute only
our Python generator; source game scripts are read with git show, never run.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE_GIT = None
SCRIPTS = Path(__file__).parent
REPORT = SCRIPTS / 'navigation-portal-sources.json'
CATALOG = SCRIPTS.parent.parent / 'src/data/travel-portals.json'


class TravelCatalogTest(unittest.TestCase):
    def setUp(self):
        if SOURCE_GIT is None:
            self.skipTest('External pinned source checkout was not supplied')

    def generate(self, report, output):
        return subprocess.run([
            sys.executable, str(SCRIPTS / 'build-travel-catalog.py'), str(report), SOURCE_GIT, str(output),
        ], capture_output=True, text=True)

    def test_reviewed_report_reproduces_exact_catalog_bytes(self):
        checked_in = json.loads(CATALOG.read_bytes())
        self.assertEqual(checked_in['reportSha256'], hashlib.sha256(REPORT.read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory(prefix='rayrag-travel-reproduction-') as directory:
            output = Path(directory) / 'travel-portals.json'
            result = self.generate(REPORT, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(json.loads(output.read_bytes())['edges']), 1360)
            self.assertEqual(output.read_bytes(), CATALOG.read_bytes())

    def test_missing_pin_evidence_preserves_existing_catalog(self):
        report = json.loads(REPORT.read_bytes())
        for areas in report['perMapEvidence'].values():
            for area in areas:
                for source in area['sources']:
                    source.pop('alsoPinnedAt', None)
        with tempfile.TemporaryDirectory(prefix='rayrag-travel-rejection-') as directory:
            incomplete = Path(directory) / 'incomplete-report.json'
            incomplete.write_text(json.dumps(report))
            output = Path(directory) / 'travel-portals.json'
            original = CATALOG.read_bytes()
            output.write_bytes(original)
            result = self.generate(incomplete, output)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('lacks pinned warp evidence', result.stderr)
            self.assertEqual(output.read_bytes(), original)

    def test_report_with_only_event_gated_edges_preserves_existing_catalog(self):
        report = json.loads(REPORT.read_bytes())
        gated = {
            map_code: [{**area, 'sources': [source]}]
            for map_code, areas in report['perMapEvidence'].items() for area in areas for source in area['sources']
            if source['kind'] == 'Warp' and source['path'].endswith('/Event/MilestoneOkolnir.txt')
        }
        self.assertEqual(len(gated), 1)
        report['perMapEvidence'] = gated
        with tempfile.TemporaryDirectory(prefix='rayrag-travel-empty-rejection-') as directory:
            gated_report = Path(directory) / 'event-only-report.json'
            gated_report.write_text(json.dumps(report))
            output = Path(directory) / 'travel-portals.json'
            original = CATALOG.read_bytes()
            output.write_bytes(original)
            result = self.generate(gated_report, output)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('No verified travel edges', result.stderr)
            self.assertEqual(output.read_bytes(), original)


def main(argv=None):
    global SOURCE_GIT
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and not argv[0].startswith('-'):
        SOURCE_GIT = str(Path(argv.pop(0)).resolve())
    unittest.main(argv=[sys.argv[0], *argv])


if __name__ == '__main__':
    main()
