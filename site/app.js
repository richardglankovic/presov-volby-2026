import { candidateExtremes, candidateSupport, colorAt, domainFor, normalize, parseState, rankCandidates, searchAddresses, stateQuery, turnoutExtremes, winningMargin, winnerMarginColor, WINNER_MARGIN_MAX, UNKNOWN_COLOR } from './core.js';
import { createBasemapInstaller, prepareBasemap } from './basemap.js';
import { assetURL, compatiblePage, fetchJSON, refreshForLatest, refreshIncompatiblePage, showStartupFailure } from './recovery.js';
import { COUNCIL_PARTY_VIEW_ENABLED, councilDomain, councilQuery, councilValue, parseCouncilState, scopeSubjects, subjectResult } from './council-core.js';
import { councilLegend, councilPanel } from './council-ui.js';

const RELEASE = typeof __APP_RELEASE__ === 'undefined' ? null : __APP_RELEASE__;
const APP_BASE = new URL('./', import.meta.url).href;

const $ = id => document.getElementById(id);
const numberFormat = new Intl.NumberFormat('sk-SK');
const percentFormat = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = n => numberFormat.format(n);
const percent = n => Number.isFinite(n) ? `${percentFormat.format(n)} %` : '—';
const points = n => Number.isFinite(n) ? `${percentFormat.format(n)} p. b.` : '—';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let data, state, addresses = [], searchMatches = [], searchIndex = -1, selectedAddress = null;
let map, maplibre, popup, marker, polygons, unknown, boundary, installBasemap, hoveredId = null, mapReady = false, basemapFailed = false, basemapApplied = false, basemapLoading = false, basemapErrors = 0;
let toastTimer, searchTimer, basemapWatchdog;
let council, districtsGeo, districtLabels = [], mayorMemory, councilMemory, councilLoading = false, councilRetrySearch = null;
const isCouncil = () => state?.election === 'council';
const neutralCouncil = () => isCouncil() && !(state.view === 'candidate' && state.candidate || state.view === 'party' && state.subject);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobileLayout = matchMedia('(max-width:760px)');
let mobileLegendOpen = false;

async function json(path) {
  return fetchJSON(assetURL(path, APP_BASE, RELEASE));
}

async function loadCouncil() {
  if (council) return;
  const [results, geography] = await Promise.all([json('./data/council-results.json'), json('./data/districts.geojson')]);
  if (results.schemaVersion !== 1 || results.municipality !== '524140' || results.districts?.length !== 6 || geography.features?.length !== 6) throw new Error('Invalid council snapshot');
  council = results;
  districtsGeo = geography;
  if (mapReady) addDistrictLayers();
}

async function switchElection(election, search = null) {
  if (election === 'council' && councilLoading) return;
  if (election === 'council') {
    councilLoading = true;
    const button = document.querySelector('[data-election="council"]');
    button.disabled = true;
    button.textContent = 'Načítavam…';
    try { await loadCouncil(); }
    catch (error) {
      console.error('Council data:', error);
      if (await refreshForLatest(RELEASE, APP_BASE, location)) return;
      councilRetrySearch = search;
      $('council-error').hidden = false;
      return;
    } finally { councilLoading = false; button.disabled = false; button.textContent = 'Poslanci'; }
  }
  const wasCouncil = isCouncil();
  if (wasCouncil) councilMemory = { ...state }; else mayorMemory = { ...state };
  const selectedPrecinct = state.precinct;
  const points = state.points;
  if (election === 'council') {
    state = search !== null ? parseCouncilState(search, council) : { ...(councilMemory ?? parseCouncilState('', council)), precinct: selectedPrecinct, points };
    if (selectedPrecinct && search === null) {
      state.district = precinct(selectedPrecinct).district;
      if (state.candidate && !state.candidate.startsWith(state.district + ':')) state.candidate = null;
    }
    if (state.corrected) { toast('Neplatnú kombináciu v odkaze sme upravili. Vyberte obvod a kandidáta znova.'); state.corrected = false; }
  } else state = { ...(mayorMemory ?? parseState('', data.candidates.map(c => c.id), data.precincts.map(p => p.id))), election: 'mayor', precinct: selectedPrecinct, points };
  $('council-error').hidden = true;
  render();
}

function selectDistrict(id, { zoom = true } = {}) {
  clearAddress();
  state.district = council.districts.some(d => d.id === Number(id)) ? Number(id) : null;
  state.precinct = null;
  if (state.candidate && !state.candidate.startsWith(state.district + ':')) state.candidate = null;
  render();
  if (zoom) fitBounds(state.district ? districtBounds(state.district) : data.bounds);
}

function districtBounds(id) {
  const bounds = data.precincts.filter(p => p.district === id).map(p => p.bounds);
  return bounds.length ? [Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])), Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3]))] : data.bounds;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidden = true, 3500);
}

function writeURL() {
  const query = isCouncil() ? councilQuery(state, council) : stateQuery(state);
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
}

function precinct(id) { return data.precincts.find(p => p.id === Number(id)); }
function candidate(id) { return data.candidates.find(c => c.id === Number(id)); }
function currentDomain() { return domainFor(data.precincts, state.candidate, state.relative); }

function precinctColor(p) {
  if (!p) return UNKNOWN_COLOR;
  if (isCouncil()) {
    if (state.district && p.district !== state.district) return '#e2e6e3';
    if (neutralCouncil()) return '#c8d2d1';
    const result = council.precincts.find(r => r.id === p.id);
    if (state.view === 'party' && !subjectResult(council, result, state.subject).nominees) return '#d2d5cf';
    return colorAt(councilValue(council, state, result), councilDomain(council, state));
  }
  if (state.view === 'winner') {
    const margin = winningMargin(p);
    return margin?.winnerId ? winnerMarginColor(candidate(margin.winnerId)?.color, margin.points) : UNKNOWN_COLOR;
  }
  return colorAt(state.view === 'turnout' ? p.turnout : p.shares[state.candidate], state.view === 'turnout' ? [0, 100] : currentDomain());
}

