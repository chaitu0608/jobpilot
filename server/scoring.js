import { daysSince } from './util.js';

const SOURCE_BONUS = { greenhouse: 6, lever: 6, ashby: 6, remoteok: 4, hn: 5, reddit: 3, x: 3 };

/**
 * Score a job 0–100 against the user's targets.
 * Title match dominates, then skills, location, freshness, source; negative keywords subtract.
 */
export function scoreJob(job, targets = {}) {
  const title = String(job.title || '').toLowerCase();
  const loc = String(job.location || '').toLowerCase();
  const desc = String(job.description || '').toLowerCase().slice(0, 8000);
  const hay = `${title}\n${desc}`;
  const why = [];
  let score = 0;

  const titles = (targets.titles || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const titleHit = titles.find((t) => title.includes(t));
  if (titleHit) {
    score += 38;
    why.push(`title:${titleHit}`);
  } else {
    const inDesc = titles.find((t) => desc.includes(t));
    if (inDesc) {
      score += 16;
      why.push(`desc:${inDesc}`);
    }
  }

  const skills = (targets.skills || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const skillHits = skills.filter((s) => hay.includes(s));
  if (skillHits.length) {
    score += Math.min(24, 4 + skillHits.length * 4);
    why.push(`skills:${skillHits.slice(0, 6).join(',')}`);
  }

  const locs = (targets.locations || []).map((l) => String(l).toLowerCase()).filter(Boolean);
  const locHit = locs.find((l) => loc.includes(l)) || locs.find((l) => hay.includes(l));
  if (locHit) {
    score += 16;
    why.push(`loc:${locHit}`);
  }
  if (job.remote) {
    score += 9;
    why.push('remote');
  }

  // "Remote - USA" style roles are usually not open to candidates outside those countries.
  // Only penalise when the user isn't targeting the US in the first place.
  const targetsUS = locs.some((l) => ['us', 'usa', 'united states', 'north america', 'americas'].includes(l));
  if (!targetsUS && /\b(u\.?s\.?a?|united states)\b/i.test(loc)) {
    score -= 12;
    why.push('geo:us-only-ish');
  }

  const d = daysSince(job.posted_at);
  if (d <= 1) score += 10;
  else if (d <= 3) score += 8;
  else if (d <= 7) score += 6;
  else if (d <= 14) score += 4;
  else if (d <= 30) score += 2;
  else if (!Number.isFinite(d)) score += 3; // unknown date

  score += SOURCE_BONUS[job.source] ?? 2;

  const negs = (targets.negative || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  for (const n of negs) {
    if (n && hay.includes(n)) {
      score -= 30;
      why.push(`neg:${n}`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // No positive signal at all → keep it low so it doesn't pollute the top of the list.
  if (!titleHit && skillHits.length === 0) score = Math.min(score, 35);
  if (negs.length && why.some((w) => w.startsWith('neg:')) && !titleHit) score = Math.min(score, 20);

  return { score, why };
}

/** Recompute scores for every job with the current targets (run after tweaking config). */
export function rescoreAll(db, cfg, { source = null } = {}) {
  const where = source ? 'WHERE source = ?' : '';
  const rows = db.prepare(
    `SELECT id, source, title, location, remote, description, posted_at, extra FROM jobs ${where}`
  ).all(...(source ? [source] : []));
  const upd = db.prepare('UPDATE jobs SET score = ?, extra = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const { score, why } = scoreJob(r, cfg?.targets || {});
    let extra = {};
    try {
      extra = JSON.parse(r.extra || '{}');
    } catch {
      extra = {};
    }
    extra.why = why;
    upd.run(score, JSON.stringify(extra), r.id);
    n++;
  }
  return n;
}
