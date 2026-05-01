# RSS Feed – Matrix Setup

Mehrere Websites parallel scrapen via GitHub Actions Matrix Strategy.

## Dateistruktur

```
web-feed/
├── scraper.js                        ← ein Scraper für alle Sites
├── sites.json                        ← Konfiguration aller Sites
├── feed-manager-magazin.xml          ← wird automatisch generiert
├── feed-handelsblatt.xml             ← wird automatisch generiert
└── .github/
    └── workflows/
        └── update-rss.yml
```

## Neue Site hinzufügen

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

Die Selektoren (`teaserSplit`, `titleSelector` etc.) musst du aus dem
HTML-Quelltext der jeweiligen Seite ableiten (Strg+U im Browser).

### Schritt 2 — Eintrag in `update-rss.yml`

```yaml
matrix:
  site:
    - manager-magazin
    - handelsblatt
    - meine-site       # ← neu
```

Das war es. Beim nächsten Run wird `feed-meine-site.xml` automatisch erstellt.

## Feed-URLs

```
https://sjeap.github.io/web-feed/feed-manager-magazin.xml
https://sjeap.github.io/web-feed/feed-handelsblatt.xml
```

## Wie Matrix funktioniert

Jede Site läuft als **eigener paralleler Job**:

```
Job: scrape (manager-magazin)   ←─ läuft gleichzeitig
Job: scrape (handelsblatt)      ←─ läuft gleichzeitig
```

Mit `fail-fast: false` schlägt eine Site fehl → die anderen laufen trotzdem durch.
Jeder Job committet seine eigene `feed-xxx.xml` unabhängig.
