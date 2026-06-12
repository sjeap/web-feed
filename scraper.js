/**
 * scraper.js — Matrix-fähig (robuste Variante, v4)
 * Aufruf: node scraper.js <site-id>
 *
 * Neu in v4:
 *  • Optionale Felder `containerStart` / `containerEnd` in sites.json
 *    → grenzen das HTML vor dem teaserSplit auf einen bestimmten Bereich ein
 *    (z. B. nur die "Popular"-Sidebar einer Themenseite)
 *  • parseFlexibleDate (vorher parseGermanDate) versteht jetzt zusätzlich
 *    englische Formate ("8th Apr, 2026", "Apr 8, 2026") und relative
 *    Formate ("5 hours ago", "2 days ago", "3 weeks ago")
 *
 * Aus v3:
 *  • Browser-Engine nutzt Patchright (Stealth-Playwright-Fork)
 *  • Patchright nutzt launchPersistentContext für volle Stealth-Wirkung
 *
 * Aus v2:
 *  • Optionales Feld `engine: "browser"` in sites.json
 *
 * Aus v1:
 *  • Split- und Title-Fallbacks
 *  • Decompression von gzip/deflate/br
 *  • Status-Code-Check
 *  • Bild-Extraktion (src/data-src)
 *  • HTML-Entity-Dekodierung
 *  • Diagnose-Stats
 *  • Snapshot bei PARSE_FAILED
 *  • Robusteres Redirect-Handling
 */

const https = require("https");
const http  = require("http");
const zlib  = require("zlib");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const crypto = require("crypto");
const { URL } = require("url");

const SITES_FILE    = path.join(__dirname, "sites.json");
const FEED_BASE_URL = "https://sjeap.github.io/web-feed/";

// ── Site-ID aus Argument lesen ──
const siteId = process.argv[2];
if (!siteId) {
  console.error("❌ Kein Site-ID angegeben. Beispiel: node scraper.js manager-magazin");
  process.exit(1);
}

const sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
const site  = sites.find(s => s.id === siteId);
if (!site) {
  console.error(`❌ Site '${siteId}' nicht in sites.json gefunden`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// Engine 1: HTTPS (lightweight, default)
// ─────────────────────────────────────────────────────────────────────
function fetchPageHttps(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Zu viele Redirects"));

    const u   = new URL(url);
    const lib = u.protocol === "http:" ? http : https;

    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9," +
          "image/avif,image/webp,image/apng,*/*;q=0.8," +
          "application/signed-exchange;v=b3;q=0.7",
        "Accept-Language":           "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding":           "gzip, deflate, br",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest":            "document",
        "Sec-Fetch-Mode":            "navigate",
        "Sec-Fetch-Site":            "none",
        "Sec-Fetch-User":            "?1",
        "sec-ch-ua":                 '"Chromium";v="149", "Google Chrome";v="149", "Not?A_Brand";v="99"',
        "sec-ch-ua-mobile":          "?0",
        "sec-ch-ua-platform":        '"Windows"',
      },
    };

    lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).href;
        console.log(`   ↪ Redirect ${res.statusCode} → ${nextUrl}`);
        res.resume();
        return fetchPageHttps(nextUrl, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} (${url})`));
      }

      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if      (enc === "gzip")    stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br")      stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on("data",  (c) => chunks.push(c));
      stream.on("end",   ()  => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    }).on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Engine 2: Patchright Chromium (stealth, für Cloudflare-protected Seiten)
// ─────────────────────────────────────────────────────────────────────
async function fetchPageBrowser(url) {
  console.log("   🌐 Engine: Patchright Chromium (Stealth-Modus)");
  const { chromium } = require("patchright");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchright-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless:   true,
    viewport:   { width: 1366, height: 768 },
    locale:     "en-US",
    timezoneId: "America/New_York",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  try {
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);

    try {
      await page.waitForSelector("article, main, [data-test-id]", { timeout: 10000 });
    } catch (e) {
      console.log("   ⚠ Kein Content-Selektor erkannt – Wall evtl. nicht durchbrochen");
    }

    const html = await page.content();

    if (
      html.includes("Just a moment") ||
      html.includes("cf-browser-verification") ||
      html.includes("Checking your browser") ||
      html.includes("Access denied") ||
      html.length < 20000
    ) {
      console.log(`   ⚠ Verdächtige Antwort (${html.length} Zeichen) – ggf. weiterhin blockiert`);
    }

    return html;
  } finally {
    await context.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// Engine-Dispatcher
// ─────────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  if (site.engine === "browser") {
    return fetchPageBrowser(url);
  }
  return fetchPageHttps(url);
}

// ─────────────────────────────────────────────────────────────────────
// HTML-Helpers
// ─────────────────────────────────────────────────────────────────────
function decodeEntities(str) {
  return (str || "")
    .replace(/&amp;/g,  "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&shy;/g,  "")
    .replace(/&#(\d+);/g,        (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi,(_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(str) {
  if (!str) return null;
  return decodeEntities(str.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function extractText(snippet, regexStr) {
  if (!regexStr || !snippet) return null;
  try {
    const m = new RegExp(regexStr, "i").exec(snippet);
    if (!m || !m[1]) return null;
    return cleanText(m[1]);
  } catch (e) {
    console.error(`   ⚠ Regex-Fehler in Selektor: ${regexStr} (${e.message})`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// JSON-API-Fetcher (für engine: "cnn-fear-greed")
// Nutzt fetchPageHttps; antwortet mit geparstem JSON-Objekt.
// ─────────────────────────────────────────────────────────────────────
async function fetchJsonApi(url) {
  const raw = await fetchPageHttps(url);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON-Parse-Fehler von ${url}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// CNN Fear & Greed: Bands (Schwellwerte + Farben)
// Farben matchen das aktuelle CNN-Design: nur das aktive Band ist farbig,
// alle anderen sind hellgrau.
// ─────────────────────────────────────────────────────────────────────
const FNG_BANDS = [
  { key: "extreme fear",  label: "Extreme Fear",  min:  0, max: 25,  color: "#F08080", text: "EXTREME FEAR" },
  { key: "fear",          label: "Fear",          min: 25, max: 45,  color: "#F5B97F", text: "FEAR" },
  { key: "neutral",       label: "Neutral",       min: 45, max: 55,  color: "#F5DC85", text: "NEUTRAL" },
  { key: "greed",         label: "Greed",         min: 55, max: 75,  color: "#9DDFC4", text: "GREED" },
  { key: "extreme greed", label: "Extreme Greed", min: 75, max: 100, color: "#7DD3A0", text: "EXTREME GREED" },
];
const FNG_INACTIVE_COLOR = "#ebedf0";
const FNG_LABEL_COLOR    = "#3a3a3a";
const FNG_SCALE_COLOR    = "#9aa0a6";
const FNG_NEEDLE_COLOR   = "#1a1a1a";
const FNG_VALUE_COLOR    = "#1a1a1a";

function bandForRating(rating) {
  const r = (rating || "").trim().toLowerCase();
  return FNG_BANDS.find(b => b.key === r) || null;
}

function bandForScore(score) {
  return FNG_BANDS.find(b => score >= b.min && score < b.max) ||
         FNG_BANDS[FNG_BANDS.length - 1];
}

// ─────────────────────────────────────────────────────────────────────
// SVG Gauge: Polar → Cartesian (SVG: Y-Achse nach unten)
// ─────────────────────────────────────────────────────────────────────
function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad),
  };
}

// Annularer Sektor (Donut-Slice) zwischen Score s1 und s2 (0..100)
function annularSector(cx, cy, rO, rI, s1, s2) {
  // Score → Winkel: 0 = 180° (links), 100 = 0° (rechts)
  const a1 = 180 - s1 * 1.8;
  const a2 = 180 - s2 * 1.8;
  const pO1 = polar(cx, cy, rO, a1);
  const pO2 = polar(cx, cy, rO, a2);
  const pI1 = polar(cx, cy, rI, a1);
  const pI2 = polar(cx, cy, rI, a2);
  return [
    `M ${pO1.x.toFixed(2)} ${pO1.y.toFixed(2)}`,
    `A ${rO} ${rO} 0 0 1 ${pO2.x.toFixed(2)} ${pO2.y.toFixed(2)}`,
    `L ${pI2.x.toFixed(2)} ${pI2.y.toFixed(2)}`,
    `A ${rI} ${rI} 0 0 0 ${pI1.x.toFixed(2)} ${pI1.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// Text-Helper (Single-Line oder Multi-Line via tspan)
function svgText(x, y, lines, opts = {}) {
  const {
    fontSize   = 14,
    fontWeight = "700",
    fill       = "#000000",
    fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  } = opts;
  const lh  = fontSize + 2;
  const arr = Array.isArray(lines) ? lines : [lines];
  const xs  = x.toFixed(1);
  const ys  = y.toFixed(1);
  const common = `text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}"`;
  if (arr.length === 1) {
    return `<text x="${xs}" y="${ys}" ${common}>${arr[0]}</text>`;
  }
  const startDy = -((arr.length - 1) * lh) / 2;
  const tspans  = arr.map((line, i) =>
    `<tspan x="${xs}" dy="${i === 0 ? startDy : lh}">${line}</tspan>`
  ).join("");
  return `<text x="${xs}" y="${ys}" ${common}>${tspans}</text>`;
}

// ─────────────────────────────────────────────────────────────────────
// Gauge-SVG-Renderer (exakt im CNN-Design)
//   score:  0..100  (z.B. 67)
//   rating: "extreme fear" | "fear" | "neutral" | "greed" | "extreme greed"
//           (Falls leer, wird Band aus Score abgeleitet)
// ─────────────────────────────────────────────────────────────────────
function renderGaugeSvg(score, rating) {
  const W = 680;
  const H = 400;
  const cx = W / 2;     // 340
  const cy = 350;
  const rO = 290;       // Außenradius des Bogens
  const rI = 170;       // Innenradius des Bogens
  const labelR = (rO + rI) / 2;  // 230 — Mitte des Bogens, für Bandlabels
  const scaleR = 148;   // innerhalb des Innenbogens, für Skala-Zahlen
  const tickR  = 132;   // innerhalb der Skala-Zahlen, für Tick-Dots
  const centerR = 48;
  const active = bandForRating(rating) || bandForScore(score);

  // 1) Sektoren — nur das aktive ist farbig, alle anderen hellgrau
  const sectors = FNG_BANDS.map(b => {
    const fill = active && b.key === active.key ? b.color : FNG_INACTIVE_COLOR;
    return `  <path d="${annularSector(cx, cy, rO, rI, b.min, b.max)}" fill="${fill}"/>`;
  }).join("\n");

  // 2) Bandlabels — INNERHALB des Bogens, tangential gedreht
  //    Rotation: für mathematischen Winkel θ ist die Tangente um (90 - θ) im Uhrzeigersinn gedreht
  const labels = FNG_BANDS.map(b => {
    const mid   = (b.min + b.max) / 2;
    const angle = 180 - mid * 1.8;
    const rot   = 90 - angle;       // SVG-Rotation (Uhrzeigersinn)
    const p     = polar(cx, cy, labelR, angle);
    const lines = b.text.split(" ");
    const x = p.x.toFixed(2);
    const y = p.y.toFixed(2);

    // Multi-Line: erste Zeile außen (weg vom Zentrum, dy negativ), zweite Zeile innen
    const lh = 14;
    const startDy = lines.length > 1 ? -(lines.length - 1) * lh / 2 : 0;
    const tspans = lines.map((line, i) =>
      `<tspan x="${x}" dy="${i === 0 ? startDy : lh}">${line}</tspan>`
    ).join("");

    return `  <text transform="rotate(${rot.toFixed(2)} ${x} ${y})" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="700" fill="${FNG_LABEL_COLOR}">${tspans}</text>`;
  }).join("\n");

  // 3) Skala-Zahlen (0, 25, 50, 75, 100) — innerhalb, NICHT rotiert
  const scaleNums = [0, 25, 50, 75, 100].map(s => {
    const angle = 180 - s * 1.8;
    const p = polar(cx, cy, scaleR, angle);
    return `  <text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="400" fill="${FNG_SCALE_COLOR}">${s}</text>`;
  }).join("\n");

  // 4) Tick-Dots — alle 5 Score-Schritte, außer wo Zahlen stehen
  const tickDots = [];
  for (let s = 0; s <= 100; s += 5) {
    if (s % 25 === 0) continue; // Skala-Zahlen-Positionen auslassen
    const angle = 180 - s * 1.8;
    const p = polar(cx, cy, tickR, angle);
    tickDots.push(`  <circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.6" fill="${FNG_SCALE_COLOR}"/>`);
  }

  // 5) Nadel — vom Zentrum bis zur Außenkante des Bogens
  const clamped     = Math.max(0, Math.min(100, score));
  const needleAngle = 180 - clamped * 1.8;
  const needleEnd   = polar(cx, cy, rO - 4, needleAngle);
  const needle      = `  <line x1="${cx}" y1="${cy}" x2="${needleEnd.x.toFixed(2)}" y2="${needleEnd.y.toFixed(2)}" stroke="${FNG_NEEDLE_COLOR}" stroke-width="4" stroke-linecap="round"/>`;

  // 6) Center-Disk (weiß, kein Border, verdeckt Nadelfuß)
  const centerDisk = `  <circle cx="${cx}" cy="${cy}" r="${centerR}" fill="#ffffff"/>`;

  // 7) Center-Wert (großer Zahlenwert)
  const value = `  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="34" font-weight="800" fill="${FNG_VALUE_COLOR}">${Math.round(score)}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
${sectors}
${tickDots.join("\n")}
${scaleNums}
${labels}
${needle}
${centerDisk}
${value}
</svg>`;
}

// ─────────────────────────────────────────────────────────────────────
// CNN Fear & Greed Item-Builder
// Erzeugt aus der JSON-API genau ein RSS-Item mit den drei vom User
// gewünschten Werten in der Description:
//   1) Fear & Greed Index – numerischer Wert + Rating (z.B. 67, greed)
//      [entspricht "market-fng-gauge__dial-number-value" auf der Seite]
//   2) 5-day average put/call ratio – Rating (z.B. fear)
//   3) VIX and its 50-day moving average – Rating (z.B. neutral)
// ─────────────────────────────────────────────────────────────────────
function capitalizeRating(rating) {
  return (rating || "")
    .split(" ")
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
    .join(" ");
}

function buildCnnFearGreedItems(data, site) {
  const fng     = data && data.fear_and_greed;
  const putCall = data && data.put_call_options;
  const vix     = data && data.market_volatility_vix;

  if (!fng || typeof fng.score !== "number" || !fng.rating) {
    throw new Error("CNN-API: 'fear_and_greed' fehlt oder hat unerwartete Struktur");
  }

  const score        = Math.round(fng.score);
  const ratingLabel  = capitalizeRating(fng.rating);
  const putCallLabel = putCall && putCall.rating ? capitalizeRating(putCall.rating) : "n/a";
  const vixLabel     = vix     && vix.rating     ? capitalizeRating(vix.rating)     : "n/a";

  // Aktive Band für Akzentfarbe in der Description
  const activeBand = bandForRating(fng.rating) || bandForScore(fng.score);
  const accent     = activeBand ? activeBand.color : "#64748b";

  // pubDate aus CNN-timestamp; Fallback auf jetzt
  const tsRaw  = fng.timestamp || (data.fear_and_greed_historical && data.fear_and_greed_historical.timestamp);
  const tsDate = tsRaw ? new Date(typeof tsRaw === "number" ? tsRaw : tsRaw) : new Date();
  const validTs = !isNaN(tsDate.getTime());
  const pubDate = (validTs ? tsDate : new Date()).toUTCString();

  // GUID inhaltsabhängig: kurzer Hash über die relevanten Werte (Score + die
  // drei Ratings). Ändert sich die Lesung → neue <id> → Reader zeigt ein neues,
  // ungelesenes Item (auch intraday); gleiche Lesung → gleiche <id> → kein
  // Fehlalarm. (Vorher datumsbasiert: max. 1 neues Item/Tag, intraday unsichtbar.)
  const contentSig = [
    score,
    (fng.rating || "").trim().toLowerCase(),
    ((putCall && putCall.rating) || "").trim().toLowerCase(),
    ((vix && vix.rating) || "").trim().toLowerCase(),
  ].join("|");
  const contentHash = crypto.createHash("sha1").update(contentSig).digest("hex").slice(0, 12);
  const guid = `${site.url}#${contentHash}`;

  // Gauge-Bild-URL: Cachebuster ebenfalls am Inhalt, damit der Reader das SVG
  // bei jeder Wert-Änderung neu lädt (nicht erst beim Datumswechsel).
  const gaugeUrl = site.gaugeOutput
    ? `${FEED_BASE_URL}${site.gaugeOutput}?v=${contentHash}`
    : null;

  const title = `Fear & Greed: ${score} (${ratingLabel}) // Put-Call Ratio: ${putCallLabel} // Market Volatility VIX: ${vixLabel}`;

  // Schön formatierte HTML-Description: Bild + Tabelle
  const imgBlock = gaugeUrl
    ? `<p style="margin:0 0 12px 0;"><img src="${escapeXml(gaugeUrl)}" alt="${escapeXml(title)}" width="660" style="max-width:100%;height:auto;display:block;"/></p>`
    : "";

  const descriptionHtml =
    imgBlock +
    `<h2 style="margin:0 0 8px 0;font-family:-apple-system,system-ui,sans-serif;font-size:20px;">` +
      `Fear &amp; Greed Index: ` +
      `<span style="color:${accent};">${score} — ${escapeXml(ratingLabel)}</span>` +
    `</h2>` +
    `<table cellpadding="6" cellspacing="0" border="0" style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;border-collapse:collapse;">` +
      `<tr>` +
        `<td style="color:#64748b;padding:4px 12px 4px 0;">5-day average put/call ratio</td>` +
        `<td style="font-weight:600;">${escapeXml(putCallLabel)}</td>` +
      `</tr>` +
      `<tr>` +
        `<td style="color:#64748b;padding:4px 12px 4px 0;">VIX and its 50-day moving average</td>` +
        `<td style="font-weight:600;">${escapeXml(vixLabel)}</td>` +
      `</tr>` +
    `</table>` +
    `<p style="color:#94a3b8;font-size:12px;margin:10px 0 0 0;font-family:-apple-system,system-ui,sans-serif;">via CNN Business</p>`;

  return [{
    title,
    // Link trägt denselben Inhalts-Hash als Fragment: Reader, die über den
    // <link> deduplizieren (statt über die <id>), erkennen so eine Änderung.
    // Das Fragment ändert das Ziel nicht (CNN ignoriert es).
    link:    `${site.url}#${contentHash}`,
    pubDate,
    imgSrc:  gaugeUrl,
    imgAlt:  title,
    mimeType: gaugeUrl ? "image/svg+xml" : null,
    guid,
    guidIsPermaLink: false,
    descriptionHtml,
  }];
}

// ─────────────────────────────────────────────────────────────────────
// tagesschau-Carousel (engine: "tagesschau-carousel")
// Die Startseiten-Teaser stehen NICHT im sichtbaren Markup, sondern als
// HTML-entity-kodiertes JSON im Attribut  data-v="..."  der Vue-Instanz
// data-v-type="Carousel". teaserSplit/containerStart greifen hier nicht —
// daher eigener Parser. Reiner HTTPS-Fetch (kein Browser): öffentliches
// ARD-Angebot ohne Bot-Schutz auf Actions-IPs.
//
// Konfig (sites.json, alle optional):
//   carouselName    : Name des Ziel-Carousels (default "LIVE UND TOPTHEMEN")
//   skipLabels      : Labels die rausfliegen (default ["Livestream"])
//   skipUrlPatterns : teaserUrl-Substrings die rausfliegen
//                     (default ["/multimedia/livestreams"])
// ─────────────────────────────────────────────────────────────────────

// Alle data-v-Werte sind entity-kodiert → der Rohwert enthält keine echten
// Anführungszeichen, daher ist [^"]+ als Capture sicher. Wir parsen ALLE
// Blobs und wählen später per Name aus (robust gegen Attribut-Reihenfolge,
// ignoriert z.B. data-v-type="Mubu" oder andere Carousels).
//
// Robustheit: tagesschau liefert in den (von uns ungenutzten) Tracking-Blobs
// gelegentlich defekte Entities, z.B. verdoppeltes q in &qquot; statt &quot;.
// Ein einziger solcher Defekt würde JSON.parse über den GESAMTEN Blob – und
// damit das ganze Carousel – killen. Daher: bei Parse-Fehler ein gezielter
// Reparaturversuch (&q{2,}uot; → &quot;), erst dann aufgeben.
function extractDataVObjects(html) {
  const out = [];
  const re  = /data-v="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let obj;
    try {
      obj = JSON.parse(decodeEntities(m[1]));
    } catch (e) {
      const repaired = m[1].replace(/&q{2,}uot;/g, "&quot;");
      if (repaired !== m[1]) {
        try {
          obj = JSON.parse(decodeEntities(repaired));
          console.warn("   ⚠ data-v-Blob mit defektem Entity repariert (&q…uot; → &quot;)");
        } catch (e2) { /* weiterhin kaputt → überspringen */ }
      }
    }
    if (obj !== undefined) out.push(obj);
  }
  return out;
}

