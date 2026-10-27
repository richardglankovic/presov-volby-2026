import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidateExtremes, candidateSupport, colorAt, domainFor, normalize, parseState, rankCandidates, searchAddresses, stateQuery, turnoutExtremes, winningMargin, winnerMarginColor, UNKNOWN_COLOR } from '../site/core.js';
const read = async name => JSON.parse(await readFile(new URL(`../site/data/${name}`, import.meta.url), 'utf8'));
const results = await read('results.json');
const addresses = await read('addresses.json');
const audit = await read('audit.json');

test('candidate extremes rank raw vote shares across differently sized precincts, including zero support', () => {
  const source = [
    { id: 1, validVotes: 1000, votes: { 3: 501 }, shares: { 3: 50 } },
    { id: 2, validVotes: 100, votes: { 3: 51 }, shares: { 3: 50 } },
    { id: 3, validVotes: 100, votes: { 3: 0 } },
    { id: 4, validVotes: 10, votes: { 3: 5 } },
    { id: 5, validVotes: 0, votes: { 3: 0 } },
    { id: 6, validVotes: 10, votes: { 3: 11 } },
    { id: 7, validVotes: 10, votes: {} },
    { id: 8, validVotes: 20, votes: { 3: 10 } },
  ];
  const before = structuredClone(source);
  const ranked = candidateExtremes(source, 3);
  assert.deepEqual(ranked.highest.map(p => p.id), [2, 1, 4]);
  assert.deepEqual(ranked.lowest.map(p => p.id), [3, 4, 8]);
  assert.deepEqual(source, before);
  assert.deepEqual(candidateExtremes(source, 99), { highest: [], lowest: [] });
  assert.equal(candidateSupport(source[2], 3).share, 0);
  for (const id of results.candidates.map(c => c.id)) {
    const actual = candidateExtremes(results.precincts, id);
    assert.equal(new Set([...actual.highest, ...actual.lowest].map(p => p.id)).size, 6);
    assert.ok(actual.highest.every(p => actual.lowest.every(low => p.support.share >= low.support.share)));
  }
});

test('candidate summaries and city benchmark use valid mayoral votes, independent of turnout and display rounding', () => {
  const local = candidateSupport(results.precincts.find(p => p.id === 28), 3);
  const city = candidateSupport(results.totals, 3);
  assert.deepEqual(local, { votes: 60, total: 420, share: 100 * 60 / 420 });
  assert.equal(city.share, 100 * 7187 / 29796);
  assert.equal((local.share - city.share).toFixed(1), '-9.8');
  assert.equal(candidateSupport({ validVotes: 0, votes: { 3: 0 } }, 3), null);
  assert.equal(candidateSupport({ validVotes: 10, votes: { 3: -1 } }, 3), null);
});

test('turnout extremes use raw participation ratios, exclude undefined rates and break ties by precinct number', () => {
  const source = [
    { id: 1, participated: 501, registered: 1000, turnout: 50 },
    { id: 2, participated: 502, registered: 1000, turnout: 50 },
    { id: 3, participated: 0, registered: 100 },
    { id: 4, participated: 50, registered: 100 },
    { id: 5, participated: 0, registered: 0 },
    { id: 6, participated: 101, registered: 100 },
    { id: 7, participated: null, registered: 100 },
    { id: 8, participated: 100, registered: 200 },
  ];
  const before = structuredClone(source);
  const extremes = turnoutExtremes(source);
  assert.deepEqual(extremes.highest.map(p => p.id), [2, 1, 4]);
  assert.deepEqual(extremes.lowest.map(p => p.id), [3, 4, 8]);
  assert.equal(extremes.highest[0].turnout, 50.2);
  assert.deepEqual(source, before);
  assert.deepEqual(turnoutExtremes([]), { highest: [], lowest: [] });
  const actual = turnoutExtremes(results.precincts);
  assert.equal(new Set([...actual.highest, ...actual.lowest].map(p => p.id)).size, 6);
  assert.ok(actual.highest.every(p => actual.lowest.every(low => p.turnout > low.turnout)));
});

test('66 complete precincts reconcile with official ballot and city totals', () => {
  assert.equal(results.precincts.length, 66);
  assert.deepEqual(results.candidates.map(c => c.id), [1, 2, 3, 4, 5, 6]);
  for (const p of results.precincts) {
    assert.equal(Object.keys(p.votes).length, 6);
    assert.equal(Object.values(p.votes).reduce((a, b) => a + b, 0), p.validVotes);
    assert.ok(p.participated >= p.validVotes && p.registered >= p.participated);
    assert.ok(Math.abs(Object.values(p.shares).reduce((a, b) => a + b, 0) - 100) < 1e-9);
  }
  assert.equal(results.totals.validVotes, 29796);
  assert.equal(results.totals.registered, 68781);
  assert.equal(results.totals.participated, 30396);
  assert.deepEqual(results.totals.votes, { 1: 2545, 2: 2027, 3: 7187, 4: 3964, 5: 12125, 6: 1948 });
  assert.equal(results.precincts.filter(p => p.winner === 5).length, 62);
  assert.equal(results.precincts.filter(p => p.winner === 3).length, 4);
});

