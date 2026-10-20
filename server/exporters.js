/**
 * Exports and briefs.
 *
 * CSV is hardened against spreadsheet formula injection: any cell whose first
 * non-space character is one of = + - @ (or a tab / carriage return) is
 * prefixed with a single quote so a spreadsheet treats it as text.
 */

export function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Formula-injection guard.
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows, columns) {
  const cols = columns && columns.length ? columns : unionColumns(rows);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows || []) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

function unionColumns(rows) {
  const cols = [];
  for (const r of rows || []) for (const k of Object.keys(r || {})) if (!cols.includes(k)) cols.push(k);
  return cols;
}

export function flattenJob(j, eligibility) {
  return {
    id: j.id,
    title: j.title,
    company: j.company || j.author || '',
    location: j.location || '',
    remote: j.remote ? 'yes' : '',
    salary: j.salary || '',
    source: j.source,
    source_url: j.source_url || '',
    apply_url: j.apply_url || '',
    apply_email: j.apply_email || '',
    posted_at: j.posted_at || '',
    first_seen_at: j.first_seen_at || '',
    status: j.status,
    score: j.score,
    eligibility: eligibility ? eligibility.bucket : '',
    eligibility_reasons: eligibility ? eligibility.reasons.filter((r) => r.level !== 'ok').map((r) => r.text).join(' | ') : '',
    role_family: eligibility ? eligibility.fit.role.label : '',
    opportunity_type: eligibility ? eligibility.fit.type.label : '',
    duplicates_seen_on: (j.seen_sources || []).join('; '),
  };
}

export function flattenPipeline(entry, { job, company, contact } = {}) {
  return {
    pipeline_id: entry.id,
    job_id: entry.job_id,
    title: job ? job.title : '',
    company: company ? company.name : (job ? (job.company || '') : ''),
    status: entry.status,
    next_action: entry.next_action || '',
    next_action_date: entry.next_action_date || '',
    contact: contact ? contact.name : '',
    contact_email: contact ? (contact.data && contact.data.email) || '' : '',
    job_url: job ? (job.source_url || '') : '',
    updated_at: entry.updated_at || '',
  };
}

const moneyish = (s) => (s ? String(s) : '');

/**
 * Build an editable, FACTUAL application/outreach brief. Only facts already in
 * the database are used; every unknown is written as "not stated" rather than
 * guessed. No message is ever sent.
 */
export function buildBrief({ job, eligibility, company, contact, criteria } = {}) {
  const L = [];
  const j = job || {};
  const role = eligibility ? eligibility.fit.role : null;
  const type = eligibility ? eligibility.fit.type : null;
  const city = eligibility ? eligibility.fit.city : null;
  L.push(`# Application brief — ${j.title || '(untitled role)'}`);
  L.push('');
  L.push(`_Generated locally. Facts below come only from the captured posting — verify before sending. Nothing is auto-sent or auto-submitted._`);
  L.push('');
  L.push('## Role facts');
  L.push(`- Title: ${j.title || 'not stated'}`);
  L.push(`- Company: ${j.company || j.author || 'not stated'}`);
  L.push(`- Location: ${j.location || 'not stated'}${j.remote ? ' (remote)' : ''}`);
  L.push(`- Opportunity type: ${type ? type.label : 'not stated'}`);
  L.push(`- Pay: ${moneyish(j.salary) || 'not stated'}`);
  L.push(`- Role family (title-first): ${role ? role.label + (role.confidence === 'description' ? ' (via description)' : '') : 'not stated'}`);
  L.push(`- City bucket: ${city ? city.label : 'not stated'}`);
  L.push(`- Source: ${j.source || 'not stated'}${j.source_url ? ' — ' + j.source_url : ''}`);
  L.push(`- Apply link: ${j.apply_url || 'not stated'}`);
  L.push(`- Posted: ${j.posted_at || 'not stated'} · captured: ${j.first_seen_at || 'not stated'}`);
  L.push('');

  if (eligibility && eligibility.reasons.length) {
    L.push('## Eligibility notes');
    for (const r of eligibility.reasons) L.push(`- [${r.level}] ${r.text}`);
    L.push('');
  }

  L.push('## Company target');
  if (company) {
    L.push(`- ${company.name}${company.data && company.data.grade ? ' · ' + company.data.grade : ''}`);
    if (company.data && company.data.cities) L.push(`- Cities on file: ${company.data.cities}`);
    if (company.data && company.data.roles) L.push(`- Roles on file: ${company.data.roles}`);
    if (company.data && company.data.notes) L.push(`- Notes: ${company.data.notes}`);
  } else {
    L.push('- Not linked yet — link a company target in the Pipeline section.');
  }
  L.push('');

  L.push('## Contact');
  if (contact) {
    L.push(`- ${contact.name || 'unnamed'}${contact.data && contact.data.title ? ' · ' + contact.data.title : ''}`);
    if (contact.data && contact.data.email) L.push(`- Email: ${contact.data.email}`);
    if (contact.data && contact.data.link) L.push(`- Public source: ${contact.data.link}`);
    if (contact.data && contact.data.verification) L.push(`- Verification: ${contact.data.verification}`);
  } else {
    L.push('- Not linked yet — link or create a recruiter/contact in the Pipeline section.');
  }
  L.push('');

  if (j.description) {
    L.push('## Captured posting text');
    L.push('');
    L.push('```');
    L.push(String(j.description).slice(0, 6000));
    L.push('```');
    L.push('');
  }

  L.push('## Outreach draft (edit before sending)');
  L.push('');
  const cand = (criteria && criteria.candidate) || {};
  L.push('Hi' + (contact && contact.name ? ' ' + contact.name.split(' ')[0] : '') + ',');
  L.push('');
  L.push(`I'm a ${cand.degree || 'BTech'} candidate (expected ${cand.graduationYear || '—'}) looking at the ${j.title || 'role'} role${j.company || j.author ? ' at ' + (j.company || j.author) : ''}.`);
  L.push(`Could you point me to the right person or the next step for this opening${city && city.rank <= 3 ? ' in ' + city.label : ''}?`);
  L.push('');
  L.push('Thanks,');
  L.push(`${cand.degree ? '' : ''}`);
  L.push('');
  L.push('> Fill in your own signature/contact from your profile. The app never sends this for you.');
  return L.join('\n');
}
