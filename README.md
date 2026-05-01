# Feeder (NoNonsenseApps) RSS Feed

Automatischer RSS-Feed für manager-magazin.de/schlagzeilen/, gehostet via GitHub Actions + GitHub Pages.

```
- Manager Magazin
```

## Setup (5 Minuten)

### 1. Repository erstellen

- Neues **öffentliches** GitHub-Repo anlegen (z.B. `mm-rss`)
- `scraper.js` ins Root-Verzeichnis hochladen
- `.github/workflows/update-rss.yml` in den entsprechenden Ordner hochladen

```
mm-rss/
├── scraper.js
├── feed.xml          ← wird automatisch generiert
├── README.md
└── .github/
    └── workflows/
        └── update-rss.yml
```

### 2. GitHub Pages aktivieren

1. Repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / Root `/`
4. Speichern

### 3. Feed-URL in scraper.js anpassen

In `scraper.js`, Zeile mit `atom:link href=` anpassen:

```js
// Ersetze:
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME/feed.xml

// Mit z.B.:
https://maxmuster.github.io/mm-rss/feed.xml
```

### 4. Ersten Lauf manuell starten

GitHub → **Actions** → `Update RSS Feed` → **Run workflow**

Nach ~30 Sekunden erscheint `feed.xml` im Repo.

---

## Deine RSS-Feed-URL

```
https://DEIN_USERNAME.github.io/DEIN_REPO/feed.xml
```

Diese URL kannst du in jeden RSS-Reader eintragen (z.B. Feedly, NetNewsWire, Inoreader).

## Zeitplan

Der Feed wird **jede Stunde** automatisch aktualisiert (konfigurierbar in `update-rss.yml`).

## Hinweise

- GitHub Actions Free: 2.000 Minuten/Monat — stündliches Scraping verbraucht ~720 Minuten/Monat, liegt gut im Limit
- Falls manager-magazin.de seinen HTML-Aufbau ändert, muss der Parser in `scraper.js` angepasst werden
