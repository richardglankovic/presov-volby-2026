"""Build audited Prešov-only static data. Network-free after fetch_sources.py.

Geometry is illustrative, not an official delineation of electoral precincts.
"""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.pythonlibs'))
import collections
import csv
import datetime as dt
import hashlib
import json
import re
import unicodedata
from decimal import Decimal
import numpy as np
from pypdf import PdfReader
from pyproj import Transformer
from shapely import make_valid, union_all, voronoi_polygons
from shapely.geometry import Point, MultiPoint, Polygon, MultiPolygon, GeometryCollection, mapping, shape
from shapely.ops import transform

SOURCE = ROOT / 'sources'
OUT = ROOT / 'site' / 'data'
MUNICIPALITY = '524140'
OCTOBER_URL = 'https://oznamypresov.sk/download/10860'
NOTICE_URL = 'https://www.presov.sk/oznamy/volby-2026--informacie-pre-volicov.html'
COLORS = {1: '#b66b17', 2: '#a45687', 3: '#cc6d53', 4: '#3f8c7e', 5: '#536dc4', 6: '#8263a8'}
DISTRICTS = {1: 'Sídlisko III a okolie', 2: 'Sídlisko II, Kalvária a okolie', 3: 'Mier, Šidlovec a Nižná Šebastová', 4: 'Staré Mesto', 5: 'Solivar a Šváby', 6: 'Sekčov a Šalgovík'}
# User-reviewed registry objects without a residential address. Keep provenance
# in the private registry snapshot without exposing a confusing search entry.
REVIEWED_OBJECTS = {4804: {'use': 'boiler-house', 'source': 'user-confirmed', 'excludeFromPublicLookup': True}}
# Explicit local-review corrections for source coordinates entered as DD.MMSS
# instead of decimal degrees. Match both registry ID and original coordinates;
# never apply this conversion to normal coordinates or automatically by proximity.
PACKED_DMS_FIXES = {
    424: ('10053736', [21.1654556, 49.01001]),
    508: ('10276915', [21.1707677, 49.01237]),
    1040: ('7101403738', [21.1652078, 49.0110595]),
    2121: ('7101358099', [21.1506364, 49.0003982]),
    3614: ('710208960A', [21.1454061, 49.0031811]),
    3627: ('7102090006', [21.1456944, 49.003254]),
    3654: ('7101680938', [21.1447347, 49.0048697]),
    8077: ('10617695', [21.1457385, 49.0000595]),
}


def unpack_dms(value):
    packed = abs(Decimal(str(value)))
    degrees = int(packed)
    minutes_full = (packed - degrees) * 100
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 100
    if minutes >= 60 or seconds >= 60:
        raise ValueError('Invalid packed DMS coordinate')
    decoded = Decimal(degrees) + Decimal(minutes) / 60 + seconds / 3600
    return round(float(decoded) * (-1 if value < 0 else 1), 7)

def load(name):
    return json.loads((SOURCE / name).read_text(encoding='utf-8'))

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')

