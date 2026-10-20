import { daysSince, truncate } from './util.js';
import { listJobs, stats } from './db.js';

const ago = (iso) => {
  const d = daysSince(iso);
  if (!Number.isFinite(d)) return 'unknown';
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))}m ago`;
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  return `${Math.round(d)}d ago`;
};

/** Markdown digest of the freshest, highest-scoring jobs. */
export function buildDigest(db, { minScore = 55, limit = 15, sinceDays = 7 } = {}) {
  const date = new Date().toDateString();
  const s = stats(db);
  const { rows: top } = listJobs(db, { status: 'new', minScore, limit, sort: 'score', sinceDays });
  const { rows: rest, total } = listJobs(db, { status: 'new', minScore: 35, limit: 400, sort: 'score', sinceDays });

  const lines = [];
  lines.push(`# Clinqy digest — ${date}`);
  lines.push('');
  lines.push(`**${s.byStatus.new || 0} new** · ${s.highScore} high-score waiting · ${total} in the last ${sinceDays}d above 35`);
  lines.push('');

  if (!top.length) {
    lines.push('_No new matches above the threshold. Run another scan or lower `--min-score`._');
  } else {
    lines.push(`## 🔥 Top ${top.length}`);
    lines.push('');
    let i = 1;
    for (const j of top) {
      const bits = [
        j.company || j.author || 'unknown company',
        j.location || (j.remote ? 'Remote' : null),
        j.salary,
      ].filter(Boolean).join(' · ');
      const link = j.apply_url || j.source_url;
      lines.push(`${i++}. **[${j.title}](${j.source_url})** — ${bits}`);
      lines.push(`   \`score ${j.score}\` · \`${j.source}\` · ${ago(j.posted_at)} · [apply ↗](${link})`);
      if (j.description) lines.push(`   ${truncate(j.description.replace(/\n+/g, ' '), 180)}`);
      lines.push('');
    }
  }

  const seen = new Set(top.map((j) => j.id));
  const others = rest.filter((j) => !seen.has(j.id)).slice(0, 30);
  if (others.length) {
    lines.push(`## 🆕 Also new (score ≥ 35)`);
    lines.push('');
    for (const j of others) {
      const bits = [j.company || j.author || '?', j.location || (j.remote ? 'Remote' : null)].filter(Boolean).join(' · ');
      lines.push(`- [${truncate(j.title, 90)}](${j.source_url}) — ${bits} — \`${j.score}\` \`${j.source}\` ${ago(j.posted_at)}`);
    }
    lines.push('');
  }

  const counts = Object.entries(s.bySource || {}).map(([k, v]) => `${k}:${v}`).join(' · ');
  lines.push(`---`);
  lines.push(`_sources — ${counts || 'none yet'}_`);
  return { markdown: lines.join('\n'), top: top.length, total: rest.length };
}
