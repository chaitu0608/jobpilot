import { cleanText, sleep } from '../util.js';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function firstMatch(xml, re) {
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Parse the Atom feed Reddit serves at /r/<sub>/new/.rss (also works for /r/a+b+c/ combined feeds) */
export function parseAtomFeed(xml) {
  const entries = [];
  const chunks = String(xml).split(/<entry>/).slice(1);
  for (const chunk of chunks) {
    const body = chunk.split('</entry>')[0];
    const title = decodeEntities(firstMatch(body, /<title>([\s\S]*?)<\/title>/));
    const id = firstMatch(body, /<id>([\s\S]*?)<\/id>/);
    const link = firstMatch(body, /<link[^>]*href="([^"]+)"/);
    const author = decodeEntities(firstMatch(body, /<author>\s*<name>([\s\S]*?)<\/name>/));
    const sub = firstMatch(body, /<category term="([^"]+)"/);
    const published = firstMatch(body, /<published>([\s\S]*?)<\/published>/) || firstMatch(body, /<updated>([\s\S]*?)<\/updated>/);
    const rawContent = firstMatch(body, /<content[^>]*>([\s\S]*?)<\/content>/);
    const contentHtml = decodeEntities(decodeEntities(rawContent || ''));
    if (!title || !link) continue;
    entries.push({
      title: title.trim(),
      id: (id || '').trim(),
      link: link.trim(),
      sub: (sub || '').trim(),
      author: (author || '').replace(/^\/u\//, '').trim(),
      published: published ? new Date(published).toISOString() : null,
      html: contentHtml,
    });
  }
  return entries;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw Object.assign(new Error('429 rate limited'), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Reddit scan from the server: RSS (works unauthenticated with a browser UA).
 * One combined request for all subs keeps us under Reddit's unauthenticated rate limit;
 * a 429 is retried once after a cool-down, then the old.reddit.com mirror is tried.
 * The extension path (logged-in) gets richer data — this is the no-browser fallback.
 */
export async function redditRssJobs(subs, { log = () => {} } = {}) {
  const list = (subs || []).filter(Boolean);
  if (!list.length) return [];
  const combined = list.map((s) => encodeURIComponent(s)).join('+');
  const candidates = [
    `https://www.reddit.com/r/${combined}/new/.rss?limit=100`,
    `https://old.reddit.com/r/${combined}/new/.rss?limit=100`,
  ];

  let xml = null;
  let lastErr = null;
  for (const url of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        xml = await fetchFeed(url);
        break;
      } catch (err) {
        lastErr = err;
        if (err.rateLimited) {
          log(`reddit: rate limited — cooling down 12s (${new URL(url).host})`);
          await sleep(12000);
        } else {
          break; // non-rate-limit errors: move to the next candidate/mirror
        }
      }
    }
    if (xml) break;
  }
  if (!xml) {
    log(`reddit: could not fetch feeds (${lastErr?.message}) — use the extension scan ("scan-reddit") for Reddit`);
    return [];
  }

  const out = [];
  for (const e of parseAtomFeed(xml)) {
    const sub = e.sub || 'reddit';
    // Source-level prefilter: [HIRING]-tag rules live in normalize (it knows the sub);
    // here we only drop the obvious "[FOR HIRE]" freelance ads.
    if (/\[for\s*hire\]/i.test(e.title) && !/\bhiring\b/i.test(e.title)) continue;
    out.push({
      source: 'reddit',
      source_id: e.id || e.link,
      source_url: e.link,
      company: null,
      title: e.title,
      author: e.author ? `u/${e.author}` : null,
      posted_at: e.published,
      description: cleanText(e.html),
      extra: { sub },
    });
  }
  log(`reddit: ${out.length} posts kept from [${list.join(', ')}]`);
  return out;
}
