const https = require("https");
const fs = require("fs");
const path = require("path");

const TARGET_URL = "https://www.manager-magazin.de/schlagzeilen/";
const OUTPUT_FILE = path.join(__dirname, "feed.xml");
const FEED_TITLE = "Manager Magazin – Der … im Überblick";
const FEED_LINK = TARGET_URL;
const FEED_DESCRIPTION = 'Nur „Der … im Überblick"-Artikel von manager-magazin.de';

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9",
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function extractText(html, regex) {
  const m = regex.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, "").trim()
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function parseGermanDate(str) {
  if (!str) return new Date().toUTCString();
  const months = {
    Januar:1,Februar:2,März:3,April:4,Mai:5,Juni:6,
    Juli:7,August:8,September:9,Oktober:10,November:11,Dezember:12
  };
  const m = str.match(/(\d{1,2})\.\s+(\w+),?\s+(\d{1,2})\.(\d{2})\s+Uhr/);
  if (!m) return new Date().toUTCString();
  const [, day, monthName, hour, min] = m;
  const month = months[monthName];
  if (!month) return new Date().toUTCString();
  return new Date(new Date().getFullYear(), month - 1, +day, +hour, +min).toUTCString();
}

// ── PARSER — wird von self-heal.js ggf. automatisch ersetzt ──
function parseHeadlines(html) {
  const items = [];
  const seen = new Set();
  const teaserRegex = /<div class="teaser"[\s\S]*?(?=<div class="teaser"|$)/gi;

  let match;
  while ((match = teaserRegex.exec(html)) !== null) {
    const block = match[0];

    const title = extractText(block, /<h2 class="teaser-headline"[^>]*>([\s\S]*?)<\/h2>/i);
    if (!title || title.length < 10) continue;

    // FILTER: nur "Der <xxx> im Überblick"
    if (!/\bDer\s+\S+.*?im\s+Überblick\b/i.test(title)) continue;

    if (seen.has(title)) continue;
    seen.add(title);

    const linkMatch = /<a[^>]+href="([^"]+)"/.exec(block);
    const rawLink = linkMatch ? linkMatch[1] : null;
    const fullLink = rawLink
      ? rawLink.startsWith("http") ? rawLink : `https://www.manager-magazin.de${rawLink}`
      : TARGET_URL;

    const dateStr = extractText(block, /<span class="teaser-date"[^>]*>([\s\S]*?)<\/span>/i);
    const pubDate = parseGermanDate(dateStr);

    const imgMatch = /<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"/.exec(block);
    const imgSrc = imgMatch ? imgMatch[1] : null;
    const imgAlt = imgMatch ? imgMatch[2] : title;

    items.push({ title, link: fullLink, pubDate, imgSrc, imgAlt });
    if (items.length >= 30) break;
  }
  return items;
}

function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildRss(items) {
  const buildDate = new Date().toUTCString();
  const itemsXml = items.map(({ title, link, pubDate, imgSrc, imgAlt }) => {
    const enclosure = imgSrc ? `\n      <enclosure url="${escapeXml(imgSrc)}" type="image/jpeg" length="0"/>` : "";
    const mediaContent = imgSrc ? `\n      <media:content url="${escapeXml(imgSrc)}" medium="image"><media:title>${escapeXml(imgAlt)}</media:title></media:content>` : "";
    const description = imgSrc
      ? `<![CDATA[<img src="${imgSrc}" alt="${imgAlt}"/><p>${escapeXml(title)}</p>]]>`
      : `<![CDATA[${escapeXml(title)}]]>`;
    return `\n    <item>\n      <title>${escapeXml(title)}</title>\n      <link>${escapeXml(link)}</link>\n      <guid isPermaLink="true">${escapeXml(link)}</guid>\n      <pubDate>${pubDate}</pubDate>\n      <description>${description}</description>${enclosure}${mediaContent}\n    </item>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(FEED_LINK)}</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>de-DE</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="https://sjeap.github.io/web-feed/feed.xml" rel="self" type="application/rss+xml"/>${itemsXml}
  </channel>
</rss>`;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching ${TARGET_URL} ...`);
  const html = await fetchPage(TARGET_URL);
  const items = parseHeadlines(html);

  if (items.length === 0) {
    // Signal für self-heal: HTML-Snapshot speichern und mit Exit-Code 2 beenden
    fs.writeFileSync(path.join(__dirname, "last-html-snapshot.txt"), html.slice(0, 15000), "utf8");
    console.error("PARSE_FAILED: 0 Artikel gefunden");
    process.exit(2);
  }

  const rss = buildRss(items);
  fs.writeFileSync(OUTPUT_FILE, rss, "utf8");
  console.log(`✅ Feed aktualisiert: ${items.length} Artikel`);
  items.forEach(({ title, pubDate }) => console.log(`   • ${title} (${pubDate})`));
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
