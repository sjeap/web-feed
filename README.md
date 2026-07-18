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
- **Aggregiert zwei Quellen** in EINEN Feed (dedupliziert über Link/Titel, sortiert, Cap 25):
  1. Startseite (HTML, `engine: browser`) — `containerStart`/`containerEnd` schneiden den
     relevanten HTML-Bereich **vor** dem `teaserSplit` heraus, damit keine Sidebar-Teaser
     im Feed landen.
  2. `tag/featured/feed/` — der WordPress-RSS-Feed (RSS, `engine: https`, `parser: rss`).
     Läuft als schlanker HTTPS-Fetch über den Residential-Proxy und umgeht damit die
     Cloudflare-Browser-Route; das Bild kommt aus `media:content`/`enclosure` bzw.
     `content:encoded`.
- Englische Inhalte → `language: en-US`; englische/Ordinal-Datumsformate.
- Pro-Quelle-Fehlertoleranz: fällt eine Quelle (Cloudflare-Block/Timeout) aus, baut der Feed
  aus der anderen.

### `cnn-fear-greed` → `atom/feed-cnn-fear-greed.xml` (+ Gauge-SVG)
- **Engine:** `cnn-fear-greed` (JSON statt HTML)
- **Eigenheit:** Kein HTML-Scraping — liest die öffentliche CNN-JSON-API direkt aus.
  Gibt Index-Wert/Rating, Put/Call-Rating und VIX-Rating aus, plus ein Gauge-SVG
  (`gaugeOutput`). Entry-IDs (`<id>`) sind **datumsbezogen**, damit Reader das tägliche Update erkennen.
- Lehre: client-seitig gerenderte Seiten besser über ihre JSON/API-Endpunkte als über
  HTML angehen.

### `seekingalpha-notable-calls` → `atom/feed-seekingalpha-notable-calls.xml`
- **Aggregiert mehrere Quellen** in EINEN Feed (dedupliziert über Link/Titel, nach Datum
  sortiert, auf 25 Items gekappt):
  1. `market-news/notable-calls` — die ursprüngliche JS-Seite (HTML, `engine: browser`).
  2. `tag/etf-portfolio-strategy.xml` — Tag-Feed (RSS, `engine: https`, `parser: rss`).
  3. je ein SeekingAlpha-**combined**-Feed pro Ticker der Watchlist unten (RSS, `https`,
     `parser: rss`), Schema `https://seekingalpha.com/api/sa/combined/{code}.xml`.

     <!-- TICKERS:START -->
     ```json
     ["AIQUY", "ASML", "BNPQF", "CHUEF", "CLLKF", "DHR", "ENLAY", "JOBY", "LILMF", "LIN", "MUTRF", "NEXPF", "PCELF", "RIO", "SE", "TEM", "TMO", "TSM", "VWAGY"]
     ```
     <!-- TICKERS:END -->
- **Engines gemischt:** Die HTML-Quelle braucht den Headless-Browser (deshalb läuft der
  Chromium-Install-Step für diesen Feed); die RSS-Quellen laufen als schlanker HTTPS-Fetch
  über den Residential-Proxy. Pro-Quelle-Fehlertoleranz: eine blockte/timeoutende Quelle
  wird übersprungen, der Feed baut aus dem Rest.