// Vorschaubild für ein Carousel-Item bestimmen.
// 1) Bevorzugt das Preview-Template aus meta.images (kind:"preview", JPG) plus
//    imageTemplateConfig → die Platzhalter {size}/{width} werden mit gewählter
//    Variante/Breite gefüllt. Volle Auflösungs-Kontrolle, kein Zusatz-Request.
// 2) Fallback: vorab aufgelöstes posterImage (JPG vor WebP).
function pickTagesschauThumbnail(it, thumbWidth, thumbVariant) {
  const mc     = it.playerData && it.playerData.mc;
  const images = (mc && mc.meta && Array.isArray(mc.meta.images)) ? mc.meta.images : [];
  const tmpl   = images.find(im => im && /\.jpe?g/i.test(im.url || ""))
              || images.find(im => im && im.url);
  const cfg    = it.playerData && it.playerData.pc && it.playerData.pc.generic
              && it.playerData.pc.generic.imageTemplateConfig;

  if (tmpl && tmpl.url && tmpl.url.includes("{size}") && cfg && Array.isArray(cfg.size)) {
    const sizeEntry = cfg.size.find(s => s && (s.value || "").includes(thumbVariant)) || cfg.size[0];
    if (sizeEntry && sizeEntry.value) {
      // Breite an die vom CDN erlaubte Spanne klemmen (Minimum ~320).
      let w = thumbWidth;
      if (cfg.width && typeof cfg.width.min === "number") w = Math.max(w, cfg.width.min);
      if (cfg.width && typeof cfg.width.max === "number") w = Math.min(w, cfg.width.max);
      const url  = tmpl.url.replace("{size}", sizeEntry.value).replace("{width}", String(w));
      const mime = /\.webp/i.test(url) ? "image/webp" : "image/jpeg";
      return { imgSrc: url, mimeType: mime };
    }
  }

  const p = it.posterImage;
  if (p) {
    if (p.urlL || p.urlM) return { imgSrc: p.urlL || p.urlM, mimeType: "image/jpeg" };
    if (p.urlS)           return { imgSrc: p.urlS,           mimeType: "image/webp" };
  }
  return { imgSrc: null, mimeType: null };
}