def norm(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', str(value)) if not unicodedata.combining(c)).lower()
    value = re.sub(r'[^a-z0-9 ]', ' ', value)
    value = re.sub(r'\s+', ' ', value).strip()
    value = re.sub(r'^ulica | ulica$', '', value)
    return value

def house(value):
    return re.sub(r'\s+', '', str(value)).upper()

def parse_rules():
    rules = []
    precinct = district = None
    current = None
    for page_no, page in enumerate(PdfReader(SOURCE / 'precincts_october.pdf').pages, 1):
        for raw in page.extract_text().splitlines():
            line = raw.strip()
            if not line or re.match(r'^Strana\s*:', line):
                continue
            found = re.match(r'VOLEBNÝ OBVOD č\.\s*(\d+)', line)
            if found:
                district = int(found[1])
                current = None
                continue
            found = re.match(r'Okrsok č\.\s*(\d+)', line)
            if found:
                precinct = int(found[1])
                current = None
                continue
            if precinct is None:
                continue
            if re.fullmatch(r'[\dA-Za-z,\s]+', line) and re.match(r'^\d', line):
                if current is not None:
                    current['numbers'].extend(house(n) for n in line.split(',') if n.strip())
                continue
            if line.startswith('trvalý pobyt'):
                continue  # City-only residence belongs to 33, not an address polygon.
            # Wrapped polling-location text belongs to the heading, not a street rule.
            if current is None and (line.startswith(('Kalváriou ', 'Slovenskou ')) or re.fullmatch(r'\d+', line)):
                continue
            current = {'street': line, 'key': norm(line), 'precinct': precinct, 'district': district, 'numbers': [], 'page': page_no, 'source': OCTOBER_URL}
            rules.append(current)
    assert {r['precinct'] for r in rules} == set(range(1, 67))
    # The later city notice explicitly extends this moved odd-number range to 169.
    for rule in rules:
        if rule['key'] == 'sabinovska' and rule['precinct'] == 2:
            rule['numbers'] = sorted(set(rule['numbers']) | {'165', '167', '169'})
            rule['supplementarySource'] = NOTICE_URL
    return rules

def candidate_rows(table):
    with (ROOT / 'vysledky' / f'OSO2026_SK_{table}.csv').open(encoding='utf-8-sig', newline='') as f:
        return [r for r in csv.DictReader(f) if r['Kód obce'] == MUNICIPALITY]

def vote_metrics(votes, registered, participated):
    total = sum(votes.values())
    leaders = [int(k) for k, v in votes.items() if total and v == max(votes.values())]
    return {'validVotes': total, 'votes': votes, 'shares': {k: (100 * v / total if total else None) for k, v in votes.items()}, 'winner': leaders[0] if len(leaders) == 1 else 0, 'tiedCandidates': leaders if len(leaders) > 1 else [], 'registered': registered, 'participated': participated, 'turnout': 100 * participated / registered if registered else None}

def results_data():
    rows = candidate_rows('tab05f')
    summaries = {int(r['Okrsok']): r for r in candidate_rows('tab02f')}
    city_rows = candidate_rows('tab05d')
    candidates = [{'id': int(r['Poradie na hlasovacom lístku']), 'name': r['Meno'] + ' ' + r['Priezvisko'], 'surname': r['Priezvisko'], 'party': r['Politický subjekt'], 'color': COLORS[int(r['Poradie na hlasovacom lístku'])], 'votes': int(r['Počet platných hlasov']), 'publishedShare': float(r['Podiel platných hlasov v %'])} for r in city_rows]
    candidates.sort(key=lambda x: x['id'])
    polling = {int(f['properties']['USER_OKRSOK']): f for f in load('polling_places.geojson')['features']}
    precincts = []
    for pid in range(1, 67):
        r = [r for r in rows if int(r['Okrsok']) == pid]
        s = summaries[pid]
        assert len(r) == 6
        assert len({int(x['Volebný obvod v obci']) for x in r}) == 1
        votes = {x['Poradie na hlasovacom lístku']: int(x['Počet platných hlasov']) for x in r}
        data = vote_metrics(votes, int(s['Počet zapísaných voličov']), int(s['Počet zúčastnených voličov']))
        assert data['validVotes'] == int(s['Počet platných hlasovacích lístkov odovzdaných pre voľby starostu'])
        assert data['validVotes'] <= data['participated'] <= data['registered']
        poll = polling[pid]
        precincts.append({'id': pid, 'key': f'{MUNICIPALITY}:{pid}', 'district': int(r[0]['Volebný obvod v obci']), 'pollingPlace': poll['properties']['volebna_miestnost'], 'pollingCoordinates': poll['geometry']['coordinates'], 'note': 'Okrsok 33 zahŕňa aj voličov s trvalým pobytom evidovaným len na mesto Prešov. Jeho účasť preto nereprezentuje iba obyvateľov zobrazenej plochy.' if pid == 33 else None, **data})
    totals = {str(c['id']): sum(p['votes'][str(c['id'])] for p in precincts) for c in candidates}
    assert all(c['votes'] == totals[str(c['id'])] for c in candidates)
    city = vote_metrics(totals, sum(p['registered'] for p in precincts), sum(p['participated'] for p in precincts))
    assert city['validVotes'] == 29796
    return {'municipality': MUNICIPALITY, 'city': 'Prešov', 'electionDate': '2026-10-24', 'candidates': candidates, 'precincts': precincts, 'totals': city, 'districts': DISTRICTS}

def polygonal(geom):
    geom = make_valid(geom)
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    return union_all([g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))]) if hasattr(geom, 'geoms') else Polygon()

