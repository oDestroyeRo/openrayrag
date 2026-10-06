#!/usr/bin/env python3
"""Synthetic, offline proof for catalog transformations and inert imports."""
import base64
import copy
import csv
from dataclasses import FrozenInstanceError
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock
import zipfile

import catalog_logic
import navigation_logic
import release_policy
from catalog_logic import RecoveryResources, RefineRule
from navigation_logic import GridDimensions, MapPosition, PortalArea, SceneMapCode, validate_grid
from release_policy import ArchiveDigest, PublicAsset, public_asset_index

SCRIPTS = Path(__file__).parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def csv_blob(headers, rows):
    output = io.StringIO()
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow(headers)
    writer.writerows(rows)
    return output.getvalue().encode()


class InertImports(unittest.TestCase):
    def test_scripts_do_not_read_argv_or_perform_effects_on_import(self):
        scripts = [(path, compile(path.read_text(), str(path), 'exec'))
                   for path in sorted(SCRIPTS.glob('*.py'))]
        blocked = ('open', 'read_bytes', 'read_text', 'write_bytes', 'write_text',
                   'stat', 'lstat', 'resolve', 'mkdir', 'replace', 'unlink')
        with mock.patch.object(sys, 'argv', None), mock.patch('builtins.print', side_effect=AssertionError('import printed')):
            with mock.patch.object(subprocess, 'run', side_effect=AssertionError('import ran a process')), \
                    mock.patch.object(subprocess, 'check_output', side_effect=AssertionError('import ran a process')):
                from contextlib import ExitStack
                with ExitStack() as stack:
                    for name in blocked:
                        stack.enter_context(mock.patch.object(Path, name, side_effect=AssertionError(f'import used Path.{name}')))
                    stack.enter_context(mock.patch('builtins.open', side_effect=AssertionError('import opened a file')))
                    for path, code in scripts:
                        with self.subTest(script=path.name):
                            exec(code, {'__name__': f'import_probe_{path.stem}', '__file__': str(path)})


