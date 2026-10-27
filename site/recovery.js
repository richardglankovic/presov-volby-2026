export const PAGE_CONTROLS = ['absolute-scale', 'retry-basemap', 'map-status-text', 'winner-lead', 'retry-results', 'candidate-heading', 'turnout-results'];

export function compatiblePage(doc, release) {
  return PAGE_CONTROLS.every(id => doc.getElementById(id)) &&
    (!release || doc.querySelector('meta[name="app-release"]')?.content === release);
}

export function freshPageURL(currentHref, baseUrl, release) {
  const current = new URL(currentHref);
  const target = new URL(baseUrl);
  target.search = current.search;
  target.hash = current.hash;
  target.searchParams.set('__release', release);
  return target.href;
}

export function refreshIncompatiblePage(doc, release, baseUrl, loc) {
  if (compatiblePage(doc, release)) return false;
  const version = release || 'development';
  if (new URL(loc.href).searchParams.get('__release') === version) return false;
  loc.replace(freshPageURL(loc.href, baseUrl, version));
  return true;
}

export function assetURL(path, baseUrl, release) {
  const name = release && path.startsWith('./data/') ? path.replace('./data/', `./data/${release}/`) : path;
  const url = new URL(name, baseUrl);
  if (release && !path.startsWith('./data/')) url.searchParams.set('v', release);
  return url;
}

export async function fetchJSON(url, { fetchImpl = globalThis.fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 8000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, { cache: 'no-cache', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (attempt || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))) throw error;
      await wait(250);
    }
  }
}

export async function refreshForLatest(release, baseUrl, loc, fetchImpl = globalThis.fetch) {
  if (!release) return false;
  try {
    const response = await fetchImpl(new URL('./release.json', baseUrl), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const latest = (await response.json()).version;
    if (!/^[a-f0-9]{12}$/.test(latest) || latest === release || new URL(loc.href).searchParams.get('__release') === latest) return false;
    loc.replace(freshPageURL(loc.href, baseUrl, latest));
    return true;
  } catch {
    return false;
  }
}

export function showStartupFailure(message, baseUrl, doc = globalThis.document, loc = globalThis.location) {
  let status = doc.getElementById('map-status');
  if (!status) {
    status = doc.createElement('div');
    status.id = 'map-status';
    status.setAttribute('role', 'alert');
    doc.body.prepend(status);
  }
  status.hidden = false;
  const text = doc.getElementById('map-status-text');
  if (text) text.textContent = message;
  else status.textContent = message;
  let retry = doc.getElementById('retry-results');
  if (!retry) {
    retry = doc.createElement('button');
    retry.id = 'retry-results';
    status.append(retry);
  }
  retry.hidden = false;
  retry.textContent = 'Načítať znova';
  retry.onclick = () => loc.replace(freshPageURL(loc.href, baseUrl, 'retry-' + Date.now()));
  const basemapRetry = doc.getElementById('retry-basemap');
  if (basemapRetry) basemapRetry.hidden = true;
}
