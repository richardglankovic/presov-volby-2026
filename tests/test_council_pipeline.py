import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_council_data as council


class CouncilPipelineTests(unittest.TestCase):
    def test_coalition_order_does_not_change_subject_identity(self):
        self.assertEqual(council.subject_id('Progresívne Slovensko, Demokrati, DS-ODS'),
                         council.subject_id('Demokrati, DS-ODS, Progresívne Slovensko'))
        self.assertNotEqual(council.subject_id('OKS'), council.subject_id('NEKA'))

    def test_ballot_numbers_are_scoped_by_district(self):
        a = {'Volebný obvod v obci': '1', 'Poradie na hlasovacom lístku': '6'}
        b = {**a, 'Volebný obvod v obci': '6'}
        self.assertNotEqual(council.candidate_key(a), council.candidate_key(b))

    def test_ballots_and_selections_are_distinct(self):
        result = council.aggregate([{'validBallots': 100, 'votes': {'1:1': 60, '1:2': 90}},
                                    {'validBallots': 50, 'votes': {'1:1': 30, '1:2': 40}}])
        self.assertEqual(result['validBallots'], 150)
        self.assertEqual(result['candidateVotes'], 220)
        self.assertEqual(result['votes']['1:1'], 90)


if __name__ == '__main__':
    unittest.main()