class CatalogLogic(unittest.TestCase):
    def assert_pure(self, function, *args):
        before = copy.deepcopy(args)
        first = function(*args)
        self.assertEqual(first, function(*args))
        self.assertEqual(args, before)
        return first

    def test_public_game_catalog_and_rejection(self):
        game = load_script('build-game-catalog')
        rows = {
            'items': [{'Id': 1, 'Name': 'Potion', 'Weight': 2, 'Price': 3, 'SellPrice': 1,
                       'ItemClass': 1, 'UseType': 1, 'Position': 0}],
            'skillinfo': [{'SkillId': 2, 'Name': '', 'Target': 5, 'MaxLevel': 1,
                           'AdjustableLevel': False, 'SpCost': [4]}],
            'skilltree': [{'ClassId': 0, 'ExtendsClass': -1, 'Skills': [
                {'Skill': 2, 'Prerequisites': [{'Skill': 1, 'Level': 1}]}]}],
        }
        raw = {name: json.dumps({'Items': values}).encode() for name, values in rows.items()}
        result = self.assert_pure(game.build_catalog, raw)
        self.assertEqual(result['items']['1']['name'], 'Potion')
        self.assertEqual(result['skills']['2']['name'], 'Skill 2')
        self.assertEqual(result['trees']['0']['skills'][0]['requires'], [{'skillId': 1, 'level': 1}])
        self.assertEqual(result['sources']['items']['sha256'], hashlib.sha256(raw['items']).hexdigest())
        raw['items'] = json.dumps({'Items': rows['items'] * 2}).encode()
        with self.assertRaisesRegex(ValueError, 'Duplicate item'):
            game.build_catalog(raw)

    def test_emote_whitelist_and_memo_flags(self):
        emote = load_script('build-emote-catalog')
        raw = csv_blob(['Id', 'Commands'], [[i, f'/emote{i}'] for i in range(59)])
        result = self.assert_pure(emote.build_catalog, raw)
        self.assertEqual([item['id'] for item in result['items']], list(range(59)))
        with self.assertRaisesRegex(ValueError, 'Unexpected emote whitelist'):
            emote.build_catalog(raw + b'58,/duplicate\n')
        memo = load_script('build-memo-map-catalog')
        raw = csv_blob(['Code', 'Name', 'Flags'], [['town', 'Town', 'CanMemo, NoWater'], ['dungeon', 'Dungeon', 'NoTeleport']])
        result = self.assert_pure(memo.build_catalog, raw)
        self.assertEqual(result['items'], [{'map': 'dungeon', 'name': 'Dungeon', 'canMemo': False},
                                          {'map': 'town', 'name': 'Town', 'canMemo': True}])
        with self.assertRaisesRegex(ValueError, 'Unknown map flag'):
            memo.build_catalog(raw.replace(b'NoTeleport', b'NewFlag'))

    def weapon_inputs(self, weapon):
        tables = {
            'ItemsWeapons': csv_blob(['Id', 'Code', 'Type', 'Range', 'MinLvl', 'EquipGroup', 'Position'],
                                    [[100, 'Bow', 'Bow', 9, 2, 'Advanced', 'BothHands'], [101, 'Pistol', 'Handgun', 8, 1, 'Archer', 'Weapon']]),
            'WeaponClass': csv_blob(['WeaponClass', 'Id'], [['Bow', 5]]),
            'Jobs': csv_blob(['Class', 'Id'], [['Archer', 2], ['Knight', 1]]),
            'EquipmentGroups': b'Archer,,Archer\nAdvanced,,Archer,Knight\n',
            'ItemsAmmo': csv_blob(['Id', 'Code', 'Type', 'MinLvl', 'Attack', 'Property'], [[200, 'Arrow', 'Arrow', 1, 5, 'Neutral']]),
            'ItemsEquipment': csv_blob(['Id', 'Code', 'Type', 'Position', 'MinLvl', 'EquipGroup'], [[300, 'Guard', 'Shield', '', 1, 'Advanced']]),
        }
        blobs = {weapon.BASE + name + '.csv': value for name, value in tables.items()}
        items = [{'Id': 100, 'Code': 'Bow', 'ItemClass': 2, 'SubType': 5},
                 {'Id': 101, 'Code': 'Pistol', 'ItemClass': 2, 'SubType': 0},
                 {'Id': 102, 'Code': 'Missing', 'ItemClass': 2, 'SubType': 0},
                 {'Id': 200, 'Code': 'Arrow', 'ItemClass': 4, 'SubType': 0},
                 {'Id': 300, 'Code': 'Guard', 'ItemClass': 3, 'SubType': 0}]
        return blobs, items

    def test_weapon_identity_groups_unknowns_and_ammo(self):
        weapon = load_script('build-weapon-catalog')
        blobs, items = self.weapon_inputs(weapon)
        result = self.assert_pure(weapon.build_catalog, blobs, json.dumps({'Items': items}).encode())
        self.assertEqual(result['items']['100'], {'code': 'Bow', 'range': 9, 'weaponClass': 5,
                         'minLevel': 2, 'jobs': [1, 2], 'twoHanded': True})
        self.assertEqual(set(result['unknown']), {'101', '102'})
        self.assertEqual(result['ammo']['200']['ammoType'], 0)
        self.assertEqual(result['equipment']['300']['jobs'], [1, 2])
        self.assertEqual(list(result['sources']), ['items', *weapon.SOURCE_NAMES])
        items[0]['SubType'] = 6
        with self.assertRaisesRegex(ValueError, 'subtype mismatch'):
            weapon.build_catalog(blobs, json.dumps({'Items': items}).encode())

    def socket_inputs(self, socket):
        blobs = dict.fromkeys(socket.SOURCE_PATHS, b'provenance')
        blobs[socket.SOURCE_PATHS[0]] = b'enum EquipPosition : short {\nWeapon = 2,\nArmor = 4,\n}'
        blobs[socket.SOURCE_PATHS[1]] = b'enum HeadgearPosition : byte {\nUpper = 1,\nMiddle = 2,\nAll = Upper | Middle,\n}'
        base = 'RoRebuildServer/GameConfig/ServerData/Db/'
        blobs[base + 'RefineSuccess.csv'] = csv_blob(['Level1', 'Level2', 'Level3', 'Level4', 'Armor'],
                                                   [[i, i + 1, i + 2, i + 3, i + 4] for i in range(10)])
        headers = ['Id', 'Code', 'Name', 'Type', 'EquipableSlot', 'Position', 'Slot', 'Refinable', 'Rank']
        blobs[base + 'ItemsWeapons.csv'] = csv_blob(headers, [[100, 'Bow', 'Bow', 'Bow', '', 'BothHands', 2, 'Yes', 3]])
        blobs[base + 'ItemsEquipment.csv'] = csv_blob(headers, [[300, 'Armor', 'Armor', 'Armor', '', '', 1, 'Yes', 0]])
        blobs[base + 'ItemsCards.csv'] = csv_blob(headers, [[400, 'Card', 'Card', '', 'Armor', '', '', '', '']])
        items = [{'Id': 100, 'Code': 'Bow', 'Name': 'Bow', 'ItemClass': 2, 'IsUnique': True, 'Slots': 2, 'Position': 3},
                 {'Id': 300, 'Code': 'Armor', 'Name': 'Armor', 'ItemClass': 3, 'IsUnique': True, 'Slots': 1, 'Position': 4},
                 {'Id': 400, 'Code': 'Card', 'Name': 'Card', 'ItemClass': 5, 'IsUnique': False, 'Slots': 0, 'Position': 4}]
        return blobs, items

    def test_socket_masks_and_sequential_refine_thresholds(self):
        socket = load_script('build-socket-catalog')
        blobs, items = self.socket_inputs(socket)
        result = self.assert_pure(socket.build_catalog, blobs, json.dumps({'Items': items}).encode())
        self.assertEqual(result['items']['100']['refine'], {'rank': 3, 'oreItemId': 984, 'zenyCost': 5000,
                                                          'thresholds': list(range(2, 12))})
        self.assertEqual(result['items']['300']['refine']['thresholds'], list(range(4, 14)))
        self.assertNotIn('refine', result['items']['400'])
        self.assertEqual(socket.enum_masks(blobs[socket.SOURCE_PATHS[1]].decode(), 'enum HeadgearPosition : byte')['All'], 3)
        items[0]['Name'] = 'Different'
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            socket.build_catalog(blobs, json.dumps({'Items': items}).encode())

    def test_recovery_uses_reviewed_bodies_and_matching_client_identity(self):
        recovery = load_script('build-recovery-item-catalog')
        effects = b'''RecoveryItem("Potion", 2, 4, 0, 0);
Item("Royal_Jelly") { HealRange(325, 405); RecoverSpRange(40, 60); }
Item("Yggdrasil_Berry") { HealHpPercent(100); HealSpPercent(100); }
Item("Yggdrasil_Seed") { HealHpPercent(50); HealSpPercent(50); }
'''
        codes = ['Potion', 'Royal_Jelly', 'Yggdrasil_Berry', 'Yggdrasil_Seed']
        blobs = {recovery.SOURCE_PATHS[0]: effects,
                 recovery.SOURCE_PATHS[1]: csv_blob(['Code', 'Id', 'Name', 'UseMode'], [[code, i, code, 'Use'] for i, code in enumerate(codes, 1)]),
                 recovery.SOURCE_PATHS[2]: b'compiler provenance'}
        client = {'sources': {'items': {'sha256': 'a' * 64}},
                  'items': {str(i): {'name': code, 'itemClass': 1, 'useType': 1, 'price': 5 - i} for i, code in enumerate(codes, 1)}}
        result = self.assert_pure(recovery.build_catalog, blobs, client)
        self.assertEqual(result['hpIds'], [4, 3, 2, 1])
        self.assertEqual(result['spIds'], [4, 3, 2])
        blobs[recovery.SOURCE_PATHS[0]] += b'Item("Unknown") { HealHpPercent(100); }'
        with self.assertRaisesRegex(ValueError, 'Unreviewed direct healing body'):
            recovery.build_catalog(blobs, client)

    def test_cast_policy_audits_every_sp_modifier(self):
        cast = load_script('build-cast-policy')
        blobs = dict.fromkeys(cast.SOURCE_PATHS, b'provenance')
        codes = ['Staff_of_Destruction', 'Ninja_Suit', 'Ninja_Suit_', 'Shinobi_Sash', 'Vitata_Card', 'Golden_Thief_Bug_Card', 'Pharaoh_Card']
        for file in ['ItemsWeapons', 'ItemsEquipment', 'ItemsCards', 'ItemsAmmo']:
            blobs[cast.BASE + f'Db/{file}.csv'] = b''
        blobs[cast.BASE + 'Db/ItemsWeapons.csv'] = b'1,Staff_of_Destruction,Staff\n'
        blobs[cast.BASE + 'Db/ItemsEquipment.csv'] = b'2,Ninja_Suit,Suit\n3,Ninja_Suit_,Suit2\n4,Shinobi_Sash,Sash\n'
        blobs[cast.BASE + 'Db/ItemsCards.csv'] = b'5,Vitata_Card,Vitata\n6,Golden_Thief_Bug_Card,Thief\n7,Pharaoh_Card,Pharaoh\n'
        script_lines = {
            'CardEffects.txt': ['Item("Vitata_Card") AddStat(SpConsumption, 15)', 'Item("Golden_Thief_Bug_Card") AddStat(SpConsumption, 100)', 'Item("Pharaoh_Card") AddStat(SpConsumption, -30)'],
            'ComboEffects.txt': ['ComboItem("ShinobiSashSet", "Ninja_Suit", "Shinobi_Sash") AddStat(SpConsumption, -30)', 'ComboItem("ShinobiSashSet2", "Ninja_Suit_", "Shinobi_Sash") AddStat(SpConsumption, -30)'],
            'EquipmentEffects.txt': ['Item("Staff_of_Destruction") AddStat(SpConsumption, Refine * 2)'],
        }
        audit = []
        for file, lines in script_lines.items():
            path = cast.BASE + 'Script/Items/' + file
            blobs[path] = '\n'.join(lines).encode()
            audit.extend(f'{cast.PIN}:{path}:{i}:{line}' for i, line in enumerate(lines, 1))
        published = {str(i): {'name': name} for i, name in enumerate(['Staff', 'Suit', 'Suit2', 'Sash', 'Vitata', 'Thief', 'Pharaoh'], 1)}
        result = self.assert_pure(cast.build_catalog, blobs, published, audit)
        self.assertEqual(result['items']['5']['percent'], 15)
        self.assertEqual(result['items']['1']['refinePercent'], 2)
        self.assertEqual(result['combos'], [{'items': [2, 4], 'percent': -30}, {'items': [3, 4], 'percent': -30}])
        with self.assertRaisesRegex(ValueError, 'Unsupported SP modifier'):
            cast.build_catalog(blobs, published, audit + ['unexpected modifier'])

    def travel_inputs(self, travel):
        area = {'x': 0, 'y': 0, 'halfWidth': 0, 'halfHeight': 0}
        path = 'RoRebuildServer/GameConfig/ServerData/Script/Maps/start.txt'
        source = {'kind': 'Warp', 'commit': travel.PIN, 'path': path, 'line': 1, 'destinations': [['end', 1, 1]]}
        report = {'sources': {'pinned': travel.PIN}, 'perMapEvidence': {'start': [{**area, 'sources': [source]}]}}
        grids = {name: {'width': 2, 'height': 2, 'walkableBitsBase64': 'Dw==', 'portals': [area] if name == 'start' else []}
                 for name in ['start', 'end']}
        blobs = {path: b'Warp("start", "gate", 0, 0, 0, 0, "end", 1, 1);'}
        return report, grids, blobs

    def test_travel_accepts_only_unconditional_pinned_walkable_warps(self):
        travel = load_script('build-travel-catalog')
        report, grids, blobs = self.travel_inputs(travel)
        result = self.assert_pure(travel.build_catalog, json.dumps(report).encode(), grids, blobs)
        self.assertEqual(result['edges'][0]['id'], 'start:0,0,0,0:end:1,1')
        self.assertEqual(travel.required_source_paths(report, grids), list(blobs))
        path, = blobs
        blobs[path] = b'#event festival\n' + blobs[path]
        report['perMapEvidence']['start'][0]['sources'][0]['line'] = 2
        with self.assertRaisesRegex(ValueError, 'No verified travel edges'):
            travel.build_catalog(json.dumps(report).encode(), grids, blobs)
        report['perMapEvidence']['start'][0]['sources'][0]['commit'] = 'other'
        with self.assertRaisesRegex(ValueError, 'lacks pinned warp evidence'):
            travel.validate_report(report)
        with self.assertRaisesRegex(ValueError, 'Invalid source path'):
            travel.validate_source_path('RoRebuildServer/GameConfig/ServerData/Script/../escape')

    def test_navigation_bitsets_and_reviewed_source_guards(self):
        tree = {'Width': 4, 'Height': 2, 'Cells': [{'Type': value} for value in [1, 2, 3, 4, 5, 0, 6, 7]]}
        grid = self.assert_pure(navigation_logic.build_grid, tree, 'town', 'url', 'a' * 64)
        self.assertEqual(base64.b64decode(grid['walkableBitsBase64']), b'\x95')
        self.assertEqual(base64.b64decode(grid['snipableOnlyBitsBase64']), b'\x48')
        source = {'map': 'town', 'width': 4, 'height': 2, 'walkableCount': 4, 'blockedCount': 4}
        result = self.assert_pure(navigation_logic.validate_grid, source, grid, [])
        self.assertEqual(result['walkableCount'], 4)
        overlap = {**grid, 'snipableOnlyBitsBase64': grid['walkableBitsBase64']}
        with self.assertRaisesRegex(ValueError, 'overlap'):
            navigation_logic.validate_grid(source, overlap, [])
        with self.assertRaisesRegex(ValueError, 'explicit portal list'):
            navigation_logic.validate_inventory([source], {})
        valid = {'map': 'town', 'sourceUrl': 'https://websea01.rayrag.com/StreamingAssets/aa/WebGL/scenes_scenes_assets_scenes_maps_town.unity.bundle',
                 'bundleBytes': 10, 'sourceSha256': 'a' * 64}
        self.assertEqual(navigation_logic.scene_url(valid), valid['sourceUrl'])
        self.assertTrue(navigation_logic.reviewed_bundle_matches(valid, 10, 'a' * 64))
        self.assertFalse(navigation_logic.reviewed_bundle_matches(valid, 11, 'a' * 64))
        with self.assertRaisesRegex(ValueError, 'Unexpected scene URL'):
            navigation_logic.scene_url({**valid, 'sourceUrl': 'https://unreviewed.example/bundle'})
        navigation_logic.validate_type_tree_header(23, 1, 23)
        for values in [(24, 1, 24), (23, 0, 23), (23, 1, 22)]:
            with self.subTest(header=values), self.assertRaises(ValueError):
                navigation_logic.validate_type_tree_header(*values)

    def test_serialization_retains_formats_and_provenance(self):
        self.assertEqual(catalog_logic.catalog_json({'name': 'ไทย'}, ensure_ascii=False), '{"name":"ไทย"}\n')
        self.assertEqual(catalog_logic.catalog_json({'x': 1}, indent=2, compact=False), '{\n  "x": 1\n}\n')
        self.assertEqual(catalog_logic.source_record(b'input', 'pin', 'source')['sha256'], hashlib.sha256(b'input').hexdigest())