def fill_holes(geom):
    parts = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
    return union_all([Polygon(p.exterior) for p in parts if isinstance(p, Polygon)])


def coordinate_groups(addresses):
    groups = collections.defaultdict(list)
    for a in addresses:
        groups[tuple(a['coordinates'])].append(a)
    conflicts, mixed = [], []
    for coordinate, group in groups.items():
        assigned = {a['precinct'] for a in group if a['precinct']}
        entry = {'coordinates': coordinate, 'ids': [a['id'] for a in group], 'precincts': [a['precinct'] for a in group]}
        if len(assigned) > 1:
            conflicts.append(entry)
            for a in group:
                if a['precinct']:
                    a['precinct'], a['district'], a['status'] = 0, 0, 'coordinate-conflict'
        elif assigned and any(not a['precinct'] for a in group):
            # A co-located unknown record is not evidence against a known address.
            # Keep both lookup statuses; never copy the known assignment to it.
            mixed.append(entry)
    return groups, conflicts, mixed


def continuous_shapes(seeds, boundary, districts, excluded_ids):
    known = [a for a in seeds if a['precinct']]
    envelope = union_all([a['_point'].buffer(150, quad_segs=6) for a in known])
    envelope = polygonal(fill_holes(polygonal(envelope.buffer(100, quad_segs=6).buffer(-100, quad_segs=6))).intersection(boundary))
    claimed = Polygon()
    overlap_removed = 0
    masks = {}
    for did, district in sorted(districts.items()):
        overlap_removed += district.intersection(claimed).area
        masks[did] = polygonal(district.difference(claimed))
        claimed = union_all([claimed, district])
    buckets = collections.defaultdict(list)
    for did, district in masks.items():
        own = [a for a in known if a['district'] == did and a['id'] not in excluded_ids]
        assert own, f'No resolved seeds for council district {did}'
        cells = list(voronoi_polygons(MultiPoint([a['_point'] for a in own]), extend_to=boundary.envelope.buffer(2000), ordered=True).geoms)
        assert len(cells) == len(own)
        mask = envelope.intersection(district)
        for a, cell in zip(own, cells):
            clipped = polygonal(cell.intersection(mask))
            if not clipped.is_empty:
                buckets[a['precinct']].append(clipped)
    shapes = {pid: polygonal(union_all(geoms)) for pid, geoms in buckets.items()}
    joined = union_all(list(shapes.values()))
    uncovered = envelope.intersection(claimed).difference(joined).area
    assert uncovered < 1, f'Uncovered urban council mask: {uncovered} m²'
    parts = [joined] if isinstance(joined, Polygon) else list(joined.geoms)
    holes = [Polygon(r) for p in parts for r in p.interiors]
    coverage = {'components': len(parts), 'holesOver1M2': sum(h.area > 1 for h in holes),
                'holeAreaM2': round(sum(h.area for h in holes), 2), 'uncoveredDistrictMaskM2': round(uncovered, 6),
                'sourceCouncilOverlapRemovedM2': round(overlap_removed, 2)}
    assert coverage['holesOver1M2'] == 0, coverage
    return shapes, envelope, coverage