function buildTagesschauCarouselItems(html, site) {
  const carouselName = site.carouselName   || "LIVE UND TOPTHEMEN";
  const skipLabels   = site.skipLabels      || ["Livestream"];
  const skipUrlParts = site.skipUrlPatterns || ["/multimedia/livestreams"];
  const thumbWidth   = (typeof site.thumbWidth === "number") ? site.thumbWidth : 320;
  const thumbVariant = site.thumbVariant || "16x9-small";

  const objs     = extractDataVObjects(html);
  const carousel = objs.find(o => o && o.name === carouselName && Array.isArray(o.sliderItems));
  if (!carousel) {
    const names = objs.map(o => o && o.name).filter(Boolean).join(", ") || "keine";
    throw new Error(
      `tagesschau-carousel: Carousel "${carouselName}" nicht gefunden (data-v-Namen: ${names})`
    );
  }

  const items = [];
  const seen  = new Set();

  for (const it of carousel.sliderItems) {
    if (!it || !it.headline || !it.teaserUrl) continue;
    if (skipLabels.includes(it.label)) continue;
    if (skipUrlParts.some(p => it.teaserUrl.includes(p))) continue;

    const title = cleanText(it.headline);
    if (!title || title.length < 10 || seen.has(title)) continue;
    seen.add(title);

    const link = it.teaserUrl.startsWith("http")
      ? it.teaserUrl
      : new URL(it.teaserUrl, site.url).href;

    // pubDate aus eingebettetem Player-Meta: präzise Online-Zeit bevorzugen,
    // sonst Sendezeit-Slot. parseFlexibleDate schluckt ISO 8601 (…Z / +0000).
    const mc  = it.playerData && it.playerData.mc;
    const tp  = mc && mc.pluginData && mc.pluginData["trackingPiano@all"];
    const av  = tp && tp.avContent;
    const iso = (av && (av["d:av_publication_time"] || av["d:av_original_air_time"]))
              || (mc && mc.meta && mc.meta.broadcastedOnDateTime)
              || null;
    const pubDate = parseFlexibleDate(iso);

    // Vorschaubild aus dem meta.images-Preview-Template bauen (Variante +
    // Breite frei wählbar, kein Zusatz-Request); Fallback: posterImage.
    const { imgSrc, mimeType } = pickTagesschauThumbnail(it, thumbWidth, thumbVariant);
    const imgAlt = title;   // alt = Schlagzeile statt generischem "Sendungsbild"

    // guid bewusst NICHT gesetzt → buildAtom nutzt link als <id> (gültiges IRI).
    // Die Artikel-URL ist eindeutig/stabil; kein Datums-Scoping wie bei CNN.
    items.push({ title, link, pubDate, imgSrc, imgAlt, mimeType });
    if (items.length >= 30) break;
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────
// Container-Slicing (neu in v4)
// Grenzt das HTML auf einen bestimmten Bereich ein, BEVOR gesplittet wird.
// Beide Argumente sind plain Strings (indexOf), keine Regex.
// Wenn start nicht gefunden wird, wird das ganze HTML zurückgegeben.
// Wenn end nicht gefunden wird, wird bis zum Ende des HTML gesliced.
// ─────────────────────────────────────────────────────────────────────
function sliceContainer(html, start, end) {
  if (!start && !end) return html;

  let s = 0;
  let e = html.length;

  if (start) {
    const idx = html.indexOf(start);
    if (idx === -1) {
      console.log(`   ⚠ containerStart "${start}" nicht im HTML gefunden — verwende ganzes HTML`);
      return html;
    }
    s = idx;
  }

  if (end) {
    const idx = html.indexOf(end, s + (start ? start.length : 0));
    if (idx === -1) {
      console.log(`   ⚠ containerEnd "${end}" nicht gefunden — slice bis Ende des HTML`);
    } else {
      e = idx;
    }
  }

  const sliced = html.slice(s, e);
  console.log(`   ✂ Container-Slice: ${html.length} → ${sliced.length} Zeichen`);
  return sliced;
}

// ─────────────────────────────────────────────────────────────────────
// Multi-Strategie-Split
// ─────────────────────────────────────────────────────────────────────
function smartSplit(html, primarySplit) {
  if (primarySplit) {
    const parts = html.split(primarySplit);
    if (parts.length >= 3) {
      console.log(`   ✓ Split via "${primarySplit}" → ${parts.length - 1} Blöcke`);
      return parts;
    }
    console.log(
      `   ⚠ Primary-Split "${primarySplit}" lieferte nur ${parts.length - 1} Block(s) – probiere Fallbacks`
    );
  }

  const fallbacks = [
    { label: "<article",                  re: /<article\b/i },
    { label: 'class="...teaser..."',      re: /<(?:div|li|article)[^>]*class="[^"]*teaser[^"]*"/i },
    { label: 'data-block-el="teaser"',    re: /data-block-(?:el|type|component)="[^"]*[Tt]easer/i },
    { label: 'data-component="Teaser"',   re: /data-component="[^"]*[Tt]easer/i },
    { label: '<li class="...headline..."',re: /<li[^>]*class="[^"]*headline[^"]*"/i },
  ];

  for (const fb of fallbacks) {
    const parts = html.split(fb.re);
    if (parts.length >= 3) {
      console.log(`   ✓ Fallback-Split via ${fb.label} → ${parts.length - 1} Blöcke`);
      return parts;
    }
  }

  console.log("   ⚠ Keine Split-Strategie lieferte ≥2 Blöcke");
  return primarySplit ? html.split(primarySplit) : [html];
}