class NavigationEffects(unittest.TestCase):
    def test_unity_adapter_delegates_and_restores_the_library_on_success_and_error(self):
        extract = load_script('extract-navigation')
        delegated = []

        class TypeTreeNode:
            @classmethod
            def parse_blob(cls, reader, version):
                delegated.append(version)
                return 'parsed'

        original = TypeTreeNode.__dict__['parse_blob']
        tree = {'m_Name': 'town_walkdata', 'Width': 1, 'Height': 1, 'Cells': [{'Type': 1}]}
        asset = types.SimpleNamespace(type=types.SimpleNamespace(name='MonoBehaviour'), read_typetree=lambda: tree)
        unity = types.ModuleType('UnityPy')
        node = types.ModuleType('UnityPy.helpers.TypeTreeNode')
        node.TypeTreeNode = TypeTreeNode
        reader = mock.Mock()
        reader.read_u_int.side_effect = [1, 0, 23]

        def load(path):
            self.assertEqual(TypeTreeNode.parse_blob(reader, 23), 'parsed')
            return types.SimpleNamespace(objects=[asset])

        unity.load = load
        with mock.patch.dict(sys.modules, {'UnityPy': unity, 'UnityPy.helpers.TypeTreeNode': node}):
            self.assertEqual(extract.load_walk_tree('fixture.bundle', 'town'), tree)
            self.assertIs(TypeTreeNode.__dict__['parse_blob'], original)
            self.assertEqual(delegated, [23])
            reader.read_bytes.assert_called_once_with(16)
            unity.load = lambda path: types.SimpleNamespace(objects=[])
            with self.assertRaisesRegex(ValueError, 'Expected one map walk asset'):
                extract.load_walk_tree('fixture.bundle', 'town')
            self.assertIs(TypeTreeNode.__dict__['parse_blob'], original)

    def test_fetch_validates_downloads_and_preserves_old_cache_on_mismatch(self):
        import tempfile
        fetch = load_script('fetch-navigation')
        content = b'reviewed bundle'
        source = {'map': 'town', 'sourceUrl': 'https://websea01.rayrag.com/StreamingAssets/aa/WebGL/scenes_scenes_assets_scenes_maps_town.unity.bundle',
                  'bundleBytes': len(content), 'sourceSha256': hashlib.sha256(content).hexdigest()}
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            output = destination / 'rayrag-town-scene.bundle'
            output.write_bytes(b'old cache')

            def download(args, **kwargs):
                Path(args[args.index('--output') + 1]).write_bytes(content)

            with mock.patch.object(fetch.subprocess, 'run', side_effect=download) as curl:
                self.assertTrue(fetch.fetch(source, destination))
                self.assertEqual(output.read_bytes(), content)
                self.assertFalse(fetch.fetch(source, destination))
                self.assertEqual(curl.call_count, 1)
            output.write_bytes(b'old cache')
            with mock.patch.object(fetch.subprocess, 'run', side_effect=lambda args, **kw: Path(args[args.index('--output') + 1]).write_bytes(b'unreviewed')):
                with self.assertRaisesRegex(ValueError, 'downloaded asset differs'):
                    fetch.fetch(source, destination)
            self.assertEqual(output.read_bytes(), b'old cache')
            self.assertEqual(list(destination.iterdir()), [output])

    def test_failed_travel_validation_does_not_replace_existing_output(self):
        import tempfile
        travel = load_script('build-travel-catalog')
        report = {'sources': {'pinned': travel.PIN}, 'perMapEvidence': {}}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / 'catalog.json'
            report_path = root / 'report.json'
            output.write_bytes(b'existing catalog\n')
            report_path.write_text(json.dumps(report))
            with mock.patch.object(travel, 'load_pinned_blobs', side_effect=AssertionError('unexpected Git read')):
                with self.assertRaisesRegex(ValueError, 'lacks pinned warp evidence'):
                    travel.main([str(report_path), 'source', str(output)])
            self.assertEqual(output.read_bytes(), b'existing catalog\n')

    def test_atomic_catalog_write_keeps_old_file_when_replace_fails(self):
        import catalog_effects
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'catalog.json'
            output.write_bytes(b'existing catalog\n')
            with mock.patch.object(Path, 'replace', side_effect=OSError('replacement failed')):
                with self.assertRaisesRegex(OSError, 'replacement failed'):
                    catalog_effects.write_catalog(output, 'new catalog\n', atomic=True)
            self.assertEqual(output.read_bytes(), b'existing catalog\n')
            self.assertEqual(list(Path(folder).iterdir()), [output])


