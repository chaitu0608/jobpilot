import { cleanText, fetchJson } from '../util.js';

/**
 * HN "Ask HN: Who is hiring?" via the Algolia API.
 * Finds the latest thread from the whoishiring bot, then reads its top-level comments.
 */
export async function hnJobs({ maxComments = 250, log = () => {} } = {}) {
  try {
    const stories = await fetchJson(
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=8',
      { timeoutMs: 20000 }
    );
    const hits = stories.hits || [];
    const thread =
      hits.find((h) => /who is hiring/i.test(h.title || '')) || hits[0];
    if (!thread) {
      log('hn: no "Who is hiring" thread found');
      return [];
    }

    const item = await fetchJson(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { timeoutMs: 30000 });
    const children = (item.children || []).slice(0, maxComments);
    const out = [];
    const SEEKER_RE = /willing to relocate|seeking work|looking for (work|a new role|a job)|hire me|my resume\b|resume attached/i;
    for (const c of children) {
      const text = cleanText(c.text || '');
      if (text.length < 40) continue;
      // the who-is-hiring thread also collects "seeking work" comments — skip those
      if (SEEKER_RE.test(text.slice(0, 400))) continue;
      const firstLine = text.split('\n')[0].trim().slice(0, 200);
      out.push({
        source: 'hn',
        source_id: String(c.id),
        source_url: `https://news.ycombinator.com/item?id=${c.id}`,
        company: null,
        title: firstLine,
        description: text,
        author: c.author,
        posted_at: c.created_at || null,
        keepAll: true,
        extra: { thread: thread.title, threadId: thread.objectID },
      });
    }
    log(`hn: ${out.length} comments from "${thread.title}"`);
    return out;
  } catch (err) {
    log(`hn: FAILED — ${err.message}`);
    return [];
  }
}
