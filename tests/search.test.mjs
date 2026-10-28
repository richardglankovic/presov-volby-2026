import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignedAddresses, pollingPlaces, searchLocations } from '../site/search.js';
const read = name => JSON.parse(readFileSync(new URL('../site/data/' + name, import.meta.url)));
const data = read('results.json');
const addresses = read('addresses.json');
const places = pollingPlaces(data.precincts);

test('polling places group shared buildings and retain every official precinct exactly once', () => {
  assert.equal(places.length, 39);
  assert.deepEqual(places.flatMap(p => p.precincts).sort((a, b) => a - b), Array.from({ length: 66 }, (_, i) => i + 1));
  assert.deepEqual(places.find(p => p.address === 'Bajkalská 29').precincts, [1, 2]);
  assert.deepEqual(places.find(p => p.address === 'Prostějovská 38').precincts, [8, 9, 10]);
  assert.equal(places.find(p => p.precincts.includes(23)).address, 'Bajkalská 33');
});

test('Sekčovská 54 finds precinct 66 as a polling place without rewriting its unassigned registry record', () => {
  const matches = searchLocations(addresses, places, 'sekcovska 54');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'polling');
  assert.deepEqual(matches[0].place.precincts, [66]);
  assert.equal(addresses.find(a => a.label === 'Sekčovská 54').precinct, 0);
});

test('a verified address and a shared polling place remain distinct choices at the same address', () => {
  const matches = searchLocations(addresses, places, 'bajkalska 29');
  assert.deepEqual(matches.map(m => m.kind), ['address', 'polling']);
  assert.equal(matches[0].address.precinct, 1);
  assert.deepEqual(matches[1].place.precincts, [1, 2]);
});

test('polling-place names are searchable without accents and house-number suffixes stay exact', () => {
  const named = searchLocations(addresses, places, 'u kominara');
  assert.ok(named.some(m => m.kind === 'polling' && m.place.precincts.includes(66)));
  assert.ok(searchLocations(addresses, places, 'benku 7a').some(m => m.kind === 'polling' && m.place.precincts.includes(49)));
  assert.ok(!searchLocations(addresses, places, 'benku 7').some(m => m.kind === 'polling' && m.place.precincts.includes(49)));
});

test('unassigned objects remain in the audit snapshot but are absent from public address search and points', () => {
  for (const query of ['antona pridavka 1', 'sekcovska 34']) assert.deepEqual(searchLocations(addresses, places, query), []);
  assert.equal(addresses.find(a => a.label === 'Sekčovská 34').precinct, 0);
  const visible = assignedAddresses(addresses);
  assert.equal(visible.length, data.coverage.electoralAddresses);
  assert.ok(!visible.some(a => a.label === 'Sekčovská 34'));
  assert.equal(searchLocations(addresses, places, 'bajkalska 1')[0].address.precinct, 1);
});

test('hidden registry objects cannot crowd verified addresses out of the search limit', () => {
  const records = Array.from({ length: 12 }, (_, id) => ({ id, label: 'Testovacia 1', precinct: 0 }));
  records.push({ id: 99, label: 'Testovacia 1', precinct: 3 });
  assert.equal(searchLocations(records, [], 'testovacia 1', 1)[0].address.id, 99);
});

test('polling lookup needs no address-register download', () => {
  assert.deepEqual(searchLocations([], places, 'sekcovska 54')[0].place.precincts, [66]);
  assert.equal(searchLocations([], places, 'zakladna skola').length, 8);
  assert.deepEqual(searchLocations(addresses, places, 'a'), []);
  assert.deepEqual(searchLocations(addresses, places, 'neexistujuca 99999'), []);
});