class ReleasePolicy(unittest.TestCase):
    def test_public_policy_rejects_duplicate_names_and_unsupported_entries(self):
        asset = {'name': 'app.tar.gz', 'size': 1, 'sha256': 'a' * 64}
        expected, total = release_policy.public_asset_index([asset], 'sha256:' + 'b' * 64)
        self.assertEqual((list(expected), total), (['app.tar.gz'], 1))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            release_policy.public_asset_index([asset, asset], 'sha256:' + 'b' * 64)
        entry = zipfile.ZipInfo('app.tar.gz')
        release_policy.validate_public_zip_entries([entry], expected)
        entry.flag_bits = 1
        with self.assertRaisesRegex(ValueError, 'encryption'):
            release_policy.validate_public_zip_entries([entry], expected)

    def test_archive_validation_precedes_extraction_and_metadata_is_pure(self):
        good = tarfile.TarInfo('Rayrag Companion.app/binary')
        good.size = 1
        bad = tarfile.TarInfo('../escape')
        with self.assertRaisesRegex(ValueError, 'Unsafe app archive path'):
            release_policy.validate_app_archive([good, bad], 'Rayrag Companion.app', 10)
        info = {'CFBundleIdentifier': 'com.rayrag.companion', 'CFBundleShortVersionString': '1.2.3',
                'CFBundleVersion': '1.2.3', 'CFBundleExecutable': 'rayrag-companion'}
        release_policy.validate_bundle_metadata(info, '1.2.3')
        with self.assertRaisesRegex(ValueError, 'Bundle version differs'):
            release_policy.validate_bundle_metadata(info, '1.2.4')
        with self.assertRaisesRegex(ValueError, 'different application'):
            release_policy.compare_app_manifests([('binary', 'left')], [('binary', 'right')])


