import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetURL, compatiblePage, fetchJSON, freshPageURL, PAGE_CONTROLS, refreshForLatest, refreshIncompatiblePage } from '../site/recovery.js';
import { compileRelease } from '../scripts/build_site.mjs';

const base = 'https://richardglankovic.github.io/presov-volby-2026/';
const oldRelease = '111111111111', nextRelease = '222222222222';
const page = (version, missing = []) => ({
  getElementById: id => PAGE_CONTROLS.includes(id) && !missing.includes(id) ? {} : null,
  querySelector: () => version ? { content: version } : null,
});
const location = href => ({ href, replace(target) { this.replaced = target; this.href = target; } });

test('old or mixed HTML refreshes to a compatible page once while keeping the shared view', () => {
  const loc = location(base + '?view=candidate&candidate=3&precinct=22&scale=absolute#map');
  assert.equal(compatiblePage(page(nextRelease), nextRelease), true);
  assert.equal(refreshIncompatiblePage(page(null, ['absolute-scale', 'winner-lead']), nextRelease, base, loc), true);
  const target = new URL(loc.replaced);
  assert.equal(target.pathname, '/presov-volby-2026/');
  assert.equal(target.searchParams.get('precinct'), '22');
  assert.equal(target.searchParams.get('view'), 'candidate');
  assert.equal(target.searchParams.get('scale'), 'absolute');
  assert.equal(target.searchParams.get('__release'), nextRelease);
  assert.equal(target.hash, '#map');
  assert.equal(refreshIncompatiblePage(page(oldRelease), nextRelease, base, loc), false, 'Never loop when fresh HTML is still incompatible');
});

test('release data paths cannot mix with unversioned cached JSON and respect the Pages subdirectory', () => {
  assert.equal(assetURL('./data/results.json', base, nextRelease).href, base + `data/${nextRelease}/results.json`);
  assert.equal(assetURL('./data/addresses.json', base, null).href, base + 'data/addresses.json');
  assert.equal(assetURL('./vendor/maplibre-gl-worker.mjs', base, nextRelease).searchParams.get('v'), nextRelease);
  assert.equal(new URL(freshPageURL(base + '?precinct=49', base, nextRelease)).searchParams.get('precinct'), '49');
});

test('transient JSON failures retry; permanent failures stay bounded and 404s recover without repeated requests', async () => {
  let calls = 0;
  const options = { wait: async () => {}, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true }) };
  assert.deepEqual(await fetchJSON(base + 'data/results.json', options), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(fetchJSON(base, { wait: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } }), /404/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchJSON(base, { wait: async () => {}, fetchImpl: async () => { calls++; throw new TypeError('Network unavailable'); } }), /Network unavailable/);
  assert.equal(calls, 2);
});

test('missing old release assets refresh to the latest manifest; current releases and offline failures do not loop', async () => {
  const loc = location(base + '?view=turnout&precinct=28');
  const manifest = async () => Response.json({ version: nextRelease });
  assert.equal(await refreshForLatest(oldRelease, base, loc, manifest), true);
  assert.equal(new URL(loc.replaced).searchParams.get('precinct'), '28');
  assert.equal(await refreshForLatest(oldRelease, base, loc, manifest), false);
  assert.equal(await refreshForLatest(nextRelease, base, location(base), manifest), false);
  assert.equal(await refreshForLatest(oldRelease, base, location(base), async () => { throw new Error('Offline'); }), false);
});

test('production HTML, bundled application, stylesheet and data form one fingerprinted release', async () => {
  const { files, manifest } = await compileRelease();
  assert.match(manifest.version, /^[a-f0-9]{12}$/);
  const html = files.get('index.html').toString();
  assert.ok(html.includes(`name="app-release" content="${manifest.version}"`));
  assert.ok(html.includes(manifest.entry));
  assert.ok(html.includes(manifest.styles));
  assert.ok(html.includes('release.json'), 'Embedded loader must recover if its old bundle is gone');
  assert.ok(!html.includes('src="./app.js"'));
  assert.ok(files.get('app.js').toString().includes(manifest.entry), 'Old unversioned pages get the compatibility entry');
  const bundle = Buffer.from(files.get(manifest.entry)).toString();
  assert.ok(!/from ['"]\.\/(core|basemap|recovery)\.js['"]/.test(bundle), 'Local modules must not be cached independently');
  assert.ok(bundle.includes('winningMargin'));
  assert.deepEqual(files.get(manifest.dataPrefix + 'results.json'), files.get('data/results.json'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(files.get(name)).digest('hex'), expected, name);
    assert.ok(!/^(sources|vysledky|dennikn_clanok|tmp)\//.test(name));
  }
});
