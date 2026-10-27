export const PALETTE = ['#e9edf9', '#a4b2e2', '#536dc4', '#1f367c'];
export const UNKNOWN_COLOR = '#abb5bb';
export const WINNER_MARGIN_MAX = 40;

export function normalize(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^ulica | ulica$/g, '');
}

export function rankCandidates(candidates, result) {
  return [...candidates].sort((a, b) => result.votes[b.id] - result.votes[a.id] || a.id - b.id);
}

export function turnoutExtremes(precincts, count = 3) {
  const valid = precincts.filter(p => Number.isFinite(p.registered) && p.registered > 0 && Number.isFinite(p.participated) && p.participated >= 0 && p.participated <= p.registered)
    .map(p => ({ ...p, turnout: 100 * p.participated / p.registered }));
  return {
    highest: [...valid].sort((a, b) => b.turnout - a.turnout || a.id - b.id).slice(0, count),
    lowest: [...valid].sort((a, b) => a.turnout - b.turnout || a.id - b.id).slice(0, count),
  };
}

export function winningMargin(result) {
  const votes = Object.entries(result?.votes ?? {});
  if (votes.length < 2 || votes.some(([id, n]) => !Number.isInteger(Number(id)) || !Number.isFinite(n) || n < 0)) return null;
  const total = votes.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return null;
  votes.sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  const tied = votes[0][1] === votes[1][1];
  return { winnerId: tied ? null : Number(votes[0][0]), runnerUpId: tied ? null : Number(votes[1][0]), points: 100 * (votes[0][1] - votes[1][1]) / total };
}

export function winnerMarginColor(color, margin) {
  if (!/^#[0-9a-f]{6}$/i.test(color ?? '') || !Number.isFinite(margin) || margin < 0) return UNKNOWN_COLOR;
  const base = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  // A visible minimum tint preserves the winner's identity in close races.
  // 0 / 20 / 40 percentage points use a pale tint / base hue / darker shade.
  const stops = [base.map(v => 255 + .28 * (v - 255)), base, base.map(v => .7 * v)];
  const t = Math.min(1, margin / WINNER_MARGIN_MAX) * 2;
  const segment = Math.min(1, Math.floor(t));
  const fraction = t - segment;
  return '#' + stops[segment].map((v, i) => Math.round(v + fraction * (stops[segment + 1][i] - v)).toString(16).padStart(2, '0')).join('');
}

export function domainFor(precincts, candidate, relative) {
  if (!relative) return [0, 100];
  const values = precincts.map(p => p.shares[candidate]).filter(Number.isFinite);
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 100];
}

export function colorAt(value, domain = [0, 100]) {
  if (!Number.isFinite(value)) return UNKNOWN_COLOR;
  // Equal-valued relative ranges have one middle shade, never divide by zero.
  const t = domain[1] === domain[0] ? .5 : Math.max(0, Math.min(1, (value - domain[0]) / (domain[1] - domain[0])));
  const segment = Math.min(PALETTE.length - 2, Math.floor(t * (PALETTE.length - 1)));
  const f = t * (PALETTE.length - 1) - segment;
  const rgb = PALETTE.slice(segment, segment + 2).map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  return '#' + rgb[0].map((v, i) => Math.round(v + (rgb[1][i] - v) * f).toString(16).padStart(2, '0')).join('');
}

export function searchAddresses(addresses, query, limit = 8) {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  const tokens = needle.split(' ');
  const scored = [];
  for (const a of addresses) {
    const key = a.searchKey ?? normalize(a.label);
    const words = key.split(' ');
    if (!tokens.every(t => /^\d/.test(t) ? words.includes(t) : key.includes(t))) continue;
    let score = key === needle ? 0 : key.startsWith(needle) ? 1 : 2;
    if (!a.precinct) score += .1;
    scored.push({ a, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.a.label.localeCompare(b.a.label, 'sk', { numeric: true }) || a.a.id - b.a.id).slice(0, limit).map(x => x.a);
}

export function parseState(search, candidateIds, precinctIds) {
  const p = new URLSearchParams(search);
  const view = ['winner', 'candidate', 'turnout'].includes(p.get('view')) ? p.get('view') : 'winner';
  const candidate = candidateIds.includes(Number(p.get('candidate'))) ? Number(p.get('candidate')) : 5;
  const precinct = precinctIds.includes(Number(p.get('precinct'))) ? Number(p.get('precinct')) : null;
  return { view, candidate, relative: !['absolute', 'shared'].includes(p.get('scale')), precinct, points: p.get('points') === '1' };
}

export function stateQuery(state) {
  const p = new URLSearchParams();
  if (state.view !== 'winner') p.set('view', state.view);
  if (state.view === 'candidate') {
    p.set('candidate', state.candidate);
    if (!state.relative) p.set('scale', 'absolute');
  }
  if (state.precinct) p.set('precinct', state.precinct);
  if (state.points) p.set('points', '1');
  return p.toString();
}