class NavigationValues(unittest.TestCase):
    def test_scene_key_confines_url_and_filename_without_changing_grammar(self):
        code = SceneMapCode('prt_fild08')
        self.assertEqual(code.bundle_filename, 'rayrag-prt_fild08-scene.bundle')
        self.assertEqual(code.source_url, 'https://websea01.rayrag.com/StreamingAssets/aa/WebGL/scenes_scenes_assets_scenes_maps_prt_fild08.unity.bundle')
        for value in ['', 'A', '../town', 'town/other', 'a' * 65, None]:
            with self.subTest(code=value), self.assertRaisesRegex(ValueError, 'Invalid map code'):
                SceneMapCode(value)
        with self.assertRaises(FrozenInstanceError):
            code.value = 'town'
        self.assertFalse(hasattr(code, '__dict__'))

    def test_dimensions_and_positions_enforce_integer_cell_bounds(self):
        dimensions = GridDimensions(4, 3)
        self.assertEqual((dimensions.cell_count, dimensions.bitset_bytes), (12, 2))
        position = MapPosition(dimensions, 2, 1)
        self.assertEqual(position.index, 6)
        self.assertEqual(position.to_json(), {'x': 2, 'y': 1})
        for width, height in [(0, 1), (1, 0), (513, 1), (1, 513), (True, 1), (1.0, 1), ('1', 1)]:
            with self.subTest(dimensions=(width, height)), self.assertRaises(ValueError):
                GridDimensions(width, height)
        for x, y in [(-1, 0), (0, -1), (4, 0), (0, 3), (True, 0), (0, 1.0)]:
            with self.subTest(position=(x, y)), self.assertRaises(ValueError):
                MapPosition(dimensions, x, y)
        with self.assertRaises(ValueError):
            MapPosition({'width': 4, 'height': 3}, 0, 0)

    def test_portal_geometry_is_immutable_and_projects_detached_json(self):
        dimensions = GridDimensions(2, 2)
        position = MapPosition(dimensions, 0, 0)
        area = PortalArea(position, 1, 1)
        self.assertEqual(list(area.cells()), [(x, y) for y in [-1, 0, 1] for x in [-1, 0, 1]])
        self.assertEqual(json.dumps(area.to_json(), separators=(',', ':')),
                         '{"x":0,"y":0,"halfWidth":1,"halfHeight":1}')
        document = area.to_json()
        document['x'] = 1
        self.assertEqual(area.center.x, 0)
        for record, field, value in [(dimensions, 'width', 3), (position, 'x', 1), (area, 'half_width', 2)]:
            with self.subTest(record=type(record).__name__), self.assertRaises(FrozenInstanceError):
                setattr(record, field, value)
            self.assertFalse(hasattr(record, '__dict__'))
        for center, width, height in [(position, -1, 0), (position, 3, 0), (position, 0, 3),
                                      (position, True, 0), (position, 1.0, 0), (None, 1, 1)]:
            with self.subTest(extents=(width, height)), self.assertRaises(ValueError):
                PortalArea(center, width, height)

    def inputs(self):
        grid = {'map': 'town', 'width': 2, 'height': 2,
                'walkableBitsBase64': base64.b64encode(b'\x09').decode(),
                'snipableOnlyBitsBase64': base64.b64encode(b'\x04').decode(),
                'sourceUrl': 'url', 'sourceSha256': 'a' * 64}
        source = {'map': 'town', 'width': 2, 'height': 2, 'walkableCount': 2, 'blockedCount': 2}
        portal = {'review': 'retained extension', 'halfHeight': 1, 'x': 0, 'halfWidth': 1, 'y': 0}
        return source, grid, [portal]

    def test_reviewed_grid_preserves_wire_values_order_and_extensions(self):
        source, grid, portals = self.inputs()
        before = copy.deepcopy((source, grid, portals))
        result = validate_grid(source, grid, portals)
        expected = {**grid, 'walkableCount': 2, 'blockedCount': 2, 'portals': portals}
        self.assertEqual(json.dumps(result, separators=(',', ':')), json.dumps(expected, separators=(',', ':')))
        self.assertEqual((source, grid, portals), before)
        result['portals'][0]['x'] = 1
        self.assertEqual(portals[0]['x'], 0)

    def test_existing_grid_and_portal_error_precedence_is_retained(self):
        source, grid, portals = self.inputs()
        invalid_bits = {**grid, 'walkableBitsBase64': '!invalid'}
        for broken, message in [({**invalid_bits, 'width': 0}, 'town: unsupported dimensions'),
                                ({**invalid_bits, 'width': 3}, 'town: dimensions differ')]:
            with self.subTest(error=message), self.assertRaisesRegex(ValueError, message):
                validate_grid(source, broken, portals)
        invalid_portals = [({**portals[0], 'x': 3, 'halfWidth': 'bad'}, 'Invalid portal values'),
                           ({**portals[0], 'x': 3, 'halfWidth': 3}, 'town: portal center outside map'),
                           ({**portals[0], 'halfWidth': 3}, 'town: invalid portal extent')]
        for portal, message in invalid_portals:
            with self.subTest(error=message), self.assertRaisesRegex(ValueError, message):
                validate_grid(source, grid, [portal])

    def test_travel_uses_bounded_positions_and_preserves_edge_json(self):
        travel = load_script('build-travel-catalog')
        report, grids, blobs = CatalogLogic().travel_inputs(travel)
        report_raw = json.dumps(report).encode()
        catalog = travel.build_catalog(report_raw, grids, blobs)
        expected = {'id': 'start:0,0,0,0:end:1,1', 'fromMap': 'start', 'toMap': 'end',
                    'area': {'x': 0, 'y': 0, 'halfWidth': 0, 'halfHeight': 0}, 'arrival': {'x': 1, 'y': 1},
                    'source': {'kind': 'Warp', 'commit': travel.PIN, 'path': next(iter(blobs)), 'line': 1}}
        self.assertEqual(json.dumps(catalog['edges'][0], separators=(',', ':')), json.dumps(expected, separators=(',', ':')))
        dimensions = GridDimensions.from_export(grids['end'], 'end')
        self.assertTrue(travel.walkable(dimensions, b'\x0f', 1, 1))
        self.assertFalse(travel.walkable(dimensions, b'\x0f', -1, 0))
        self.assertFalse(travel.walkable(dimensions, b'\x0f', 2, 0))

    def test_travel_admits_dimensions_once_per_used_map_after_bounds_skips(self):
        travel = load_script('build-travel-catalog')
        report, grids, blobs = CatalogLogic().travel_inputs(travel)
        # An unused invalid map and an outside-cell arrival must keep their
        # existing skip behavior instead of triggering eager validation.
        grids['unused'] = {'width': 0, 'height': 0, 'walkableBitsBase64': '', 'portals': []}
        grids['outside'] = {'width': 513, 'height': 1, 'walkableBitsBase64': '', 'portals': []}
        evidence = copy.deepcopy(report['perMapEvidence']['start'][0]['sources'][0])
        evidence['line'] = 2
        evidence['destinations'] = [['outside', 600, 0]]
        report['perMapEvidence']['start'][0]['sources'].extend([evidence, copy.deepcopy(evidence)])
        path, = blobs
        blobs[path] += b'\nWarp("start", "gate", 0, 0, 0, 0, "outside", 600, 0);'
        with mock.patch.object(GridDimensions, 'from_export', wraps=GridDimensions.from_export) as admit:
            result = travel.build_catalog(json.dumps(report).encode(), grids, blobs)
        self.assertEqual([call.args[1] for call in admit.call_args_list], ['end', 'start'])
        self.assertEqual(result['excluded'], {'blockedArrival': 2})
        self.assertEqual(len(result['edges']), 1)