function rankingMarkup(sections, candidateId = null) {
  return sections.map(([title, rows]) => `<section class="ranking-group"><h3>${title}</h3><ol class="ranking-list">${rows.map(p => {
    const support = candidateId ? candidateSupport(p, candidateId) : null;
    const note = !candidateId && p.note;
    const counts = support ? `${integer(support.votes)} z ${integer(support.total)} platných hlasov` : `${integer(p.participated)} z ${integer(p.registered)} voličov`;
    return `<li><button class="ranking-row${state.precinct === p.id ? ' is-selected' : ''}" data-ranked-precinct="${p.id}" aria-pressed="${state.precinct === p.id}"${note ? ` aria-describedby="turnout-note-${p.id}"` : ''}><span class="ranking-row-head"><strong>Okrsok ${p.id}${note ? '<sup aria-hidden="true">*</sup>' : ''}</strong><strong>${percent(support ? support.share : p.turnout)}</strong></span><span class="ranking-location">${escape(p.pollingPlace)}</span><span class="ranking-count">${counts}</span></button></li>`;
  }).join('')}</ol></section>`).join('');
}

function renderTurnoutRanking() {
  const extremes = turnoutExtremes(data.precincts);
  const sections = [['Najvyššia účasť', extremes.highest], ['Najnižšia účasť', extremes.lowest]];
  $('turnout-results').innerHTML = rankingMarkup(sections);
  const notes = [...extremes.highest, ...extremes.lowest].filter(p => p.note);
  for (const p of new Map(notes.map(p => [p.id, p])).values()) {
    $('turnout-results').insertAdjacentHTML('beforeend', `<p class="turnout-context" id="turnout-note-${p.id}">* ${escape(p.note)}</p>`);
  }
}

function candidateRows(result) {
  return rankCandidates(data.candidates, result).map(c => {
    const share = result.shares[c.id];
    const active = state.view === 'candidate' && state.candidate === c.id;
    return `<div class="candidate-row${active ? ' is-active' : ''}"><div class="candidate-row-head"><button class="candidate-name" data-candidate="${c.id}" title="Zobraziť podporu kandidáta ${escape(c.name)}">${escape(c.name)}${result.winner === c.id ? '<span class="winner-tag">VÍŤAZ</span>' : ''}${result.tiedCandidates.includes(c.id) ? '<span class="winner-tag">REMÍZA</span>' : ''}</button><span class="candidate-numbers">${percent(share)}<small>${integer(result.votes[c.id])}</small></span></div><div class="candidate-track" aria-hidden="true"><div class="candidate-bar" style="width:${share ?? 0}%;background:${c.color}"></div></div></div>`;
  }).join('');
}

function renderCandidateFocus(result, selected) {
  const person = candidate(state.candidate);
  const support = candidateSupport(result, person.id);
  const city = candidateSupport(data.totals, person.id);
  let benchmark = '';
  if (selected && city) {
    const difference = support ? support.share - city.share : null;
    const comparison = difference === null ? 'Podiel v okrsku nemožno vypočítať.' : difference === 0 ? 'Rovnaký podiel ako v celom meste.' : Math.abs(difference) < .05 ? 'Rozdiel oproti mestu je menší než 0,1 p. b.' : `O ${points(Math.abs(difference))} ${difference > 0 ? 'viac' : 'menej'} než v celom meste.`;
    benchmark = `<p class="candidate-benchmark">Prešov celkovo: ${percent(city.share)} · ${integer(city.votes)} hlasov<br><strong>${comparison}</strong></p>`;
  }
  $('candidate-focus').innerHTML = `<p class="eyebrow">PODPORA KANDIDÁTA</p><h3>${escape(person.name)}</h3><div class="candidate-focus-share">${percent(support?.share)}</div><p class="candidate-focus-count">${support ? `${integer(support.votes)} z ${integer(support.total)} platných hlasov` : 'Bez platných hlasov pre výpočet podielu.'}</p>${benchmark}`;
  const extremes = candidateExtremes(data.precincts, person.id);
  $('candidate-rankings').innerHTML = rankingMarkup([['Najsilnejšie okrsky', extremes.highest], ['Najslabšie okrsky', extremes.lowest]], person.id);
  if (selected) $('comparison-results').innerHTML = candidateRows(result);
}

