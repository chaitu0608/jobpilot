import { cleanText, fetchJson, humanizeToken } from '../util.js';

function compensationSummary(comp) {
  if (!comp) return null;
  if (typeof comp === 'string') return comp;
  const cands = [
    comp.compensationTierSummary,
    comp.scrapeableCompensationSalarySummary,
    comp.summary,
  ].filter((s) => typeof s === 'string' && s.trim());
  if (cands.length) return cands[0].trim();
  const tiers = Array.isArray(comp.compensationTiers) ? comp.compensationTiers : [];
  for (const t of tiers) {
    const s = t?.tierSummary || t?.components?.map?.((c) => c?.summary).filter(Boolean).join(' ');
    if (s) return String(s).trim();
  }
  return null;
}

/** Ashby job boards. Public JSON, one request per org. */
export async function ashbyJobs(orgs, { perCompany = 40, log = () => {} } = {}) {
  const out = [];
  for (const org of orgs) {
    try {
      const data = await fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
        { timeoutMs: 25000 }
      );
      const jobs = (data.jobs || [])
        .filter((j) => j.isListed !== false)
        .sort((a, b) => String(b.publishedAt || b.updatedAt || '').localeCompare(String(a.publishedAt || a.updatedAt || '')))
        .slice(0, perCompany);
      for (const j of jobs) {
        const secondary = (j.secondaryLocations || []).map((l) => l?.location).filter(Boolean);
        out.push({
          source: 'ashby',
          source_id: String(j.id),
          source_url: j.jobUrl,
          company: humanizeToken(org),
          title: j.title,
          location: [j.location, ...secondary].filter(Boolean).join(' • '),
          posted_at: j.publishedAt || j.updatedAt || null,
          description: cleanText(j.descriptionPlain || j.descriptionHtml || ''),
          apply_url: j.applyUrl || j.jobUrl,
          salary: compensationSummary(j.compensation) || undefined,
          remote: j.isRemote ? 1 : undefined,
          tags: [j.department, j.team, j.employmentType].filter(Boolean),
          extra: { ats: 'ashby', org, workplaceType: j.workplaceType },
        });
      }
      log(`ashby/${org}: ${jobs.length} jobs`);
    } catch (err) {
      log(`ashby/${org}: FAILED — ${err.message}`);
    }
  }
  return out;
}