def build():
    OUT.mkdir(parents=True, exist_ok=True)
    results = results_data()
    rules = parse_rules()
    by_street = collections.defaultdict(list)
    for rule in rules:
        by_street[rule['key']].append(rule)
    precinct_district = {p['id']: p['district'] for p in results['precincts']}
    addresses = []
    corrections, conflicts, coordinate_corrections = [], [], []
    counts = collections.Counter()
    for f in load('addresses.geojson')['features']:
        p = f['properties']
        street, number = p['streetname'].strip(), house(p['orientatio'])
        original = int(p.get('okrsok') or 0)
        matches = [r for r in by_street[norm(street)] if not r['numbers'] or number in r['numbers']]
        choices = {r['precinct'] for r in matches}
        status = 'arcgis' if original else 'unresolved'
        pid = original
        if len(choices) == 1:
            resolved = next(iter(choices))
            pid = resolved
            status = 'verified' if resolved == original else 'official-rule'
            if resolved != original:
                corrections.append({'addressId': p['FID'], 'street': street, 'number': number, 'originalPrecinct': original, 'precinct': pid, 'source': matches[0]['source'], 'page': matches[0]['page'], 'supplementarySource': matches[0].get('supplementarySource')})
        elif len(choices) > 1:
            conflicts.append({'addressId': p['FID'], 'street': street, 'number': number, 'originalPrecinct': original, 'matches': sorted(choices)})
            pid, status = 0, 'conflict'
        if not street or not number:
            # An explicit whole-street rule can validate a street without orientation
            # number; absent street names can never be assigned from proximity.
            if not street:
                pid, status = 0, 'unresolved'
        counts[status] += 1
        coordinates = [round(x, 7) for x in f['geometry']['coordinates']]
        original_coordinates = None
        if p['FID'] in PACKED_DMS_FIXES:
            registry_id, expected = PACKED_DMS_FIXES[p['FID']]
            assert p['uri_identi'].endswith('/' + registry_id) and coordinates == expected, 'Source coordinate changed; re-review its explicit format correction.'
            original_coordinates = coordinates
            coordinates = [unpack_dms(x) for x in coordinates]
            coordinate_corrections.append({'addressId': p['FID'], 'registryUrl': p['uri_identi'], 'street': street, 'number': number, 'originalCoordinates': original_coordinates, 'coordinates': coordinates, 'method': 'packed-degrees-minutes-seconds-decoded', 'source': load('manifest.json')['addresses']['url']})
        registration = p['fulladdres'].split(',')[1].split('/')[0] if street else p['fulladdres'].split(',')[0]
        label = f'{street} {number}' if street and number else f'{street} · súp. č. {registration} (bez orientačného čísla)' if street else p['fulladdres']
        addresses.append({'id': p['FID'], 'street': street, 'number': number, 'registrationNumber': registration, 'label': label, 'coordinates': coordinates, 'precinct': pid, 'district': precinct_district.get(pid, 0), 'status': status, 'originalPrecinct': original, 'source': 'city-address-layer' if status == 'arcgis' else 'official-october-definition' if pid else 'city-address-layer'})
        if original_coordinates:
            addresses[-1].update({'originalCoordinates': original_coordinates, 'coordinateMethod': 'packed-degrees-minutes-seconds-decoded'})
    print(f'Address matching: {dict(counts)}; {len(corrections)} corrections; {len(conflicts)} ambiguous', flush=True)
    forward = Transformer.from_crs(4326, 32634, always_xy=True).transform
    backward = Transformer.from_crs(32634, 4326, always_xy=True).transform
    boundary = polygonal(union_all([transform(forward, shape(f['geometry'])) for f in load('municipality.geojson')['features']]))
    district_shapes = {int(f['properties']['cislo_volebneho_obvodu']): polygonal(transform(forward, shape(f['geometry'])).intersection(boundary)) for f in load('districts.geojson')['features']}
    groups, duplicate_conflicts, mixed_coordinates = coordinate_groups(addresses)
    for correction in coordinate_corrections:
        address = next(a for a in addresses if a['id'] == correction['addressId'])
        assert district_shapes[address['district']].covers(Point(forward(*address['coordinates']))), correction
    boundary_conflicts = []
    for a in addresses:
        a['_point'] = Point(forward(*a['coordinates']))
        if a['precinct'] and not district_shapes[a['district']].buffer(0.5).covers(a['_point']):
            boundary_conflicts.append({'addressId': a['id'], 'precinct': a['precinct'], 'district': a['district'], 'coordinates': a['coordinates'], 'reason': 'Assigned address outside council-district polygon; lookup retained, area omitted at this point.'})
    print(f'Coordinate conflicts: {len(duplicate_conflicts)}; addresses outside district boundary: {len(boundary_conflicts)}', flush=True)
    seeds = [next((a for a in group if a['precinct']), group[0]) for group in groups.values() if boundary.covers(group[0]['_point'])]
    shapes, envelope, area_coverage = continuous_shapes(seeds, boundary, district_shapes, {c['addressId'] for c in boundary_conflicts})
    features = []
    geometry_checks = []
    for precinct in results['precincts']:
        pid = precinct['id']
        geometry = shapes.get(pid, Polygon())
        assert not geometry.is_empty, f'No area for precinct {pid}'
        assert geometry.is_valid
        own = [a for a in addresses if a['precinct'] == pid]
        outside = [a['id'] for a in own if not geometry.buffer(0.5).covers(a['_point'])]
        expected_outside = {c['addressId'] for c in boundary_conflicts if c['precinct'] == pid}
        unexpected = [i for i in outside if i not in expected_outside]
        assert not unexpected, (pid, unexpected)
        geometry_checks.append({'precinct': pid, 'addresses': len(own), 'contained': len(own) - len(outside), 'flaggedOutside': outside, 'areaM2': round(geometry.area, 2)})
        precinct['addressCount'] = len(own)
        bounds = transform(backward, geometry).bounds
        precinct['bounds'] = list(bounds)
        # Keep coverage-preserving coordinates. Rounded WGS84 saves space without
        # independent polygon simplification opening gaps between adjacent cells.
        features.append({'type': 'Feature', 'id': pid, 'properties': {'precinct': pid, 'district': precinct['district'], 'municipality': MUNICIPALITY, 'approximate': True}, 'geometry': mapping(transform(backward, geometry))})
    known = [shapes[p] for p in range(1, 67)]
    overlap = sum(g.area for g in known) - union_all(known).area
    assert abs(overlap) < 1, f'Overlapping precincts: {overlap} m²'
    unknown = shapes.get(0, Polygon())
    unknown_geojson = {'type': 'FeatureCollection', 'features': [] if unknown.is_empty else [{'type': 'Feature', 'properties': {'unknown': True}, 'geometry': mapping(transform(backward, unknown))}]}
    audit = {'sourceAddressCount': len(addresses), 'originalAssigned': sum(a['originalPrecinct'] > 0 for a in addresses), 'originalUnassigned': sum(a['originalPrecinct'] == 0 for a in addresses), 'resolved': sum(a['precinct'] > 0 for a in addresses), 'unresolved': sum(a['precinct'] == 0 for a in addresses), 'statusCounts': dict(collections.Counter(a['status'] for a in addresses)), 'corrections': corrections, 'ruleConflicts': conflicts, 'duplicateCoordinateGroups': sum(len(g) > 1 for g in groups.values()), 'coordinateConflicts': duplicate_conflicts, 'mixedAssignmentCoordinates': mixed_coordinates, 'boundaryConflicts': boundary_conflicts, 'geometryChecks': geometry_checks, 'areaCoverage': area_coverage, 'overlapAreaM2': round(overlap, 6), 'parameters': {'crs': 'EPSG:32634', 'addressBufferM': 150, 'closingGapM': 200, 'fillInteriorHoles': True, 'partition': 'nearest-resolved-address-within-council-district'}, 'notes': ['No individual voting behavior is available or inferred.', 'Objects absent from the electoral address list do not carve holes in display areas; lookup never infers their assignment from proximity.', 'Council-boundary conflicts retain source lookup assignments but do not extend estimated areas beyond official polygons.']}
    for a in addresses:
        del a['_point']
    audit['coordinateCorrections'] = coordinate_corrections
    manifest = load('manifest.json')
    results['sources'] = manifest
    for a in addresses:
        if a['id'] in REVIEWED_OBJECTS:
            a['objectReview'] = REVIEWED_OBJECTS[a['id']]
    public_addresses = [a for a in addresses if a['street'] and not a.get('objectReview', {}).get('excludeFromPublicLookup')]
    results['coverage'] = {'searchableAddresses': len(public_addresses), 'electoralAddresses': audit['resolved'], 'objectsOutsideElectoralList': sum(not a['precinct'] for a in public_addresses)}
    results['bounds'] = list(transform(backward, envelope).bounds)
    results['snapshotDate'] = max(x['fetchedAt'] for x in manifest.values())[:10]
    save('results.json', results)
    save('addresses.json', public_addresses)
    # Retain full registry provenance locally; number-only records are excluded
    # from the public lookup and address-point display.
    (ROOT / 'tmp').mkdir(exist_ok=True)
    (ROOT / 'tmp' / 'registry-addresses.json').write_text(json.dumps(addresses, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    save('precincts.geojson', {'type': 'FeatureCollection', 'features': features})
    save('unknown.geojson', unknown_geojson)
    save('boundary.geojson', {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {}, 'geometry': mapping(transform(backward, boundary))}]})
    save('audit.json', audit)
    save('street-rules.json', rules)
    save('sources.json', manifest)
    print(json.dumps({k: audit[k] for k in ['sourceAddressCount', 'resolved', 'unresolved', 'overlapAreaM2']}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build()
