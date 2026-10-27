from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_data as build

class PipelineTests(unittest.TestCase):
    def test_packed_dms_decoding_and_invalid_minutes(self):
        self.assertAlmostEqual(build.unpack_dms(21.1652078), 21.2811328, places=7)
        self.assertAlmostEqual(build.unpack_dms(49.0110595), 49.0196097, places=7)
        self.assertAlmostEqual(build.unpack_dms(21.1454061), 21.2483503, places=7)
        with self.assertRaises(ValueError):
            build.unpack_dms(48.9593213)

    def test_unknown_colocated_record_does_not_erase_or_inherit_known_assignment(self):
        records = [
            {'id': 1, 'coordinates': [21, 49], 'precinct': 11, 'district': 1, 'status': 'verified'},
            {'id': 2, 'coordinates': [21, 49], 'precinct': 0, 'district': 0, 'status': 'unresolved'},
        ]
        groups, conflicts, mixed = build.coordinate_groups(records)
        self.assertEqual([a['precinct'] for a in records], [11, 0])
        self.assertEqual(conflicts, [])
        self.assertEqual(len(mixed), 1)
        self.assertEqual(len(groups), 1)

    def test_colocated_conflicting_known_assignments_stay_flagged(self):
        records = [
            {'id': 1, 'coordinates': [21, 49], 'precinct': 11, 'district': 1, 'status': 'verified'},
            {'id': 2, 'coordinates': [21, 49], 'precinct': 12, 'district': 1, 'status': 'verified'},
        ]
        _, conflicts, _ = build.coordinate_groups(records)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual([a['precinct'] for a in records], [0, 0])
        self.assertTrue(all(a['status'] == 'coordinate-conflict' for a in records))

    def test_zero_and_tied_results(self):
        zero = build.vote_metrics({'1': 0, '2': 0}, 0, 0)
        self.assertEqual(zero['winner'], 0)
        self.assertIsNone(zero['shares']['1'])
        self.assertIsNone(zero['turnout'])
        tied = build.vote_metrics({'1': 10, '2': 10}, 40, 21)
        self.assertEqual(tied['winner'], 0)
        self.assertEqual(tied['tiedCandidates'], [1, 2])
        self.assertEqual(tied['shares']['1'], 50)

    def test_official_street_rules_and_later_notice(self):
        rules = build.parse_rules()
        self.assertEqual({r['precinct'] for r in rules}, set(range(1, 67)))
        special = next(r for r in rules if r['key'] == 'prostejovska' and r['precinct'] == 5)
        self.assertEqual(special['numbers'], ['37A'])
        sab = next(r for r in rules if r['key'] == 'sabinovska' and r['precinct'] == 2)
        self.assertIn('169', sab['numbers'])
        self.assertIn('supplementarySource', sab)
        self.assertEqual(build.norm('Ulica Štefana Náhalku'), build.norm('Štefana Náhalku'))
        self.assertEqual(build.house(' 37 a '), '37A')

if __name__ == '__main__':
    unittest.main()