function renderResults() {
  $('council-results').hidden = !isCouncil();
  $('clear-district').hidden = !isCouncil() || !state.district;
  $('clear-selection').textContent = isCouncil() ? '← Celý obvod' : '← Celý Prešov';
  if (isCouncil()) {
    for (const id of ['results-metrics', 'candidate-focus', 'candidate-rankings', 'candidate-comparison', 'candidate-heading', 'candidate-results', 'turnout-results', 'winner-lead']) $(id).hidden = true;
    const panel = $('council-results');
    const key = `${state.view}:${state.district}:${state.precinct}`;
    const context = `${key}:${state.candidate}:${state.subject}`;
    if (panel.dataset.context !== context) document.querySelector('.results-panel').scrollTop = 0;
    panel.dataset.context = context;
    const open = panel.dataset.comparisonKey === key ? panel.querySelector('details')?.open ?? true : true;
    const result = councilPanel(council, data, state, open);
    panel.innerHTML = result.html;
    panel.dataset.comparisonKey = key;
    $('results-heading').textContent = result.title;
    $('results-kicker').textContent = result.kicker;
    $('results-subtitle').textContent = result.subtitle;
    $('clear-selection').hidden = !state.precinct;
    $('precinct-explainer').textContent = 'Výsledky opisujú celý okrsok. Zvolení poslanci sa určujú za celý volebný obvod, nie za jednotlivé okrsky.';
    renderAddressNotice();
    return;
  }
  $('council-results').dataset.comparisonKey = '';
  const selected = precinct(state.precinct);
  const result = selected ?? data.totals;
  $('results-kicker').textContent = selected ? `VOLEBNÝ OBVOD ${selected.district} / ${data.districts[selected.district].toLocaleUpperCase('sk')}` : 'CELÉ MESTO';
  $('results-heading').textContent = selected ? `Okrsok ${selected.id}` : 'Prešov';
  $('results-subtitle').textContent = selected ? selected.pollingPlace : 'Voľba primátora · 66 volebných okrskov';
  $('winner-lead').hidden = !selected || state.view !== 'winner';
  if (!$('winner-lead').hidden) {
    const margin = winningMargin(selected);
    $('winner-lead').textContent = !margin ? 'Bez platných hlasov.' : !margin.winnerId ? 'Remíza na prvom mieste.' : `${candidate(margin.winnerId).surname} · náskok ${points(margin.points)} · 2. ${candidate(margin.runnerUpId).surname}`;
  }
  $('clear-selection').hidden = !selected;
  $('turnout-value').textContent = percent(result.turnout);
  $('turnout-count').textContent = `${integer(result.participated)} z ${integer(result.registered)} voličov`;
  $('votes-value').textContent = integer(result.validVotes);
  const turnoutView = state.view === 'turnout';
  const candidateView = state.view === 'candidate';
  $('results-metrics').hidden = candidateView;
  $('candidate-focus').hidden = !candidateView;
  $('candidate-rankings').hidden = !candidateView;
  const comparison = $('candidate-comparison');
  const showComparison = candidateView && Boolean(selected);
  comparison.hidden = !showComparison;
  if (!showComparison) comparison.open = false;
  else if (comparison.dataset.precinct !== String(selected.id)) comparison.open = true;
  comparison.dataset.precinct = showComparison ? String(selected.id) : '';
  $('candidate-heading').hidden = state.view !== 'winner';
  $('candidate-results').hidden = state.view !== 'winner';
  $('turnout-results').hidden = !turnoutView;
  if (turnoutView) renderTurnoutRanking();
  else if (candidateView) renderCandidateFocus(result, selected);
  else $('candidate-results').innerHTML = candidateRows(result);
  $('precinct-explainer').textContent = turnoutView
    ? 'Rebríčky porovnávajú všetkých 66 okrskov v meste. Kliknutím na položku zobrazíte okrsok na mape. Účasť je podiel zúčastnených zo zapísaných voličov.'
    : candidateView ? 'Rebríčky porovnávajú podiel kandidáta zo všetkých platných hlasov v každom okrsku. Kliknutím na položku zobrazíte okrsok na mape.'
    : selected ? `${selected.addressCount} priradených adresných bodov. Podiely kandidátov sú z ${integer(result.validVotes)} platných hlasov v celom okrsku.${selected.note ? ' ' + selected.note : ''}` : 'Kliknite na farebnú plochu alebo vyhľadajte adresu. Zistíte, ako volilo vaše susedstvo.';
  $('precinct-select').value = selected ? selected.id : '';
  renderAddressNotice();
}

function renderAddressNotice() {
  if (selectedAddress) {
    const outsideList = !selectedAddress.precinct;
    $('address-notice').hidden = false;
    $('address-notice').classList.toggle('outside-list', outsideList);
    const objectNote = selectedAddress.number ? 'Objekt nie je samostatne uvedený vo volebnom zozname adries. Register obsahuje aj školy, športoviská a prevádzky.' : 'Tento registračný záznam má iba súpisné číslo, bez orientačného čísla. Nejde o označenie celej ulice.';
    $('address-notice').innerHTML = `<strong>${escape(selectedAddress.label)}</strong><br>${outsideList ? objectNote + ' Výsledky okolia zobrazíte výberom obvodu alebo okrsku.' : `Adresa patrí do okrsku ${selectedAddress.precinct}. Nižšie sú výsledky celého okrsku.`}`;
  } else $('address-notice').hidden = true;
}

function renderLegend() {
  if (isCouncil()) { $('legend').innerHTML = councilLegend(council, state); return; }
  if (state.view === 'winner') {
    const ticks = [0, 10, 20, 30, WINNER_MARGIN_MAX];
    const winners = new Set(data.precincts.map(p => winningMargin(p)?.winnerId).filter(Boolean));
    $('legend').innerHTML = `<div class="legend-title">Víťaz a náskok pred druhým</div><div class="winner-scale-label">Náskok v percentuálnych bodoch (p. b.)</div><div class="winner-legend-row winner-legend-axis"><span></span><span class="winner-legend-ticks">${ticks.map(n => `<span>${n}</span>`).join('')}</span></div>${data.candidates.filter(c => winners.has(c.id)).sort((a, b) => b.votes - a.votes).map(c => `<div class="winner-legend-row"><span>${escape(c.surname)}</span><span class="winner-legend-ramp" style="background:linear-gradient(90deg,${winnerMarginColor(c.color, 0)},${winnerMarginColor(c.color, 20)},${winnerMarginColor(c.color, WINNER_MARGIN_MAX)})"></span></div>`).join('')}<p class="winner-legend-note">Tmavšia farba znamená väčší náskok.${state.points ? '<br>Sivé body: objekty mimo volebného zoznamu adries.' : ''}</p>`;
  } else {
    const domain = state.view === 'turnout' ? [0, 100] : currentDomain();
    const ticks = [domain[0], (domain[0] + domain[1]) / 2, domain[1]];
    const relative = state.view === 'candidate' && state.relative;
    $('legend').innerHTML = `<div class="legend-title">${state.view === 'turnout' ? 'Volebná účasť v okrsku' : escape(candidate(state.candidate).name) + ' · podiel hlasov'}</div><div class="legend-gradient"></div><div class="legend-ticks">${ticks.map(t => `<span>${percent(t)}</span>`).join('')}</div><p class="legend-note">${relative ? 'Relatívna škála: od najslabšieho po najsilnejší okrsok tohto kandidáta.' : 'Spoločná škála 0–100 %. Tmavšia farba znamená vyšší podiel.'}${state.points ? '<br>Sivé body: objekty mimo volebného zoznamu adries.' : ''}</p>`;
  }
}

