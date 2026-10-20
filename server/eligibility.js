/**
 * Eligibility classifier — shared, pure, dependency-free.
 *
 * Runs identically on the server and in the browser (served at /eligibility.js),
 * so the dashboard gate and the server gate can never drift.
 *
 * Design rules (these fix the previously observed failures):
 *  - TITLE FIRST. A role family is read from the title; the description is only
 *    a lower-confidence fallback for generic titles. "TA specialist", "technical
 *    writer", "designer" must never be classified software/data because the
 *    description mentions those words.
 *  - Seniority, incompatible required experience, explicit non-India
 *    restrictions and closed/expired postings GATE OUT (excluded).
 *  - Remote without an explicit India / worldwide eligibility statement is
 *    UNKNOWN — never auto-eligible.
 *  - Pay and duration are only reported when the source states them.
 *  - "Needs review" is kept distinct from "potentially suitable".
 */

import { DEFAULT_CRITERIA, normalizeCriteria } from './criteria.js';

/* ---------------------------------------------------------------- role family */

// Ordered by specificity: a title is matched against these top-to-bottom.
export const ROLE_FAMILIES = [
  { key: 'grad', rank: 5, label: 'Graduate / trainee',
    re: /\b(graduate (?:engineer|trainee|program|scheme)|grad program|new grad|campus hire|engineering trainee|management trainee|apprentice(?:ship)?|fresher|trainee engineer)\b/i },
  { key: 'qa', rank: 3, label: 'QA / test',
    re: /\b(qa|quality assurance|sdet|test engineer|automation test(?:er)?|software test(?:er)?|test automation|manual test|quality engineer|validation engineer)\b/i },
  { key: 'cloud', rank: 2, label: 'Cloud / platform',
    re: /\b(cloud|devops|dev-ops|sre|site reliability|platform engineer|infrastructure|kubernetes|k8s|terraform|systems engineer|network engineer|build engineer|release engineer)\b/i },
  { key: 'data', rank: 1, label: 'Data / AI / ML',
    re: /\b(data engineer|data scientist|machine learning|ml engineer|\bml\b|\bai\b|artificial intelligence|deep learning|nlp|computer vision|\bllm\b|data science|research engineer|applied scientist)\b/i },
  { key: 'analytics', rank: 6, label: 'Analytics / BA',
    re: /\b(analyst|business analyst|data analyst|product analyst|business intelligence|\bbi\b|reporting analyst|analytics engineer|\banalytics\b|associate consultant)\b/i },
  { key: 'consulting', rank: 4, label: 'Consulting / implementation',
    re: /\b(consultant|consulting|implementation|solutions engineer|solution architect|forward deployed|customer engineer|technical account|professional services|onboarding engineer|support engineer|integration engineer|solutions analyst)\b/i },
  { key: 'swe', rank: 0, label: 'Software engineering',
    re: /\b(software|swe\b|sde\b|engineer|developer|programmer|backend|back-end|frontend|front-end|full[\s-]?stack|fullstack|mobile|android|ios\b|react|node|java|golang|gopher|python|typescript|javascript|php|rails|ruby|rust|kotlin|swift|platform|web developer|api developer)\b/i },
];

// Titles that are emphatically NOT the target software/data families. If the
// title lands here, the description cannot promote it into a tech family.
export const NON_TARGET_FAMILIES = [
  { key: 'ta', label: 'Recruiting / TA',
    re: /\b(recruiter|recruiting|talent acquisition|\bta\b|talent partner|sourcing specialist|hr (?:specialist|executive|generalist)|human resources|people partner)\b/i },
  { key: 'writing', label: 'Writing / content',
    re: /\b(technical writer|content writer|copywriter|content (?:specialist|strategist|marketer)|editor|documentation specialist|proofreader)\b/i },
  { key: 'design', label: 'Design',
    re: /\b(designer|ux|ui\/ux|product design|graphic design|visual design|motion design|brand design|illustrator)\b/i },
  { key: 'sales', label: 'Sales / BD',
    re: /\b(sales|business development|account executive|account manager|inside sales|field sales|pre-?sales|bdm|bde|customer success|partnerships)\b/i },
  { key: 'marketing', label: 'Marketing',
    re: /\b(marketing|seo|growth hacker|demand generation|social media|campaign manager|performance marketing|brand manager)\b/i },
  { key: 'support', label: 'Support / ops',
    re: /\b(customer support|customer service|help ?desk|service desk|technical support(?! engineer)|operations (?:executive|associate|manager)|data entry|back office|bpo)\b/i },
  { key: 'finance', label: 'Finance / accounting',
    re: /\b(accountant|accounting|finance (?:analyst|associate|executive)|audit|taxation|financial analyst|treasury)\b/i },
  { key: 'nontech-other', label: 'Non-technical',
    re: /\b(lawyer|legal|paralegal|nurse|doctor|physician|teacher|professor|chef|driver|security guard|housekeeping|receptionist)\b/i },
];

