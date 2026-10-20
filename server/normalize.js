import { cleanText, sha1, stripEmoji, truncate, humanizeToken } from './util.js';
import { scoreJob } from './scoring.js';

const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com',
  'recruitee.com', 'bamboohr.com', 'jobvite.com', 'myworkdayjobs.com', 'icims.com',
  'successfactors.com', 'taleo.net', 'zohorecruit.com', 'keka.com', 'darwinbox.com',
  'rippling-ats.com', 'teamtailor.com', 'freshteam.com', 'peopleforce.io',
];

const NOISE_HOSTS = [
  'reddit.com', 'redd.it', 'x.com', 'twitter.com', 't.co', 'imgur.com', 'youtube.com',
  'youtu.be', 'pbs.twimg.com', 'discord.gg', 'instagram.com', 'facebook.com',
  'tiktok.com', 'spotify.com', 'telegra.ph', 'giphy.com', 'gofundme.com',
  'drive.google.com', 'calendar.app.google', 'maps.google.com', 'wikipedia.org',
];

const CITIES = [
  'bangalore', 'bengaluru', 'blr', 'hyderabad', 'pune', 'mumbai', 'chennai', 'gurgaon',
  'gurugram', 'noida', 'new delhi', 'delhi', 'kolkata', 'ahmedabad', 'jaipur', 'kochi',
  'coimbatore', 'indore', 'trivandrum', 'remote', 'anywhere', 'worldwide', 'london',
  'new york', 'san francisco', 'austin', 'seattle', 'berlin', 'amsterdam', 'singapore',
  'dubai', 'tokyo', 'sydney', 'toronto', 'dublin', 'warsaw', 'bangkok', 'ho chi minh',
];

const ROLE_RE = /\b(engineer|developer|dev\b|programmer|sde|swe\b|architect|designer|analyst|scientist|manager|lead\b|intern|internship|devops|sre\b|qa\b|tester|consultant|specialist|administrator|data|ml\b|ai\b|backend|frontend|full[\s-]?stack|mobile|android|ios|react|node|python|java|golang|rust|php|rails|ruby|cloud|platform|security|blockchain|web3|founding)\b/i;

const COMPANY_STOPWORDS = new Set([
  'we', 'our', 'the', 'this', 'that', 'join', 'apply', 'remote', 'india', 'company',
  'us', 'you', 'they', 'it', 'now', 'hiring', 'urgent', 'looking', 'role', 'position',
  'job', 'full', 'part', 'time', 'senior', 'junior', 'staff', 'lead', 'principal',
  'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'chennai', 'delhi',
]);

