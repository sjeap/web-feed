/**
 * self-heal.js — Matrix-fähig
 * Aufruf: node self-heal.js <site-id>
 * Beispiel: node self-heal.js manager-magazin
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SITES_FILE = path.join(__dirname, "sites.json");
const SCRAPER_FILE = path.join(__dirname, "scraper.js");
const MAX_ATTEMPTS = 3;

const siteId = process.argv[2];
if (!siteId) {
  console.error("❌ Kein Site-ID angegeben. Beispiel: node self-heal.js manager-magazin");
  process.exit(1);
}

const sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
const site = sites.find(s => s.id === siteId);
if (!site) {
  console.error(`❌ Site '${siteId}' nicht in sites.json gefunden`);
  process.exit(1);
}

const SNAPSHOT_FILE = path.join(__dirname, `snapshot-${siteId}.txt`);

function callClaude(htmlSnapshot, site, previousError = null) {
  return new Promise((resolve, reject) => {
    const errorHint = previousError
      ? `\nDer vorherige Versuch hat folgenden Fehler produziert: ${previousError}\nBitte korrigiere den Code.`
      : "";

    const prompt = `Du bist ein Node.js-Experte. Unten ist ein HTML-Ausschnitt der Website: ${site.url}
Der bisherige Parser findet keine Artikel mehr — die Seitenstruktur hat sich geändert.

Die aktuelle Konfiguration in sites.json für diese Site:
${JSON.stringify(site, null, 2)}

Deine Aufgabe: Liefere ein aktualisiertes JSON-Objekt mit neuen Selektoren, das die Struktur
des HTML korrekt parsed. Gib NUR das JSON-Objekt zurück (nur die geänderten Felder plus "id"),
ohne Erklärung, ohne Markdown-Backticks.

Das JSON muss folgende Felder enthalten:
- id: "${site.id}" (unveränderlich)
- teaserSplit: String zum Aufteilen des HTML in Artikel-Blöcke
- titleSelector: Regex-String zum Extrahieren des Titels
- dateSelector: Regex-String zum Extrahieren des Datums
- linkSelector: Regex-String zum Extrahieren des Links
- filter: Regex-String oder null${errorHint}

HTML-Ausschnitt (erste 12000 Zeichen):
\`\`\`html
${htmlSnapshot.slice(0, 12000)}
\`\`\`

Antworte NUR mit dem JSON-Objekt, beginnend mit {`;

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.content.find(b => b.type === "text")?.text || "";
          // JSON extrahieren
          const jsonStr = text.startsWith("{") ? text : text.slice(text.indexOf("{"));
          const parsed = JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf("}") + 1));
          resolve(parsed);
        } catch (e) { reject(new Error(`JSON parse error: ${e.message} — Response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function testSelectors(newSelectors, htmlSnapshot, site) {
  try {
    const parts = htmlSnapshot.split(newSelectors.teaserSplit);
    if (parts.length < 2) return { ok: false, error: `teaserSplit '${newSelectors.teaserSplit}' findet keine Blöcke` };

    let found = 0;
    for (let i = 1; i < parts.length; i++) {
      const block = parts[i];
      const titleMatch = new RegExp(newSelectors.titleSelector, "i").exec(block);
      if (titleMatch) {
        const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
        if (!newSelectors.filter || new RegExp(newSelectors.filter, "i").test(title)) found++;
      }
    }
    console.log(`   → Test: ${parts.length - 1} Blöcke, ${found} Artikel nach Filter`);
    return { ok: found > 0, count: found };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function patchSites(newSelectors) {
  const sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
  const idx = sites.findIndex(s => s.id === siteId);
  if (idx === -1) throw new Error(`Site '${siteId}' nicht in sites.json`);

  // Nur Selektoren überschreiben, Rest behalten
  sites[idx] = { ...sites[idx], ...newSelectors, id: siteId };
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2), "utf8");
  console.log(`✅ sites.json gepatcht für '${siteId}'`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY nicht gesetzt");
    process.exit(1);
  }
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.error(`❌ Kein Snapshot gefunden: ${SNAPSHOT_FILE}`);
    process.exit(1);
  }

  const htmlSnapshot = fs.readFileSync(SNAPSHOT_FILE, "utf8");
  console.log(`[self-heal][${siteId}] Snapshot geladen (${htmlSnapshot.length} Zeichen)`);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n[self-heal][${siteId}] Versuch ${attempt}/${MAX_ATTEMPTS}...`);

    try {
      const newSelectors = await callClaude(htmlSnapshot, site, lastError);
      console.log(`   → Neue Selektoren: ${JSON.stringify(newSelectors)}`);

      const test = testSelectors(newSelectors, htmlSnapshot, site);

      if (test.ok) {
        patchSites(newSelectors);
        fs.unlinkSync(SNAPSHOT_FILE);
        console.log(`\n✅ Self-heal erfolgreich [${siteId}] nach ${attempt} Versuch(en)`);
        process.exit(0);
      } else {
        lastError = test.error || "0 Artikel nach Filter";
        console.warn(`   ⚠️  Test fehlgeschlagen: ${lastError}`);
      }
    } catch (e) {
      lastError = e.message;
      console.warn(`   ⚠️  Fehler: ${lastError}`);
    }
  }

  console.error(`\n❌ Self-heal fehlgeschlagen [${siteId}] nach ${MAX_ATTEMPTS} Versuchen`);
  process.exit(1);
}

main();