export function matchRoleFamily(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const f of ROLE_FAMILIES) if (f.re.test(t)) return f;
  return null;
}
export function matchNonTarget(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const f of NON_TARGET_FAMILIES) if (f.re.test(t)) return f;
  return null;
}

/**
 * Role family from the TITLE first. Only when the title is generic (no target
 * family AND no explicitly non-target family) do we fall back to the
 * description, and we mark that lower confidence. A non-target title wins over
 * any description signal.
 */
export function roleInfo(job) {
  const title = String(job.title || '');
  const target = matchRoleFamily(title);
  const nonTarget = matchNonTarget(title);
  if (nonTarget && !target) return { key: 'other', familyKey: nonTarget.key, label: nonTarget.label, rank: 9, confidence: 'title', nonTarget: true };
  if (target) return { key: target.key, label: target.label, rank: target.rank, confidence: 'title', nonTarget: false };
  if (nonTarget) return { key: 'other', familyKey: nonTarget.key, label: nonTarget.label, rank: 9, confidence: 'title', nonTarget: true };
  const descHay = (title + ' ' + String(job.description || '')).slice(0, 1200);
  const descHit = matchRoleFamily(descHay);
  if (descHit) return { key: descHit.key, label: descHit.label, rank: descHit.rank, confidence: 'description', nonTarget: false };
  return { key: 'other', label: 'Unclear from title', rank: 8, confidence: 'none', nonTarget: false };
}

/* ---------------------------------------------------------------- opportunity type */

const INTERN_TITLE_RE = /\bintern(?:ship)?s?\b|\bco-?ops?\b|\bapprentice(?:ship)?s?\b|\bindustrial trainee\b|\bplacement (?:student|year)\b|\bsummer (?:analyst|associate|intern)\b/i;
const INTERN_STRUCT_RE = /\bintern(?:ship)?s?\b|\bco-?ops?\b|\bapprentice(?:ship)?s?\b/i;
const FULLTIME_STRUCT_RE = /\bfull[\s-]?time\b|\bpermanent\b|\bregular\b/i;
const PARTTIME_STRUCT_RE = /\bpart[\s-]?time\b/i;
const CONTRACT_STRUCT_RE = /\bcontract(?:or)?\b|\btemporary\b|\bfixed[\s-]?term\b|\bfreelance\b/i;
const SEMESTER_RE = /\bsemester\b|\b(?:4|5|6)\s*(?:-|–|to|and|\/)?\s*(?:6|5|4)?\s*months?\b|\b(?:four|five|six)\s*months?\b/i;
const UNPAID_RE = /\bunpaid\b|\bwithout (?:pay|stipend)\b|\bno stipend\b|\bcommission[- ]only\b|\bequity[- ]only\b/i;
const PAID_RE = /\bstipend\b|\bpaid (?:internship|intern|position|role|program)\b|\bmonthly stipend\b/i;

