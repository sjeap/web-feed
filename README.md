# web-feed – Atom aus Web-Inhalten (Matrix-Setup)

Mehrere Quellen parallel scrapen via GitHub Actions Matrix, Ausgabe als Atom/XML,
veröffentlicht über GitHub Pages.

## Dateistruktur

```
web-feed/
├── scraper.js              ← ein Scraper für alle Feeds (mehrere Engines)
├── self-heal.js            ← repariert kaputte Selektoren via Anthropic API
├── sites.json              ← zentrale Konfiguration aller Feeds (Single Source of Truth)
├── package.json            ← npm-Dependencies (z. B. Patchright); vom Workflow via npm install genutzt
├── atom/                    ← generierte Feeds (ein File pro Quelle)
│   └── feed-*.xml           ← z. B. feed-manager-magazin.xml
├── asset/                  ← generierte Zusatz-Artefakte (gaugeOutput)
│   └── *.svg               ← z. B. Gauge-SVG für cnn-fear-greed
├── backup/                 ← OPML-Exporte
│   └── twine_backup.opml   ← Twine-Abo-Backup (Quelle für den OPML-Abschnitt)
├── ACKNOWLEDGMENTS.md      ← Credits/Quellen (wird ins README gespiegelt)
└── .github/workflows/
    └── update-rss.yml      ← Matrix-Run (cron + manueller Trigger)
```

## Feeds & konzeptionelle Unterschiede

Jeder Feed nutzt bewusst einen anderen Ansatz — abhängig davon, **wie die Quelle ihre
Inhalte ausliefert**. Das ist der Kern des Projekts:

### `manager-magazin` → `atom/feed-manager-magazin.xml`
- **Engine:** Default (HTML + Regex)
- **Eigenheit:** Einziger Feed mit `filter` — eine Titel-Regex (`Der .+ im Überblick`)
  behält nur die täglichen Überblicks-Artikel, alles andere wird verworfen.
- Server-gerendertes HTML, `teaserSplit` an `<div class="teaser"`, klassenbasierte
  Selektoren, deutsche Datumsformate.

### `visualcapitalist` → `atom/feed-visualcapitalist.xml`
- **Engine:** Default (HTML + Regex) **mit** `containerStart` / `containerEnd`
- **Eigenheit:** Die Seite mischt Hauptinhalt und Sidebar. `containerStart`/`End`
  schneiden den relevanten HTML-Bereich **vor** dem `teaserSplit` heraus, damit keine
  Sidebar-Teaser im Feed landen.
- Englische Inhalte → `language: en-US`; englische/Ordinal-Datumsformate.

### `cnn-fear-greed` → `atom/feed-cnn-fear-greed.xml` (+ Gauge-SVG)
- **Engine:** `cnn-fear-greed` (JSON statt HTML)
- **Eigenheit:** Kein HTML-Scraping — liest die öffentliche CNN-JSON-API direkt aus.
  Gibt Index-Wert/Rating, Put/Call-Rating und VIX-Rating aus, plus ein Gauge-SVG
  (`gaugeOutput`). Entry-IDs (`<id>`) sind **datumsbezogen**, damit Reader das tägliche Update erkennen.
- Lehre: client-seitig gerenderte Seiten besser über ihre JSON/API-Endpunkte als über
  HTML angehen.

### `seekingalpha-notable-calls` → `atom/feed-seekingalpha-notable-calls.xml`
- **Engine:** `browser` (Patchright Stealth-Chromium)
- **Eigenheit:** JS-lastige Seite → Headless-Browser nötig (deshalb läuft der
  Chromium-Install-Step **nur** für diesen Feed).
- **Bekanntes Problem:** Cloudflare blockt GitHub-Actions-Runner-IPs (Azure-Datacenter).
  Lokal funktioniert es, in CI kommt nur die Challenge-Seite an. Sauberer Weg wäre der
  offizielle RSS-Feed.

### `tagesschau-topthemen` → `atom/feed-tagesschau-topthemen.xml`
- **Engine:** `tagesschau-carousel` — die „LIVE UND TOPTHEMEN"-Teaser stehen als
  entity-kodiertes JSON im `data-v`-Attribut der Vue-`Carousel`-Instanz (nicht im Markup).
  Der Parser iteriert `sliderItems[]`, filtert den Livestream via
  `skipLabels`/`skipUrlPatterns`; reiner HTTPS-Fetch, Entry-`<id>` = Artikel-URL. Defekte
  Entities in den Tracking-Blobs (`&qquot;`) werden vor `JSON.parse` repariert.
