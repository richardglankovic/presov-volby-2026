"""Prepare Prešov council results without changing precinct geometry or addresses."""
import collections
import csv
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.pythonlibs'))
from shapely.geometry import shape
from shapely import union_all
OUT = ROOT / 'site' / 'data'
SEATS = {1: 7, 2: 3, 3: 4, 4: 5, 5: 4, 6: 8}
BALLOTS = 'Počet platných hlasovacích lístkov odovzdaných pre voľby do zastupiteľstva'
VOTES = 'Počet platných hlasov'
SUBJECT = 'Politický subjekt'
TABLES = ['08f', '08e', '02f', '02e', '06d', '07d']


def subject_key(name):
    return '|'.join(sorted(s.strip().casefold() for s in name.split(',')))


def subject_id(name):
    return 'independent' if name == 'NEKA' else 's-' + hashlib.sha256(subject_key(name).encode()).hexdigest()[:12]


def rows(table):
    path = ROOT / 'vysledky' / f'OSO2026_SK_tab{table}.csv'
    with path.open(encoding='utf-8-sig', newline='') as f:
        return [r for r in csv.DictReader(f) if r['Kód obce'] == '524140']


def candidate_key(row):
    return f"{int(row['Volebný obvod v obci'])}:{int(row['Poradie na hlasovacom lístku'])}"


def aggregate(precincts):
    votes = collections.Counter()
    for p in precincts:
        votes.update(p['votes'])
    return {'validBallots': sum(p['validBallots'] for p in precincts),
            'candidateVotes': sum(votes.values()), 'votes': dict(votes)}


def build():
    source = {t: rows(t) for t in TABLES}
    mayor = json.loads((OUT / 'results.json').read_text(encoding='utf-8'))
    candidates = []
    subjects = {}
    for r in source['08e']:
        name = r[SUBJECT]
        sid = subject_id(name)
        subjects[sid] = {'id': sid, 'name': 'Nezávislí kandidáti spolu' if name == 'NEKA' else name,
                         'officialName': name, 'independent': name == 'NEKA'}
        candidates.append({'id': candidate_key(r), 'district': int(r['Volebný obvod v obci']),
                           'ballot': int(r['Poradie na hlasovacom lístku']), 'name': r['Meno'] + ' ' + r['Priezvisko'],
                           'subject': sid, 'status': r['Kandidát'], 'elected': r['Kandidát'] == 'zvolený',
                           'votes': int(r[VOTES]), 'publishedSelectionShare': float(r['Podiel platných hlasov v %'])})
    candidates.sort(key=lambda c: (c['district'], c['ballot']))
    assert len(candidates) == len({c['id'] for c in candidates}) == 138
    by_id = {c['id']: c for c in candidates}
    elected = {candidate_key(r) for r in source['06d']}
    assert elected == {c['id'] for c in candidates if c['elected']}
    assert all(by_id[candidate_key(r)]['votes'] == int(r[VOTES]) for r in source['06d'])
    summary = {int(r['Okrsok']): r for r in source['02f']}
    precinct_votes = collections.defaultdict(dict)
    for r in source['08f']:
        pid, cid = int(r['Okrsok']), candidate_key(r)
        assert cid in by_id and cid not in precinct_votes[pid]
        assert by_id[cid]['subject'] == subject_id(r[SUBJECT])
        precinct_votes[pid][cid] = int(r[VOTES])
    precincts = []
    for base in mayor['precincts']:
        pid, did = base['id'], base['district']
        r = summary[pid]
        assert int(r['Volebný obvod v obci']) == did
        votes = precinct_votes[pid]
        assert set(votes) == {c['id'] for c in candidates if c['district'] == did}
        ballots = int(r[BALLOTS])
        assert 0 <= ballots <= int(r['Počet zúčastnených voličov'])
        assert all(0 <= v <= ballots for v in votes.values())
        assert sum(votes.values()) <= ballots * SEATS[did]
        precincts.append({'id': pid, 'district': did, 'validBallots': ballots,
                         'candidateVotes': sum(votes.values()), 'votes': votes})
    assert len(precincts) == 66 and len(source['08f']) == 1687
    districts = []
    for did, seats in SEATS.items():
        own = [p for p in precincts if p['district'] == did]
        totals = aggregate(own)
        r = next(r for r in source['02e'] if int(r['Volebný obvod v obci']) == did)
        assert totals['validBallots'] == int(r[BALLOTS])
        assert len(own) == int(r['Počet okrskov'])
        assert sum(c['elected'] for c in candidates if c['district'] == did) == seats
        districts.append({'id': did, 'name': mayor['districts'][str(did)], 'seats': seats,
                          'precincts': [p['id'] for p in own], **totals})
        for c in [c for c in candidates if c['district'] == did]:
            assert totals['votes'][c['id']] == c['votes']
            assert abs(100 * c['votes'] / totals['candidateVotes'] - c['publishedSelectionShare']) < .011
    totals = aggregate(precincts)
    assert (totals['validBallots'], totals['candidateVotes'], len(elected)) == (28505, 110113, 31)
    seat_totals = collections.Counter(c['subject'] for c in candidates if c['elected'])
    assert seat_totals == {subject_id(r[SUBJECT]): int(r['Počet poslancov']) for r in source['07d']}
    for r in source['08f']:
        p = next(p for p in precincts if p['id'] == int(r['Okrsok']))
        assert abs(100 * int(r[VOTES]) / p['candidateVotes'] - float(r['Podiel platných hlasov v %'])) < .011
    snapshot = json.loads((ROOT / 'sources' / 'districts.geojson').read_text(encoding='utf-8'))
    urban = json.loads((OUT / 'precincts.geojson').read_text(encoding='utf-8'))
    features = []
    for f in snapshot['features']:
        did = int(f['properties']['cislo_volebneho_obvodu'])
        display = union_all([shape(p['geometry']) for p in urban['features'] if p['properties']['district'] == did])
        largest = max(display.geoms, key=lambda g: g.area) if hasattr(display, 'geoms') else display
        point = largest.representative_point()
        assert shape(f['geometry']).buffer(.000001).covers(point)
        features.append({'type': 'Feature', 'id': did, 'properties': {'district': did,
                         'name': mayor['districts'][str(did)], 'seats': SEATS[did],
                         'labelCoordinates': [point.x, point.y]}, 'geometry': f['geometry']})
    assert {f['id'] for f in features} == set(SEATS)
    result = {'schemaVersion': 1, 'municipality': '524140', 'electionDate': mayor['electionDate'],
              'snapshotDate': mayor['snapshotDate'], 'candidates': candidates,
              'subjects': sorted(subjects.values(), key=lambda s: s['id']), 'districts': districts,
              'precincts': precincts, 'totals': totals,
              'sources': {'results': 'https://volbysr.sk/', 'tables': ['OSO2026_SK_tab' + t for t in TABLES],
                          'districts': mayor['sources']['districts']},
              'verification': {'candidateRecords': 138, 'precinctCandidateRecords': 1687, 'elected': 31,
                               'validBallots': 28505, 'candidateVotes': 110113}}
    for name, value in [('council-results.json', result), ('districts.geojson', {'type': 'FeatureCollection', 'features': features})]:
        (OUT / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    print(json.dumps(result['verification']))
    return result


if __name__ == '__main__':
    build()
