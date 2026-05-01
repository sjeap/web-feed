/**
 * scraper.js — Matrix-fähig
 * Aufruf: node scraper.js <site-id>
 * Beispiel: node scraper.js manager-magazin
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SITES_FILE = path.join(__dirname, "sites.json");
const FEED_BASE_URL = "https://sjeap.github.io/web-feed/";

// ── Site-ID aus Argument lesen ──
const siteId = process.argv[2];
if (!siteId) {
  console.error("❌ Kein Site-ID angegeben. Beispiel: node scraper.js manager-magazin");
  process.exit(1);
}

const sites = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
const site = sites.find(s => s.id === siteId);
if (!site) {
  console.error(`❌ Site '${siteId}' nicht in sites.json gefunden`);
  process.exit(1);
}

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

function extractText(snippet, regexStr) {
  const m = new RegExp(regexStr, "i").exec(snippet);
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

function parseHeadlines(html, site) {
  const items = [];
  const seen = new Set();
  const parts = html.split(site.teaserSplit);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    const title = extractText(block, site.titleSelector);
    if (!title || title.length < 10) continue;

    // Filter anwenden wenn definiert
    if (site.filter && !new RegExp(site.filter, "i").test(title)) continue;

    if (seen.has(title)) continue;
    seen.add(title);

    const linkMatch = new RegExp(site.linkSelector).exec(block);
    const rawLink = linkMatch ? linkMatch[1] : null;
    const base = new URL(site.url).origin;
    const fullLink = rawLink
      ? rawLink.startsWith("http") ? rawLink : `${base}${rawLink}`
      : site.url;

    const dateStr = extractText(block, site.dateSelector);
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

function buildRss(items, site) {
  const buildDate = new Date().toUTCString();
  const selfUrl = `${FEED_BASE_URL}${site.output}`;

  const itemsXml = items.map(({ title, link, pubDate, imgSrc, imgAlt }) => {
    const enclosure = imgSrc
      ? `\n      <enclosure url="${escapeXml(imgSrc)}" type="image/jpeg" length="0"/>`
      : "";
    const mediaContent = imgSrc
      ? `\n      <media:content url="${escapeXml(imgSrc)}" medium="image"><media:title>${escapeXml(imgAlt)}</media:title></media:content>`
      : "";
    const description = imgSrc
      ? `<![CDATA[<img src="${imgSrc}" alt="${imgAlt}"/><p>${escapeXml(title)}</p>]]>`
      : `<![CDATA[${escapeXml(title)}]]>`;
    return `
    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
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
    <language>de-DE</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>${itemsXml}
  </channel>
</rss>`;
}

async function main() {
  console.log(`[${new Date().toISOString()}] [${site.id}] Fetching ${site.url} ...`);
  const html = await fetchPage(site.url);
  console.log(`   HTML geladen: ${html.length} Zeichen`);

  const items = parseHeadlines(html, site);

  if (items.length === 0) {
    fs.writeFileSync(
      path.join(__dirname, `snapshot-${site.id}.txt`),
      html.slice(0, 15000), "utf8"
    );
    console.error(`PARSE_FAILED [${site.id}]: 0 Artikel — Snapshot gespeichert`);
    process.exit(2);
  }

  const outputFile = path.join(__dirname, site.output);
  fs.writeFileSync(outputFile, buildRss(items, site), "utf8");
  console.log(`✅ [${site.id}] ${items.length} Artikel → ${site.output}`);
  items.forEach(({ title }) => console.log(`   • ${title}`));
}

main().catch(err => {
  console.error(`❌ [${siteId}] Fehler:`, err.message);
  console.error(err.stack);
  process.exit(1);
});