- **Vorschaubild:** aus dem `meta.images`-Template gebaut — Größe/Variante via `thumbWidth`
  (Default 320) / `thumbVariant` (`16x9-small`|`16x9-big`), JPG, `alt` = Schlagzeile,
  Fallback `posterImage`.

### `marketscreener` → `atom/feed-marketscreener.xml`
- **Engine:** `browser` (Patchright) — reiner HTTPS-Fetch liefert 403 (Fingerprint-Block).
- **Eigenheit:** Einziger Feed mit dem optionalen `urls`-Array (Schwerpunkte, ETF, Aktien):
  drei Sub-Seiten, ein Feed. Ergebnisse werden über alle Quellen dedupliziert (Link, dann
  Titel), nach Datum sortiert, auf 30 gekappt. `url` bleibt die kanonische Seite; die
  Scrape-Ziele stehen in `urls`. Deutsches Datum „Am 03. Juli 2026 um 17:13 Uhr".

## Engines (in `scraper.js`)

- **Default** — HTML laden, optional via `containerStart`/`containerEnd` zuschneiden, an
  `teaserSplit` in Items zerlegen, Titel/Datum/Link per Regex-Selektoren extrahieren.
- **`cnn-fear-greed`** — JSON-API statt HTML; eigener Output inkl. Gauge-SVG.
- **`tagesschau-carousel`** — liest die Teaser aus dem `data-v`-JSON der
  Startseiten-Carousel-Instanz (per `carouselName` ausgewählt); filtert via
  `skipLabels` / `skipUrlPatterns`. Reiner HTTPS-Fetch, kein Browser.
- **`browser`** — Rendering via Patchright für JS-Seiten.

`buildAtom` (Atom 1.0 / RFC 4287) erzeugt `<feed>`/`<entry>`; optional `descriptionHtml`
(→ `<content type="html">`) und `guid` (→ `<id>`); `language` wird zu `xml:lang` (Default
`de-DE`). Datumsangaben werden nach RFC 3339 ausgegeben (`<updated>`/`<published>`); der
Datumsparser deckt deutsche, englische (inkl. Ordinal), relative ("5 hours ago") und reine
Uhrzeit-Formate ab.

## Neue Quelle hinzufügen

### Schritt 1 — Eintrag in `sites.json`

```json
{
  "id": "meine-site",
  "name": "Meine Site – Titel",
  "url": "https://www.beispiel.de/news/",
  "filter": null,
  "output": "atom/feed-meine-site.xml",
  "teaserSplit": "<article",
  "titleSelector": "<h2[^>]*>([\\s\\S]*?)<\\/h2>",
  "dateSelector": "<time[^>]*>([\\s\\S]*?)<\\/time>",
  "linkSelector": "href=\"([^\"]+)\""
}
```

Pflichtfelder: `id`, `name`, `url`, `output`, `teaserSplit`, Selektoren. Optional:
`engine`, `filter`, `containerStart`/`containerEnd`, `language`, `gaugeOutput`, `urls` — ohne
`engine`-Feld läuft die Default-Engine (HTML + Regex). Die Selektoren leitest du aus dem
HTML-Quelltext der Seite ab (Strg+U im Browser).

Mit dem optionalen `urls`-Array (Liste von Sub-URLs) werden **mehrere Quellen zu einem Feed
aggregiert**: jede URL wird mit denselben Selektoren geparst, die Ergebnisse werden über alle
Quellen dedupliziert (Link, dann Titel), nach Datum sortiert und auf 30 Items gekappt. Ohne
`urls` bleibt es beim Single-URL-Verhalten via `url` (siehe `marketscreener`).

### Schritt 2 — Eintrag in `update-rss.yml`

```yaml
matrix:
  site:
    - manager-magazin
    - cnn-fear-greed
    - visualcapitalist
    - seekingalpha-notable-calls
    - tagesschau-topthemen
    - marketscreener
    - meine-site       # ← neu
```

Das war es. Beim nächsten Run wird `atom/feed-meine-site.xml` automatisch erstellt.

## Self-heal

Schlägt das Parsen fehl (0 Artikel → Exit-Code 2), kann `self-heal.js` die Anthropic API
aufrufen und die Selektoren in `sites.json` automatisch patchen; danach läuft der Scraper
erneut. (Im Workflow aktuell auskommentiert.) Logik-Trennung: gepatcht wird nur
`sites.json`, nie der Scraper-Code.

## Matrix & Commit

