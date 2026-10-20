/**
 * Turn a Browsy accessibility snapshot (or raw copied text) into EDITABLE field
 * suggestions for the capture review form. Everything returned is a suggestion
 * with a stated basis — nothing is auto-imported, and no fact is invented.
 */

import { cleanText } from './util.js';
import { guessTitle, guessCompany, guessLocation, extractSalary, extractEmails, detectRemote, extractLinks } from './normalize.js';
import { typeInfo, matchRoleFamily, matchNonTarget } from './eligibility.js';

const SNAPSHOT_LINE = /^\s*(?:w\d+\s+)?([a-z-]+)\s*:\s*(.*)$/i;
const NOISE_LINE = /^(link|button|image|banner|navigation|complementary|contentinfo|heading|tab|tabpanel|menu|menuitem|checkbox|radio|switch|combobox|listbox|option|img|graphic|separator|status|alert)\b/i;

/** Strip a11y markup ("w12 link: Apply now") down to readable text lines. */
export function cleanSnapshot(snapshotText) {
  const raw = String(snapshotText || '');
  const out = [];
  for (const line of raw.split('\n')) {
    const m = line.match(SNAPSHOT_LINE);
    let text = m ? m[2] : line;
    text = cleanText(text, 1000);
    if (!text) continue;
    if (NOISE_LINE.test(text)) continue;
    if (/^(skip to|cookie|subscribe|newsletter|sign in|log in|privacy|terms)\b/i.test(text)) continue;
    out.push(text);
  }
  return dedupeLines(out);
}

function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const k = l.toLowerCase().slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

const REQ_HEADING = /^(requirements?|qualifications?|what (we|you)(?:'re| are) looking for|what you(?:'ll| will) need|who you are|must have|minimum qualifications|preferred qualifications|skills?)\b/i;
const REQ_STOP = /^(about (us|the company)|benefits|perks|compensation|how to apply|apply now|equal opportunity|we are an equal)\b/i;

function extractRequirements(lines) {
  const reqs = [];
  let inBlock = false;
  for (const l of lines) {
    if (REQ_HEADING.test(l)) { inBlock = true; continue; }
    if (inBlock && REQ_STOP.test(l)) { inBlock = false; continue; }
    if (inBlock) {
      const t = l.replace(/^[•\-*\u2022]\s*/, '').trim();
      if (t.length >= 3 && t.length <= 220) reqs.push(t);
      if (reqs.length >= 20) break;
    }
  }
  return reqs;
}

/**
 * @param {object} o
 * @param {string} o.snapshotText  Browsy snapshot text (or pasted text)
 * @param {string} [o.url]         tab url
 * @param {string} [o.pageTitle]   tab title
 * @returns {object} editable suggestions
 */
export function extractCapture({ snapshotText = '', url = '', pageTitle = '' } = {}) {
  const lines = cleanSnapshot(snapshotText);
  const body = lines.join('\n');
  const description = cleanText(body, 20000);
  const links = extractLinks(`${url}\n${body}`);
  const rawTitle = pageTitle || lines.find((l) => l.length > 8 && l.length < 120) || '';

  const title = guessTitle(rawTitle, body);
  const company = guessCompany(rawTitle, body, { links });
  const location = guessLocation(rawTitle, body, '');
  const salary = extractSalary(`${title}\n${body.slice(0, 3000)}`);
  const remote = detectRemote(body, location) === 1;
  const emails = extractEmails(body);
  const pseudo = { title, description, location, remote, tags: [] };
  const t = typeInfo(pseudo);
  const family = matchRoleFamily(title) || null;
  const nonTarget = matchNonTarget(title);

  const requirements = extractRequirements(lines);

  const field = (value, basis) => ({ value: value || '', basis, confidence: value ? basis : 'not found' });

  return {
    url,
    pageTitle: rawTitle,
    capturedAt: new Date().toISOString(),
    fields: {
      title: field(title, pageTitle ? 'page title' : 'snapshot'),
      company: field(company, company ? 'snapshot / links' : ''),
      location: field(location, location ? 'snapshot' : ''),
      pay: field(salary, salary ? 'snapshot' : ''),
      type: field(t.key === 'unknown' ? '' : t.label, t.basis === 'title' ? 'title' : ''),
      remote: { value: remote, basis: remote ? 'snapshot' : '' },
      requirements: { value: requirements.join('\n'), basis: requirements.length ? 'requirements section' : '' },
      roleFamily: family ? family.label : (nonTarget ? nonTarget.label + ' (non-target)' : ''),
      applyEmail: field(emails[0], emails[0] ? 'snapshot' : ''),
    },
    description,
    notes: 'Review and edit every field before importing. Fields left blank stay blank — nothing is guessed.',
  };
}