test('accent-insensitive lookup respects exact house-number suffixes', () => {
  assert.equal(normalize('Ulica Štefana Náhalku'), normalize('Štefana Náhalku'));
  const exact = searchAddresses(addresses, 'prostejovska 37a');
  assert.ok(exact.length);
  assert.ok(exact.every(a => a.number.toLowerCase() === '37a'));
  assert.equal(exact[0].precinct, 5);
  assert.ok(!searchAddresses(addresses, 'prostejovska 37').some(a => a.number === '37A'));
  assert.deepEqual(searchAddresses(addresses, 'neexistujuca 99999'), []);
  assert.deepEqual(searchAddresses(addresses, 'a'), []);
});

test('2026 moved streets and ambiguous addresses keep source-backed assignment', () => {
  for (const n of ['55', '57', '59']) {
    const matches = addresses.filter(a => normalize(a.street) === 'jesenskeho' && a.number === n);
    assert.ok(matches.length);
    assert.ok(matches.every(a => a.precinct === 2));
  }
  assert.equal(audit.originalAssigned, 9991);
  assert.equal(audit.originalUnassigned, 5172);
  assert.equal(audit.sourceAddressCount, 15163);
  assert.equal(audit.resolved + audit.unresolved, audit.sourceAddressCount);
  assert.ok(audit.corrections.length >= 38);
  assert.ok(addresses.filter(a => a.status === 'coordinate-conflict').every(a => a.precinct === 0));
  assert.ok(addresses.every(a => a.street));
});

