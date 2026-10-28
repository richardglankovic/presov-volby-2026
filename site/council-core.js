// Remove the party view through this registration; candidate results do not depend on it.
export const COUNCIL_PARTY_VIEW_ENABLED = true;
export const COUNCIL_VIEWS = ['overview', 'candidate', ...(COUNCIL_PARTY_VIEW_ENABLED ? ['party'] : [])];

export function ballotSupport(votes, validBallots) {
  return Number.isFinite(votes) && Number.isFinite(validBallots) && validBallots > 0 && votes >= 0 && votes <= validBallots
    ? 100 * votes / validBallots : null;
}

export function selectionShare(votes, candidateVotes) {
  return Number.isFinite(votes) && Number.isFinite(candidateVotes) && candidateVotes > 0 && votes >= 0 && votes <= candidateVotes
    ? 100 * votes / candidateVotes : null;
}

export function councilScope(data, state) {
  return state.precinct ? data.precincts.find(p => p.id === state.precinct)
    : state.district ? data.districts.find(d => d.id === state.district) : data.totals;
}

export function scopeCandidates(data, state) {
  const district = state.precinct ? data.precincts.find(p => p.id === state.precinct)?.district : state.district;
  return data.candidates.filter(c => !district || c.district === district);
}

export function scopeSubjects(data, state) {
  // Candidate totals are district-wide, so precinct selection never reshuffles choices.
  const totals = new Map();
  for (const c of scopeCandidates(data, state)) totals.set(c.subject, (totals.get(c.subject) ?? 0) + c.votes);
  return data.subjects.filter(s => totals.has(s.id))
    .sort((a, b) => totals.get(b.id) - totals.get(a.id) || a.name.localeCompare(b.name, 'sk'));
}

export function subjectResult(data, result, subject) {
  const candidates = data.candidates.filter(c => c.subject === subject && Object.hasOwn(result.votes, c.id));
  const votes = candidates.reduce((sum, c) => sum + result.votes[c.id], 0);
  return { votes, share: candidates.length ? selectionShare(votes, result.candidateVotes) : null,
    nominees: candidates.length, seats: candidates.filter(c => c.elected).length, candidates };
}

export function councilValue(data, state, precinct) {
  if (state.district && state.district !== precinct.district) return null;
  if (state.view === 'candidate' && state.candidate) return ballotSupport(precinct.votes[state.candidate], precinct.validBallots);
  if (state.view === 'party' && state.subject) return subjectResult(data, precinct, state.subject).share;
  return null;
}

export function councilExtremes(data, state) {
  const rows = data.precincts.map(p => ({ ...p, value: councilValue(data, state, p) })).filter(p => Number.isFinite(p.value));
  return { highest: [...rows].sort((a, b) => b.value - a.value || a.id - b.id).slice(0, 3),
    lowest: [...rows].sort((a, b) => a.value - b.value || a.id - b.id).slice(0, 3) };
}

export function councilDomain(data, state) {
  if (!state.relative) return [0, 100];
  const values = data.precincts.map(p => councilValue(data, state, p)).filter(Number.isFinite);
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 100];
}

export function parseCouncilState(search, data, partyEnabled = COUNCIL_PARTY_VIEW_ENABLED) {
  const q = new URLSearchParams(search);
  const views = ['overview', 'candidate', ...(partyEnabled ? ['party'] : [])];
  let corrected = false;
  let view = views.includes(q.get('view')) ? q.get('view') : 'overview';
  if (q.has('view') && !views.includes(q.get('view'))) corrected = true;
  let district = data.districts.some(d => d.id === Number(q.get('district'))) ? Number(q.get('district')) : null;
  let precinct = data.precincts.find(p => p.id === Number(q.get('precinct'))) ?? null;
  const invalidDistrict = q.has('district') && !district;
  const mismatch = precinct && district && precinct.district !== district;
  if (mismatch) { corrected = true; view = 'overview'; }
  if (invalidDistrict || q.has('precinct') && !precinct) corrected = true;
  if (precinct) district = precinct.district;
  const person = !mismatch && !invalidDistrict && district && data.candidates.find(c => c.district === district && c.ballot === Number(q.get('candidate')));
  if (q.has('candidate') && !person) { corrected = true; view = 'overview'; }
  const subject = partyEnabled && data.subjects.some(s => s.id === q.get('subject')) ? q.get('subject') : null;
  if (q.has('subject') && !subject) { corrected = true; view = 'overview'; }
  return { election: 'council', view: corrected ? 'overview' : view, district, precinct: precinct?.id ?? null,
    candidate: corrected ? null : person?.id ?? null, subject: corrected ? null : subject, relative: !['absolute', 'shared'].includes(q.get('scale')),
    points: q.get('points') === '1', corrected };
}

export function councilQuery(state, data) {
  const q = new URLSearchParams({ election: 'council' });
  if (state.view !== 'overview') q.set('view', state.view);
  if (state.district) q.set('district', state.district);
  if (state.precinct) q.set('precinct', state.precinct);
  if (state.view === 'candidate' && state.candidate) {
    const c = data.candidates.find(c => c.id === state.candidate);
    if (c) { q.set('candidate', c.ballot); q.set('district', c.district); }
  }
  if (state.view === 'party' && state.subject) q.set('subject', state.subject);
  if (['candidate', 'party'].includes(state.view) && !state.relative) q.set('scale', 'absolute');
  if (state.points) q.set('points', '1');
  return q.toString();
}
