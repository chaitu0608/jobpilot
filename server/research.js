/**
 * Research query builder. Turns a city/role/employer selection into a small,
 * targeted set of safe http(s) search URLs (official careers, LinkedIn, Indeed,
 * Unstop). Nothing is scraped here — the URLs are opened in the user's own
 * browser through the Browsy adapter, and the results come back through the
 * normal capture workflow.
 */

const SITE_DEFS = [
  { id: 'careers', label: 'Official careers', build: careersUrl },
  { id: 'linkedin', label: 'LinkedIn Jobs', build: linkedinUrl },
  { id: 'indeed', label: 'Indeed', build: indeedUrl },
  { id: 'unstop', label: 'Unstop', build: unstopUrl },
];

function q(s) { return encodeURIComponent(String(s || '').trim()); }

function careersUrl({ role, city, employer }) {
  const terms = [employer, role, city, 'careers', 'apply'].filter(Boolean).join(' ');
  // A plain search is the honest "official careers" route when we don't know a
  // specific domain; if an employer is named, bias with a site-ish hint.
  return `https://www.google.com/search?q=${q(terms)}`;
}
function linkedinUrl({ role, city, employer }) {
  const keywords = [employer, role].filter(Boolean).join(' ') || role || '';
  return `https://www.linkedin.com/jobs/search/?keywords=${q(keywords)}&location=${q(city || 'India')}`;
}
function indeedUrl({ role, city, employer }) {
  const terms = [employer, role].filter(Boolean).join(' ') || role || '';
  return `https://in.indeed.com/jobs?q=${q(terms)}&l=${q(city || 'India')}`;
}
function unstopUrl({ role, city, employer }) {
  const terms = [employer, role, city].filter(Boolean).join(' ') || role || '';
  return `https://unstop.com/jobs?searchTerm=${q(terms)}`;
}

/**
 * Build the run definition: the sites + the steps (one per site). Steps start
 * `pending`; a human opens each one and records what it found.
 */
export function buildResearchPlan({ city = '', role = '', employer = '', sites } = {}) {
  const wanted = Array.isArray(sites) && sites.length ? sites : SITE_DEFS.map((s) => s.id);
  const chosen = SITE_DEFS.filter((s) => wanted.includes(s.id));
  const query = { city, role, employer };
  const steps = chosen.map((s, i) => ({
    seq: i + 1,
    kind: 'query',
    label: s.label,
    url: s.build(query),
    status: 'pending',
  }));
  return { city, role, employer, sites: chosen.map((s) => s.id), query, steps };
}

export const RESEARCH_SITES = SITE_DEFS.map((s) => ({ id: s.id, label: s.label }));