class CatalogValues(unittest.TestCase):
    def test_recovery_resource_roles_are_named_validated_and_immutable(self):
        hp = RecoveryResources(hp=True, sp=False)
        sp = RecoveryResources(hp=False, sp=True)
        both = RecoveryResources(hp=True, sp=True)
        self.assertEqual((hp.hp, hp.sp, sp.hp, sp.sp, both.hp, both.sp), (True, False, False, True, True, True))
        self.assertEqual(RecoveryResources(hp=False, sp=False).hp, False)
        with self.assertRaises(TypeError):
            RecoveryResources(True, False)
        for hp_value, sp_value in [(1, False), (True, 0), ('yes', False), (False, None)]:
            with self.subTest(resources=(hp_value, sp_value)), self.assertRaises(ValueError):
                RecoveryResources(hp=hp_value, sp=sp_value)
        with self.assertRaises(FrozenInstanceError):
            hp.sp = True
        self.assertFalse(hasattr(hp, '__dict__'))

    def test_refine_rule_binds_rank_to_sequential_thresholds_and_canonical_costs(self):
        rows = [[i, i + 10, i + 20, i + 30, i + 40] for i in range(20)]
        costs = {0: (985, 2000), 1: (1010, 200), 2: (1011, 1000), 3: (984, 5000), 4: (984, 10000)}
        for rank in range(5):
            rule = RefineRule.from_sequential_rows(rank, rows)
            column = rank - 1 if rank else 4
            ore, cost = costs[rank]
            expected = {'rank': rank, 'oreItemId': ore, 'zenyCost': cost,
                        'thresholds': [row[column] for row in rows[:10]]}
            self.assertEqual(json.dumps(rule.to_json(), separators=(',', ':')), json.dumps(expected, separators=(',', ':')))
            self.assertEqual(rule.materials, costs[rank])
        armor = RefineRule.from_sequential_rows(0, rows)
        rows[0][4] = 0
        self.assertEqual(armor.thresholds[0], 40)
        armor.to_json()['thresholds'][0] = 0
        self.assertEqual(armor.thresholds[0], 40)
        with self.assertRaises(FrozenInstanceError):
            armor.rank = 1
        with self.assertRaises(TypeError):
            armor.thresholds[0] = 0
        self.assertFalse(hasattr(armor, '__dict__'))

    def test_refine_rule_rejects_invalid_rank_count_probability_and_mutable_storage(self):
        for rank in [-1, 5, True, 1.0, None]:
            with self.subTest(rank=rank), self.assertRaisesRegex(ValueError, 'Invalid refine rank'):
                RefineRule(rank=rank, thresholds=(50,) * 10)
        for thresholds in [(50,) * 9, (50,) * 11, (-1,) * 10, (101,) * 10, (True,) * 10, [50] * 10]:
            with self.subTest(thresholds=thresholds), self.assertRaisesRegex(ValueError, 'Invalid sequential refine thresholds'):
                RefineRule(rank=1, thresholds=thresholds)
        with self.assertRaisesRegex(ValueError, 'Invalid sequential refine thresholds'):
            RefineRule.from_sequential_rows(1, [[50] * 5] * 9)