function extraOf(job) {
  const e = job && job.extra;
  if (e && typeof e === 'object') return e;
  if (typeof e === 'string') { try { const p = JSON.parse(e); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }
  return {};
}

/** Structured employment type from ATS tags/metadata only — never free-text prose. */
export function structuredType(job) {
  const extra = extraOf(job);
  const bits = [].concat(
    Array.isArray(job.tags) ? job.tags : [],
    extra.commitment || [], extra.employmentType || [], extra.employment_type || [], extra.employment || [],
    extra.metadata && typeof extra.metadata === 'object' ? Object.values(extra.metadata) : []
  );
  const hay = bits.map((b) => String(b == null ? '' : b)).join(' | ');
  if (!hay.trim()) return null;
  if (INTERN_STRUCT_RE.test(hay)) return 'internship';
  if (FULLTIME_STRUCT_RE.test(hay)) return 'full-time';
  if (PARTTIME_STRUCT_RE.test(hay)) return 'part-time';
  if (CONTRACT_STRUCT_RE.test(hay)) return 'contract';
  return null;
}

export function typeInfo(job) {
  const title = String(job.title || '');
  const structured = structuredType(job);
  if (INTERN_TITLE_RE.test(title)) return { key: 'internship', confirmed: true, basis: 'title', label: 'Internship' };
  if (structured === 'internship') return { key: 'internship', confirmed: true, basis: 'stated', label: 'Internship' };
  if (structured) return { key: structured, confirmed: true, basis: 'stated', label: structured.replace(/\b\w/g, (c) => c.toUpperCase()) };
  return { key: 'unknown', confirmed: false, basis: 'none', label: 'Type not stated' };
}

export function durationInfo(job, type) {
  if (!(type && type.key === 'internship' && type.confirmed)) return { key: 'n-a', label: 'Not applicable', stated: false };
  const inTitle = SEMESTER_RE.test(String(job.title || ''));
  const inDesc = SEMESTER_RE.test(String(job.description || '').slice(0, 1500));
  if (inTitle || inDesc) return { key: 'semester', label: '4–6 months (stated)', stated: true, basis: inTitle ? 'title' : 'description' };
  return { key: 'unknown', label: 'Duration not stated', stated: false };
}

export function payInfo(job, type) {
  const desc = String(job.description || '').slice(0, 1500);
  if (UNPAID_RE.test(desc)) return { key: 'unpaid', label: 'Unpaid (stated)', stated: true };
  if (job.salary) return { key: 'paid', label: 'Paid · ' + job.salary, stated: true };
  if (PAID_RE.test(desc)) return { key: 'paid', label: 'Paid (stated)', stated: true };
  return { key: 'unknown', label: 'Pay not stated', stated: false };
}

/* ---------------------------------------------------------------- geography */

export const CITY_GROUPS = [
  { label: 'Mumbai', tokens: ['mumbai', 'navi mumbai', 'thane', 'andheri', 'powai', 'lower parel', 'bkc'] },
  { label: 'Pune', tokens: ['pune', 'pimpri', 'hinjawadi', 'hinjewadi', 'magarpatta'] },
  { label: 'Bengaluru', tokens: ['bengaluru', 'bangalore', 'blr', 'whitefield', 'electronic city'] },
  { label: 'Hyderabad', tokens: ['hyderabad', 'secunderabad', 'gachibowli', 'hitech city', 'hitec city'] },
];
export const OTHER_INDIA = ['chennai', 'gurgaon', 'gurugram', 'noida', 'delhi', 'new delhi', 'kolkata', 'ahmedabad',
  'jaipur', 'kochi', 'cochin', 'coimbatore', 'indore', 'trivandrum', 'thiruvananthapuram', 'chandigarh', 'mohali',
  'ghaziabad', 'nagpur', 'mysore', 'mysuru', 'goa', 'bhubaneswar', 'vizag', 'visakhapatnam', 'trichy', 'madurai',
  'surat', 'vadodara', 'lucknow', 'dehradun', 'nashik', 'bhopal'];

export const FOREIGN_NAMES = ['usa', 'u.s.a', 'united states', 'us only', 'u.s. only', 'usa only', 'north america', 'americas',
  'canada', 'toronto', 'vancouver', 'montreal', 'latam', 'brazil', 'sao paulo', 'mexico', 'argentina', 'chile', 'colombia',
  'uk', 'united kingdom', 'england', 'scotland', 'london', 'ireland', 'dublin', 'europe', 'emea', 'eu', 'germany', 'berlin',
  'munich', 'france', 'paris', 'netherlands', 'amsterdam', 'spain', 'madrid', 'barcelona', 'italy', 'milan', 'poland', 'warsaw',
  'sweden', 'stockholm', 'switzerland', 'zurich', 'portugal', 'lisbon', 'singapore', 'australia', 'sydney', 'melbourne',
  'new zealand', 'auckland', 'dubai', 'uae', 'abu dhabi', 'saudi', 'riyadh', 'qatar', 'doha', 'japan', 'tokyo', 'korea', 'seoul',
  'china', 'shanghai', 'beijing', 'hong kong', 'taiwan', 'vietnam', 'ho chi minh', 'thailand', 'bangkok', 'indonesia',
  'jakarta', 'malaysia', 'kuala lumpur', 'philippines', 'manila', 'new york', 'san francisco', 'seattle', 'austin', 'boston',
  'chicago', 'los angeles', 'denver', 'atlanta', 'dallas', 'remote - us', 'remote us', 'remote (us)', 'us-remote', 'us-based',
  'remote - canada', 'remote canada'];
const FOREIGN_RE = new RegExp('\\b(' + FOREIGN_NAMES.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
const INDIA_RE = /\bindia\b|\bindian\b|\bpan[ -]?india\b|\banywhere in india\b/i;
const WORLDWIDE_RE = /\bworldwide\b|\banywhere in the world\b|\bfully remote\b|\bglobal remote\b|\bremote \(global\)\b|\bwork from anywhere\b/i;

/**
 * Geography verdict for a job.
 *  rank: 0..3 preferred cities, 4 other India, 5 remote-India-eligible, 7 unknown
 *  restricted:true  → a definite non-India location (excluded)
 *  remoteUnknown:true → remote by nature but no explicit India/worldwide eligibility
 */
export function cityInfo(job) {
  const loc = String(job.location || '').toLowerCase();
  const titleDesc = (String(job.title || '') + ' ' + String(job.description || '').slice(0, 600)).toLowerCase();
  const hay = `${loc} ${titleDesc}`;
  for (let i = 0; i < CITY_GROUPS.length; i++) {
    if (CITY_GROUPS[i].tokens.some((t) => loc.includes(t))) return { rank: i, label: CITY_GROUPS[i].label, restricted: false };
  }
  if (OTHER_INDIA.some((c) => loc.includes(c))) return { rank: 4, label: 'Other India', restricted: false };

  const saysIndia = INDIA_RE.test(loc) || INDIA_RE.test(titleDesc);
  const saysWorldwide = WORLDWIDE_RE.test(hay);
  const foreign = FOREIGN_RE.test(loc) || (!loc && FOREIGN_RE.test(titleDesc));
  const remoteish = Boolean(job.remote) || /\bremote\b|anywhere|worldwide|distributed|\bwfh\b|work from home|telecommut/.test(hay);

  // Explicit India / worldwide eligibility always wins.
  if (remoteish && (saysIndia || saysWorldwide)) return { rank: 5, label: saysWorldwide && !saysIndia ? 'Remote — worldwide' : 'Remote — India eligible', restricted: false, remoteEligible: true };
  if (remoteish && foreign) return { rank: 6, label: 'Remote — restricted geography', restricted: true, remoteUnknown: true };
  if (remoteish) return { rank: 5, label: 'Remote — eligibility not stated', remoteUnknown: true, restricted: false };
  if (foreign) return { rank: 6, label: 'Outside India', restricted: true };
  return { rank: 7, label: job.location ? String(job.location).slice(0, 26) : 'Location unknown' };
}

/* ---------------------------------------------------------------- employer tier */

export const MNC_NAMES = ['google', 'alphabet', 'microsoft', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'adobe', 'nvidia',
  'intel', 'qualcomm', 'amd', 'cisco', 'juniper', 'oracle', 'sap', 'salesforce', 'servicenow', 'workday', 'vmware', 'dell',
  'hewlett', 'lenovo', 'ibm', 'accenture', 'deloitte', 'pwc', 'kpmg', 'ernst', 'mckinsey', 'boston consulting', 'bain',
  'goldman', 'jpmorgan', 'j.p. morgan', 'morgan stanley', 'citi', 'citibank', 'barclays', 'hsbc', 'deutsche', 'ubs',
  'wells fargo', 'american express', 'paypal', 'visa', 'mastercard', 'walmart', 'target', 'uber', 'lyft', 'airbnb', 'tesla',
  'bosch', 'siemens', 'philips', 'honeywell', 'general electric', 'samsung', 'sony', 'panasonic', 'lg electronics', 'hitachi',
  'toyota', 'honda', 'ford', 'general motors', 'boeing', 'airbus', 'unilever', 'procter', 'nestle', 'coca', 'pepsi', 'johnson',
  'pfizer', 'novartis', 'roche', 'gsk', 'astrazeneca', 'infosys', 'tata consultancy', 'tcs', 'wipro', 'cognizant', 'hcl',
  'tech mahindra', 'capgemini', 'ltimindtree', 'l&t', 'lnt', 'mphasis', 'persistent', 'coforge', 'birlasoft', 'genpact',
  'dxc', 'atos', 'ntt', 'fujitsu', 'ericsson', 'nokia', 'motorola', 'siemens healthineers', 'rockwell', 'schneider',
  'abb', 'kpmg india', 'ey', 'pwc india', 'standard chartered', 'axis', 'hdfc', 'icici', 'kotak', 'bajaj', 'mahindra',
  'godrej', 'reliance', 'aditya birla', 'tata motors', 'tata steel', 'tata digital', 'jindal', 'vedanta', 'itc', 'hindustan'];
export const SCALEUP_NAMES = ['databricks', 'stripe', 'cloudflare', 'gitlab', 'coinbase', 'brex', 'pinterest', 'robinhood',
  'figma', 'twilio', 'instacart', 'vercel', 'highradius', 'slice', 'groww', 'glance', 'dropbox', 'mongodb', 'elastic',
  'asana', 'duolingo', 'discord', 'netlify', 'airtable', 'paytm', 'meesho', 'cred', 'palantir', 'binance', 'supabase',
  'linear', 'resend', 'posthog', 'deepgram', 'vanta', 'modal', 'ramp', 'sarvam', 'atlan', 'browserbase', 'perplexity',
  'openai', 'anthropic', 'razorpay', 'zomato', 'swiggy', 'flipkart', 'phonepe', 'ola', 'dream11', 'nykaa', 'freshworks',
  'zoho', 'postman', 'chargebee', 'browserstack', 'hasura', 'innovaccer', 'darwinbox', 'uniphore', 'yellow.ai', 'eightfold',
  'atlassian', 'canva', 'notion', 'rippling', 'deel', 'navi', 'jupiter', 'zepto', 'blinkit', 'myntra', 'sharechat', 'practo',
  'policybazaar', 'cars24', 'scaler', 'upgrad', 'unacademy', 'byju', 'mpl', 'juspay', 'turing', 'nference', 'zeta', 'setu'];
const reFrom = (list) => new RegExp('\\b(' + list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
const MNC_RE = reFrom(MNC_NAMES);
const SCALEUP_RE = reFrom(SCALEUP_NAMES);

export function tierInfo(job) {
  const c = String(job.company || job.author || '').toLowerCase();
  if (!c) return { rank: 2, key: 'other', label: 'Employer unknown' };
  if (MNC_RE.test(c)) return { rank: 0, key: 'mnc', label: 'MNC / large' };
  if (SCALEUP_RE.test(c)) return { rank: 1, key: 'startup', label: 'Startup / scaleup' };
  return { rank: 2, key: 'other', label: 'Other employer' };
}

/* ---------------------------------------------------------------- gates */

const CLOSED_RE = /\b(no longer accepting|applications? (?:are )?closed|applications? closed|position (?:has been )?filled|role filled|posting closed|this job (?:is )?(?:no longer|closed)|deadline passed|expired|closed for applications|applications? have closed)\b/i;
const PHD_RE = /\b(ph\.?\s?d|doctorate|doctoral|post[- ]?doc(?:toral)?)\b/i;
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|distinguished|manager|director|head of|vp|vice president|chief|architect|fellow|lead)\b/i;
// "lead" is ambiguous (lead generation, lead scoring); require an engineering-ish context.
const LEAD_ENG_RE = /\blead\s+(software|backend|back-end|frontend|front-end|full[\s-]?stack|platform|data|ml|ai|cloud|devops|sre|qa|engineer|developer|sde|swe|architect)\b/i;

const ENTRY_HINT_RE = /\b(fresher|entry[- ]level|graduate|new grad|recent graduate|0[- ]?(?:to|-)?\s?[12]\s*years?|no prior experience|internship|trainee|associate)\b/i;

/** Parse a stated minimum years-of-experience requirement. Conservative. */
export function requiredYears(text) {
  const t = String(text || '');
  const out = { min: null, max: null, stated: false, raw: null };
  // ranges first: "2-4 years", "3 to 5 years"
  const range = t.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i);
  if (range) { out.min = Number(range[1]); out.max = Number(range[2]); out.stated = true; out.raw = range[0]; return out; }
  const plus = t.match(/\b(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/i) || t.match(/\b(?:minimum|at least|min\.?|over)\s+(\d{1,2})\s*(?:years?|yrs?)\b/i);
  if (plus) { out.min = Number(plus[1]); out.stated = true; out.raw = plus[0]; return out; }
  const plain = t.match(/\b(\d{1,2})\s*(?:years?|yrs?)\b/i);
  if (plain) { out.min = Number(plain[1]); out.stated = true; out.raw = plain[0]; return out; }
  return out;
}

const NON_INDIA_RESTRICT_RE = /\b(must (?:be )?(?:be )?(?:based|located|residing|reside|live) in the (?:us|usa|united states|uk|united kingdom|canada|eu|europe)|authorized to work in the (?:us|uk|canada)|must have (?:us|uk) work authorization|us citizens? only|only us|us work authorization|right to work in the (?:uk|eu|us)(?! .{0,20}india)|india(?:n)? (?:candidates|applicants) (?:are )?not (?:eligible|considered)|not open to (?:candidates in )?india|cannot sponsor|no sponsorship|we do not sponsor)\b/i;

/* ---------------------------------------------------------------- classifier */

export const BUCKET = { SUITABLE: 'suitable', REVIEW: 'review', EXCLUDED: 'excluded' };

/**
 * Classify a job into suitable / review / excluded with visible reasons.
 * @param {object} job  job row (title, description, location, remote, company, tags, extra)
 * @param {object} rawCriteria
 * @returns {{bucket, eligible, reasons, fit, gates, kind}}
 */
export function classifyEligibility(job, rawCriteria) {
  const criteria = normalizeCriteria(rawCriteria || DEFAULT_CRITERIA);
  const role = roleInfo(job);
  const type = typeInfo(job);
  const duration = durationInfo(job, type);
  const pay = payInfo(job, type);
  const city = cityInfo(job);
  const tier = tierInfo(job);
  const title = String(job.title || '');
  const desc = String(job.description || '');
  const full = `${title}\n${desc}`;

  const reasons = [];
  const gates = [];
  const addEx = (gate, text) => { gates.push({ gate, level: 'excluded', text }); reasons.push({ level: 'excluded', text, gate }); };
  const addWarn = (gate, text) => { gates.push({ gate, level: 'review', text }); reasons.push({ level: 'review', text, gate }); review = true; };
  const addInfo = (gate, text) => { gates.push({ gate, level: 'info', text }); reasons.push({ level: 'info', text, gate }); };
  const addOk = (gate, text) => { gates.push({ gate, level: 'ok', text }); reasons.push({ level: 'ok', text, gate }); };

  let excluded = false;
  let review = false;

  /* 1. closed / expired ---------------------------------------------------- */
  const deadline = extraOf(job).deadline || extraOf(job).closingDate || extraOf(job).closeDate;
  if (CLOSED_RE.test(full)) { addEx('closed', 'Posting says applications are closed or the role is filled.'); excluded = true; }
  if (deadline) {
    const d = new Date(deadline).getTime();
    if (Number.isFinite(d) && d < Date.now()) { addEx('closed', 'Application deadline has passed (' + String(deadline) + ').'); excluded = true; }
  }

  /* 2. seniority / PhD ----------------------------------------------------- */
  if (PHD_RE.test(title)) { addEx('seniority', 'PhD / doctorate role — not an early-career undergraduate role.'); excluded = true; }
  else if (SENIOR_RE.test(title) || LEAD_ENG_RE.test(title)) {
    const hit = (title.match(SENIOR_RE) || title.match(LEAD_ENG_RE))[0];
    addEx('seniority', `Seniority marker “${hit}” in the title — a gated, non-early-career level.`);
    excluded = true;
  }

  /* 3. required experience ------------------------------------------------- */
  const expSource = title + '\n' + desc.slice(0, 1500);
  const yrs = requiredYears(expSource);
  if (yrs.stated && yrs.min != null) {
    if (yrs.min >= criteria.excludeMinYears && !ENTRY_HINT_RE.test(expSource.slice(0, 200))) {
      addEx('experience', `Requires ${yrs.min}${yrs.max ? '–' + yrs.max : '+'} years of experience (stated: “${yrs.raw}”).`);
      excluded = true;
    } else if (yrs.min >= criteria.reviewMinYears) {
      addWarn('experience', `States ${yrs.min}${yrs.max ? '–' + yrs.max : '+'} years of experience — check against your profile.`);
    }
  }

  /* 4. explicit non-India restriction -------------------------------------- */
  if (NON_INDIA_RESTRICT_RE.test(full)) {
    addEx('geo-restriction', 'Posting states a non-India work-authorization / location restriction.');
    excluded = true;
  }

  /* 5. role family --------------------------------------------------------- */
  if (role.nonTarget) {
    addEx('role', `Title reads as ${role.label}, not a target engineering/data family — the description cannot override the title.`);
    excluded = true;
  } else if (role.confidence === 'none') {
    addWarn('role', 'Role family is unclear from the title — needs a human look.');
  } else if (role.confidence === 'description') {
    if (criteria.roleFamilies.includes(role.key)) {
      addWarn('role', `Role family only found in the description (${role.label}) — lower confidence.`);
    } else {
      addWarn('role', `Only the description suggests a role family (${role.label}); the title is generic.`);
    }
  } else if (!criteria.roleFamilies.includes(role.key)) {
    addEx('role', `Role family “${role.label}” is outside your target families.`);
    excluded = true;
  } else {
    addOk('role', `Target role family: ${role.label} (from the title).`);
  }

  /* 6. geography ----------------------------------------------------------- */
  if (city.restricted) {
    addEx('geo', city.remoteUnknown
      ? 'Remote role restricted to a non-India geography.'
      : `Location is outside India (${city.label}).`);
    excluded = true;
  } else if (criteria.requireExplicitRemoteEligibility && (city.remoteUnknown || (city.rank === 5 && !city.remoteEligible))) {
    addWarn('geo', 'Remote role — the posting does not state India or worldwide eligibility. Treated as unknown, not eligible.');
  } else if (city.rank === 5) {
    addOk('geo', 'Remote role (explicit-eligibility check is disabled).');
  } else if (city.rank <= 3) {
    addOk('geo', `Preferred city: ${city.label}.`);
  } else if (city.rank === 4) {
    if (criteria.otherIndiaAllowed) addOk('geo', 'India location outside your top cities (allowed).');
    else addWarn('geo', 'India location outside your preferred cities.');
  } else if (city.rank === 7) {
    addWarn('geo', 'Location is not stated — cannot confirm India eligibility.');
  }

  /* 7. opportunity type / pay / duration — reporting only, never invented ---- */
  if (type.key === 'internship') addOk('type', `Internship stated in the ${type.basis === 'title' ? 'title' : 'ATS employment-type field'}.`);
  else if (type.basis === 'none') addInfo('type', 'Opportunity type not stated by the source.');

  if (pay.key === 'unpaid') addInfo('pay', 'Unpaid (stated) — lower priority than paid roles.');
  else if (pay.stated) addOk('pay', pay.label);

  /* 8. employer preference is a ranking signal only — never a gate ---------- */
  if (tier.key === 'mnc') addOk('employer', 'Large / MNC employer.');

  const bucket = excluded ? BUCKET.EXCLUDED : review ? BUCKET.REVIEW : BUCKET.SUITABLE;
  return {
    bucket,
    eligible: bucket === BUCKET.SUITABLE,
    reasons,
    gates,
    fit: { role, type, duration, pay, city, tier, requiredYears: yrs },
    kind: type.key,
  };
}

/** Attach eligibility to job rows without mutating stored data. */
export function decorateJobs(rows, criteria) {
  return (rows || []).map((j) => ({ ...j, eligibility: classifyEligibility(j, criteria) }));
}

export function summarizeBuckets(rows) {
  const out = { total: 0, suitable: 0, review: 0, excluded: 0 };
  for (const j of rows || []) {
    out.total++;
    const b = j && j.eligibility ? j.eligibility.bucket
      : (j && j.bucket) ? j.bucket : null;
    if (b === BUCKET.SUITABLE) out.suitable++;
    else if (b === BUCKET.REVIEW) out.review++;
    else if (b === BUCKET.EXCLUDED) out.excluded++;
  }
  return out;
}
