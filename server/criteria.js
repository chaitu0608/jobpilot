/**
 * Candidate criteria — the editable rules the eligibility classifier and the
 * ranking use. Deliberately stored SEPARATELY from the private `config.json`
 * (profile/answers/resume live there). These are non-secret preferences.
 *
 * This module is dependency-free and pure so the browser can import the exact
 * same code the server uses (`import('/criteria.js')`) — no duplicated logic.
 */

export const DEFAULT_CRITERIA = {
  candidate: {
    // Editable. Marked "provisional" on purpose — the app never asserts it as
    // verified. Change it in the Research/Criteria panel.
    graduationYear: 2027,
    degree: 'BTech',
    status: 'provisional',
    yearsExperience: 0,
    earlyCareer: true,
    note: 'Pre-final/final year undergraduate, early-career roles.',
  },
  // Preference order (best first). Used to rank, never to exclude by itself.
  cities: ['Mumbai', 'Pune', 'Bengaluru', 'Hyderabad'],
  otherIndiaAllowed: true,
  // Role families the candidate is targeting, best-first partial ordering.
  roleFamilies: ['swe', 'data', 'cloud', 'qa', 'consulting', 'grad', 'analytics'],
  // Prefer bigger employers first (MNC/large before startup/scaleup).
  employerPreference: ['mnc', 'startup', 'other'],
  preferredTypes: ['semester', 'intern', 'fulltime', 'unknown'],
  // Seniority markers in the TITLE that gate a role out (title-first).
  excludeSeniority: [
    'senior', 'sr', 'staff', 'principal', 'manager', 'director', 'head of', 'vp',
    'vice president', 'chief', 'architect', 'phd', 'ph.d', 'doctoral', 'postdoc',
    'post-doctoral', 'distinguished', 'fellow', 'lead',
  ],
  // A stated minimum experience at or above this excludes for an early-career
  // candidate. 2 is surfaced as "needs review", not excluded.
  excludeMinYears: 3,
  reviewMinYears: 2,
  // Remote roles are UNKNOWN unless the posting states India / worldwide
  // eligibility. Never auto-eligible.
  requireExplicitRemoteEligibility: true,
  // Only shown when the source states it — never inferred for the verdict.
  requireStatedPayForInternship: false,
};

function asStringArray(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice();
  return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
}

/** Merge incoming criteria over the defaults, normalising shapes. Never throws. */
export function normalizeCriteria(raw) {
  const base = structuredClone(DEFAULT_CRITERIA);
  if (!raw || typeof raw !== 'object') return base;
  const out = base;
  if (raw.candidate && typeof raw.candidate === 'object') {
    out.candidate = { ...base.candidate, ...raw.candidate };
  }
  for (const k of ['cities', 'roleFamilies', 'employerPreference', 'preferredTypes', 'excludeSeniority']) {
    if (k in raw) out[k] = asStringArray(raw[k], base[k]);
  }
  for (const k of ['otherIndiaAllowed', 'requireExplicitRemoteEligibility', 'requireStatedPayForInternship']) {
    if (k in raw) out[k] = Boolean(raw[k]);
  }
  for (const k of ['excludeMinYears', 'reviewMinYears']) {
    if (k in raw && Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]);
  }
  return out;
}
