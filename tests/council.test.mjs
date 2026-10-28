import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ballotSupport, selectionShare, councilScope, scopeCandidates, scopeSubjects, subjectResult, councilValue, councilDomain, councilExtremes, parseCouncilState, councilQuery } from '../site/council-core.js';
import { councilPanel } from '../site/council-ui.js';
const read = name => JSON.parse(readFileSync(new URL('../site/data/' + name, import.meta.url)));
const data = read('council-results.json');
const mayor = read('results.json');
const sum = values => values.reduce((a, b) => a + b, 0);

test('council ballot support and selection share use different denominators, including zero and missing data', () => {
  assert.equal(ballotSupport(60, 100), 60);
  assert.equal(selectionShare(60, 300), 20);
  assert.equal(ballotSupport(0, 100), 0);
  assert.equal(selectionShare(0, 300), 0);
  for (const f of [ballotSupport, selectionShare]) {
    assert.equal(f(0, 0), null); assert.equal(f(undefined, 100), null);
    assert.equal(f(-1, 100), null); assert.equal(f(101, 100), null);
  }
});

test('audited council snapshot reconciles every district and candidate, independently of mayoral vote totals', () => {
  assert.equal(data.candidates.length, 138);
  assert.equal(data.precincts.length, 66);
  assert.equal(sum(data.precincts.map(p => Object.keys(p.votes).length)), 1687);
  assert.equal(data.totals.validBallots, 28505);
  assert.equal(data.totals.candidateVotes, 110113);
  assert.equal(data.candidates.filter(c => c.elected).length, 31);
  assert.deepEqual(data.districts.map(d => d.seats), [7, 3, 4, 5, 4, 8]);
  for (const d of data.districts) {
    const precincts = data.precincts.filter(p => p.district === d.id);
    assert.equal(sum(precincts.map(p => p.validBallots)), d.validBallots);
    assert.equal(sum(precincts.map(p => p.candidateVotes)), d.candidateVotes);
    for (const c of data.candidates.filter(c => c.district === d.id)) {
      assert.equal(sum(precincts.map(p => p.votes[c.id])), c.votes);
      assert.equal(c.votes, d.votes[c.id]);
    }
    for (const p of precincts) {
      assert.equal(sum(Object.values(p.votes)), p.candidateVotes);
      assert.ok(p.candidateVotes <= p.validBallots * d.seats);
      assert.ok(Object.values(p.votes).every(v => Number.isInteger(v) && v >= 0 && v <= p.validBallots));
    }
  }
  assert.equal(sum(data.districts.map(d => d.validBallots)), data.totals.validBallots);
  assert.equal(sum(data.districts.map(d => d.candidateVotes)), data.totals.candidateVotes);
});

test('subjects partition selections without splitting coalitions or making independents a party', () => {
  for (const result of [...data.precincts, ...data.districts, data.totals]) {
    const summaries = data.subjects.map(s => subjectResult(data, result, s.id));
    assert.equal(sum(summaries.map(s => s.votes)), result.candidateVotes);
    assert.ok(Math.abs(sum(summaries.map(s => s.share ?? 0)) - 100) < 1e-9);
  }
  const independents = data.subjects.find(s => s.independent);
  assert.equal(independents.name, 'Nezávislí kandidáti spolu');
  assert.equal(subjectResult(data, data.totals, independents.id).seats, 9);
  const absent = data.subjects.find(s => s.name === 'Volt SK');
  assert.equal(subjectResult(data, data.districts[0], absent.id).share, null);
  assert.equal(subjectResult(data, data.districts[0], absent.id).nominees, 0);
});

test('party choices follow district candidacy, retain zero-vote nominees and include all city subjects', () => {
  assert.equal(scopeSubjects(data, { district: null, precinct: null }).length, data.subjects.length);
  const volt = data.subjects.find(s => s.name === 'Volt SK');
  assert.ok(!scopeSubjects(data, { district: 4 }).some(s => s.id === volt.id));
  assert.ok(scopeSubjects(data, { district: 5 }).some(s => s.id === volt.id));
  assert.deepEqual(scopeSubjects(data, { district: 4, precinct: 36 }), scopeSubjects(data, { district: 4 }));
  const zero = { subjects: [{ id: 'zero' }, { id: 'absent' }], candidates: [{ district: 1, subject: 'zero', votes: 0 }] };
  assert.deepEqual(scopeSubjects(zero, { district: 1 }), [{ id: 'zero' }]);
  const panel = councilPanel(data, mayor, { view: 'party', district: 4, precinct: 36, subject: null });
  assert.ok(!panel.html.includes(`data-council-subject="${volt.id}"`));
});