function syncLegendDisclosure() {
  const expanded = !mobileLayout.matches || mobileLegendOpen;
  $('legend').hidden = !expanded;
  $('legend-toggle').setAttribute('aria-expanded', String(expanded));
}

function renderControls() {
  const councilMode = isCouncil();
  document.body.classList.toggle('council-mode', councilMode);
  document.querySelectorAll('[data-election]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.election === (councilMode ? 'council' : 'mayor'))));
  $('election-label').textContent = councilMode ? 'Voľby poslancov mesta' : 'Voľby primátora mesta';
  document.title = `Ako volil Prešov · ${councilMode ? 'Voľby poslancov' : 'Voľby primátora'} 2026`;
  $('mayor-views').hidden = councilMode;
  $('council-views').hidden = !councilMode;
  $('council-controls').hidden = !councilMode;
  document.querySelector('[data-council-view="party"]').hidden = !COUNCIL_PARTY_VIEW_ENABLED;
  const precincts = data.precincts.filter(p => !councilMode || !state.district || p.district === state.district);
  $('precinct-select').innerHTML = `<option value="">${councilMode && state.district ? 'Celý obvod' : 'Všetky okrsky'}</option>` + precincts.map(p => `<option value="${p.id}">Okrsok ${p.id}</option>`).join('');
  $('precinct-select').value = state.precinct ?? '';
  $('coverage-text').textContent = councilMode ? state.district ? `${precincts.length} okrskov · obvod ${state.district}` : '6 obvodov · 66 okrskov' : '66 z 66 okrskov';
  if (councilMode) {
    $('candidate-controls').hidden = true;
    document.querySelectorAll('[data-council-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.councilView === state.view)));
    $('district-select').innerHTML = '<option value="">Celé mesto · vyberte obvod</option>' + council.districts.map(d => `<option value="${d.id}">${d.id}. ${escape(d.name)}</option>`).join('');
    $('district-select').value = state.district ?? '';
    $('council-candidate').hidden = state.view !== 'candidate';
    $('council-candidate').disabled = !state.district;
    $('council-candidate').innerHTML = `<option value="">${state.district ? 'Vyberte kandidáta…' : 'Najprv vyberte obvod'}</option>` + council.candidates.filter(c => c.district === state.district).sort((a, b) => b.votes - a.votes || a.ballot - b.ballot).map(c => `<option value="${c.id}">${escape(c.name)}${c.elected ? ' · zvolený' : ''}</option>`).join('');
    $('council-candidate').value = state.candidate ?? '';
    const subjects = scopeSubjects(council, state);
    if (state.subject && !subjects.some(s => s.id === state.subject)) state.subject = null;
    $('council-subject').hidden = state.view !== 'party';
    $('council-subject').innerHTML = '<option value="">Vyberte stranu alebo koalíciu…</option>' + subjects.map(s => `<option value="${s.id}">${escape(s.name)}</option>`).join('');
    $('council-subject').value = state.subject ?? '';
    $('council-scale-label').hidden = neutralCouncil();
    $('council-absolute-scale').checked = !state.relative;
    $('point-toggle').setAttribute('aria-pressed', String(state.points));
    return;
  }
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('candidate-controls').hidden = state.view !== 'candidate';
  $('candidate').value = state.candidate;
  $('absolute-scale').checked = !state.relative;
  $('point-toggle').setAttribute('aria-pressed', String(state.points));
}

function render() {
  renderControls();
  renderResults();
  renderLegend();
  recolorMap();
  writeURL();
  requestAnimationFrame(() => map?.resize());
}

function clearAddress() {
  selectedAddress = null;
  $('address-search').value = '';
  marker?.remove();
  marker = null;
}

function selectPrecinct(id, { zoom = true, mobileScroll = false, keepAddress = false } = {}) {
  if (!keepAddress) clearAddress();
  state.precinct = precinct(id)?.id ?? null;
  if (isCouncil() && state.precinct) {
    state.district = precinct(state.precinct).district;
    if (state.candidate && !state.candidate.startsWith(state.district + ':')) state.candidate = null;
  }
  render();
  const p = precinct(state.precinct);
  if (map && zoom && p) fitBounds(p.bounds, { padding: 70, maxZoom: 15.5 });
  if (mobileScroll && matchMedia('(max-width:760px)').matches) $('results-heading').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
}

function fitBounds(b, options = {}) {
  if (map && b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 45, right: 45, bottom: 48, left: 35 }, duration: reducedMotion ? 0 : 700, ...options });
}

function recolorMap() {
  if (!mapReady || !map?.getLayer('precinct-fill')) return;
  const color = ['match', ['get', 'precinct']];
  for (const p of data.precincts) color.push(p.id, precinctColor(p));
  color.push(UNKNOWN_COLOR);
  map.setPaintProperty('precinct-fill', 'fill-color', color);
  const districtOverview = neutralCouncil() && !state.district;
  map.setLayoutProperty('precinct-fill', 'visibility', state.points || districtOverview ? 'none' : 'visible');
  map.setLayoutProperty('unknown-fill', 'visibility', state.points ? 'none' : 'visible');
  map.setLayoutProperty('precinct-outline', 'visibility', state.points || districtOverview ? 'none' : 'visible');
  map.setFilter('precinct-selected', ['==', ['get', 'precinct'], state.precinct ?? -1]);
  if (map.getLayer('address-points')) {
    map.setPaintProperty('address-points', 'circle-color', color);
    map.setLayoutProperty('address-points', 'visibility', state.points ? 'visible' : 'none');
  }
  if (districtsGeo) {
    addDistrictLayers();
    map.setLayoutProperty('district-fill', 'visibility', neutralCouncil() && !state.points ? 'visible' : 'none');
    map.setLayoutProperty('district-outline', 'visibility', isCouncil() ? 'visible' : 'none');
    map.setPaintProperty('district-fill', 'fill-color', ['case', ['==', ['get', 'district'], state.district ?? -1], '#8ba6a7', '#c5cfcc']);
    map.setPaintProperty('district-outline', 'line-width', ['case', ['==', ['get', 'district'], state.district ?? -1], 2, 1]);
    syncDistrictLabels();
  }
  popup?.remove();
  hoveredId = null;
}