// ─────────────────────────────────────────────────────────────────────
// Multi-Strategie-Titel
// ─────────────────────────────────────────────────────────────────────
const FALLBACK_TITLE_PATTERNS = [
  '<h2[^>]*>([\\s\\S]*?)<\\/h2>',
  '<h3[^>]*>([\\s\\S]*?)<\\/h3>',
  '<a[^>]*\\stitle="([^"]+)"',
  '<span[^>]*class="[^"]*headline[^"]*"[^>]*>([\\s\\S]*?)<\\/span>',
];

function extractTitle(block, primarySelector) {
  let t = extractText(block, primarySelector);
  if (t && t.length >= 10) return t;
  for (const sel of FALLBACK_TITLE_PATTERNS) {
    t = extractText(block, sel);
    if (t && t.length >= 10) return t;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Bild
// ─────────────────────────────────────────────────────────────────────
function extractImage(block) {
  const imgTag = /<img\b[^>]*>/i.exec(block);
  if (!imgTag) return { src: null, alt: null };
  const tag = imgTag[0];
  const src =
    (/\sdata-src="([^"]+)"/i.exec(tag) || [])[1] ||
    (/\ssrc="([^"]+)"/i.exec(tag)      || [])[1] || null;
  const alt =
    (/\salt="([^"]*)"/i.exec(tag)        || [])[1] ||
    (/\saria-label="([^"]*)"/i.exec(tag) || [])[1] || null;
  return { src, alt };
}

