import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBasemapInstaller, prepareBasemap } from '../site/basemap.js';

class FakeMap extends EventEmitter {
  applied = [];
  // Simulates a map that fired load but is now dirty/moving, as during fitBounds.
  loaded() { return false; }
  setStyle(style, options) { this.applied.push({ style, options }); }
}

test('a late basemap is installed after initial load even while map.loaded() is false', async () => {
  const map = new FakeMap();
  const install = createBasemapInstaller(map);
  map.emit('style.load');
  map.emit('load');
  assert.equal(map.loaded(), false);
  const style = { version: 8, sources: { streets: {} }, layers: [] };
  await install(style);
  assert.equal(map.applied.length, 1);
  assert.equal(map.applied[0].style, style);
  assert.deepEqual(map.applied[0].options, { diff: false });
});

test('an early basemap waits for style readiness, then retries do not need another load event', async () => {
  const map = new FakeMap();
  const install = createBasemapInstaller(map);
  const pending = install({ name: 'first' });
  await Promise.resolve();
  assert.equal(map.applied.length, 0);
  map.emit('style.load');
  await pending;
  await install({ name: 'retry' });
  assert.deepEqual(map.applied.map(call => call.style.name), ['first', 'retry']);
});

test('local name preparation preserves original label paint, road shields and attribution', () => {
  const original = { version: 8, metadata: { provider: 'OpenFreeMap' }, sources: { streets: { attribution: 'OpenStreetMap' } }, layers: [
    { id: 'road-name', type: 'symbol', layout: { 'text-field': ['get', 'name_en'] }, paint: { 'text-opacity': .9 } },
    { id: 'road-shield', type: 'symbol', layout: { 'text-field': ['to-string', ['get', 'ref']] } },
    { id: 'house-number', type: 'symbol', layout: { 'text-field': ['get', 'housenumber'] } },
  ] };
  const style = prepareBasemap(original);
  assert.equal(style.metadata.presovBasemap, true);
  assert.equal(style.metadata.provider, 'OpenFreeMap');
  assert.deepEqual(style.sources, original.sources);
  assert.deepEqual(style.layers[0].paint, original.layers[0].paint);
  assert.deepEqual(style.layers[1], original.layers[1]);
  assert.deepEqual(style.layers[2], original.layers[2]);
  assert.deepEqual(original.layers[0].layout['text-field'], ['get', 'name_en']);
});