function syncDistrictLabels() {
  for (const label of districtLabels) {
    label.element.hidden = !neutralCouncil() || state.points || Boolean(state.district && state.district !== label.id);
    label.element.classList.toggle('is-compact', map.getZoom() < 12.2);
  }
}

function addDistrictLayers() {
  if (!mapReady || !districtsGeo || map.getLayer('district-fill')) return;
  map.addSource('districts', { type: 'geojson', data: districtsGeo });
  map.addLayer({ id: 'district-fill', source: 'districts', type: 'fill', layout: { visibility: 'none' }, paint: { 'fill-color': '#c5cfcc', 'fill-opacity': .25 } }, 'precinct-fill');
  map.addLayer({ id: 'district-outline', source: 'districts', type: 'line', layout: { visibility: 'none' }, paint: { 'line-color': '#506a70', 'line-width': 1, 'line-opacity': .75 } });
  if (!districtLabels.length) districtLabels = districtsGeo.features.map(f => {
    const element = document.createElement('button');
    element.className = 'district-map-label';
    element.hidden = true;
    element.innerHTML = `<strong>Obvod ${f.properties.district}</strong><span>${escape(f.properties.name)}</span>`;
    element.setAttribute('aria-label', `Vybrať obvod ${f.properties.district}: ${f.properties.name}`);
    element.title = f.properties.name;
    element.addEventListener('click', event => { event.stopPropagation(); selectDistrict(f.properties.district); });
    const marker = new maplibre.Marker({ element }).setLngLat(f.properties.labelCoordinates).addTo(map);
    return { id: f.properties.district, element, marker };
  });
}

function pointsData() {
  // Draw source-backed assignments above co-located records outside the list.
  const ordered = [...addresses.filter(a => !a.precinct), ...addresses.filter(a => a.precinct)];
  return { type: 'FeatureCollection', features: ordered.map(a => ({ type: 'Feature', id: a.id, properties: { addressId: a.id, precinct: a.precinct }, geometry: { type: 'Point', coordinates: a.coordinates } })) };
}

function addLayers() {
  mapReady = true;
  const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  const add = layer => map.addLayer(layer, before);
  map.addSource('precincts', { type: 'geojson', data: polygons, promoteId: 'precinct', tolerance: 0 });
  map.addSource('unknown', { type: 'geojson', data: unknown, tolerance: 0 });
  map.addSource('boundary', { type: 'geojson', data: boundary });
  add({ id: 'unknown-fill', source: 'unknown', type: 'fill', paint: { 'fill-color': '#c7cdd0', 'fill-opacity': .45 } });
  add({ id: 'precinct-fill', source: 'precincts', type: 'fill', paint: { 'fill-color': '#536dc4', 'fill-opacity': .63 } });
  add({ id: 'precinct-outline', source: 'precincts', type: 'line', paint: { 'line-color': '#ffffff', 'line-opacity': .88, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, .5, 16, 1.2] } });
  // Keep building detail legible above the election fill at street scale.
  const building = map.getStyle().layers.find(l => l.type === 'fill' && l['source-layer'] === 'building');
  if (building) add({ id: 'building-detail', type: 'line', source: building.source, 'source-layer': 'building', minzoom: 14, paint: { 'line-color': '#627478', 'line-opacity': .34, 'line-width': .6 } });
  add({ id: 'city-boundary', source: 'boundary', type: 'line', paint: { 'line-color': '#657b7c', 'line-width': 1, 'line-dasharray': [4, 4], 'line-opacity': .45 } });
  add({ id: 'precinct-selected', source: 'precincts', type: 'line', filter: ['==', ['get', 'precinct'], -1], paint: { 'line-color': '#233b4b', 'line-width': 2.3, 'line-opacity': .9 } });
  map.addSource('addresses', { type: 'geojson', data: pointsData() });
  add({ id: 'address-points', source: 'addresses', type: 'circle', layout: { visibility: state.points ? 'visible' : 'none' }, paint: { 'circle-color': UNKNOWN_COLOR, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3.5, 18, 6], 'circle-opacity': .92, 'circle-stroke-color': '#fff', 'circle-stroke-width': .5 } });
  recolorMap();
}

function hoverHTML(p, address) {
  if (address && !address.precinct) return `<span class="hover-title">${escape(address.label)}</span>${address.number ? 'Objekt mimo volebného zoznamu adries' : 'Registračný záznam bez orientačného čísla'}`;
  if (isCouncil()) {
    const result = council.precincts.find(r => r.id === p.id);
    let label = `${integer(result.validBallots)} platných lístkov pre poslancov`;
    if (state.view === 'candidate' && state.candidate) label = state.candidate.startsWith(p.district + ':') ? `${council.candidates.find(c => c.id === state.candidate).name}: ${percent(councilValue(council, { ...state, district: null }, result))} platných lístkov` : 'Kandidát v tomto obvode nekandidoval.';
    if (state.view === 'party' && state.subject) {
      const r = subjectResult(council, result, state.subject);
      label = r.nominees ? `${council.subjects.find(s => s.id === state.subject).name}: ${percent(r.share)} hlasov pre kandidátov` : 'Bez kandidátov v obvode';
    }
    return `<span class="hover-title">${address ? escape(address.label) + ' · ' : ''}Okrsok ${p.id} · obvod ${p.district}</span><span class="hover-metric">${escape(label)}</span><small>Kliknutím zobrazíte výsledky celého okrsku.</small>`;
  }
  const name = candidate(p.winner)?.surname ?? (p.validVotes ? 'Remíza' : 'Bez platných hlasov');
  const label = state.view === 'candidate' ? `${candidate(state.candidate).surname}: ${percent(p.shares[state.candidate])}` : state.view === 'turnout' ? `Účasť: ${percent(p.turnout)}` : `${name}${p.winner ? ': ' + percent(p.shares[p.winner]) : ''}`;
  const margin = state.view === 'winner' ? winningMargin(p) : null;
  const lead = margin?.winnerId ? `<span class="hover-runner">2. ${escape(candidate(margin.runnerUpId).surname)}: ${percent(p.shares[margin.runnerUpId])}</span><span class="hover-margin">Náskok: ${points(margin.points)}</span>` : '';
  return `<span class="hover-title">${address ? escape(address.label) + ' · ' : ''}Okrsok ${p.id}</span><span class="hover-metric"><span class="hover-dot" style="background:${precinctColor(p)}"></span>${escape(label)}</span>${lead}<small>Kliknutím zobrazíte výsledky celého okrsku.</small>`;
}

