import { ballotSupport, councilDomain, councilExtremes, councilScope, scopeCandidates, subjectResult } from './council-core.js';

const fmt = new Intl.NumberFormat('sk-SK');
const dec = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n = value => fmt.format(value);
const pct = value => Number.isFinite(value) ? dec.format(value) + ' %' : '—';
const countLabel = (value, one, few, many) => `${n(value)} ${value === 1 ? one : value >= 2 && value <= 4 ? few : many}`;
const mandates = value => countLabel(value, 'mandát', 'mandáty', 'mandátov');
const nominees = value => countLabel(value, 'kandidát', 'kandidáti', 'kandidátov');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const BALLOT_LABEL = 'Podiel platných lístkov s hlasom pre kandidáta';
export const SUBJECT_LABEL = 'Podiel zo všetkých hlasov pre kandidátov';
const ballotNote = 'Volič mohol označiť viac kandidátov. Percentá vyjadrujú podiel platných lístkov a ich súčet môže presiahnuť 100 %.';
const subjectNote = 'Sčítavame hlasy jednotlivých kandidátov subjektu. Nejde o podiel jednotlivých voličov. Výsledok ovplyvňuje aj počet kandidátov a mandátov v obvode.';

function candidateRows(data, candidates, result, { divider = false, active = null } = {}) {
  const sorted = [...candidates].sort((a, b) => result.votes[b.id] - result.votes[a.id] || a.ballot - b.ballot);
  const lastElected = divider ? sorted.findLastIndex(c => c.elected) : -1;
  return sorted.map((c, i) => {
    const share = ballotSupport(result.votes[c.id], result.validBallots);
    const subject = data.subjects.find(s => s.id === c.subject);
    return `<div class="candidate-row council-candidate${active === c.id ? ' is-active' : ''}"><div class="candidate-row-head"><button class="candidate-name" data-council-candidate="${c.id}">${esc(c.name)}${c.elected ? '<span class="winner-tag">ZVOLENÝ</span>' : ''}</button><span class="candidate-numbers">${pct(share)}<small>${n(result.votes[c.id])}</small></span></div><small class="council-subject-label">${esc(subject.independent ? 'Nezávislý kandidát' : subject.name)}</small><div class="candidate-track" aria-hidden="true"><div class="candidate-bar" style="width:${share ?? 0}%;background:var(--accent)"></div></div></div>${i === lastElected && i < sorted.length - 1 ? '<p class="elected-divider">Ďalší kandidáti</p>' : ''}`;
  }).join('');
}

function ranking(data, mayor, state) {
  const extremes = councilExtremes(data, state);
  return [['Najsilnejšie okrsky', extremes.highest], ['Najslabšie okrsky', extremes.lowest]].map(([title, rows]) => `<section class="ranking-group"><h3>${title}</h3><ol class="ranking-list">${rows.map(p => {
    const place = mayor.precincts.find(b => b.id === p.id);
    const support = state.view === 'candidate' ? { votes: p.votes[state.candidate], total: p.validBallots } : { votes: subjectResult(data, p, state.subject).votes, total: p.candidateVotes };
    return `<li><button class="ranking-row${state.precinct === p.id ? ' is-selected' : ''}" data-council-precinct="${p.id}" aria-pressed="${state.precinct === p.id}"><span class="ranking-row-head"><strong>Okrsok ${p.id}</strong><strong>${pct(p.value)}</strong></span><span class="ranking-location">${esc(place.pollingPlace)}</span><span class="ranking-count">${n(support.votes)} z ${n(support.total)} ${state.view === 'candidate' ? 'platných lístkov' : 'hlasov pre kandidátov'}</span></button></li>`;
  }).join('')}</ol></section>`).join('');
}