test('shared color scales compare percentages; relative scales handle flat or missing data', () => {
  assert.deepEqual(domainFor(results.precincts, 1, false), [0, 100]);
  const domain = domainFor(results.precincts, 1, true);
  assert.ok(domain[0] >= 0 && domain[1] <= 100 && domain[1] > domain[0]);
  assert.equal(colorAt(20), colorAt(20, [0, 100]));
  assert.equal(colorAt(0), '#e9edf9');
  assert.equal(colorAt(100), '#1f367c');
  assert.equal(colorAt(null), UNKNOWN_COLOR);
  assert.match(colorAt(4, [4, 4]), /^#[0-9a-f]{6}$/);
  assert.deepEqual(domainFor([{ shares: { 1: null } }], 1, true), [0, 100]);
});

test('winner margins use the actual top two and percentage points across different precinct sizes', () => {
  const a = winningMargin({ votes: { 1: 40, 2: 35, 3: 25 } });
  const b = winningMargin({ votes: { 1: 400, 2: 350, 3: 250 } });
  assert.deepEqual(a, { winnerId: 1, runnerUpId: 2, points: 5 });
  assert.deepEqual(a, b);
  const p22 = winningMargin(results.precincts.find(p => p.id === 22));
  assert.equal(p22.winnerId, 5);
  assert.equal(p22.runnerUpId, 4, 'Mochnacký, not a fixed comparison with Hagyari');
  assert.ok(p22.points > 34 && p22.points < 35);
  assert.deepEqual(winningMargin({ votes: { 1: 10, 2: 10, 3: 0 } }), { winnerId: null, runnerUpId: null, points: 0 });
  assert.equal(winningMargin({ votes: { 1: 0, 2: 0 } }), null);
  assert.equal(winningMargin({ votes: { 1: 10, 2: null } }), null);
  assert.equal(winningMargin(null), null);
});

test('winner shading shares one margin scale, retains a minimum tint and caps at 40 points', () => {
  const blue = '#536dc4', orange = '#cc6d53';
  const shades = [0, 5, 20, 40].map(n => winnerMarginColor(blue, n));
  const brightness = hex => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(shades.every(s => /^#[0-9a-f]{6}$/.test(s) && s !== '#ffffff'));
  assert.ok(shades.slice(1).every((s, i) => brightness(s) < brightness(shades[i])));
  assert.equal(winnerMarginColor(blue, 20), blue);
  assert.notEqual(winnerMarginColor(blue, 5), winnerMarginColor(orange, 5));
  assert.equal(winnerMarginColor(blue, 40), winnerMarginColor(blue, 100));
  assert.equal(winnerMarginColor(blue, null), UNKNOWN_COLOR);
  assert.equal(winnerMarginColor(blue, -1), UNKNOWN_COLOR);
  assert.equal(winnerMarginColor(undefined, 5), UNKNOWN_COLOR);
});

test('all public view choices survive a share-link round trip; invalid input is safe', () => {
  const s = { view: 'candidate', candidate: 6, precinct: 66, relative: true, points: true };
  assert.deepEqual(parseState(stateQuery(s), [1, 2, 3, 4, 5, 6], results.precincts.map(p => p.id)), s);
  assert.deepEqual(parseState('?view=bogus&candidate=99&precinct=999', [1, 2, 3, 4, 5, 6], [1, 2]), { view: 'winner', candidate: 5, precinct: null, relative: true, points: false });
  const zero = { votes: { 1: 0, 2: 0 } };
  assert.deepEqual(rankCandidates([{ id: 2 }, { id: 1 }], zero).map(c => c.id), [1, 2]);
});

test('relative is the default; optional shared scale and old relative links round trip', () => {
  const candidates = [1, 2, 3, 4, 5, 6];
  const precincts = [1, 2, 3];
  assert.equal(parseState('?view=candidate&candidate=3', candidates, precincts).relative, true);
  assert.equal(parseState('?view=candidate&candidate=3&scale=relative', candidates, precincts).relative, true);
  assert.equal(parseState('?view=candidate&scale=shared', candidates, precincts).relative, false);
  const absolute = { view: 'candidate', candidate: 3, relative: false, precinct: 2, points: false };
  assert.match(stateQuery(absolute), /scale=absolute/);
  assert.deepEqual(parseState(stateQuery(absolute), candidates, precincts), absolute);
  assert.ok(!stateQuery({ ...absolute, relative: true }).includes('scale='));
});

test('geometry covers all precincts without overlaps and exposes every containment exception', async () => {
  const geo = await read('precincts.geojson');
  assert.deepEqual(geo.features.map(f => f.properties.precinct).sort((a, b) => a - b), Array.from({ length: 66 }, (_, i) => i + 1));
  assert.ok(Math.abs(audit.overlapAreaM2) < 1);
  assert.equal(audit.geometryChecks.length, 66);
  const flagged = new Set(audit.boundaryConflicts.map(a => a.addressId));
  for (const check of audit.geometryChecks) {
    assert.ok(check.areaM2 > 0 && check.addresses > 0);
    assert.equal(check.addresses, check.contained + check.flaggedOutside.length);
    assert.ok(check.flaggedOutside.every(id => flagged.has(id)));
  }
});

test('continuous coverage and public lookup exclude anonymous records without guessing object assignments', async () => {
  assert.equal(audit.areaCoverage.holesOver1M2, 0);
  assert.ok(audit.areaCoverage.uncoveredDistrictMaskM2 < 1);
  assert.equal((await read('unknown.geojson')).features.length, 0);
  assert.ok(addresses.every(a => a.street));
  assert.equal(addresses.length, results.coverage.searchableAddresses);
  assert.equal(addresses.filter(a => a.precinct).length, results.coverage.electoralAddresses);
  assert.equal(addresses.find(a => a.id === 7455).precinct, 11);
  assert.equal(addresses.find(a => a.id === 7693).precinct, 16);
  assert.equal(addresses.find(a => a.id === 7814).precinct, 0);
  assert.equal(addresses.find(a => a.id === 1793).precinct, 0);
  assert.ok(!addresses.some(a => a.id === 4804), 'Confirmed boiler-house registration should not appear as a residential address lookup');
});

test('every Mirka Nešpora number in the official electoral list is searchable in its correct precinct', async () => {
  const rules = (await read('street-rules.json')).filter(r => r.key === 'mirka nespora');
  let checked = 0;
  for (const rule of rules) for (const number of rule.numbers) {
    const records = addresses.filter(a => a.street === 'Mirka Nešpora' && a.number === number);
    assert.ok(records.length, `Missing Mirka Nešpora ${number}`);
    assert.ok(records.every(a => a.precinct === rule.precinct));
    checked++;
  }
  assert.equal(checked, 60);
});

test('explicit coordinate-format repairs preserve assignments and retain original source coordinates', () => {
  assert.equal(audit.coordinateCorrections.length, 8);
  const lub = addresses.find(a => a.id === 1040);
  const surdok = addresses.find(a => a.id === 3614);
  assert.equal(lub.precinct, 30);
  assert.equal(surdok.precinct, 28);
  assert.deepEqual(lub.originalCoordinates, [21.1652078, 49.0110595]);
  assert.deepEqual(surdok.originalCoordinates, [21.1454061, 49.0031811]);
  assert.ok(Math.abs(lub.coordinates[0] - 21.2811328) < 1e-7);
  assert.ok(Math.abs(surdok.coordinates[0] - 21.2483503) < 1e-7);
  assert.equal(addresses.find(a => a.id === 13273).coordinateMethod, undefined, 'Do not transform normal coordinates near the city boundary');
});
