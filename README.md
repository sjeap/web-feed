# web-feed – RSS aus Web-Inhalten (Matrix-Setup)

Mehrere Quellen parallel scrapen via GitHub Actions Matrix, Ausgabe als RSS/XML,
veröffentlicht über GitHub Pages.

## Dateistruktur

```
web-feed/
├── scraper.js              ← ein Scraper für alle Feeds (mehrere Engines)
├── self-heal.js            ← repariert kaputte Selektoren via Anthropic API
├── sites.json              ← zentrale Konfiguration aller Feeds (Single Source of Truth)
├── feed-*.xml              ← generierte Feeds (ein File pro Quelle)
├── assets/                 ← generierte Zusatz-Artefakte (gaugeOutput)
│   └── *.svg               ← z. B. Gauge-SVG für cnn-fear-greed
├── ACKNOWLEDGMENTS.md      ← Credits/Quellen (wird ins README gespiegelt)
└── .github/workflows/
    └── update-rss.yml      ← Matrix-Run (cron + manueller Trigger)
```

## Feeds & konzeptionelle Unterschiede

Jeder Feed nutzt bewusst einen anderen Ansatz — abhängig davon, **wie die Quelle ihre
Inhalte ausliefert**. Das ist der Kern des Projekts:

### `manager-magazin` → `feed-manager-magazin.xml`
- **Engine:** Default (HTML + Regex)
- **Eigenheit:** Einziger Feed mit `filter` — eine Titel-Regex (`Der .+ im Überblick`)
  behält nur die täglichen Überblicks-Artikel, alles andere wird verworfen.
- Server-gerendertes HTML, `teaserSplit` an `<div class="teaser"`, klassenbasierte
  Selektoren, deutsche Datumsformate.

### `visualcapitalist` → `feed-visualcapitalist.xml`
- **Engine:** Default (HTML + Regex) **mit** `containerStart` / `containerEnd`
- **Eigenheit:** Die Seite mischt Hauptinhalt und Sidebar. `containerStart`/`End`
  schneiden den relevanten HTML-Bereich **vor** dem `teaserSplit` heraus, damit keine
  Sidebar-Teaser im Feed landen.
- Englische Inhalte → `language: en-US`; englische/Ordinal-Datumsformate.

### `cnn-fear-greed` → `feed-cnn-fear-greed.xml` (+ Gauge-SVG)
- **Engine:** `cnn-fear-greed` (JSON statt HTML)
- **Eigenheit:** Kein HTML-Scraping — liest die öffentliche CNN-JSON-API direkt aus.
  Gibt Index-Wert/Rating, Put/Call-Rating und VIX-Rating aus, plus ein Gauge-SVG
  (`gaugeOutput`). GUIDs sind **datumsbezogen**, damit Reader das tägliche Update erkennen.
- Lehre: client-seitig gerenderte Seiten besser über ihre JSON/API-Endpunkte als über
  HTML angehen.

### `seekingalpha-notable-calls` → `feed-seekingalpha-notable-calls.xml`
- **Engine:** `browser` (Patchright Stealth-Chromium)
- **Eigenheit:** JS-lastige Seite → Headless-Browser nötig (deshalb läuft der
  Chromium-Install-Step **nur** für diesen Feed).
- **Bekanntes Problem:** Cloudflare blockt GitHub-Actions-Runner-IPs (Azure-Datacenter).
  Lokal funktioniert es, in CI kommt nur die Challenge-Seite an. Sauberer Weg wäre der
  offizielle RSS-Feed.

## Engines (in `scraper.js`)

- **Default** — HTML laden, optional via `containerStart`/`containerEnd` zuschneiden, an
  `teaserSplit` in Items zerlegen, Titel/Datum/Link per Regex-Selektoren extrahieren.
- **`cnn-fear-greed`** — JSON-API statt HTML; eigener Output inkl. Gauge-SVG.
- **`browser`** — Rendering via Patchright für JS-Seiten.

`buildRss` unterstützt optional `descriptionHtml`, `guid` und `guidIsPermaLink`; `language`
ist je Feed konfigurierbar (Default `de-DE`). Der Datumsparser deckt deutsche, englische
(inkl. Ordinal), relative ("5 hours ago") und reine Uhrzeit-Formate ab.

## Neue Quelle hinzufügen

### Schritt 1 — Eintrag in `sites.json`

```json
{
  "id": "meine-site",
  "name": "Meine Site – Titel",
  "url": "https://www.beispiel.de/news/",
  "filter": null,
  "output": "feed-meine-site.xml",
  "teaserSplit": "<article",
  "titleSelector": "<h2[^>]*>([\\s\\S]*?)<\\/h2>",
  "dateSelector": "<time[^>]*>([\\s\\S]*?)<\\/time>",
  "linkSelector": "href=\"([^\"]+)\""
}
```

Pflichtfelder: `id`, `name`, `url`, `output`, `teaserSplit`, Selektoren. Optional:
`engine`, `filter`, `containerStart`/`containerEnd`, `language`, `gaugeOutput` — ohne
`engine`-Feld läuft die Default-Engine (HTML + Regex). Die Selektoren leitest du aus dem
HTML-Quelltext der Seite ab (Strg+U im Browser).

### Schritt 2 — Eintrag in `update-rss.yml`

```yaml
matrix:
  site:
    - manager-magazin
    - cnn-fear-greed
    - visualcapitalist
    - seekingalpha-notable-calls
    - meine-site       # ← neu
```

Das war es. Beim nächsten Run wird `feed-meine-site.xml` automatisch erstellt.

## Self-heal

Schlägt das Parsen fehl (0 Artikel → Exit-Code 2), kann `self-heal.js` die Anthropic API
aufrufen und die Selektoren in `sites.json` automatisch patchen; danach läuft der Scraper
erneut. (Im Workflow aktuell auskommentiert.) Logik-Trennung: gepatcht wird nur
`sites.json`, nie der Scraper-Code.

## Matrix & Commit

Jede Quelle läuft als **eigener paralleler Job**. `fail-fast: false` → eine fehlschlagende
Quelle blockiert die anderen nicht. Jeder Job committet nur seine eigenen Artefakte (XML
+ ggf. SVG); die Pfade kommen aus `sites.json` (`jq`). Parallele Pushes sind durch
Rebase-Retry race-frei. Ein separater `sync-readme`-Job spiegelt **nach** der Matrix
`ACKNOWLEDGMENTS.md` in dieses README.

## Feed-URLs

```
https://sjeap.github.io/web-feed/feed-manager-magazin.xml
https://sjeap.github.io/web-feed/feed-visualcapitalist.xml
https://sjeap.github.io/web-feed/feed-cnn-fear-greed.xml
https://sjeap.github.io/web-feed/feed-seekingalpha-notable-calls.xml
```

<!-- ACKNOWLEDGMENTS:START -->
## Acknowledgments & References

Dieses Projekt wurde inspiriert von und referenziert die folgenden Arbeiten und Quellen.

### Inspirierende Projekte
- [feedmaker (kevinschaul)](https://github.com/kevinschaul/feedmaker) – Inspiration für die Feed-Generierung
- [feedmaker (Hipska)](https://github.com/Hipska/feedmaker) – Inspiration für die Feed-Generierung
- [feedmaker (williamkray)](https://github.com/williamkray/feedmaker) – Inspiration für die Feed-Generierung

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
