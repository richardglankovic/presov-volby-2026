import { normalize, searchAddresses } from './core.js';

// Keep registry-only objects in the snapshot, outside public search and map points.
export const assignedAddresses = addresses => addresses.filter(a => a.precinct > 0);

export function pollingPlaces(precincts) {
  const groups = new Map();
  for (const p of precincts) {
    const parts = p.pollingPlace.split(',').map(s => s.trim()).filter(Boolean);
    const address = parts.at(-1);
    const key = normalize(address);
    if (!groups.has(key)) groups.set(key, { address, name: parts.slice(0, -1).join(', ') || p.pollingPlace,
      coordinates: p.pollingCoordinates, precincts: [], labels: new Set() });
    const place = groups.get(key);
    place.precincts.push(p.id);
    place.labels.add(p.pollingPlace);
  }
  return [...groups.values()].map(({ labels, ...place }) => ({ ...place,
    precincts: [...new Set(place.precincts)].sort((a, b) => a - b),
    searchKey: normalize([...labels].join(' ')),
  }));
}

export function searchLocations(addresses, places, query, limit = 8) {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  const tokens = needle.split(' ');
  const matches = (key) => {
    const words = key.split(' ');
    return tokens.every(t => /^\d/.test(t) ? words.includes(t) : key.includes(t));
  };
  const score = key => key === needle ? 0 : key.startsWith(needle) ? 1 : 2;
  const results = searchAddresses(assignedAddresses(addresses), query, limit)
    .map(address => ({ kind: 'address', address, label: address.label,
      score: score(address.searchKey ?? normalize(address.label)), priority: 0 }));
  for (const place of places) {
    if (matches(place.searchKey)) results.push({ kind: 'polling', place, label: place.address,
      score: Math.min(score(normalize(place.address)), score(place.searchKey)), priority: 1 });
  }
  return results.sort((a, b) => a.score - b.score || a.priority - b.priority || a.label.localeCompare(b.label, 'sk', { numeric: true }))
    .slice(0, limit).map(({ score, priority, ...result }) => result);
}