// ─────────────────────────────────────────────────────────────────────
// Datum: Deutsch + Englisch + Relativ + ISO 8601
// ─────────────────────────────────────────────────────────────────────
function parseFlexibleDate(str) {
  if (!str) return new Date().toUTCString();
  const s = str.trim();

  // ── Relativ: "5 hours ago", "2 days ago", "3 weeks ago", "1 month ago"
  const rel = s.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (rel) {
    const n   = parseInt(rel[1], 10);
    const ms  = {
      second: 1000,
      minute: 60_000,
      hour:   3_600_000,
      day:    86_400_000,
      week:   604_800_000,
      month:  2_592_000_000,    // 30 Tage approx.
      year:   31_536_000_000,   // 365 Tage approx.
    }[rel[2].toLowerCase()];
    if (ms) return new Date(Date.now() - n * ms).toUTCString();
  }

  // ── Englisch mit Ordnungszahl: "8th Apr, 2026", "1st Mar 2026"
  const ord = s.match(/^(\d{1,2})(?:st|nd|rd|th)\s+(\w+)\.?,?\s+(\d{4})$/i);
  if (ord) {
    const cleaned = `${ord[1]} ${ord[2]} ${ord[3]}`;
    const t = Date.parse(cleaned);
    if (!isNaN(t)) return new Date(t).toUTCString();
  }

  // ── Deutsch: "5. Mai, 14.30 Uhr"
  const months = {
    Januar:1, Februar:2, März:3, Maerz:3, April:4, Mai:5, Juni:6,
    Juli:7, August:8, September:9, Oktober:10, November:11, Dezember:12,
  };
  const de = s.match(/(\d{1,2})\.\s+(\w+),?\s+(\d{1,2})\.(\d{2})\s+Uhr/);
  if (de) {
    const [, day, monthName, hour, min] = de;
    const month = months[monthName];
    if (month) {
      return new Date(new Date().getFullYear(), month - 1, +day, +hour, +min).toUTCString();
    }
  }

  // ── ISO/RFC fallback
  const iso = Date.parse(s);
  if (!isNaN(iso)) return new Date(iso).toUTCString();

  return new Date().toUTCString();
}

