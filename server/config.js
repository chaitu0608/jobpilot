import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
export const DB_PATH = process.env.JOBPILOT_DB
  ? path.resolve(process.env.JOBPILOT_DB)
  : path.join(DATA_DIR, 'jobpilot.db');

export const DEFAULT_CONFIG = {
  port: 8787,
  profile: {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    location: '',
    country: 'India',
    linkedin: '',
    github: '',
    portfolio: '',
    twitter: '',
    resumePath: '',
    currentCompany: '',
    currentTitle: '',
    yearsExperience: '',
    noticePeriod: '',
    expectedSalary: '',
  },
  answers: [
    { pattern: 'authoriz|legally (allowed|permitted) to work|right to work', value: 'Yes' },
    { pattern: 'sponsor', value: 'No' },
    { pattern: 'notice period|availability to join|when can you (start|join)', value: '30 days' },
    { pattern: 'expected (salary|ctc|compensation)|salary expectation', value: '' },
    { pattern: 'how did you hear|where did you (hear|find)', value: 'Company careers page' },
    { pattern: 'willing to relocate|relocat', value: 'Yes' },
    { pattern: 'comfortable with (a )?(hybrid|onsite|in-office)', value: 'Yes' },
  ],
  targets: {
    titles: ['software engineer', 'sde', 'backend', 'back-end', 'frontend', 'front-end', 'full stack', 'fullstack', 'platform engineer', 'devops', 'site reliability', 'sre', 'data engineer', 'ml engineer', 'machine learning', 'mobile engineer', 'android', 'ios', 'node', 'python', 'golang', 'typescript', 'react', 'java'],
    skills: ['javascript', 'typescript', 'node', 'react', 'next.js', 'python', 'django', 'flask', 'fastapi', 'go', 'golang', 'java', 'spring', 'sql', 'postgres', 'mysql', 'mongodb', 'redis', 'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'k8s', 'terraform', 'graphql', 'rest', 'kafka', 'rabbitmq', 'grpc', 'microservices', 'distributed systems', 'ci/cd', 'linux', 'elasticsearch', 'spark', 'airflow'],
    locations: ['bangalore', 'bengaluru', 'remote', 'india', 'hyderabad', 'pune', 'mumbai', 'gurgaon', 'gurugram', 'noida', 'delhi', 'chennai', 'anywhere'],
    negative: ['unpaid', 'commission only', 'equity only', 'no salary', 'only us', 'us citizens only', 'must be located in the us', 'must be based in the us', 'w2 only', 'c2c', 'corp to corp', 'field sales', 'telecalling', 'business development'],
  },
  x: {
    queries: [
      '"we are hiring" ("software engineer" OR backend OR frontend) remote',
      'hiring "software engineer" india',
      '"we\'re hiring" developer (bangalore OR bengaluru OR remote)',
      'hiring "full stack" developer remote india',
    ],
    accounts: [],
    perQuery: 60,
    maxScrolls: 3,
  },
  reddit: { subs: ['forhire', 'jobbit', 'hiring', 'RemoteJobs'] },
  boards: { file: 'companies.json', perCompany: 40 },
  safety: { autoSubmit: false },
};

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
    ) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

export function loadConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      deepMerge(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (err) {
      console.error(`⚠️  config.json is not valid JSON (${err.message}). Using defaults; run "node server/cli.js setup" to fix.`);
    }
  }
  if (process.env.JOBPILOT_PORT) cfg.port = Number(process.env.JOBPILOT_PORT);
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return CONFIG_PATH;
}

export function loadCompanies(cfg) {
  const file = path.isAbsolute(cfg.boards?.file || '')
    ? cfg.boards.file
    : path.join(ROOT_DIR, cfg.boards?.file || 'companies.json');
  const out = { greenhouse: [], lever: [], ashby: [] };
  if (!fs.existsSync(file)) return out;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(out)) {
      const list = data[key] || [];
      out[key] = list
        .map((c) => (typeof c === 'string' ? c : c?.token))
        .filter(Boolean)
        .map((t) => String(t).trim().toLowerCase());
    }
  } catch (err) {
    console.error(`⚠️  Could not read ${file}: ${err.message}`);
  }
  return out;
}

/** Everything the extension needs to fill a form. Empty values are dropped. */
export function buildPacket(cfg) {
  const p = cfg.profile || {};
  const profile = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    profile[k] = String(v).trim();
  }
  const answers = (cfg.answers || [])
    .filter((a) => a && a.pattern && String(a.value ?? '').trim() !== '')
    .map((a) => ({ pattern: String(a.pattern), value: String(a.value).trim() }));
  let resume = null;
  if (profile.resumePath) {
    const rp = profile.resumePath.replace(/^~(?=$|\/)/, process.env.HOME || '');
    if (fs.existsSync(rp)) {
      const stat = fs.statSync(rp);
      resume = { name: path.basename(rp), size: stat.size, path: rp };
    } else {
      resume = { name: path.basename(rp), size: 0, path: rp, missing: true };
    }
  }
  return { profile, answers, resume, autoSubmit: Boolean(cfg.safety?.autoSubmit) };
}
