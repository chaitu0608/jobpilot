import { cleanText, fetchJson } from '../util.js';

/** RemoteOK public feed (all-remote jobs; scoring weeds out irrelevant ones). */
export async function remoteokJobs({ limit = 150, log = () => {} } = {}) {
  try {
    const data = await fetchJson('https://remoteok.com/api', { timeoutMs: 25000 });
    const rows = (Array.isArray(data) ? data : []).filter((d) => d && d.id && d.position).slice(0, limit);
    const out = rows.map((j) => {
      // RemoteOK values are usually annual dollars, but some posts carry hourly
      // rates (e.g. 30–60). Only format as "$Xk" when the numbers are annual-sized.
      const sm = Number(j.salary_min) || 0;
      const sx = Number(j.salary_max) || 0;
      const annual = sm >= 1000 && sx >= 1000;
      const hourly = sm > 0 && sm < 1000;
      const salary = annual
        ? `$${Math.round(sm / 1000)}k–$${Math.round(sx / 1000)}k`
        : sm >= 1000
          ? `$${Math.round(sm / 1000)}k+`
          : hourly && sx > 0
            ? `$${Math.round(sm)}–$${Math.round(sx)}/hr`
            : hourly
              ? `$${Math.round(sm)}/hr`
              : undefined;
      return {
        source: 'remoteok',
        source_id: String(j.id),
        source_url: j.url || j.apply_url,
        company: j.company,
        title: j.position,
        location: j.location || 'Remote',
        remote: 1,
        salary,
        posted_at: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : null),
        description: cleanText(j.description || ''),
        apply_url: j.apply_url || j.url,
        tags: Array.isArray(j.tags) ? j.tags.slice(0, 15) : [],
        extra: { ats: 'remoteok' },
      };
    });
    log(`remoteok: ${out.length} jobs`);
    return out;
  } catch (err) {
    log(`remoteok: FAILED — ${err.message}`);
    return [];
  }
}