// ─────────────────────────────────────────────────────────────────────
// Haupt-Parser
// ─────────────────────────────────────────────────────────────────────
function parseHeadlines(html, site) {
  const items = [];
  const seen  = new Set();

  // v4: optionales Container-Slicing vor dem Split
  const scoped = sliceContainer(html, site.containerStart, site.containerEnd);

  const parts = smartSplit(scoped, site.teaserSplit);

  const stats = {
    blocks:     Math.max(0, parts.length - 1),
    titleFound: 0,
    filtered:   0,
    deduped:    0,
  };

  let filterRegex = null;
  if (site.filter) {
    try { filterRegex = new RegExp(site.filter, "i"); }
    catch (e) { console.error(`   ⚠ Ungültiger Filter "${site.filter}": ${e.message}`); }
  }

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    const title = extractTitle(block, site.titleSelector);
    if (!title || title.length < 10) continue;
    stats.titleFound++;

    if (filterRegex && !filterRegex.test(title)) {
      stats.filtered++;
      continue;
    }

    if (seen.has(title)) {
      stats.deduped++;
      continue;
    }
    seen.add(title);

    const linkMatch = site.linkSelector ? new RegExp(site.linkSelector).exec(block) : null;
    const rawLink   = linkMatch ? linkMatch[1] : null;
    const fullLink  = rawLink
      ? rawLink.startsWith("http")
        ? rawLink
        : new URL(rawLink, site.url).href
      : site.url;

    const dateStr = extractText(block, site.dateSelector);
    const pubDate = parseFlexibleDate(dateStr);

    const { src: imgSrc, alt: imgAlt } = extractImage(block);

    items.push({
      title,
      link:    fullLink,
      pubDate,
      imgSrc,
      imgAlt:  imgAlt || title,
    });

    if (items.length >= 30) break;
  }

  console.log(
    `   📊 Stats: ${stats.blocks} Blöcke · ${stats.titleFound} Titel · ` +
    `${stats.filtered} per Filter · ${stats.deduped} Duplikate · ${items.length} Items`
  );
  return items;
}