function onMapMove(event) {
  if (!mapReady || event.originalEvent?.pointerType === 'touch') return;
  const features = map.queryRenderedFeatures(event.point, { layers: [state.points ? 'address-points' : 'precinct-fill'] });
  map.getCanvas().style.cursor = features.length ? 'pointer' : '';
  if (!features.length) { popup?.remove(); hoveredId = null; return; }
  const f = features[0];
  const address = state.points ? addresses.find(a => a.id === Number(f.properties.addressId)) : null;
  const p = precinct(f.properties.precinct);
  if (!p && !address) return;
  const hoverKey = `${state.election}:${state.points}:${f.id}:${state.view}:${state.candidate}:${state.subject}`;
  if (hoveredId !== hoverKey) {
    popup.setHTML(hoverHTML(p, address));
    hoveredId = hoverKey;
  }
  popup.setLngLat(event.lngLat).addTo(map);
}

function onMapClick(event) {
  if (!mapReady) return;
  if (neutralCouncil() && !state.points) {
    const districtFeatures = map.queryRenderedFeatures(event.point, { layers: ['district-fill'] });
    if (!state.district && districtFeatures.length) { selectDistrict(Number(districtFeatures[0].properties.district)); return; }
  }
  const features = map.queryRenderedFeatures(event.point, { layers: [state.points ? 'address-points' : 'precinct-fill'] });
  if (!features.length) {
    if (neutralCouncil() && !state.points) {
      const districts = map.queryRenderedFeatures(event.point, { layers: ['district-fill'] });
      if (districts.length) selectDistrict(Number(districts[0].properties.district));
    }
    return;
  }
  const f = features[0];
  if (state.points) {
    const a = addresses.find(a => a.id === Number(f.properties.addressId));
    if (a) selectAddress(a, false);
  } else {
    const id = Number(f.properties.precinct);
    selectPrecinct(state.precinct === id ? null : id, { zoom: false, mobileScroll: true });
  }
  popup?.remove();
}

async function startMap() {
  try {
    [maplibre, polygons, unknown, boundary] = await Promise.all([import('./vendor/maplibre-gl.mjs'), json('./data/precincts.geojson'), json('./data/unknown.geojson'), json('./data/boundary.geojson')]);
    maplibre.setWorkerUrl(assetURL('./vendor/maplibre-gl-worker.mjs', APP_BASE, RELEASE).href);
    map = new maplibre.Map({ container: 'map', style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#edf0eb' } }] }, center: [21.246, 49.003], zoom: 12, maxZoom: 19, minZoom: 10, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
    // Capture readiness now, before a fetch or the initial camera movement can
    // race the one-time map load event.
    installBasemap = createBasemapInstaller(map);
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibre.AttributionControl({ compact: true, customAttribution: 'Výsledky: ŠÚ SR · Geografia: Mesto Prešov' }));
    popup = new maplibre.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '280px' });
    map.on('style.load', () => {
      addLayers();
      basemapApplied = map.getStyle().metadata?.presovBasemap === true;
    });
    map.once('load', () => fitBounds(precinct(state.precinct)?.bounds ?? (isCouncil() && state.district ? districtBounds(state.district) : data.bounds)));
    map.on('idle', () => {
      if (basemapApplied && !basemapFailed) {
        clearTimeout(basemapWatchdog);
        $('map-status').hidden = true;
      }
    });
    map.on('mousemove', onMapMove);
    map.on('zoom', syncDistrictLabels);
    map.on('mouseout', () => { popup.remove(); hoveredId = null; });
    map.on('click', onMapClick);
    map.on('error', event => {
      if (['precincts', 'unknown', 'boundary', 'addresses', 'districts'].includes(event.sourceId)) return;
      basemapErrors++;
      if (basemapErrors > 2) showBasemapFailure('Podkladová mapa sa nepodarila načítať. Farebné plochy, vyhľadávanie a výsledky sú stále dostupné.');
    });
    await loadBasemap();
  } catch (error) {
    console.error('Map initialization:', error);
    if (await refreshForLatest(RELEASE, APP_BASE, location)) return;
    showBasemapFailure('Mapu sa nepodarilo spustiť. Výsledky si môžete prezerať výberom okrsku alebo vyhľadaním adresy.');
  }
}

function showBasemapFailure(message) {
  basemapFailed = true;
  clearTimeout(basemapWatchdog);
  $('map-status').hidden = false;
  $('map-status-text').textContent = message;
  $('retry-basemap').hidden = !map || !installBasemap;
}

async function loadBasemap() {
  if (basemapLoading || !installBasemap) return;
  basemapLoading = true;
  basemapFailed = false;
  basemapApplied = false;
  basemapErrors = 0;
  $('map-status').hidden = false;
  $('map-status-text').textContent = 'Načítavam podkladovú mapu…';
  $('retry-basemap').hidden = true;
  clearTimeout(basemapWatchdog);
  basemapWatchdog = setTimeout(() => showBasemapFailure('Podkladová mapa sa načítava príliš dlho. Výsledky sú dostupné; načítanie podkladu môžete skúsiť znova.'), 20000);
  try {
    const response = await fetch('https://tiles.openfreemap.org/styles/positron', { signal: AbortSignal.timeout(12000), cache: 'reload' });
    if (!response.ok) throw new Error('Basemap style unavailable');
    const style = prepareBasemap(await response.json());
    mapReady = false;
    await installBasemap(style);
  } catch (error) {
    console.warn('Basemap could not be loaded:', error.message);
    showBasemapFailure('Podkladová mapa nie je dostupná. Farebné plochy, vyhľadávanie a výsledky fungujú aj bez nej.');
  } finally {
    basemapLoading = false;
  }
}