export function extractLinks(text) {
  const raw = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  return [...new Set(raw.map((u) => u.replace(/[.,;:]+$/, '')))];
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function pickApplyUrl(links, fallback = null) {
  let best = null;
  let bestScore = -Infinity;
  for (const url of links || []) {
    const host = hostOf(url);
    if (!host) continue;
    let sc;
    if (NOISE_HOSTS.some((n) => host === n || host.endsWith(`.${n}`))) {
      sc = -1000;
    } else if (ATS_HOSTS.some((n) => host === n || host.endsWith(`.${n}`))) {
      sc = 100;
    } else if (/apply|careers?|jobs?|hiring|openings?/i.test(url)) {
      sc = 55;
    } else if (/forms\.gle|airtable\.com|notion\.(so|site)|typeform\.com|docs\.google\.com\/forms|forms\.office\.com/i.test(url)) {
      sc = 45;
    } else {
      sc = 10;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = url;
    }
  }
  // Only replace the posting URL when we found something clearly apply-ish (ATS / careers / form),
  // not some random link that happened to be in the text.
  if (bestScore < 40) return fallback || null;
  return best;
}

export function extractEmails(text) {
  return [...new Set((String(text || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []))]
    .filter((e) => !/reddit|noreply|no-reply|example\.(com|org)/i.test(e))
    .slice(0, 2);
}

export function detectRemote(text, location = '') {
  const hay = `${location} ${truncate(text, 3000)}`;
  if (/\b(on-?site only|no remote|in-?office only)\b/i.test(hay)) return 0;
  return /\b(remote|work from home|wfh|anywhere|distributed team|telecommut|work-from-home)\b/i.test(hay) ? 1 : 0;
}

/** Reject numbers that look like money stats but not a salary ("$1", "$100", "rs 20"). */
function looksMoney(s) {
  const t = String(s || '');
  if (!/\d/.test(t)) return false;
  if (/\d{1,3}(?:,\d{3})+/.test(t)) return true;
  if (/\b\d{1,3}(?:\.\d{1,2})?\s*[kK]\b/.test(t)) return true;
  if (/(?:₹|INR|Rs\.?|\$|€|£)\s?\d{4,}/i.test(t)) return true;
  if (/\b(?:LPA|lakhs?|lakh)\b/i.test(t)) return true;
  if (/\b\d{2,}\s*(?:\/\s*(?:yr|year|hr|hour|mo|month)|per\s+(?:year|hour|month|annum))/i.test(t)) return true;
  return false;
}

export function extractSalary(text) {
  const t = String(text || '');
  const patterns = [
    /(?:ctc|salary|compensation|pay)\s*[:\-–]\s*([^\n|•]{2,48})/i,
    /(?:₹|INR|Rs\.?)\s?\d{1,3}(?:[.,]\d{2,3})?(?:\s*(?:-|–|to)\s*₹?\s*\d{1,3}(?:[.,]\d{2,3})?)?\s*(?:LPA|Lakhs?|Lakh|k\b|per\s+month|\/month|monthly)/i,
    /\b\d{1,3}(?:\.\d{1,2})?\s*(?:-|–|to)\s*\d{1,3}(?:\.\d{1,2})?\s*LPA\b/i,
    /\b\d{1,3}\s*LPA\b/i,
    /[$€£]\s?\d{1,3}(?:,\d{3})?(?:k|K)?(?:\s*(?:-|–|to)\s*[$€£]?\s?\d{1,3}(?:,\d{3})?(?:k|K)?)?(?:\s*(?:\/|per\s+)\s*(?:yr|year|hr|hour|mo|month))?/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const s = String(m[1] || m[0]).trim().replace(/\s+/g, ' ');
      if (s.length >= 2 && s.length <= 60 && looksMoney(s)) return s;
    }
  }
  return null;
}

const SEG_SPLIT = /[|•·—–]|(?:\s[-:]\s)/;

function cleanSegment(s) {
  let x = stripEmoji(String(s || '')).trim();
  x = x.replace(/^(location|remote|willing to relocate|technologies|tech stack|compensation|salary|equity|website|contact|apply( via)?|role|title|company)\s*[:\-–]\s*/i, '');
  if (x.length > 70) {
    const cut = x.search(/\.\s/);
    if (cut > 20) x = x.slice(0, cut);
  }
  return x.replace(/\s*[-–]\s*$/, '').trim();
}

export function guessTitle(titleRaw, bodyRaw = '') {
  const attempt = (s) => {
    const stripped = stripEmoji(String(s || ''))
      .replace(/^\s*\[(hiring|remote|full[- ]?time|part[- ]?time)\]\s*/gi, '')
      .replace(/^\s*(hiring|we('| a)?re hiring|we are hiring)\s*[:\-–]\s*/i, '')
      .trim();
    const segs = stripped.split(SEG_SPLIT).map((x) => x.trim()).filter(Boolean);
    const withRole = segs.find((seg) => ROLE_RE.test(seg));
    return { pick: withRole || segs.slice().sort((a, b) => b.length - a.length)[0] || stripped, hasRole: Boolean(withRole) };
  };

  let best = attempt(titleRaw);
  if (!best.hasRole && bodyRaw) {
    const lines = String(bodyRaw)
      .split(/\n|(?<=[.!?])\s+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6);
    for (const l of lines) {
      const c = attempt(l);
      if (c.hasRole) {
        best = c;
        break;
      }
    }
  }
  let out = cleanSegment(best.pick);
  out = out
    .replace(/\(\s*(remote|hybrid|on-?site|anywhere|wfh)[^)]*\)/gi, '')
    .replace(/\[(remote|hiring|full[- ]?time|part[- ]?time)\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return truncate(out || String(titleRaw || ''), 140);
}

export function guessCompany(titleRaw, bodyRaw = '', ctx = {}) {
  // 1) from an ATS / careers URL
  const links = ctx.links && ctx.links.length ? ctx.links : extractLinks(bodyRaw);
  for (const url of links) {
    const host = hostOf(url);
    const m = url.match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com)\/([^/?#]+)/i);
    if (m && m[1] && !['jobs', 'job', 'boards', 'embed'].includes(m[1].toLowerCase())) {
      return humanizeToken(m[1]);
    }
    const hm = host.match(/^(?:careers|jobs|apply|boards)\.([a-z0-9-]+)\./i) ||
      (ATS_HOSTS.some((n) => host.endsWith(n)) && host !== 'boards.greenhouse.io' ? host.match(/^([a-z0-9-]+)\./i) : null);
    if (hm && hm[1] && !['www', 'boards', 'jobs', 'job-boards'].includes(hm[1].toLowerCase())) {
      return humanizeToken(hm[1]);
    }
  }
  // 2) "Acme | Role" / "Acme (site) | Role" style titles
  const title = stripEmoji(String(titleRaw || ''));
  const segs = title.split(/[|•·]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    for (const s of segs) {
      const clean = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!clean || clean.length < 2 || clean.length > 34) continue;
      if (ROLE_RE.test(clean)) continue;
      if (CITIES.some((c) => clean.toLowerCase() === c)) continue;
      if (/^(remote|hybrid|on-?site|full[- ]?time|part[- ]?time|contract|interns?|equity|salary|compensation[- ]?range)$/i.test(clean)) continue;
      if (/^[\d$€£₹]/.test(clean)) continue;
      if (/^[A-Z0-9][\w&.'-]*(\s+[A-Z0-9][\w&.'-]*){0,4}$/.test(clean)) return clean;
    }
  }
  // 3) "at Acme" / "Acme is hiring"
  const hay = `${truncate(titleRaw, 200)}\n${truncate(bodyRaw, 1500)}`;
  const pats = [
    /\b(?:is hiring|is looking for|is recruiting|seeking)\b[^.\n]{0,40}\b(?:at|for)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/,
    /\b(?:join|at|@)\s+([A-Z][\w&.'-]{1,24}(?:\s+[A-Z][\w&.'-]{1,24}){0,2})\b/,
  ];
  for (const re of pats) {
    const m = hay.match(re);
    if (m && m[1]) {
      const words = m[1].split(/\s+/);
      while (words.length && COMPANY_STOPWORDS.has(words[0].toLowerCase())) words.shift();
      const cand = words.join(' ').trim();
      if (cand && cand.length >= 2 && !COMPANY_STOPWORDS.has(cand.toLowerCase())) return cand;
    }
  }
  return null;
}

export function guessLocation(titleRaw, bodyRaw = '', given = '') {
  if (given && String(given).trim()) return String(given).trim();
  const hay = `${titleRaw || ''}`;
  const found = CITIES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(hay));
  if (found.length) return found.map((c) => humanizeToken(c)).join(' • ');
  const inBody = CITIES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(truncate(bodyRaw, 400))).slice(0, 2);
  return inBody.map((c) => humanizeToken(c)).join(' • ');
}

const HIRING_RE = /\b(hiring|we'?re hiring|we are hiring|open (role|position|positions)|opening|vacanc|looking for (a|an|our|someone)|join (our|the) team|apply|jd\b|job description|referral|we need|recruit|positions? open|roles? open|now hiring)\b/i;
const NOT_HIRING_RE = /\b(for hire|forhire|available for (work|hire|freelance)|hire me|my (portfolio|resume))\b/i;

export function looksLikeHiringPost(title, body = '') {
  const t = String(title || '');
  if (NOT_HIRING_RE.test(t)) return false;
  return HIRING_RE.test(`${t}\n${truncate(body, 800)}`);
}

// Reddit needs a tighter net: its feeds are full of discussion posts that merely mention "hiring".
const RD_TITLE_HIRE = /\bhiring\b|\[hiring\]|now hiring|we'?re looking for|join our team|open (role|position|positions)|roles? open|seeking (a|an)|wanted:|looking for a (senior |staff |lead |principal )?(dev|developer|engineer|designer|sre|analyst)/i;
const RD_BODY_HIRE = /\b(we'?re hiring|we are hiring|we'?re looking for|we are looking for|i'?m looking for a|hiring (a|an|for)|join (our|my) team|apply (here|at|via|now|through)|send (your|me your) (resume|cv|profile)|(role|position|job title|job description)\s*[:\-])\b/i;
const RD_DISCUSSION = /^(how\b|what\b|why\b|when\b|where\b|is it just|any advice|advice needed|rant|help\b|need help|i'?m (lost|stuck|confused|struggling)|feeling|does anyone|did anyone|has anyone|anyone (else|here)|interview (experience|questions)|my (review|experience)|review\b|experience (with|at)|preparation|roadmap)/i;

export function looksLikeRedditHiringPost(title, body = '', sub = '') {
  const t = String(title || '').trim();
  const b = String(body || '');
  if (NOT_HIRING_RE.test(t)) return false;
  // r/forhire has a mandatory [HIRING] tag — anything else there is noise.
  if (String(sub).toLowerCase() === 'forhire') {
    if (!/\[hiring\]/i.test(t)) return false;
  } else {
    if (RD_DISCUSSION.test(t)) return false;
    if (!RD_TITLE_HIRE.test(t) && !RD_BODY_HIRE.test(b.slice(0, 900))) return false;
  }
  // Even tagged posts are often gigs for non-tech work (device testers, presenters…):
  // require some sign of a software-ish role somewhere in the post.
  return ROLE_RE.test(t) || ROLE_RE.test(b.slice(0, 900));
}

/** Stable identity across sources: company+title (seniority stripped) when possible. */
export function fingerprint(company, title, url) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\b(senior|sr|junior|jr|lead|staff|principal|iii|ii|iv|i)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const c = norm(company);
  const t = norm(title);
  if (c && t) return sha1(`${c}|${t}`);
  if (t && t.length > 8) return sha1(`t|${t}`);
  return sha1(String(url || JSON.stringify({ c, t, x: Math.random() })));
}

/** Normalize one raw scraped item into a DB-ready job with score. Returns null if it should be skipped. */
export function finalizeJob(raw, cfg) {
  if (!raw || !raw.title) return null;
  const source = raw.source || 'unknown';
  let title = cleanText(raw.title, 200);
  const body = cleanText(raw.description || '', 20000);

  if (!raw.keepAll && (source === 'reddit' || source === 'x')) {
    const ok =
      source === 'reddit'
        ? looksLikeRedditHiringPost(title, body, raw.extra?.sub)
        : looksLikeHiringPost(title, body);
    if (!ok) return null;
  }

  const links = extractLinks(`${raw.description || ''}\n${raw.title || ''}`);
  const applyUrl = raw.apply_url || pickApplyUrl(links, raw.source_url);
  const company = raw.company || guessCompany(raw.title, body, { links, author: raw.author }) || null;
  const cleanTitle = guessTitle(title, body);
  const location = guessLocation(title, body, raw.location || '');
  const remote = raw.remote === 1 || raw.remote === true ? 1 : detectRemote(`${title}\n${body}`, location);
  const salary = raw.salary || extractSalary(`${title}\n${body.slice(0, 3000)}`);
  const emails = extractEmails(body);

  const tags = [...new Set((raw.tags || []).filter(Boolean).map((t) => String(t).toLowerCase()))].slice(0, 25);

  const job = {
    fingerprint: fingerprint(company, cleanTitle, raw.source_url),
    source,
    source_id: raw.source_id ? String(raw.source_id) : null,
    source_url: raw.source_url || null,
    company,
    title: cleanTitle,
    location: location || null,
    remote,
    salary: salary || null,
    tags: JSON.stringify(tags),
    description: body || null,
    apply_url: applyUrl || null,
    apply_email: emails[0] || null,
    author: raw.author || null,
    posted_at: raw.posted_at || null,
    status: 'new',
    extra: JSON.stringify({
      ...(raw.extra || {}),
      rawTitle: title !== cleanTitle ? title : undefined,
      links: links.slice(0, 12),
      why: undefined,
    }),
  };

  const { score, why } = scoreJob(job, cfg?.targets || {});
  job.score = score;
  const extra = JSON.parse(job.extra);
  extra.why = why;
  job.extra = JSON.stringify(extra);

  return job;
}