function subjectRows(data, result, active = null) {
  return data.subjects.map(s => ({ ...s, result: subjectResult(data, result, s.id) }))
    .filter(s => s.result.nominees > 0)
    .sort((a, b) => b.result.votes - a.result.votes || a.name.localeCompare(b.name, 'sk'))
    .map(s => `<button class="subject-row${active === s.id ? ' is-active' : ''}" data-council-subject="${s.id}"><span><strong>${esc(s.name)}</strong><small>${s.result.nominees ? `${nominees(s.result.nominees)} · ${mandates(s.result.seats)}` : 'Bez kandidátov v obvode'}</small></span><span class="subject-numbers">${pct(s.result.share)}<small>${n(s.result.votes)} hlasov</small></span></button>`).join('');
}

export function councilPanel(data, mayor, state, comparisonOpen = true) {
  const d = data.districts.find(d => d.id === state.district);
  const p = mayor.precincts.find(p => p.id === state.precinct);
  const result = councilScope(data, state);
  const people = scopeCandidates(data, state);
  const header = `<p class="council-ballots">${n(result.validBallots)} platných lístkov vo voľbe poslancov${d ? ` · ${mandates(d.seats)} v obvode` : ' · 31 mandátov'}</p>`;
  const title = p ? `Okrsok ${p.id}` : d ? `Obvod ${d.id}` : 'Prešov';
  const subtitle = p ? p.pollingPlace : d ? d.name : 'Voľba poslancov · 6 volebných obvodov';
  let html = header;
  if (state.view === 'party') {
    const subject = data.subjects.find(s => s.id === state.subject);
    if (!subject) {
      html += '<h3 class="council-section-title">Mandáty v zastupiteľstve</h3><p class="council-note">Číslo mandátov vyjadruje zvolené osoby, nie podiel hlasov. Vyberte subjekt a zobrazte jeho podporu na mape.</p>';
      const seats = data.subjects.map(s => ({ ...s, ...subjectResult(data, result, s.id) })).filter(s => s.seats).sort((a, b) => b.seats - a.seats || a.name.localeCompare(b.name, 'sk'));
      html += '<div class="seat-summary">' + seats.map(s => `<button data-council-subject="${s.id}"><strong>${s.seats}</strong><span>${esc(s.name)}</span></button>`).join('') + '</div>';
      html += `<h3 class="council-section-title">${SUBJECT_LABEL}</h3>${subjectRows(data, result)}`;
    } else {
      const r = subjectResult(data, result, subject.id);
      const benchmark = d ? d : data.totals;
      const b = subjectResult(data, benchmark, subject.id);
      html += `<section class="candidate-focus"><p class="eyebrow">STRANA / KOALÍCIA</p><h3>${esc(subject.name)}</h3><div class="candidate-focus-share">${pct(r.share)}</div><p class="candidate-focus-count">${r.nominees ? `${n(r.votes)} z ${n(result.candidateVotes)} hlasov pre kandidátov` : 'Bez kandidátov v tomto obvode.'}</p><p class="council-note">${SUBJECT_LABEL}</p><p class="candidate-benchmark">${nominees(r.nominees)} · ${mandates(r.seats)} v ${d ? 'obvode' : 'meste'}${p ? `<br>${d ? 'Obvod' : 'Prešov'} celkovo: ${pct(b.share)}` : ''}</p></section>`;
      if (r.nominees) html += ranking(data, mayor, state);
      if (p) html += `<details class="candidate-comparison" ${comparisonOpen ? 'open' : ''}><summary>Všetky subjekty v tomto okrsku</summary>${subjectRows(data, result, subject.id)}</details><h3 class="council-section-title">Kandidáti vybraného subjektu</h3><p class="council-note">${BALLOT_LABEL}</p>${candidateRows(data, r.candidates, result)}`;
    }
    html += `<p class="council-note metric-explanation">${subjectNote}</p><p class="council-note">Nezávislí kandidáti spolu sú súhrnom navzájom nezávislých osôb, nie jednou stranou alebo spoločným tímom.</p>`;
  } else if (state.view === 'candidate' && state.candidate) {
    const c = data.candidates.find(c => c.id === state.candidate);
    const share = ballotSupport(result.votes[c.id], result.validBallots);
    const b = ballotSupport(d.votes[c.id], d.validBallots);
    const diff = share === null || b === null ? null : share - b;
    html += `<section class="candidate-focus"><p class="eyebrow">PODPORA KANDIDÁTA${c.elected ? ' · ZVOLENÝ' : ''}</p><h3>${esc(c.name)}</h3><p class="council-note">${esc(data.subjects.find(s => s.id === c.subject).independent ? 'Nezávislý kandidát' : data.subjects.find(s => s.id === c.subject).name)}</p><div class="candidate-focus-share">${pct(share)}</div><p class="candidate-focus-count">${n(result.votes[c.id])} z ${n(result.validBallots)} platných lístkov</p><p class="council-note">${BALLOT_LABEL}</p>${p ? `<p class="candidate-benchmark">Obvod celkovo: ${pct(b)} · ${n(c.votes)} hlasov<br><strong>${diff === null ? 'Podiel nemožno vypočítať.' : Math.abs(diff) < .05 ? 'Rozdiel oproti obvodu je menší než 0,1 p. b.' : `O ${dec.format(Math.abs(diff))} p. b. ${diff > 0 ? 'viac' : 'menej'} než v obvode.`}</strong></p>` : ''}</section>`;
    if (p) html += `<details class="candidate-comparison" ${comparisonOpen ? 'open' : ''}><summary>Všetci kandidáti v tomto okrsku</summary><p class="council-note">${BALLOT_LABEL}</p>${candidateRows(data, people, result, { active: c.id })}</details>`;
    html += ranking(data, mayor, state) + `<p class="council-note metric-explanation">${ballotNote}</p>`;
  } else if (d) {
    html += `<h3 class="council-section-title">${state.view === 'candidate' ? 'Vyberte kandidáta' : p ? 'Výsledky v okrsku' : 'Výsledky v obvode'}</h3><p class="council-note">${BALLOT_LABEL}. Značka Zvolený označuje výsledok v celom obvode.</p>${candidateRows(data, people, result, { divider: !p })}<p class="council-note metric-explanation">${ballotNote}</p>`;
  } else {
    html += `<p class="council-intro">${state.view === 'candidate' ? 'Najprv vyberte volebný obvod. Potom si môžete zvoliť konkrétneho kandidáta.' : 'Vyberte svoj obvod na mape, zo zoznamu alebo vyhľadajte adresu. Pozrite si zvolených poslancov aj výsledky všetkých kandidátov.'}</p><div class="district-cards">${data.districts.map(d => `<button class="district-card" data-council-district="${d.id}"><span class="eyebrow">OBVOD ${d.id}</span><strong>${esc(d.name)}</strong><small>${mandates(d.seats)} · ${d.precincts.length} okrskov</small></button>`).join('')}</div>`;
  }
  return { title, subtitle, kicker: d ? `VOLEBNÝ OBVOD ${d.id} / ${d.name.toLocaleUpperCase('sk')}` : 'POSLANCI / CELÉ MESTO', html };
}

