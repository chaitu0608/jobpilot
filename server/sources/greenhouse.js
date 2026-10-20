import { cleanText, fetchJson, humanizeToken } from '../util.js';
import { getMeta, setMeta } from '../db.js';

/**
 * Greenhouse boards. One request per company with full content.
 * Board display names are cached in the meta table to avoid extra requests.
 */
export async function greenhouseJobs(tokens, { perCompany = 40, db, log = () => {} } = {}) {
  const out = [];
  for (const token of tokens) {
    try {
      const data = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
        { timeoutMs: 25000 }
      );
      const jobs = (data.jobs || [])
        .sort((a, b) => String(b.first_published || b.updated_at).localeCompare(String(a.first_published || a.updated_at)))
        .slice(0, perCompany);

      let name = db ? getMeta(db, `board_name:gh:${token}`) : null;
      if (!name) {
        name = jobs.find((j) => j.company_name)?.company_name || humanizeToken(token);
        if (db) setMeta(db, `board_name:gh:${token}`, name);
      }

      for (const j of jobs) {
        out.push({
          source: 'greenhouse',
          source_id: String(j.id),
          source_url: j.absolute_url,
          company: j.company_name || name,
          title: j.title,
          location: j.location?.name || '',
          posted_at: j.first_published || j.updated_at || null,
          description: cleanText(j.content || ''),
          apply_url: j.absolute_url,
          tags: (j.departments || []).map((d) => d.name).filter(Boolean),
          extra: {
            ats: 'greenhouse',
            token,
            offices: (j.offices || []).map((o) => o.name),
            // Greenhouse exposes custom metadata (often "Employment Type") — keep it so the
            // dashboard can use a structured employment-type signal instead of guessing.
            metadata: (j.metadata || []).reduce((acc, m) => {
              if (m && m.name) acc[m.name] = m.value;
              return acc;
            }, {}),
          },
        });
      }
      log(`greenhouse/${token}: ${jobs.length} jobs`);
    } catch (err) {
      log(`greenhouse/${token}: FAILED — ${err.message}`);
    }
  }
  return out;
}
