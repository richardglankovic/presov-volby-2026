"""Explain unresolved lookup records without changing any election/address data.

Writes a private local review table to tmp/, never into the published site.
"""
import collections
import html
import json
from pathlib import Path
from urllib.parse import urlencode, quote
import build_data as build

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tmp'
LAYER = 'https://services-eu1.arcgis.com/coW662rcZatH0tHA/arcgis/rest/services/adresne_body_okrsky/FeatureServer/0/query'
CITY = 'https://experience.arcgis.com/experience/bcb44005e2ce4a28826418f70ef4f206?org=mestopresov#data_s='
DOCUMENT = 'https://oznamypresov.sk/download/10860'


def main():
    addresses = json.loads((OUT / 'registry-addresses.json').read_text(encoding='utf-8'))
    raw = {f['properties']['FID']: f['properties'] for f in build.load('addresses.geojson')['features']}
    by_street = collections.defaultdict(list)
    for rule in build.parse_rules():
        by_street[rule['key']].append(rule)
    rows = []
    for a in addresses:
        if a['precinct']:
            continue
        p = raw[a['id']]
        rules = by_street[build.norm(a['street'])]
        exact = sorted({r['precinct'] for r in rules if not r['numbers'] or a['number'] in r['numbers']})
        category = 'complete' if a['street'] and a['number'] else 'no-number' if a['street'] else 'no-street'
        reason = ('Chýba ulica aj orientačné číslo; ostal iba registračný údaj.' if category == 'no-street' else
                  'Ulica zasahuje do viacerých okrskov; chýba orientačné číslo.' if category == 'no-number' else
                  'Ulica je v dokumente, ale toto orientačné číslo nie je v jej zoznamoch.')
        if exact:
            reason = f"Priradenie je známe (okrsok {exact[0]}). Náš príliš prísny filter ho potlačil pre súradnice spoločné s nepriradeným záznamom."
        elif a['status'] == 'coordinate-conflict':
            reason += ' Navyše zdieľa súradnice s iným záznamom.'
        if a.get('objectReview', {}).get('use') == 'boiler-house':
            reason = 'Kotolňa — nerezidenčný objekt potvrdený používateľom. Vyradený z verejného vyhľadávania a adresných bodov.'
        rows.append({**a, 'category': category, 'fullAddress': p['fulladdres'], 'sourcePrecinct': p['okrsok'],
                     'sourceDistrict': p['obvod'], 'reason': reason, 'documentPages': sorted({r['page'] for r in rules}),
                     'documentPrecincts': exact, 'registryUrl': p['uri_identi'],
                     'cityUrl': CITY + quote(f"id:dataSource_1-1a1163bc100-layer-7:{a['id']}", safe=''),
                     'rawUrl': LAYER + '?' + urlencode({'objectIds': a['id'], 'outFields': '*', 'returnGeometry': 'false', 'f': 'pjson'})})
    rows.sort(key=lambda a: (a['street'], a['number'], a['id']))
    summary = dict(collections.Counter(a['category'] for a in rows))
    assert summary == {'no-street': 4724, 'complete': 409, 'no-number': 1}, summary
    assert not any(a['documentPrecincts'] for a in rows)
    OUT.mkdir(exist_ok=True)
    (OUT / 'address-review.json').write_text(json.dumps({'summary': summary, 'records': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
    esc = html.escape
    cells = []
    for a in rows:
        pages = ' · '.join(f'<a href="{DOCUMENT}#page={p}" target="_blank">str. {p}</a>' for p in a['documentPages']) or 'Bez ulice na porovnanie'
        cells.append(f'''<tr data-category="{a['category']}" data-search="{esc(build.norm(a['label']))}">
<td><strong>{esc(a['label'])}</strong><small>{esc(a['fullAddress'])}<br>FID {a['id']} · {esc(a['status'])}</small></td>
<td>{a['sourcePrecinct'] or '0 — nepriradené'}</td><td>{esc(a['reason'])}<small>{pages}</small></td>
<td><a href="{esc(a['cityUrl'])}" target="_blank">Mestská mapa</a><br><a href="{esc(a['rawUrl'])}" target="_blank">Zdrojový záznam</a></td></tr>''')
    page = r'''<!doctype html><html lang="sk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prešov · Audit nepriradených adries</title><style>
body{font:15px/1.6 system-ui,sans-serif;color:#203746;background:#f8f8f4;margin:0;padding:28px}main{max-width:1180px;margin:auto}h1{font-size:29px;margin:0}p{max-width:960px}a{color:#355cab}small{display:block;color:#68757d;font-size:12px;margin-top:5px}.counts{display:flex;flex-wrap:wrap;gap:12px;margin:22px 0}.counts span{background:#fff;border:1px solid #d9dfdd;border-radius:7px;padding:12px 18px}.counts b{font-size:24px;display:block}.tools{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}input,select{padding:10px;border:1px solid #b9c4c9;border-radius:4px;font:inherit}input{flex:1;min-width:200px}table{border-collapse:collapse;width:100%;background:#fff}th,td{text-align:left;padding:13px;vertical-align:top;border-bottom:1px solid #e1e4e2}th{background:#edf0ee;font-size:12px}td:first-child{width:27%}td:nth-child(2){width:13%}td:last-child{white-space:nowrap;font-size:12px}.note{padding:13px 17px;background:#fff4df;border-left:3px solid #b28b42}tr[hidden]{display:none}@media(max-width:700px){body{padding:16px}table{font-size:12px}th,td{padding:7px}}
</style><main><small>SÚKROMNÝ KONTROLNÝ AUDIT · Snímka údajov z 27. októbra 2026 · toto nie je verejná stránka mapy</small>
<h1>Registračné objekty mimo volebného zoznamu</h1>
<p>Ide o záznamy registra adries, nie o počet voličov, domácností ani preukázateľne obývaných domov. V mestskej vrstve má 0 význam chýbajúceho priradenia, nie existujúceho okrsku.</p>
<div class="counts"><span><b>4 724</b>iba v lokálnom zdrojovom audite; vyradené z verejného vyhľadávania a bodov</span><span><b>409</b>objektov s ulicou a orientačným číslom</span><span><b>1</b>potvrdená kotolňa; iba v lokálnom audite</span></div>
<p><a href="https://oznamypresov.sk/download/10860" target="_blank">Oficiálne oznámenie mesta · PDF, 20 strán</a>. Ulice týchto 409 objektov sú uvedené v dokumente, ale ich konkrétne čísla nie sú vo volebných zoznamoch. Overené príklady zahŕňajú školu, plaváreň a obchodné objekty. Farebné plochy ich areály súvislo pokrývajú.</p>
<p class="note"><strong>Opravené:</strong> Volgogradská 72 má okrsok 11 a Zabíjaná 3 má okrsok 16. Spoločné súradnice s iným objektom ich platné priradenia už nerušia. <strong>Mirka Nešpora:</strong> všetkých 60 čísel z volebného dokumentu je prítomných a priradených. Používateľ identifikoval záznam 1656 ako kotolňu. Je vedený iba v lokálnom audite; verejné vyhľadávanie ani adresné body ho neobsahujú.</p>
<div class="tools"><label>Skupina <select id="category"><option value="complete">S ulicou a číslom (409)</option><option value="no-street">Iba lokálny audit (4 724)</option><option value="no-number">Bez orientačného čísla (1)</option><option value="all">Všetky zdrojové záznamy (5 134)</option></select></label><input id="filter" aria-label="Filtrovať adresy" placeholder="Ulica alebo číslo…"></div>
<p id="count" aria-live="polite"></p><table><thead><tr><th>ADRESA / IDENTIFIKÁTOR</th><th>OKRSOK V MESTSKOM ZDROJI</th><th>ČO SA STALO / DOKUMENT</th><th>OVERIŤ</th></tr></thead><tbody>ROWS</tbody></table>
<script>const norm=v=>v.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();const rows=[...document.querySelectorAll('tbody tr')];function filter(){const c=document.getElementById('category').value,q=norm(document.getElementById('filter').value);let count=0;for(const r of rows){r.hidden=(c!=='all'&&r.dataset.category!==c)||!r.dataset.search.includes(q);if(!r.hidden)count++}document.getElementById('count').textContent=`Zobrazených ${count} záznamov`;}document.getElementById('category').addEventListener('change',filter);document.getElementById('filter').addEventListener('input',filter);document.getElementById('filter').value=new URLSearchParams(location.search).get('q')||'';filter();</script></main></html>'''
    (OUT / 'address-review.html').write_text(page.replace('ROWS', ''.join(cells)), encoding='utf-8')
    print(json.dumps({'unresolvedRecords': len(rows), **summary, 'exactDocumentExceptions': 0}))


if __name__ == '__main__':
    main()