test('party dropdown ranks city or district totals, breaks ties alphabetically and ignores precinct votes', () => {
  const fixture = {
    subjects: [{ id: 'b', name: 'Beta' }, { id: 'g', name: 'Gama' }, { id: 'a', name: 'Alfa' }],
    candidates: [
      { district: 1, subject: 'a', votes: 120 }, { district: 2, subject: 'a', votes: 30 },
      { district: 1, subject: 'b', votes: 120 }, { district: 2, subject: 'b', votes: 30 },
      { district: 1, subject: 'g', votes: 100 }, { district: 2, subject: 'g', votes: 100 },
    ],
    precincts: [{ id: 1, district: 1, votes: { a: 0, b: 1, g: 50 } }],
  };
  const ids = state => scopeSubjects(fixture, state).map(s => s.id);
  assert.deepEqual(ids({ district: null }), ['g', 'a', 'b']);
  assert.deepEqual(ids({ district: 1 }), ['a', 'b', 'g']);
  assert.deepEqual(ids({ district: 1, precinct: 1 }), ['a', 'b', 'g']);
});

test('shared council links round trip both measures, district, precinct, scale and points', () => {
  for (const view of ['overview', 'candidate', 'party']) {
    const state = { election: 'council', view, district: 4, candidate: '4:11', subject: 'independent', precinct: 32, relative: false, points: true };
    const parsed = parseCouncilState('?' + councilQuery(state, data), data);
    assert.equal(parsed.view, view); assert.equal(parsed.district, 4); assert.equal(parsed.precinct, 32);
    assert.equal(parsed.points, true); assert.equal(parsed.corrected, false);
    if (view === 'candidate') assert.equal(parsed.candidate, '4:11');
    if (view === 'party') assert.equal(parsed.subject, 'independent');
    if (view !== 'overview') assert.equal(parsed.relative, false);
  }
  const wrongDistrict = parseCouncilState('?election=council&view=candidate&district=1&candidate=11&precinct=48', data);
  assert.equal(wrongDistrict.view, 'overview'); assert.equal(wrongDistrict.candidate, null);
  assert.equal(wrongDistrict.district, 6); assert.equal(wrongDistrict.corrected, true);
  const noDistrict = parseCouncilState('?election=council&view=candidate&candidate=11', data);
  assert.equal(noDistrict.candidate, null); assert.equal(noDistrict.view, 'overview');
  const removed = parseCouncilState('?election=council&view=party&subject=independent', data, false);
  assert.equal(removed.view, 'overview'); assert.equal(removed.subject, null);
  assert.equal(parseCouncilState('?district=99&precinct=999', data).corrected, true);
  const unknownDistrict = parseCouncilState('?view=candidate&district=99&candidate=11&precinct=32', data);
  assert.equal(unknownDistrict.candidate, null);
  assert.equal(unknownDistrict.view, 'overview');
});

test('candidate maps, relative scales and rankings stay within the candidate district', () => {
  const state = parseCouncilState('?district=1&view=candidate&candidate=6', data);
  const rows = data.precincts.filter(p => p.district === 1);
  const values = rows.map(p => ballotSupport(p.votes['1:6'], p.validBallots));
  assert.deepEqual(councilDomain(data, state), [Math.min(...values), Math.max(...values)]);
  assert.deepEqual(councilDomain(data, { ...state, relative: false }), [0, 100]);
  assert.equal(councilValue(data, state, data.precincts.find(p => p.district === 2)), null);
  assert.equal(scopeCandidates(data, state).length, 27);
  assert.equal(councilScope(data, state).id, 1);
  const extremes = councilExtremes(data, state);
  assert.ok(extremes.highest.every(p => p.district === 1));
  assert.ok(extremes.lowest.every(p => p.district === 1));
  assert.equal(extremes.highest[0].value, Math.max(...values));
});

test('party city maps exclude non-candidacy, use full precision and recompute scales for district scope', () => {
  const subject = data.subjects.find(s => s.name === 'Volt SK').id;
  const state = { election: 'council', view: 'party', subject, relative: true, district: null };
  const rankings = councilExtremes(data, state);
  assert.ok(rankings.highest.every(p => p.district === 5));
  assert.equal(councilValue(data, state, data.precincts[0]), null);
  assert.deepEqual(councilDomain(data, { ...state, district: 1 }), [0, 100]);
});

test('council display uses official elected status and labels local percentages, rather than declaring precinct winners', () => {
  const state = parseCouncilState('?view=candidate&district=1&candidate=6&precinct=1', data);
  const panel = councilPanel(data, mayor, state, true);
  assert.match(panel.html, /<details[^>]* open>/);
  assert.match(panel.html, /Podiel platných lístkov/);
  assert.doesNotMatch(panel.html, /VÍŤAZ/);
  assert.match(panel.html, /ZVOLENÝ/);
  assert.doesNotMatch(councilPanel(data, mayor, state, false).html, /<details[^>]* open>/);
});

test('flat, missing and tied synthetic results retain zeros and deterministic precinct ordering', () => {
  const synthetic = { candidates: [{ id: '1:1', district: 1 }], precincts: [
    { id: 2, district: 1, validBallots: 100, votes: { '1:1': 0 } },
    { id: 1, district: 1, validBallots: 50, votes: { '1:1': 0 } },
    { id: 3, district: 1, validBallots: 0, votes: { '1:1': 0 } },
  ] };
  const state = { view: 'candidate', candidate: '1:1', relative: true, district: 1 };
  assert.deepEqual(councilDomain(synthetic, state), [0, 0]);
  assert.deepEqual(councilExtremes(synthetic, state).highest.map(p => p.id), [1, 2]);
});
