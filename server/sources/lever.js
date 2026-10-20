import { cleanText, fetchJson, humanizeToken } from '../util.js';

/** Lever postings. Public JSON, one request per company. */
export async function leverJobs(tokens, { perCompany = 40, log = () => {} } = {}) {
  const out = [];
  for (const token of tokens) {
    try {
      const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`, {
        timeoutMs: 25000,
      });
      const rows = (Array.isArray(data) ? data : [])
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, perCompany);
      for (const j of rows) {
        out.push({
          source: 'lever',
          source_id: String(j.id),
          source_url: j.hostedUrl,
          company: humanizeToken(token),
          title: j.text,
          location: j.categories?.location || (j.categories?.allLocations || []).join(' • '),
          posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
          description: cleanText(`${j.descriptionPlain || j.description || ''}\n\n${j.additionalPlain || ''}`),
          apply_url: j.applyUrl || j.hostedUrl,
          tags: [j.categories?.team, j.categories?.commitment].filter(Boolean),
          extra: { ats: 'lever', token, workplaceType: j.workplaceType },
        });
      }
      log(`lever/${token}: ${rows.length} jobs`);
    } catch (err) {
      log(`lever/${token}: FAILED — ${err.message}`);
    }
  }
  return out;
}
