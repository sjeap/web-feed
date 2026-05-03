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
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control":   "no-cache",
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

  // pubDate aus CNN-timestamp; Fallback auf jetzt
  const tsRaw   = fng.timestamp || (data.fear_and_greed_historical && data.fear_and_greed_historical.timestamp);
  const tsDate  = tsRaw ? new Date(typeof tsRaw === "number" ? tsRaw : tsRaw) : new Date();
  const pubDate = (isNaN(tsDate.getTime()) ? new Date() : tsDate).toUTCString();

  // GUID datumsabhängig, damit Reader täglich ein neues Item erkennen
  const dayKey = (isNaN(tsDate.getTime()) ? new Date() : tsDate).toISOString().slice(0, 10);
  const guid   = `${site.url}#${dayKey}`;

  const title = `Fear & Greed: ${score} (${ratingLabel}) – Put/Call: ${putCallLabel}, VIX: ${vixLabel}`;

  const descriptionHtml =
    `<p><strong>Fear &amp; Greed Index:</strong> ${score} (${escapeXml(ratingLabel)})</p>` +
    `<p><strong>5-day average put/call ratio:</strong> ${escapeXml(putCallLabel)}</p>` +
    `<p><strong>VIX and its 50-day moving average:</strong> ${escapeXml(vixLabel)}</p>`;

  return [{
    title,
    link:    site.url,
    pubDate,
    imgSrc:  null,
    imgAlt:  title,
    guid,
    guidIsPermaLink: false,
    descriptionHtml,
  }];
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
// RSS-Bau
// ─────────────────────────────────────────────────────────────────────
function escapeXml(str) {
  return (str || "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

function buildRss(items, site) {
  const buildDate = new Date().toUTCString();
  const selfUrl   = `${FEED_BASE_URL}${site.output}`;

  const itemsXml = items.map(({ title, link, pubDate, imgSrc, imgAlt, guid, guidIsPermaLink, descriptionHtml }) => {
    const enclosure = imgSrc
      ? `\n      <enclosure url="${escapeXml(imgSrc)}" type="image/jpeg" length="0"/>`
      : "";
    const mediaContent = imgSrc
      ? `\n      <media:content url="${escapeXml(imgSrc)}" medium="image"><media:title>${escapeXml(imgAlt)}</media:title></media:content>`
      : "";
    const description = descriptionHtml
      ? `<![CDATA[${descriptionHtml}]]>`
      : imgSrc
        ? `<![CDATA[<img src="${imgSrc}" alt="${imgAlt}"/><p>${escapeXml(title)}</p>]]>`
        : `<![CDATA[${escapeXml(title)}]]>`;
    const guidValue   = guid || link;
    const isPermaLink = (guidIsPermaLink === false) ? "false" : "true";
    return `
    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="${isPermaLink}">${escapeXml(guidValue)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>${enclosure}${mediaContent}
    </item>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(site.name)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>${escapeXml(site.name)}</description>
    <language>${escapeXml(site.language || "de-DE")}</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>${itemsXml}
  </channel>
</rss>`;
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
  fs.writeFileSync(outputFile, buildRss(items, site), "utf8");
  console.log(`✅ [${site.id}] ${items.length} Item(s) → ${site.output}`);
  items.forEach(({ title }) => console.log(`   • ${title}`));
}

main().catch((err) => {
  console.error(`❌ [${siteId}] Fehler:`, err.message);
  console.error(err.stack);
  process.exit(1);
});
