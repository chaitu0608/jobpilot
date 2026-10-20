# Job Pilot

**A local-first job-search cockpit — and its own MCP server.** Job Pilot is the
practical child of [Browsy](https://github.com/adityabelgaonkar05/browsy) and
[Clinqy](https://github.com/Amrit-Nigam/clinqy):

- **Browsy's 17-tool browser surface**, served end to end by our own Chrome
  extension in your real logged-in session — no Browsy install required.
- **Clinqy's native-Mac reach** (look / stats / gated tasks), plus a local
  **watch-and-learn** recorder that replays browser workflows and a durable
  memory store.
- **A job workflow that stays human**: discover → gate eligibility → capture and
  review a posting → link a company and contact → write a factual brief → track
  the next action → pre-fill the application **you** submit.

Job Pilot speaks **MCP over stdio** with **46 tools**, so any MCP agent (OpenCode,
Claude Code, Codex, Cursor…) can drive the whole cockpit: search jobs, inspect
tabs, click and type with snapshots, fill applications, remember preferences,
record workflows, and call Clinqy — all on `127.0.0.1`.

No API keys. No cloud. No npm runtime dependencies. **Nothing is ever submitted
or sent for you** — Job Pilot opens, reads, fills and prepares; you review and
act.

> **Integrations are real.** The built-in browser engine, the optional external
> Browsy MCP server, and the real Clinqy macOS app are all spoken to over
> bounded stdio/HTTP with strict gating. What each engine can and cannot do is
> documented honestly in [`docs/capabilities.md`](docs/capabilities.md) and
> reflected live in the **Connections** section.

```
┌──────────────── your agent (OpenCode · Claude Code · Codex …) ───────────────┐
│                        MCP over stdio · 46 tools                             │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────── your Mac ────────────────────────────────────┐
│  Job Pilot MCP (server/mcp.js) ── HTTP ── Node server → 127.0.0.1:8787        │
│                                         ┌──────────────────────────────────┐ │
│  Chrome (your real session)             │ SQLite: jobs · captures ·        │ │
│  ┌────────────────────────┐  commands   │ companies · contacts · pipeline  │ │
│  │ Job Pilot extension    │◄───────────►│ research · memories · workflows  │ │
│  │ • 17 browser tools     │             │ eligibility · exports · dashboard│ │
│  │ • scans X / Reddit     │             └──────────┬───────────┬───────────┘ │
│  │ • fills forms          │                        │ stdio     │ stdio       │
│  │ • never submits        │          ┌─────────────▼──┐   ┌────▼───────────┐ │
│  └────────────────────────┘          │ Browsy (opt.)  │   │ Clinqy (real)  │ │
│                                      │ capture / tabs │   │ look·stats·run │ │
│                                      └────────────────┘   └────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
cd ~/jobpilot

# 1. answer a few questions (writes config.json)
node server/cli.js setup

# 2. start the server + dashboard
node server/cli.js serve          # → http://127.0.0.1:8787
```

Check what is connected:

```bash
node server/cli.js connections    # built-in engine + optional Browsy + Clinqy
```

**3. Load the extension once** (powers the browser tools, X/Reddit scanning and
autofill):

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `~/jobpilot/extension`
4. Pin the Job Pilot icon

**4. Make it available to your agent** (OpenCode example):

```bash
opencode mcp add --global jobpilot -- node "$HOME/jobpilot/server/mcp.js"
# restart the agent session, then ask: "jobpilot status"
```

Other clients use the same command in their MCP config — see
[Use it from any MCP agent](#use-it-from-any-mcp-agent).

**5. Run a scan** (optional — Job Pilot also works purely from captured pages):

```bash
node server/cli.js scan           # boards + HN + reddit RSS (server-side)
node server/cli.js scan-x         # X  (needs the extension + login on x.com)
node server/cli.js scan-reddit    # reddit through your logged-in session
```

Open **http://127.0.0.1:8787** — that's the real UI.

---

## Use it from any MCP agent

Job Pilot is the MCP server; the HTTP server auto-starts on the first tool call
if it isn't already running. stdout carries JSON-RPC only; logs go to stderr.

```jsonc
// Claude Desktop / Codex / Cursor style
{
  "mcpServers": {
    "jobpilot": {
      "command": "node",
      "args": ["/Users/you/jobpilot/server/mcp.js"]
    }
  }
}
```

**OpenCode**

```bash
opencode mcp add --global jobpilot -- node "$HOME/jobpilot/server/mcp.js"
opencode mcp list
```

**46 tools in five groups**

| Group | Count | What it does |
|---|---|---|
| `jobpilot_*` | 17 | status, scans, list/get, digest, status changes, apply packet, apply/fill, capture/import, rescore, research plan/list, brief |
| `browser_*` | 17 | Browsy parity via the extension: tabs, snapshot + refs, HTML, screenshot, click, type, keys, scroll, nav, wait, release |
| `clinqy_*` | 4 | `look`, `stats`, gated `run`, fixed native handoff |
| `memory_*` | 3 | remember / recall / forget local facts |
| `workflow_*` | 5 | record, stop, list, replay, delete browser workflows |

Resources: `jobpilot://status` and `jobpilot://capabilities`.

**Try these**

```text
jobpilot status
scan greenhouse + hn, then show me the top 10 backend roles in India
list jobs scoring 70+ that need review, pick one, and show its packet
capture the posting in my active tab, then import it after I review the fields
remember that I want remote-only roles with no on-call
record a workflow for this application form, then replay it on the next job
```

**Safety in the MCP layer**

- Every mutating browser call needs `confirmed: true`; submit / send / pay /
  delete clicks additionally need `approved: true` after you approve them.
- `jobpilot_apply` and `jobpilot_fill_current` only pre-fill. They never submit.
- `clinqy_run` is gated the same way and is never run automatically.
- Unknown mutation outcomes latch the tab until a fresh `browser_snapshot`.
- The server answers only on loopback; memory and workflows stay in local SQLite.

Full reference: [`docs/mcp.md`](docs/mcp.md). Agent skill:
[`skills/jobpilot/SKILL.md`](skills/jobpilot/SKILL.md).

---

## The workflow this is built around

```
find a posting in Chrome
        │  node server/cli.js tabs → capture --tab=<id>
        ▼
browser snapshot → editable capture   (review / fix the fields FIRST)
        │  import-capture <id>
        ▼
job + provenance + eligibility        (suitable · needs review · excluded)
        │
        ▼
link / create company + contact       (public source + verification)
        │
        ▼
editable factual brief → pipeline      (next action · date · status)
        │
        ▼
export CSV / JSON + per-job Markdown
```

The extension **never submits by itself**. It fills the form, highlights what it
answered in green and what it couldn't answer in amber, and shows a review bar.
You check it and press **Submit application ▶**. Only then is the job marked
*applied*.

---

## The five sections

| Section | What it holds |
|---|---|
| **Opportunities** | Captured + scanned jobs with eligibility. Sub-views: captured · potentially suitable · needs review · excluded. Filters live behind an expandable panel. |
| **Research** | Research runs that build official careers / LinkedIn / Indeed / Unstop queries and open them through the browser engine, with steps and checkpoints you can stop and resume. |
| **Pipeline** | Linked applications: status, next action and date, editable facts. |
| **People & Companies** | Employer targets and public recruiter contacts (source link, verification, approach angle, draft message — never sent). |
| **Connections** | Live status of the built-in browser engine, the optional external Browsy server, the real Clinqy app, the extension, the truthful Clinqy capability map, and the audit log. |

The UI is intentionally minimal: a short header, five sections, short rows,
evidence in a drawer, one primary action per context, and empty states with an
action. There are no mock results.

---

## Eligibility — gated before ranking

Eligibility is a pure, dependency-free classifier (`server/eligibility.js`)
served to the browser at `/eligibility.js` (importing `/criteria.js`), so the
server and UI always agree. It is **computed when read**, so editing criteria
changes verdicts **without** any destructive rescoring of the existing records.

Rules, in order:

1. **Gate before ranking** — senior / staff / principal / manager / director /
   head / VP / chief / architect titles, PhD / doctorate roles, incompatible
   required experience, explicit non-India restrictions, and closed or
   past-deadline postings are **excluded**, with visible reasons.
2. **Remote is never auto-eligible** — remote without an explicit India or
   worldwide statement is **UNKNOWN → needs review**.
3. **Title-first role family** — TA specialist / technical writer / designer are
   never promoted to software / data because a description mentions code.
4. **Pay and duration** are shown only when the posting states them.
5. **Unknown stays review.**

Buckets: **captured · potentially suitable · needs review · excluded**.

---

## Candidate criteria (separate from `config.json`)

Editable in the dashboard and via the CLI, stored in the database — deliberately
separate from your private `config.json`:

- **2027 BTech** (provisional, editable — not treated as verified).
- City order **Mumbai > Pune > Bengaluru > Hyderabad**, other India allowed.
- Role families: SWE, data / AI / ML, cloud, QA, consulting / implementation,
  graduate trainee, analytics / BA.
- Preferred types: **paid semester 4–6 month internships first**, then
  internships, then full-time.
- Employer preference: **MNC before startups**.
- Early-career / India-focus.

---

## Configuration (`config.json`)

| Section | What it does |
|---|---|
| `profile` | What gets typed into forms. `resumePath` can be `~/Documents/resume.pdf`. |
| `answers` | `{pattern, value}` bank for questions the profile rules don't cover — regex, case-insensitive. |
| `targets` | Fit scoring: `titles`, `skills`, `locations`, `negative`. Transparent — hover a score to see `why`. |
| `x.queries` / `x.accounts` | X searches and always-scan handles. |
| `reddit.subs` | Subreddits for the reddit scan. |
| `boards` | Which `companies.json` to poll + `perCompany` cap. |
| `port` | Server port (default 8787). |

`companies.json` holds the board tokens. Add your own from a careers URL
(`boards.greenhouse.io/<token>` → token = `<token>`).

---

## CLI reference

```
node server/cli.js setup                 first-run wizard
node server/cli.js serve                 server + dashboard
node server/cli.js mcp [--stdio]         run Job Pilot as an MCP server / print setup
node server/cli.js scan [--sources=boards,hn,reddit]   # also: greenhouse, lever, ashby, remoteok
node server/cli.js scan-x [--queries="a|b"]
node server/cli.js scan-reddit [--subs=forhire,developersIndia]
node server/cli.js list [--min-score=55] [--status=new] [--source=greenhouse] [--q=backend] [--remote] [--limit=25] [--json]
node server/cli.js show <id>
node server/cli.js save|skip|applied|archive <id>
node server/cli.js apply <id> [--packet]     queue autofill (or print a copy-paste packet)
node server/cli.js open <id>
node server/cli.js digest [--open]
node server/cli.js rescore                   re-score everything after editing targets
node server/cli.js stats

# integrations & durable workflow
node server/cli.js connections [--refresh]   browser engine + Browsy + Clinqy status, tools
node server/cli.js tabs                       list open browser tabs (read-only)
node server/cli.js capture --tab=<id>         snapshot a tab → editable capture (no submit)
node server/cli.js captures                   list saved captures
node server/cli.js import-capture <id> [--title= --company= --location=]
node server/cli.js pipeline                   list linked pipeline items
node server/cli.js brief <id>                 write a per-job markdown brief
node server/cli.js research                   list research runs
node server/cli.js criteria [--file=f.json]   show or update candidate criteria
node server/cli.js export [jobs|pipeline|companies|contacts] [--format=csv|json] [--out=path] [--print]
```

---

## How autofill works ("easy apply")

1. The server builds a **packet** from `config.json`: name/email/phone/links/
   resume + an answer bank.
2. The extension opens the apply URL and injects `content/ats.js` into every
   frame.
3. The filler matches each field's label against your profile rules and answer
   patterns, filling with native setters so React/Greenhouse/Lever/Ashby forms
   register the values.
4. Your resume is uploaded straight into the file input via `DataTransfer`.
5. A review bar appears; **you** submit.

Works well on **Greenhouse, Lever, Ashby**, and most career-page forms.
LinkedIn/Indeed "Easy Apply" is deliberately out of scope — use the direct apply
links.

---

## Safety & hygiene

- Filling and submitting are **two separate acts** — Job Pilot only does the
  first. `jobpilot_apply` and `jobpilot_fill_current` stop at the review bar.
- Every browser **mutation** requires `confirmed: true`; submit / send / pay /
  delete clicks also require `approved: true` in the built-in engine.
- Browsy/external mutations are **preview-and-confirm**, args are validated and
  capped, and an **unknown outcome requires a fresh snapshot** before the
  mutation can be repeated.
- `clinqy_run` requires an explicit confirmation; the dev workflow never runs
  native action tasks automatically. Cancellation is supported.
- Recorded workflows store **selectors and typed text locally** in SQLite. Avoid
  recording passwords or secrets; replay still asks for approval on submit-like
  clicks.
- Password fields, captchas and demographic questions are never touched.
- The server binds `127.0.0.1` only; your data sits in `data/jobpilot.db`.
- Only loopback `Host` names on its own port are served (DNS-rebinding
  defense), and any request whose `Origin` is a different web origin is rejected
  before handlers run. Mutations require `application/json` and are body-size
  limited. Credentials, private config and arbitrary paths are never served.
- The extension requests `<all_urls>` because browser tools must operate on
  arbitrary postings, but it only acts on commands from
  `http://127.0.0.1:8787`; no page content is sent anywhere else.
- `safety.autoSubmit` exists in config for future use; it is `false` and not
  implemented.

See [`docs/capabilities.md`](docs/capabilities.md) for the full, honest
capability map and the remaining native limitations.

---

## Sources

| Source | Path | Notes |
|---|---|---|
| Greenhouse / Lever / Ashby | server (`scan`) | Public JSON APIs, one request per company. |
| RemoteOK | server (`scan`) | Public feed. |
| HN "Who is hiring" | server (`scan`) | Algolia API, latest thread. |
| Reddit | server (`scan`) + extension (`scan-reddit`) | Server uses RSS; extension uses your session. |
| X | extension (`scan-x`) | Real search tabs in your logged-in Chrome. Rate limits apply. |
| Any posting you open | built-in engine (or Browsy) (`capture`) | Snapshot → editable capture → import. |

## Troubleshooting

- **Connections shows a tool "not found"** → install/locate it, or set
  `JOBPILOT_BROWSY_CLI` / `JOBPILOT_CLINQY_BIN` to the executable path.
- **MCP browser tools say the extension is offline** → load `extension/` in
  Chrome (`chrome://extensions` → Developer mode → Load unpacked) and keep
  Chrome running. Job search/DB tools still work without it.
- **The agent doesn't list jobpilot** → check the client config, then restart the
  agent session. `node server/mcp.js` must stay stdout-clean; diagnostics go to
  stderr.
- **Extension shows offline** → the server isn't running (`node server/cli.js
  serve`), or the extension isn't loaded.
- **X scan fails "not logged in"** → open x.com in Chrome and log in.
- **Reddit scan HTTP 403** → Reddit blocks datacenter IPs; the RSS path is the
  fallback.
- **Autofill says "review N"** → those fields have no matching answer; add a
  pattern to `answers` in `config.json`.
- **Port clash** → change `port` in `config.json` or set `JOBPILOT_PORT`.

## Files

```
jobpilot/
  config.json           your profile/targets (gitignored once you edit it)
  companies.json        board tokens to poll
  docs/capabilities.md  honest capability map + native limitations
  docs/mcp.md           MCP server reference: tools, setup, safety
  skills/jobpilot/      agent skill (when-to-use + workflow)
  server/
    mcp.js              Job Pilot's own MCP server (stdio, 46 tools)
    http.js             API + dashboard server, /ext/* routes, all CRUD
    cli.js              the CLI
    adapters.js         external Browsy + Clinqy adapters, schemas, capabilities
    browser-local.js    built-in browser engine adapter (Browsy tool surface)
    mcp-client.js       bounded stdio JSON-RPC client (timeouts, cleanup)
    eligibility.js      shared eligibility gate (served to the browser too)
    criteria.js         editable candidate criteria defaults
    capture.js          snapshot → editable job-field extraction
    research.js         research query builder (careers/LinkedIn/Indeed/Unstop)
    exporters.js        CSV (formula-injection safe) / JSON / brief builder
    db.js               SQLite — jobs, captures, companies, contacts, pipeline, research, memories, workflows, audit
    normalize.js        title/company/location/salary/apply-link extraction
    scoring.js          the 0–100 fit score
    sources/            greenhouse · lever · ashby · remoteok · hn · reddit(rss)
    commands.js         command queue the extension long-polls
    dashboard.html      the UI (5 sections)
  extension/
    manifest.json       MV3
    background.js       poll loop, scan_x / scan_reddit / fill, 17 browser tools
    content/browser.js  in-page snapshot/refs/click/type engine
    content/ats.js      form matching + filling + review bar
    popup.html/.js      status, quick scans, "fill this page"
  tests/                eligibility · end-to-end · MCP fixtures
  data/jobpilot.db      all your data (SQLite, gitignored)
```

## Tests

```bash
node --test tests/*.test.mjs
```

Covers the eligibility gate (observed failure cases), capture → import →
company/contact link → brief → pipeline → export, CSV formula-injection
escaping, mutation content-type/body-size rejection, cross-origin rejection,
Browsy argument validation, unknown-tool rejection, MCP client timeout / crash /
spawn-failure behaviour, and the Job Pilot MCP server end to end (initialize,
tools/list, jobs, browser tools, confirmation gates, memory, workflow
record/replay) against a simulated extension.