class ReleaseValues(unittest.TestCase):
    def test_public_asset_requires_valid_flat_identity_size_and_digest(self):
        valid = PublicAsset('app.tar.gz', 5, 'a' * 64)
        for name in ['', '.', '..', '../app', '/app', 'folder/app', 'space app', None]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                PublicAsset(name, valid.size, valid.sha256)
        for size in [0, -1, 256 * 1024 * 1024 + 1, True, 1.0, None]:
            with self.subTest(size=size), self.assertRaises(ValueError):
                PublicAsset(valid.name, size, valid.sha256)
        for digest in ['a' * 63, 'a' * 65, 'A' * 64, 'sha256:' + 'a' * 64, None]:
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                PublicAsset(valid.name, valid.size, digest)
        self.assertEqual(PublicAsset('max.tar.gz', 256 * 1024 * 1024, 'b' * 64).size, 256 * 1024 * 1024)

    def test_asset_index_owns_immutable_records_and_preserves_wire_projection(self):
        wire = {'name': 'app.tar.gz', 'size': 5, 'sha256': 'a' * 64}
        index, total = public_asset_index([wire], 'sha256:' + 'b' * 64)
        asset = index[wire['name']]
        self.assertIsInstance(asset, PublicAsset)
        self.assertEqual(total, 5)
        self.assertEqual(json.dumps(asset.to_json(), separators=(',', ':')), json.dumps(wire, separators=(',', ':')))
        wire['size'] = 6
        self.assertEqual(asset.size, 5)
        asset.to_json()['size'] = 7
        self.assertEqual(asset.size, 5)
        for field, value in [('name', 'other.zip'), ('size', 7), ('sha256', 'c' * 64)]:
            with self.subTest(field=field), self.assertRaises(FrozenInstanceError):
                setattr(asset, field, value)
        self.assertFalse(hasattr(asset, '__dict__'))

    def test_archive_digest_is_algorithm_specific_and_immutable(self):
        digest = ArchiveDigest('sha256:' + 'a' * 64)
        self.assertEqual(digest, ArchiveDigest(digest.value))
        for value in ['a' * 64, 'sha1:' + 'a' * 64, 'sha256:' + 'A' * 64, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ArchiveDigest(value)
        with self.assertRaises(FrozenInstanceError):
            digest.value = 'sha256:' + 'b' * 64

    def test_asset_validation_retains_first_error_before_effects(self):
        asset = {'name': 'app.tar.gz', 'size': 5, 'sha256': 'a' * 64}
        with self.assertRaisesRegex(ValueError, 'Invalid ZIP digest'):
            public_asset_index([], 'invalid')
        with self.assertRaisesRegex(ValueError, 'Invalid or duplicate public asset name'):
            public_asset_index([asset, {**asset, 'size': 0, 'sha256': 'invalid'}], 'sha256:' + 'b' * 64)
        with self.assertRaisesRegex(ValueError, 'Invalid asset fields'):
            public_asset_index([{**asset, 'extra': True}], 'sha256:' + 'b' * 64)

    def test_stream_consumer_preserves_verification_result_json(self):
        public_zip = load_script('release-public-zip')
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'artifact.zip'
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as target:
                target.writestr('asset.bin', b'proof')
            digest = 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest()
            assets = [{'name': 'asset.bin', 'size': 5, 'sha256': hashlib.sha256(b'proof').hexdigest()}]
            result = public_zip.verify_archive(archive, assets, digest)
            expected = {'zipBytes': archive.stat().st_size, 'zipDigest': digest, 'publicAssetCount': 1,
                        'proof': 'Original Actions ZIP digest and every entry hash/size equal anonymous public assets'}
            self.assertEqual(json.dumps(result, separators=(',', ':')), json.dumps(expected, separators=(',', ':')))


if __name__ == '__main__':
    unittest.main()
