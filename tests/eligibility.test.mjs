import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEligibility, BUCKET } from '../server/eligibility.js';
import { normalizeCriteria, DEFAULT_CRITERIA } from '../server/criteria.js';

const C = normalizeCriteria(DEFAULT_CRITERIA);
const classify = (j) => classifyEligibility(j, C);
const reasons = (r) => r.reasons.filter((x) => x.level === 'excluded' || x.level === 'review').map((x) => x.text).join(' | ');

test('senior/staff/principal/manager/director roles are excluded on the title', () => {
  for (const title of ['Senior Software Engineer', 'Staff Engineer', 'Principal Backend Engineer', 'Engineering Manager', 'Director of Engineering', 'Lead Software Engineer']) {
    const r = classify({ title, company: 'Acme', location: 'Bengaluru, India' });
    assert.equal(r.bucket, BUCKET.EXCLUDED, title + ' should be excluded');
    assert.match(reasons(r), /seniority/i);
  }
});

test('"Lead Generation Specialist" is not caught by the lead-engineer gate', () => {
  // "lead" alone is ambiguous — only lead + an engineering noun gates out.
  const r = classify({ title: 'Lead Generation Specialist', company: 'Acme', location: 'Mumbai' });
  assert.notEqual(r.bucket, BUCKET.SUITABLE);
});

test('PhD / doctorate roles are excluded', () => {
  const r = classify({ title: 'PhD Research Scientist', company: 'Lab', location: 'London' });
  assert.equal(r.bucket, BUCKET.EXCLUDED);
  assert.match(reasons(r), /PhD|doctorate/i);
});

test('incompatible required experience is excluded, borderline is review', () => {
  const hard = classify({ title: 'Software Engineer', company: 'Acme', location: 'Pune', description: 'You bring 5+ years of experience.' });
  assert.equal(hard.bucket, BUCKET.EXCLUDED);
  assert.match(reasons(hard), /years of experience/i);
  const soft = classify({ title: 'Software Engineer', company: 'Acme', location: 'Pune', description: '2+ years of experience preferred.' });
  assert.equal(soft.bucket, BUCKET.REVIEW);
});

test('explicit non-India restrictions are excluded', () => {
  const r = classify({ title: 'Software Engineer', company: 'Acme', location: 'Bengaluru', description: 'Must be authorized to work in the US.' });
  assert.equal(r.bucket, BUCKET.EXCLUDED);
  assert.match(reasons(r), /non-India|work-authorization/i);
});

test('closed / deadline-passed postings are excluded', () => {
  assert.equal(classify({ title: 'Software Engineer', company: 'Acme', location: 'Pune', description: 'Applications are closed.' }).bucket, BUCKET.EXCLUDED);
  const past = classify({ title: 'Software Engineer', company: 'Acme', location: 'Pune', extra: { deadline: '2020-01-01' } });
  assert.equal(past.bucket, BUCKET.EXCLUDED);
});

test('non-technical titles are never promoted by the description', () => {
  for (const title of ['Technical Writer', 'Product Designer', 'Talent Acquisition Specialist', 'Sales Executive']) {
    const r = classify({ title, company: 'Acme', location: 'Mumbai', description: 'You will work with software engineers on react, node, python and data pipelines.' });
    assert.equal(r.bucket, BUCKET.EXCLUDED, title + ' must not be classified as software/data');
    assert.match(reasons(r), /not a target|outside your target/i);
  }
});

test('remote without explicit India/worldwide eligibility is review, never suitable', () => {
  const bare = classify({ title: 'Software Engineer', company: 'Acme', location: 'Remote' });
  assert.equal(bare.bucket, BUCKET.REVIEW);
  assert.match(reasons(bare), /does not state India or worldwide/i);

  const explicit = classify({ title: 'Software Engineer', company: 'Acme', location: 'Remote', description: 'Open to candidates worldwide.' });
  assert.equal(explicit.bucket, BUCKET.SUITABLE);

  const india = classify({ title: 'Backend Engineer', company: 'Acme', location: 'Remote, India' });
  assert.equal(india.bucket, BUCKET.SUITABLE);
});

test('remote restricted to a foreign geography is excluded', () => {
  const r = classify({ title: 'Software Engineer', company: 'Acme', location: 'Remote - US' });
  assert.equal(r.bucket, BUCKET.EXCLUDED);
});

test('a definite foreign location is excluded', () => {
  assert.equal(classify({ title: 'Software Engineer', company: 'Acme', location: 'New York, USA' }).bucket, BUCKET.EXCLUDED);
});

test('paid semester internship is suitable; pay/duration only reported when stated', () => {
  const r = classify({ title: 'Software Engineer Intern', company: 'Acme', location: 'Mumbai', description: 'A paid 6 month internship with a monthly stipend.' });
  assert.equal(r.bucket, BUCKET.SUITABLE);
  assert.equal(r.fit.duration.stated, true);
  assert.equal(r.fit.pay.stated, true);

  const vague = classify({ title: 'Software Engineer Intern', company: 'Acme', location: 'Pune' });
  assert.equal(vague.fit.pay.stated, false);
  assert.equal(vague.fit.duration.stated, false);
});

test('unknown location is review, not suitable', () => {
  const r = classify({ title: 'Software Engineer', company: 'Acme', location: '' });
  assert.equal(r.bucket, BUCKET.REVIEW);
});

test('eligibility is computed on read — mutating criteria changes the verdict without stored data', () => {
  const job = { title: 'Software Engineer', company: 'Acme', location: 'Remote' };
  const strict = classifyEligibility(job, C);
  assert.equal(strict.bucket, BUCKET.REVIEW);
  const relaxed = classifyEligibility(job, normalizeCriteria({ ...DEFAULT_CRITERIA, requireExplicitRemoteEligibility: false }));
  assert.equal(relaxed.bucket, BUCKET.SUITABLE);
});