function hideSearch() {
  $('search-results').hidden = true;
  $('address-search').setAttribute('aria-expanded', 'false');
  $('address-search').removeAttribute('aria-activedescendant');
  searchIndex = -1;
}

function renderSearch() {
  const query = $('address-search').value;
  searchMatches = searchAddresses(addresses, query);
  searchIndex = -1;
  $('address-search').removeAttribute('aria-activedescendant');
  const show = normalize(query).length >= 2;
  $('search-results').hidden = !show;
  $('address-search').setAttribute('aria-expanded', String(show));
  $('search-results').innerHTML = searchMatches.length ? searchMatches.map((a, i) => `<li id="address-option-${i}" role="option" aria-selected="false" data-address-index="${i}"><span>${escape(a.label)}</span><small>${a.precinct ? 'okrsok ' + a.precinct : a.number ? 'mimo volebného zoznamu' : 'registračný záznam'}</small></li>`).join('') : `<li class="no-result" role="presentation">${addresses.length ? 'Adresa sa nenašla. Skúste názov ulice bez čísla.' : 'Adresy sa ešte načítavajú…'}</li>`;
}

function selectAddress(a, zoom = true) {
  clearAddress();
  selectedAddress = a;
  $('address-search').value = a.label;
  hideSearch();
  selectPrecinct(a.precinct, { zoom: false, keepAddress: true, mobileScroll: true });
  if (map) {
    marker = new maplibre.Marker({ color: a.precinct ? '#203747' : '#7b878c' }).setLngLat(a.coordinates).addTo(map);
    if (zoom) map.flyTo({ center: a.coordinates, zoom: 16, padding: { bottom: 100 }, duration: reducedMotion ? 0 : 800 });
  }
}

function openMethod() { if (!$('method-dialog').open) $('method-dialog').showModal(); }

function bindEvents() {
  document.querySelectorAll('[data-election]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.election !== (isCouncil() ? 'council' : 'mayor')) switchElection(button.dataset.election);
  }));
  $('retry-council').addEventListener('click', () => switchElection('council', councilRetrySearch));
  document.querySelectorAll('[data-council-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.councilView; render(); }));
  $('district-select').addEventListener('change', event => selectDistrict(event.target.value));
  $('council-candidate').addEventListener('change', event => { state.candidate = event.target.value || null; render(); });
  $('council-subject').addEventListener('change', event => { state.subject = event.target.value || null; render(); });
  $('council-absolute-scale').addEventListener('change', event => { state.relative = !event.target.checked; render(); });
  $('clear-district').addEventListener('click', () => selectDistrict(null));
  $('council-results').addEventListener('click', event => {
    const districtButton = event.target.closest('[data-council-district]');
    const personButton = event.target.closest('[data-council-candidate]');
    const subjectButton = event.target.closest('[data-council-subject]');
    const precinctButton = event.target.closest('[data-council-precinct]');
    if (districtButton) { selectDistrict(Number(districtButton.dataset.councilDistrict)); $('results-heading').focus({ preventScroll: !mobileLayout.matches }); }
    else if (personButton) {
      const c = council.candidates.find(c => c.id === personButton.dataset.councilCandidate);
      if (!c) return;
      if (state.district !== c.district) { clearAddress(); state.precinct = null; }
      state.district = c.district;
      state.candidate = c.id;
      state.view = 'candidate';
      render();
      $('results-heading').focus({ preventScroll: !mobileLayout.matches });
    } else if (subjectButton) { state.subject = subjectButton.dataset.councilSubject; state.view = 'party'; render(); $('results-heading').focus({ preventScroll: !mobileLayout.matches }); }
    else if (precinctButton) {
      const id = Number(precinctButton.dataset.councilPrecinct);
      selectPrecinct(state.precinct === id ? null : id, { mobileScroll: true });
    }
  });
  $('legend-toggle').addEventListener('click', () => { mobileLegendOpen = !mobileLegendOpen; syncLegendDisclosure(); });
  $('legend-toggle').addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobileLegendOpen) { mobileLegendOpen = false; syncLegendDisclosure(); }
  });
  mobileLayout.addEventListener('change', syncLegendDisclosure);
  syncLegendDisclosure();
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.view; render(); }));
  $('candidate').addEventListener('change', event => { state.candidate = Number(event.target.value); render(); });
  $('absolute-scale').addEventListener('change', event => { state.relative = !event.target.checked; render(); });
  $('retry-basemap').addEventListener('click', loadBasemap);
  $('point-toggle').addEventListener('click', () => { state.points = !state.points; render(); if (state.points && !addresses.length) toast('Adresné body sa načítavajú…'); });
  ['candidate-results', 'comparison-results'].forEach(id => $(id).addEventListener('click', event => {
    const b = event.target.closest('[data-candidate]');
    if (!b) return;
    state.view = 'candidate';
    state.candidate = Number(b.dataset.candidate);
    render();
    if (id === 'comparison-results') $(id).querySelector(`[data-candidate="${state.candidate}"]`).focus({ preventScroll: true });
  }));
  ['turnout-results', 'candidate-rankings'].forEach(id => $(id).addEventListener('click', event => {
    const b = event.target.closest('[data-ranked-precinct]');
    if (!b) return;
    const precinctId = Number(b.dataset.rankedPrecinct);
    selectPrecinct(state.precinct === precinctId ? null : precinctId);
    $(id).querySelector(`[data-ranked-precinct="${precinctId}"]`).focus({ preventScroll: true });
  }));
  $('precinct-select').addEventListener('change', event => selectPrecinct(event.target.value, { mobileScroll: true }));
  $('clear-selection').addEventListener('click', () => { selectPrecinct(null, { zoom: false }); if (isCouncil() && state.district) fitBounds(districtBounds(state.district)); });
  $('reset-map').addEventListener('click', () => { if (isCouncil()) selectDistrict(null, { zoom: false }); else selectPrecinct(null, { zoom: false }); $('address-search').value = ''; hideSearch(); fitBounds(data.bounds); });
  $('address-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchTimer = null; renderSearch(); }, 90); });
  $('address-search').addEventListener('focus', () => { if ($('address-search').value.length >= 2) renderSearch(); });
  $('address-search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { hideSearch(); return; }
    if (searchTimer && ['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) { clearTimeout(searchTimer); searchTimer = null; renderSearch(); }
    if (event.key === 'Enter' && searchMatches.length && !$('search-results').hidden) { event.preventDefault(); selectAddress(searchMatches[Math.max(0, searchIndex)]); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !searchMatches.length) return;
    event.preventDefault();
    searchIndex = (searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + searchMatches.length) % searchMatches.length;
    $('search-results').hidden = false;
    $('address-search').setAttribute('aria-expanded', 'true');
    $('address-search').setAttribute('aria-activedescendant', `address-option-${searchIndex}`);
    document.querySelectorAll('[data-address-index]').forEach((el, i) => el.setAttribute('aria-selected', String(i === searchIndex)));
  });
  $('search-results').addEventListener('click', event => { const li = event.target.closest('[data-address-index]'); if (li) selectAddress(searchMatches[Number(li.dataset.addressIndex)]); });
  document.addEventListener('click', event => { if (!event.target.closest('.search-wrap')) hideSearch(); });
  $('share').addEventListener('click', async () => {
    writeURL();
    try { await navigator.clipboard.writeText(location.href); toast('Odkaz na toto zobrazenie je skopírovaný.'); }
    catch { toast('Odkaz môžete skopírovať z adresného riadka prehliadača.'); }
  });
  ['method-open', 'sources-open'].forEach(id => $(id).addEventListener('click', openMethod));
  $('method-close').addEventListener('click', () => $('method-dialog').close());
  $('method-dialog').addEventListener('click', event => { if (event.target === $('method-dialog') && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > event.target.clientWidth || event.offsetY > event.target.clientHeight)) $('method-dialog').close(); });
  window.addEventListener('popstate', async () => {
    clearAddress();
    if (new URLSearchParams(location.search).get('election') === 'council') await switchElection('council', location.search);
    else { state = { ...parseState(location.search, data.candidates.map(c => c.id), data.precincts.map(p => p.id)), election: 'mayor' }; render(); }
  });
  window.addEventListener('resize', () => map?.resize());
}

