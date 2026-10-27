# Ako volil Prešov

**[Explore the live map](https://richardglankovic.github.io/presov-volby-2026/)**

An interactive, Slovak-language map of Prešov’s mayoral election on **24 October 2026**, designed for desktop and mobile. It covers **66 precincts, six candidates and 29,796 valid votes**.

- **Precinct winners:** color identifies the winner; darker shades show a larger lead over the runner-up, on a shared 0–40 percentage-point scale.
- **Candidate support:** explore each candidate’s vote share and three strongest/weakest precincts, with a citywide benchmark and expandable local results. The default relative scale highlights variation within the city; an optional fixed 0–100% scale allows comparison between candidates.
- **Turnout:** view participation by precinct and the three highest- and lowest-turnout precincts.

Search for an address or select a precinct to see its results and polling location. Links preserve the view and selected precinct. Every result describes the **whole precinct**, never an individual address or household.

## Run locally

Requires **Node.js 22 or newer**. Prepared data are included; Python is only needed to rebuild them.

```sh
npm ci
npm start
```

Open the URL printed in the terminal, normally `http://127.0.0.1:4173`. Use the local server rather than opening the HTML file directly.

## Build and check

```sh
npm run check
npm run build
```

The production site is generated in `dist/` from `site/`. The GitHub Pages workflow runs checks and publishes this build on updates to `main`.

The app uses **MapLibre GL JS**, **OpenFreeMap** and static HTML/CSS/JavaScript. It has no backend, database or API key. Election and address data are served locally by the site; the basemap requires an internet connection. Results and address search remain usable if the basemap fails.

## Data and boundaries

Election results come from **Štatistický úrad SR**, filtered to municipality **524140**. Address assignments, polling locations and city/electoral-district boundaries come from **Mesto Prešov**, reconciled with the [official precinct definitions](https://oznamypresov.sk/download/10860) and [subsequent city notice](https://www.presov.sk/oznamy/volby-2026--informacie-pre-volicov.html).

**The colored precinct areas are approximate.** They are derived from the nearest assigned address points within official electoral districts, merged into continuous urban areas and clipped to the city boundary. They are not official precinct boundaries. Address search uses verified assignments directly, rather than inferring them from the colored area. Registry objects without a separate electoral-list entry can appear as unassigned points.

**Precinct 33 includes voters registered only to the city of Prešov**, so its turnout does not describe only residents of the displayed area. The turnout ranking marks this exception with an asterisk.

Public data are in [`site/data/`](site/data/):

| File | Contents |
| --- | --- |
| `results.json` | Candidate and precinct results, turnout and polling locations |
| `addresses.json` | Searchable addresses, coordinates, assignments and provenance |
| `precincts.geojson`, `boundary.geojson` | Approximate precinct areas and municipal boundary |
| `audit.json`, `street-rules.json`, `sources.json` | Corrections, validation, address rules and source metadata |

Candidate IDs follow ballot numbers; precincts join by municipality and precinct number. Percentages are calculated from vote/participation counts and displayed to one decimal place. Assignment and coordinate corrections retain their provenance in the data audit.

## Rebuild the data

Requires Python and the original national results files, which are not included in the repository. Place these CSVs in `vysledky/`:

- `OSO2026_SK_tab05f.csv` — mayoral votes by candidate and precinct
- `OSO2026_SK_tab02f.csv` — registered voters, participation and ballots
- `OSO2026_SK_tab05d.csv` — city-level candidate totals for verification

```sh
python -m pip install --target .pythonlibs -r requirements.txt
python scripts/fetch_sources.py
python scripts/build_data.py
python -m unittest discover -s tests -p 'test_*.py'
```

The fetch script downloads public city data and documents into `sources/` and reuses existing snapshots. Its optional `--refresh` replaces snapshots and refreshes vendored MapLibre assets. The build validates vote totals, polygon geometry and address containment, recording source exceptions explicitly. Python geography tests require the source snapshots; the website build does not.

Raw national CSVs, source snapshots and temporary review files stay local and are excluded from publication.

## Credits

- **Election results:** Štatistický úrad SR.
- **Geography and precinct definitions:** Mesto Prešov. Source URLs and dates are recorded in [`sources.json`](site/data/sources.json). The electoral-district dataset specifies CC BY 4.0; address metadata provides no explicit license.
- **Basemap:** OpenFreeMap, OpenMapTiles and OpenStreetMap contributors. Attribution is displayed on the map.
- **Map renderer:** MapLibre GL JS; see its [license](site/vendor/LICENSE.txt).

This is an independent informational project, not an official city election application.