export function councilLegend(data, state) {
  const c = data.candidates.find(c => c.id === state.candidate);
  const s = data.subjects.find(s => s.id === state.subject);
  const selected = state.view === 'candidate' ? c : state.view === 'party' ? s : null;
  if (!selected) return '<div class="legend-title">Volebné obvody mesta Prešov</div><p class="legend-note">Neutrálne plochy označujú obvody, nie volebný výsledok. Vyberte obvod alebo subjekt.</p>';
  const domain = councilDomain(data, state);
  return `<div class="legend-title">${esc(selected.name)}</div><p class="council-legend-metric">${state.view === 'candidate' ? BALLOT_LABEL : SUBJECT_LABEL}</p><div class="legend-gradient"></div><div class="legend-ticks">${[domain[0], (domain[0] + domain[1]) / 2, domain[1]].map(pct).map(t => `<span>${t}</span>`).join('')}</div><p class="legend-note">${state.relative ? 'Relatívna škála v zobrazenom území.' : 'Pevná škála 0–100 %.'} Tmavšia farba znamená vyšší podiel.<br>${state.view === 'candidate' ? 'Ostatné obvody: kandidát tu nekandidoval.' : 'Sivé plochy: bez kandidátov v obvode. Ostatné obvody mimo výberu sú utlmené.'}</p>`;
}
