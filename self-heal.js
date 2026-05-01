/**
 * self-heal.js
 * Wird aufgerufen wenn scraper.js mit Exit-Code 2 endet (0 Artikel gefunden).
 * Schickt den HTML-Snapshot an Claude, bekommt neuen parseHeadlines()-Code,
 * testet ihn, und ersetzt die Funktion in scraper.js bei Erfolg.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SCRAPER_FILE = path.join(__dirname, "scraper.js");
const SNAPSHOT_FILE = path.join(__dirname, "last-html-snapshot.txt");
const MAX_ATTEMPTS = 3;

function callClaude(htmlSnapshot, previousError = null, attempt = 1) {
  return new Promise((resolve, reject) => {
    const errorHint = previousError
      ? `\nDer vorherige Versuch hat folgenden Fehler produziert: ${previousError}\nBitte korrigiere den Code.`
      : "";

    const prompt = `Du bist ein Node.js-Experte. Unten ist ein HTML-Ausschnitt einer deutschen Nachrichtenwebsite.
Der bisherige Parser findet keine Artikel mehr — die Seitenstruktur hat sich geändert.

Deine Aufgabe: Schreibe eine neue JavaScript-Funktion \`parseHeadlines(html)\` die:
1. Alle Artikel-Titel (Headlines) aus dem HTML extrahiert
2. Pro Artikel ein Objekt zurückgibt: { title, link, pubDate, imgSrc, imgAlt }
3. Nur Artikel matched bei denen der Titel dem Muster entspricht: /\\bDer\\s+\\S+.*?im\\s+Überblick\\b/i
4. Links zu absoluten URLs mit https://www.manager-magazin.de ergänzt falls nötig
5. Das Datumsformat "25. September, 18.34 Uhr" in RFC 2822 (toUTCString()) umwandelt
6. imgSrc/imgAlt auf null setzt wenn kein Bild vorhanden
${errorHint}

HTML-Ausschnitt (erste 12000 Zeichen):
\`\`\`html
${htmlSnapshot.slice(0, 12000)}
\`\`\`

Antworte NUR mit dem JavaScript-Funktionscode, ohne Erklärung, ohne Markdown-Backticks, ohne import/require.
Beginne direkt mit: function parseHeadlines(html) {`;

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
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
          // Sicherstellen dass die Funktion mit dem richtigen Header beginnt
          const code = text.startsWith("function parseHeadlines")
            ? text
            : "function parseHeadlines" + text.split("function parseHeadlines").slice(1).join("function parseHeadlines");
          resolve(code.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function testParser(newFunctionCode, htmlSnapshot) {
  try {
    // Hilfsfunktionen die der Parser braucht
    const extractText = (html, regex) => {
      const m = regex.exec(html);
      if (!m) return null;
      return m[1].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
    };
    const parseGermanDate = (str) => {
      if (!str) return new Date().toUTCString();
      const months = {Januar:1,Februar:2,März:3,April:4,Mai:5,Juni:6,Juli:7,August:8,September:9,Oktober:10,November:11,Dezember:12};
      const m = str.match(/(\d{1,2})\.\s+(\w+),?\s+(\d{1,2})\.(\d{2})\s+Uhr/);
      if (!m) return new Date().toUTCString();
      const [, day, monthName, hour, min] = m;
      return new Date(new Date().getFullYear(), (months[monthName]||1)-1, +day, +hour, +min).toUTCString();
    };

    // eslint-disable-next-line no-new-func
    const fn = new Function("html", "extractText", "parseGermanDate",
      newFunctionCode.replace(/^function parseHeadlines\(html\)\s*\{/, "").replace(/\}$/, "")
    );
    const results = fn(htmlSnapshot, extractText, parseGermanDate);

    if (!Array.isArray(results)) throw new Error("Rückgabewert ist kein Array");
    console.log(`   → Test: ${results.length} Artikel gefunden`);
    return { ok: results.length > 0, count: results.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function patchScraper(newFunctionCode) {
  let src = fs.readFileSync(SCRAPER_FILE, "utf8");

  // Ersetze den parseHeadlines Block zwischen den Kommentarmarkern
  const startMarker = "// ── PARSER — wird von self-heal.js ggf. automatisch ersetzt ──";
  const endMarker = "function escapeXml";

  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Parser-Marker in scraper.js nicht gefunden");
  }

  const before = src.slice(0, startIdx);
  const after = src.slice(endIdx);

  const patched = before
    + startMarker + "\n"
    + newFunctionCode + "\n\n"
    + after;

  fs.writeFileSync(SCRAPER_FILE, patched, "utf8");
  console.log("✅ scraper.js erfolgreich gepatcht");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY nicht gesetzt");
    process.exit(1);
  }

  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.error("❌ Kein HTML-Snapshot gefunden (last-html-snapshot.txt)");
    process.exit(1);
  }

  const htmlSnapshot = fs.readFileSync(SNAPSHOT_FILE, "utf8");
  console.log(`[self-heal] HTML-Snapshot geladen (${htmlSnapshot.length} Zeichen)`);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n[self-heal] Versuch ${attempt}/${MAX_ATTEMPTS} — Claude generiert neuen Parser...`);

    try {
      const newCode = await callClaude(htmlSnapshot, lastError, attempt);
      console.log(`   → Code erhalten (${newCode.length} Zeichen)`);

      const test = testParser(newCode, htmlSnapshot);

      if (test.ok) {
        patchScraper(newCode);
        console.log(`\n✅ Self-heal erfolgreich nach ${attempt} Versuch(en) — ${test.count} Artikel`);
        // Snapshot löschen
        fs.unlinkSync(SNAPSHOT_FILE);
        process.exit(0);
      } else {
        lastError = test.error || "Parser liefert 0 Ergebnisse";
        console.warn(`   ⚠️  Test fehlgeschlagen: ${lastError}`);
      }
    } catch (e) {
      lastError = e.message;
      console.warn(`   ⚠️  Fehler: ${lastError}`);
    }
  }

  console.error(`\n❌ Self-heal fehlgeschlagen nach ${MAX_ATTEMPTS} Versuchen — manuelle Überprüfung nötig`);
  process.exit(1);
}

main();
