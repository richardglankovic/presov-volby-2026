/** Latch style readiness once. map.loaded() can turn false again after its
 * one-time `load` event, for example during the initial fitBounds animation.
 * Waiting on that event at that point silently strands the real basemap.
 */
export function createBasemapInstaller(map) {
  const initialStyleReady = new Promise(resolve => map.once('style.load', resolve));
  return async style => {
    await initialStyleReady;
    // A full style load restores the election overlays through style.load.
    map.setStyle(style, { diff: false });
  };
}

export function prepareBasemap(style) {
  const prepared = structuredClone(style);
  prepared.metadata = { ...prepared.metadata, presovBasemap: true };
  for (const layer of prepared.layers) {
    if (layer.type !== 'symbol' || !JSON.stringify(layer.layout?.['text-field'] ?? '').includes('name')) continue;
    layer.layout['text-field'] = ['coalesce', ['get', 'name:sk'], ['get', 'name'], ['get', 'name:latin']];
  }
  return prepared;
}