async function start() {
  if (refreshIncompatiblePage(document, RELEASE, APP_BASE, location)) return;
  if (!compatiblePage(document, RELEASE)) {
    showStartupFailure('Stránku sa nepodarilo dokončiť načítať. Skúste načítať aktuálnu verziu.', APP_BASE);
    return;
  }
  try {
    data = await json('./data/results.json');
    state = parseState(location.search, data.candidates.map(c => c.id), data.precincts.map(p => p.id));
    state.election = 'mayor';
    const initialCouncilSearch = new URLSearchParams(location.search).get('election') === 'council' ? location.search : null;
    if (initialCouncilSearch !== null) {
      try { await loadCouncil(); state = parseCouncilState(initialCouncilSearch, council); }
      catch (error) { councilRetrySearch = initialCouncilSearch; $('council-error').hidden = false; console.error('Council data:', error); }
    }
    $('candidate').innerHTML = [...data.candidates].sort((a, b) => b.votes - a.votes).map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('');
    $('precinct-select').insertAdjacentHTML('beforeend', data.precincts.map(p => `<option value="${p.id}">Okrsok ${p.id}</option>`).join(''));
    $('audit-summary').textContent = 'Vyhľadávanie používa priradenia z mestských údajov a oficiálneho zoznamu volebných adries. Register obsahuje aj školy, športoviská, obchody a ďalšie objekty bez samostatnej položky v tomto zozname. Ich areály sú zahrnuté do súvislých farebných plôch; nejde o chýbajúce výsledky okrskov.';
    $('snapshot-date').textContent = `Snímka zdrojových údajov: ${data.snapshotDate}. Nezávislý informačný projekt; nejde o oficiálnu volebnú aplikáciu mesta.`;
    bindEvents();
    render();
    if (state.corrected) { toast('Neplatnú kombináciu v odkaze sme upravili. Vyberte obvod a kandidáta znova.'); state.corrected = false; }
    startMap();
    json('./data/addresses.json').then(records => {
      addresses = records.map(a => ({ ...a, searchKey: normalize(a.label) }));
      if (mapReady && map.getSource('addresses')) map.getSource('addresses').setData(pointsData());
      if (!$('search-results').hidden) renderSearch();
    }).catch(async error => { console.error('Address data:', error); if (await refreshForLatest(RELEASE, APP_BASE, location)) return; $('address-search').placeholder = 'Adresy sa nepodarilo načítať'; $('address-search').disabled = true; toast('Vyhľadávanie adries nie je dostupné. Okrsky môžete vyberať zo zoznamu.'); });
  } catch (error) {
    console.error('Application initialization:', error);
    if (await refreshForLatest(RELEASE, APP_BASE, location)) return;
    showStartupFailure(data ? 'Stránku sa nepodarilo dokončiť načítať. Skúste načítať aktuálnu verziu.' : 'Výsledky sa nepodarilo načítať. Skontrolujte pripojenie a skúste znova.', APP_BASE);
    $('candidate-results').innerHTML = '<p>Výsledky momentálne nie sú dostupné. <a href="./data/results.json">Otvoriť zdrojové výsledky</a>.</p>';
    ['method-open', 'sources-open'].forEach(id => $(id).onclick = openMethod);
    $('method-close').onclick = () => $('method-dialog').close();
  }
}

start();
