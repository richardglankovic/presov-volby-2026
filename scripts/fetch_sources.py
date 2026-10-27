"""Snapshot public city geography, precinct definitions and browser dependencies.

Run explicitly to refresh. Existing snapshots are reused unless --refresh is supplied.
No account, token, or user data is sent.
"""
from pathlib import Path
import argparse
import datetime as dt
import io
import json
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'sources'
SERVICE = 'https://services-eu1.arcgis.com/coW662rcZatH0tHA/arcgis/rest/services/'
LAYERS = {
    'addresses': 'adresne_body_okrsky/FeatureServer/0',
    'polling_places': 'volebny_okrsok/FeatureServer/0',
    'districts': 'volebne_obvody_nove/FeatureServer/0',
    'municipality': 'Katastrálne_územia_mesta_Prešov/FeatureServer/118',
}
DOCUMENTS = {
    'precincts_july.pdf': 'https://www.presov.sk/download_file_f.php?id=2451007',
    'precincts_october.pdf': 'https://oznamypresov.sk/download/10860',
    'october_notice.html': 'https://www.presov.sk/oznamy/volby-2026--informacie-pre-volicov.html',
}

def request(url):
    safe = urllib.parse.quote(url, safe=':/?=&%,+@')
    req = urllib.request.Request(safe, headers={'User-Agent': 'PresovElectionMap/1.0 (public-data research)'})
    with urllib.request.urlopen(req, timeout=90) as response:
        return response.read()

def read_json(url):
    result = json.loads(request(url))
    if isinstance(result, dict) and result.get('error'):
        raise RuntimeError(result['error'])
    return result

def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    SOURCE.mkdir(exist_ok=True)
    manifest_path = SOURCE / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    for name, layer in LAYERS.items():
        path = SOURCE / f'{name}.geojson'
        if path.exists() and not args.refresh:
            continue
        url = SERVICE + layer
        metadata = read_json(url + '?f=json')
        save_json(SOURCE / f'{name}.metadata.json', metadata)
        oid = metadata['objectIdField']
        count = read_json(url + '/query?' + urllib.parse.urlencode({'where': '1=1', 'returnCountOnly': 'true', 'f': 'json'}))['count']
        features = []
        for offset in range(0, count, 2000):
            query = urllib.parse.urlencode({'where': '1=1', 'outFields': '*', 'returnGeometry': 'true', 'outSR': 4326, 'orderByFields': oid, 'resultOffset': offset, 'resultRecordCount': 2000, 'f': 'geojson'})
            page = read_json(url + '/query?' + query)
            features.extend(page['features'])
        assert len(features) == count, (name, count, len(features))
        save_json(path, {'type': 'FeatureCollection', 'features': features})
        manifest[name] = {'url': url, 'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'count': count}
        print(f'{name}: {count} features', flush=True)
    for name, url in DOCUMENTS.items():
        path = SOURCE / name
        if not path.exists() or args.refresh:
            path.write_bytes(request(url))
            manifest[name] = {'url': url, 'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
            print(f'{name}: {path.stat().st_size} bytes', flush=True)
    vendor = ROOT / 'site' / 'vendor'
    vendor.mkdir(parents=True, exist_ok=True)
    # Pin the resolved version in a public manifest; future builds reuse these files.
    if not (vendor / 'manifest.json').exists() or args.refresh:
        package = read_json('https://registry.npmjs.org/maplibre-gl/latest')
        archive = request(package['dist']['tarball'])
        kept = []
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            for member in tar.getmembers():
                name = Path(member.name).name
                if member.isfile() and (member.name.startswith('package/dist/') and name in ('maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'maplibre-gl-shared.mjs') or name in ('LICENSE.txt', 'LICENSE')):
                    (vendor / name).write_bytes(tar.extractfile(member).read())
                    kept.append(name)
        save_json(vendor / 'manifest.json', {'package': 'maplibre-gl', 'version': package['version'], 'source': package['dist']['tarball'], 'files': kept})
        print(f'MapLibre {package["version"]}: {kept}', flush=True)
    save_json(manifest_path, manifest)

if __name__ == '__main__':
    main()