// ─────────────────────────────────────────────────────────────────────
// Atom-Bau (Atom 1.0 / RFC 4287)
// ─────────────────────────────────────────────────────────────────────
function escapeXml(str) {
  return (str || "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

// Atom verlangt date-time nach RFC 3339. Akzeptiert RFC-822-Strings
// (toUTCString), ISO-Strings oder Date; gibt "YYYY-MM-DDTHH:MM:SSZ" zurück.
function toRfc3339(input) {
  const d     = (input instanceof Date) ? input : new Date(input);
  const valid = isNaN(d.getTime()) ? new Date() : d;
  return valid.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildAtom(items, site) {
  const lang    = site.language || "de-DE";
  const selfUrl = `${FEED_BASE_URL}${site.output}`;

  // Feed-<updated> = jüngstes Item-Datum, sonst jetzt.
  let newest = 0;
  for (const it of items) {
    const t = Date.parse(it.pubDate);
    if (!isNaN(t) && t > newest) newest = t;
  }
  const feedUpdated = toRfc3339(newest ? new Date(newest) : new Date());

  const entriesXml = items.map(({ title, link, pubDate, imgSrc, imgAlt, guid, descriptionHtml, mimeType }) => {
    const itemMime = mimeType || "image/jpeg";
    const updated  = toRfc3339(pubDate);
    const entryId  = guid || link;   // Artikel-URL ist ein gültiges IRI

    // Atom: Bild als rel="enclosure"-Link (kein media:content nötig).
    const enclosure = imgSrc
      ? `\n      <link rel="enclosure" type="${itemMime}" href="${escapeXml(imgSrc)}"/>`
      : "";

    let content = "";
    if (descriptionHtml) {
      content = `\n      <content type="html"><![CDATA[${descriptionHtml}]]></content>`;
    } else if (imgSrc) {
      content = `\n      <content type="html"><![CDATA[<img src="${imgSrc}" alt="${imgAlt || title}"/><p>${escapeXml(title)}</p>]]></content>`;
    }

    return `
    <entry>
      <title>${escapeXml(title)}</title>
      <id>${escapeXml(entryId)}</id>
      <link rel="alternate" href="${escapeXml(link)}"/>
      <updated>${updated}</updated>
      <published>${updated}</published>${enclosure}${content}
    </entry>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(lang)}">
  <title>${escapeXml(site.name)}</title>
  <subtitle>${escapeXml(site.name)}</subtitle>
  <id>${escapeXml(selfUrl)}</id>
  <link rel="alternate" href="${escapeXml(site.url)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeXml(selfUrl)}"/>
  <updated>${feedUpdated}</updated>
  <author>
    <name>${escapeXml(site.name)}</name>
  </author>
  <generator uri="https://github.com/sjeap/web-feed">web-feed</generator>${entriesXml}
</feed>`;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] [${site.id}] Start ...`);

  let items;

  if (site.engine === "cnn-fear-greed") {
    // ── JSON-API-Pfad: kein HTML-Scraping, kein Teaser-Splitting
    const apiUrl = site.apiUrl || "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
    console.log(`   📡 Fetching JSON: ${apiUrl}`);
    const data = await fetchJsonApi(apiUrl);
    console.log(`   ✓ JSON empfangen, baue Item ...`);
    items = buildCnnFearGreedItems(data, site);

    // SVG-Gauge mit aktuellem Wert generieren und ins Repo schreiben
    if (site.gaugeOutput) {
      const fng = data.fear_and_greed;
      const svg = renderGaugeSvg(fng.score, fng.rating);
      const svgPath = path.join(__dirname, site.gaugeOutput);
      fs.mkdirSync(path.dirname(svgPath), { recursive: true });   // gaugeOutput-Ordner (z.B. asset/) anlegen
      fs.writeFileSync(svgPath, svg, "utf8");
      console.log(`   🎨 Gauge-SVG geschrieben → ${site.gaugeOutput} (score=${Math.round(fng.score)}, rating=${fng.rating})`);
    }
  } else if (site.engine === "tagesschau-carousel") {
    // ── Carousel-Pfad: HTML laden, Teaser aus data-v-JSON extrahieren
    console.log(`   🌐 Fetching HTML: ${site.url}`);
    const html = await fetchPage(site.url);
    console.log(`   HTML geladen: ${html.length} Zeichen`);
    items = buildTagesschauCarouselItems(html, site);

    if (items.length === 0) {
      fs.writeFileSync(
        path.join(__dirname, `snapshot-${site.id}.txt`),
        html.slice(0, 30000),
        "utf8"
      );
      console.error(`PARSE_FAILED [${site.id}]: 0 Items — Snapshot gespeichert (snapshot-${site.id}.txt, ~30 KB)`);
      process.exit(2);
    }
  } else {
    // ── Standard-Pfad: HTML laden + parsen
    console.log(`   🌐 Fetching HTML: ${site.url}`);
    const html = await fetchPage(site.url);
    console.log(`   HTML geladen: ${html.length} Zeichen`);
    items = parseHeadlines(html, site);

    if (items.length === 0) {
      fs.writeFileSync(
        path.join(__dirname, `snapshot-${site.id}.txt`),
        html.slice(0, 30000),
        "utf8"
      );
      console.error(`PARSE_FAILED [${site.id}]: 0 Artikel — Snapshot gespeichert (snapshot-${site.id}.txt, ~30 KB)`);
      process.exit(2);
    }
  }

  if (items.length === 0) {
    console.error(`PARSE_FAILED [${site.id}]: 0 Items`);
    process.exit(2);
  }

  const outputFile = path.join(__dirname, site.output);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });   // Output-Ordner (z.B. atom/) anlegen
  fs.writeFileSync(outputFile, buildAtom(items, site), "utf8");
  console.log(`✅ [${site.id}] ${items.length} Item(s) → ${site.output}`);
  items.forEach(({ title }) => console.log(`   • ${title}`));
}

main().catch((err) => {
  console.error(`❌ [${siteId}] Fehler:`, err.message);
  console.error(err.stack);
  process.exit(1);
});