- **Bekanntes Problem:** SeekingAlpha steht hinter **PerimeterX** (HUMAN Security) und blockt
  Datacenter-/CI-IPs. Der Residential-Proxy verbessert die IP-Reputation, aber PerimeterX
  fingerprintet auch TLS/Browser — Erfolg (v. a. für die HTML-Quelle) nicht garantiert. Die
  RSS-Endpunkte sind der „sauberere Weg", können aber ebenfalls geblockt werden.

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
- **Engine:** Default (HTTPS) **über Residential-Proxy** (`proxyCountry: "de"`). MarketScreener
  steht hinter **Akamai Bot Manager**; der Headless-Browser wurde geblockt, ein schlichter
  HTTPS-Client mit sauberer Wohn-IP hat bessere Chancen (Versuch — Akamai fingerprintet auch
  TLS, Erfolg nicht garantiert). Siehe [Residential-Proxy](#residential-proxy-dataimpulse).
- **Eigenheit:** Einziger Feed mit dem optionalen `urls`-Array (Schwerpunkte, ETF, Aktien):
  drei Sub-Seiten, ein Feed. Ergebnisse werden über alle Quellen dedupliziert (Link, dann
  Titel), nach Datum sortiert, auf 25 gekappt. `url` bleibt die kanonische Seite; die
  Scrape-Ziele stehen in `urls`. Deutsches Datum „Am 03. Juli 2026 um 17:13 Uhr".
- **Quellen-Filter:** `excludeIf: "alphavalue"` verwirft alle Items mit dem „AlphaValue"-Label
  (Provider-Icon rechts neben dem Timestamp). Items ohne Label oder mit anderer Quelle (z. B.
  MarketScreener/Zonebourse) bleiben.

## Engines (in `scraper.js`)

- **Default** — HTML laden, optional via `containerStart`/`containerEnd` zuschneiden, an
  `teaserSplit` in Items zerlegen, Titel/Datum/Link per Regex-Selektoren extrahieren.
- **`cnn-fear-greed`** — JSON-API statt HTML; eigener Output inkl. Gauge-SVG.
- **`tagesschau-carousel`** — liest die Teaser aus dem `data-v`-JSON der
  Startseiten-Carousel-Instanz (per `carouselName` ausgewählt); filtert via
  `skipLabels` / `skipUrlPatterns`. Reiner HTTPS-Fetch, kein Browser.
- **`browser`** — Rendering via Patchright für JS-Seiten. Läuft wie alle Feeds über den
  Residential-Proxy (siehe unten), inkl. Bild/Font/Media-Blocking.

**Engine vs. Parser:** `engine` bestimmt den **Transport** (schlanker HTTPS-Fetch vs.
Patchright-Browser), `parser` die **Interpretation** der Antwort: `html` (Default) =
`teaserSplit` + Regex-Selektoren, `rss` = RSS-2.0-/Atom-Parser für echte Feed-Endpunkte
(`…/x.xml`; liest `<item>`/`<entry>`, CDATA-fest, zieht Titel/Link/Datum/GUID/Bild aus
`media:content`/`enclosure`/`<img>`). Beides ist pro Quelle wählbar (siehe unten), sodass ein
Feed HTML- und RSS-Quellen mischen kann (`seekingalpha`).

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
`engine`, `parser`, `filter`, `excludeIf`, `containerStart`/`containerEnd`, `language`,
`gaugeOutput`, `urls`, `tickers`/`tickerTemplate`, `proxy: false` (Proxy-Opt-out; Proxy ist
global an), `proxyCountry`/`proxyLocale`/`proxyTimezone` — ohne `engine`-Feld läuft die
Default-Engine (HTML + Regex). Die Selektoren leitest du aus dem HTML-Quelltext der Seite ab
(Strg+U im Browser).

`filter` und `excludeIf` sind komplementär: `filter` ist eine **Whitelist** auf den Titel
(nur Treffer bleiben), `excludeIf` eine **Blacklist** gegen das **rohe Block-HTML** (Treffer
fliegen raus). Weil `excludeIf` den ganzen Block sieht — nicht nur den Titel — greift es auch
bei Markern, die außerhalb des Titels stehen, z. B. einem Quellen-/Provider-Label neben dem
Timestamp (bei `marketscreener` das „AlphaValue"-Label). Beide Regexes matchen case-insensitive.

Mit dem optionalen `urls`-Array (Liste von Sub-URLs) werden **mehrere Quellen zu einem Feed
aggregiert**: jede URL wird geparst, die Ergebnisse werden über alle Quellen dedupliziert
(Link, dann Titel), nach Datum sortiert und auf 25 Items gekappt. Ohne `urls` bleibt es beim
Single-URL-Verhalten via `url` (siehe `marketscreener`).

Ein `urls`-Eintrag darf ein **String** sein (nutzt `engine`/`parser` der Site) oder ein
**Objekt** `{ "url", "engine"?, "parser"? }` mit Per-Quelle-Overrides. So mischt ein Feed
HTML- und RSS-Quellen mit unterschiedlichem Transport — z. B. `seekingalpha`: die HTML-Seite
via `engine: browser`, die Feed-Endpunkte via `engine: https` + `parser: rss`.

Für viele gleichartige Feed-Quellen gibt es die **Ticker-Expansion**: `tickers` (Array von
Codes) + `tickerTemplate` (URL mit `{code}`-Platzhalter) erzeugen je Code eine zusätzliche
Quelle (Default `tickerEngine: "https"`, `tickerParser: "rss"`). Beispiel `seekingalpha`:
`tickerTemplate: "https://seekingalpha.com/api/sa/combined/{code}.xml"`. Das `tickers`-Array
ist die Single Source of Truth; die alphabetisch sortierte Watchlist-Liste im README wird
daraus gespiegelt.

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

## Residential-Proxy (DataImpulse)

**Alle Feeds** laufen über die Residential-IP — greift in beiden Engines: Browser (Patchright
`proxy:`) und HTTPS/JSON (`https-proxy-agent`, CONNECT-Tunnel; `fetchJsonApi` nutzt intern den
HTTPS-Fetcher). Per Feed abschaltbar mit `"proxy": false`. Optional `proxyCountry` (kostenloses
Country-Targeting, z. B. `"de"` bei `marketscreener`); `proxyLocale`/`proxyTimezone` wirken nur
in der Browser-Engine (geo-konsistente Locale/Zeitzone).

**Credentials** als zwei GitHub-Secrets (Settings → Secrets and variables → Actions), nie im
Code: `DATAIMPULSE_USER`, `DATAIMPULSE_PASS`. Getrennt, weil User/Passwort separat gebraucht
werden und der Username pro Lauf um die Session ergänzt wird. Host/Port
(`gw.dataimpulse.com:823`) stehen im Code (per Env überschreibbar). Fehlen die Secrets, läuft
**direkt** ohne Proxy (Warnung statt Abbruch).

Pro Lauf wird eine zufällige `sessid` an den Username gehängt (`login__cr.de;sessid.<hex>`) →
DataImpulse hält dafür ~30 Min dieselbe IP: **jeder Cron-Scrape eine andere IP**, im Lauf
stabil. In der Browser-Engine werden zusätzlich Bilder/Fonts/Media abgebrochen (~80–90 %
weniger Traffic). HTTPS/JSON-Feeds sind ohnehin winzig; so reicht das $5-/5-GB-Guthaben (nicht
verfallend) über Jahre.

> Hinweis: Kommerzielle Anti-Bot-Systeme (z. B. **PerimeterX** bei SeekingAlpha, **Akamai Bot
> Manager** bei MarketScreener) fingerprinten Browser/TLS und werden vom Residential-Proxy
> allein **nicht** zuverlässig umgangen.

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
- [Feed43](https://feed43.com/) – Web-zu-RSS-Dienst
- [RSS Everything](https://rsseverything.com/de) – Web-zu-RSS-Dienst
- [FetchRSS – Developers](https://fetchrss.com/developers) – Web-zu-RSS-Dienst / API

### Apps
- [Twine](https://play.google.com/store/apps/details?id=dev.sasikanth.rss.reader) (Sasikanth Miriyampalli) ⭐
- [Feeder](https://play.google.com/store/apps/details?id=com.nononsenseapps.feeder.play) (NoNonsenseApps)
- [FeedFlow](https://play.google.com/store/apps/details?id=com.prof18.feedflow) (Marco Gomiero)
- [Feedly](https://play.google.com/store/apps/details?id=com.devhd.feedly) (DevHD)
- [Pluma](https://play.google.com/store/apps/details?id=qijaz221.android.rss.reader) (QMS Apps)
- [FocusReader](https://play.google.com/store/apps/details?id=allen.town.focus.reader) (Focus App)

### Built with
Node.js · Patchright (Stealth-Chromium) · [DataImpulse](https://app.dataimpulse.com/sign-in) (Residential-Proxy) · GitHub Actions · GitHub Pages

---

Sämtliche Inhalte verbleiben beim jeweiligen Anbieter; dieses Projekt verarbeitet deren
öffentlich zugängliche Inhalte ausschließlich zur Feed-Generierung.
<!-- ACKNOWLEDGMENTS:END -->