Jede Quelle läuft als **eigener paralleler Job**. `fail-fast: false` → eine fehlschlagende
Quelle blockiert die anderen nicht. Erzeugt ein Lauf **0 Artikel**, wird kein leerer Feed
geschrieben; der Lauf vermerkt dies als **Warnung** (ohne fehlzuschlagen) und der zuletzt
veröffentlichte Feed bleibt unverändert. Jeder Job committet nur seine eigenen Artefakte (XML
+ ggf. SVG); die Pfade kommen aus `sites.json` (`jq`). Parallele Pushes sind durch
Rebase-Retry race-frei. Ein separater `sync-readme`-Job spiegelt **nach** der Matrix
`ACKNOWLEDGMENTS.md` in dieses README.

## OPML Backup

Abonnement-Backup aus Twine (`backup/twine_backup.opml`).
Die Liste wird bei jedem Workflow-Run automatisch aus der OPML erzeugt.

<!-- OPML:START -->
- [CNN Fear & Greed Index](https://sjeap.github.io/web-feed/feed-cnn-fear-greed.xml) ⭐
- [Golem.de - Wissenschaft](https://rss.golem.de/rss.php?ms=wissenschaft&feed=RSS1.0)
- [iNTELLiGENT iNVESTiEREN](https://feeds.feedburner.com/IntelligentInvestieren)
- [Manager Magazin – Der … im Überblick](https://sjeap.github.io/web-feed/feed-manager-magazin.xml) ⭐
- [t3n.de - New Finance](https://t3n.de/tag/finance/rss.xml)
- [Visual Capitalist – Popular](https://sjeap.github.io/web-feed/feed-visualcapitalist.xml) ⭐
- [tagesschau.de - die erste Adresse für Nachrichten und Information](https://www.tagesschau.de/index~rss2.xmlInlandalle)
- [Golem.de - Open Source](https://rss.golem.de/rss.php?ms=open-source&feed=RSS1.0)
<!-- OPML:END -->

<!-- ACKNOWLEDGMENTS:START -->
## Acknowledgments & References

Dieses Projekt wurde inspiriert von und referenziert die folgenden Arbeiten und Quellen.

### Inspirierende Projekte
- [feedmaker (kevinschaul)](https://github.com/kevinschaul/feedmaker) – Inspiration für die Feed-Generierung
- [automated-feed-generator (pineconedata)](https://github.com/pineconedata/automated-feed-generator) – config-getriebener Scraper → RSS-XML (Python/Selenium)
- [html2rss (html2rss)](https://github.com/html2rss/html2rss) – HTML/JSON → RSS via CSS-Selektoren oder Auto-Detection (Ruby)
- [HungryHippo (hueyy)](https://github.com/hueyy/HungryHippo) – scrapt Websites → RSS/ATOM/JSON, on-demand serviert (Node/TS)
- [elixir-scrape (Anonyfox)](https://github.com/Anonyfox/elixir-scrape) – strukturierte Extraktion aus Website/Artikel/Feed (Elixir)
- [rss-ticker (marcus-crane)](https://github.com/marcus-crane/rss-ticker) – RSS-Ticker für den Linux-Desktop (Feed-Konsument, Python)

### Websites
- [Feed43](https://feed43.com/) – Web-zu-RSS-Dienst (Referenz)
- [RSS Everything](https://rsseverything.com/de) – Web-zu-RSS-Dienst (Referenz)
- [FetchRSS – Developers](https://fetchrss.com/developers) – Web-zu-RSS-Dienst / API (Referenz)

### Apps
- [Twine](https://play.google.com/store/apps/details?id=dev.sasikanth.rss.reader) (Sasikanth Miriyampalli) ⭐
- [Feeder](https://play.google.com/store/apps/details?id=com.nononsenseapps.feeder.play) (NoNonsenseApps)
- [FeedFlow](https://play.google.com/store/apps/details?id=com.prof18.feedflow) (Marco Gomiero)
- [Feedly](https://play.google.com/store/apps/details?id=com.devhd.feedly) (DevHD)
- [Pluma](https://play.google.com/store/apps/details?id=qijaz221.android.rss.reader) (QMS Apps)
- [FocusReader](https://play.google.com/store/apps/details?id=allen.town.focus.reader) (Focus App)

### Built with
Node.js · Patchright (Stealth-Chromium) · GitHub Actions · GitHub Pages

---

Sämtliche Inhalte verbleiben beim jeweiligen Anbieter; dieses Projekt verarbeitet deren
öffentlich zugängliche Inhalte ausschließlich zur Feed-Generierung.
<!-- ACKNOWLEDGMENTS:END -->
