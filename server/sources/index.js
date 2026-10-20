import { nowIso } from '../util.js';
import { loadCompanies } from '../config.js';
import { addRun, upsertJob } from '../db.js';
import { finalizeJob } from '../normalize.js';
import { greenhouseJobs } from './greenhouse.js';
import { leverJobs } from './lever.js';
import { ashbyJobs } from './ashby.js';
import { remoteokJobs } from './remoteok.js';
import { hnJobs } from './hn.js';
import { redditRssJobs } from './reddit.js';

/** Normalize + score a batch of raw items and write them to the DB. */
export function ingestItems(db, cfg, sourceName, items, { log = () => {} } = {}) {
  let added = 0;
  let merged = 0;
  let skipped = 0;
  const errors = [];
  for (const raw of items || []) {
    try {
      const job = finalizeJob(raw, cfg);
      if (!job) {
        skipped++;
        continue;
      }
      const res = upsertJob(db, job);
      if (res.added) added++;
      else merged++;
    } catch (err) {
      if (errors.length < 5) errors.push(`${sourceName}: ${err.message}`);
    }
  }
  log(`${sourceName}: +${added} new, ${merged} merged, ${skipped} filtered out`);
  return { added, merged, skipped, errors };
}

/**
 * Server-side scan: company boards + HN + Reddit RSS.
 * (X and logged-in Reddit come from the browser extension instead.)
 */
export async function runServerScan(db, cfg, { sources = ['boards', 'hn', 'reddit'], log = console.log } = {}) {
  const results = { found: 0, added: 0, merged: 0, skipped: 0, bySource: {}, errors: [] };
  const companies = loadCompanies(cfg);

  const jobs = [];
  // "boards" expands to every board source; individual names also work
  // (e.g. sources: ['remoteok']) so you can rescan one source cheaply.
  const boards = sources.includes('boards') || ['greenhouse', 'lever', 'ashby', 'remoteok'].some((n) => sources.includes(n));
  if (boards) {
    const opts = { perCompany: cfg.boards?.perCompany || 40, db, log };
    if (sources.includes('boards') || sources.includes('greenhouse')) jobs.push(['greenhouse', () => greenhouseJobs(companies.greenhouse, opts)]);
    if (sources.includes('boards') || sources.includes('lever')) jobs.push(['lever', () => leverJobs(companies.lever, opts)]);
    if (sources.includes('boards') || sources.includes('ashby')) jobs.push(['ashby', () => ashbyJobs(companies.ashby, opts)]);
    if (sources.includes('boards') || sources.includes('remoteok')) jobs.push(['remoteok', () => remoteokJobs({ log })]);
  }
  if (sources.includes('hn')) jobs.push(['hn', () => hnJobs({ log })]);
  if (sources.includes('reddit')) jobs.push(['reddit', () => redditRssJobs(cfg.reddit?.subs || [], { log })]);

  for (const [name, fn] of jobs) {
    const started = nowIso();
    try {
      const raws = await fn();
      const ing = ingestItems(db, cfg, name, raws, { log });
      addRun(db, {
        source: name,
        started_at: started,
        found: raws.length,
        added: ing.added,
        error: ing.errors.join('; ') || null,
      });
      results.found += raws.length;
      results.added += ing.added;
      results.merged += ing.merged;
      results.skipped += ing.skipped;
      results.bySource[name] = { found: raws.length, added: ing.added, merged: ing.merged, skipped: ing.skipped };
      results.errors.push(...ing.errors);
    } catch (err) {
      addRun(db, { source: name, started_at: started, error: err.message });
      results.errors.push(`${name}: ${err.message}`);
      log(`${name}: FAILED — ${err.message}`);
    }
  }
  return results;
}
