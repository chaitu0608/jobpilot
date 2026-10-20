# Capabilities & local integrations

This document is the honest, current map of what Job Pilot can do. It separates
**what really works now** from **what is only reachable through the native
apps** and from **what is deliberately not done**. When a capability is not
available, the app says so instead of pretending.

- MCP server: `node server/mcp.js` (stdio JSON-RPC 2.0, 46 tools).
- HTTP server: `127.0.0.1:8787` (loopback only). Override with `JOBPILOT_PORT`.
- Storage: SQLite at `data/jobpilot.db` (override with `JOBPILOT_DB`).
- No API keys, no cloud, no npm runtime dependencies, no auto-submit, no
  auto-outreach.

---

## 1. Job Pilot MCP server — the merged surface

Job Pilot is itself an MCP server. Any stdio MCP client gets one coherent tool
set instead of stitching three servers together.

| Item | Value |
|---|---|
| Entry point | `server/mcp.js` (`node server/cli.js mcp --stdio` also works) |
| Transport | newline-delimited JSON-RPC 2.0 over stdio |
| Protocol versions | `2025-06-18`, `2025-03-26`, `2024-11-05` |
| Tools | **46** |
| Resources | `jobpilot://status`, `jobpilot://capabilities` |
| Backend | auto-starts `server/http.js` on `127.0.0.1:8787` if needed |
| stdout | JSON-RPC frames only; all logs go to stderr |

**Tool groups**

| Prefix | Count | Contents |
|---|---:|---|
| `jobpilot_` | 17 | status, scan, scan_x, scan_reddit, list_jobs, get_job, set_status, digest, apply_packet, apply, fill_current, capture, import_capture, rescore, research_plan, research_list, brief |
| `browser_` | 17 | Browsy’s surface, served by the built-in extension engine |
| `clinqy_` | 4 | look, stats, gated run, fixed native handoff |
| `memory_` | 3 | remember, recall, forget |
| `workflow_` | 5 | record_start, record_stop, list, run, delete |

**Protocol behavior**

- `initialize` negotiates a supported protocol version, advertises `tools`,
  `resources`, `prompts` and `logging`, and returns safety instructions.
- `tools/list` includes annotations (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) so clients can reason about risk.
- `tools/call` errors are returned as MCP tool errors (`isError: true`) with a
  readable message; unknown tools are JSON-RPC `-32602`.
- Notifications are accepted (`notifications/initialized`,
  `notifications/cancelled`); batch requests are handled in order so browser
  actions never race.
- The server exits cleanly on stdin close, after in-flight work finishes.

**Safety gates in the MCP layer**

- Browser mutations require `confirmed: true`.
- The built-in engine refuses submit/send/pay/delete clicks unless
  `approved: true` is also set.
- `clinqy_run` requires `confirmed: true` and supports `dry: true`.
- `jobpilot_apply` and `jobpilot_fill_current` only pre-fill; they never submit.
- Unknown mutation outcomes latch the tab until a fresh `browser_snapshot`.

---

## 2. Built-in browser engine — Browsy’s surface, our extension

The 17 `browser_*` MCP tools are implemented end to end by the Job Pilot Chrome
extension. No Browsy installation and no native-messaging bridge are needed.

| Item | Value |
|---|---|
| Transport | server → extension command queue (`/ext/poll` long-poll), result via `/ext/result` |
| Engine | MV3 service worker + `content/browser.js` injected on demand |
| Tools | 17 (the full Browsy inventory) |
| Snapshot | headings + visible interactive elements with short-lived `eN` refs + page text |
| Extras | CSS `selector` targeting, `approved` gate for consequential clicks, `active` flag on open |

**How it works**

1. `browser_list_tabs` lists real tabs.
2. `browser_snapshot` assigns refs (`e12`…) to visible interactive elements,
   plus headings and a page-text excerpt.
3. `browser_click` / `browser_type` / `browser_press_key` / `browser_scroll`
   act on a ref, selector, or coordinates.
4. `browser_screenshot` activates the tab and returns a downscaled JPEG as MCP
   image content.
5. Refs die on navigation and on the next snapshot; take a fresh snapshot.

**Mutation handling**

- Mutating tools are validated and require `confirmed: true` at the MCP/HTTP
  layer.
- Consequential in-page controls (submit, send, pay, purchase, delete, “apply
  now”) return `needsApproval` and **do not click** until `approved: true`.
- A timeout or dropped result is an **unknown outcome**: the tab is latched and
  no further mutation is allowed until a fresh snapshot clears it.
- Calls are audited (`adapter=extension`) with masked text and no page content.

### Capture flow (no submit)

1. `GET /api/browsy/tabs` (or MCP `browser_list_tabs`) lists open tabs.
2. Capture uses external Browsy when installed, otherwise the built-in engine.
3. `POST /api/browsy/capture { tabId }` stores a **capture** with method
   `browsy-snapshot` or `extension-snapshot` and extracts editable suggestions
   (title/company/location/type/salary/deadline).
4. You review/edit, then `POST /api/captures/import` creates a job with
   provenance + eligibility.

---

## 3. External Browsy — real local MCP server (optional)

When installed, the real Browsy server is used for the dashboard, CLI, research
and capture routes. It is preferred over the built-in engine for those flows.

| Item | Value |
|---|---|
| Executable | resolved from `PATH` (`browsy`); override with `JOBPILOT_BROWSY_CLI` |
| Args | `node <browsy-cli> mcp --home <HOME>` (fixed, no shell interpolation) |
| Home | `~/.agent-native`; override with `JOBPILOT_BROWSY_HOME` |
| Protocol | newline-delimited JSON-RPC 2.0, `2025-06-18` |
| Observed server | name `agent-native-browser`, version `0.1.2` |
| Tools | 17 |
| Routes | `/api/browsy/tabs`, `/api/browsy/call`, `/api/browsy/capture` |

The routes fall back to the built-in engine if Browsy is unavailable or fails,
and report `engine: "browsy" | "extension"` in responses. Browsy mutations go
through preview + explicit confirmation; unknown outcomes latch the tab.

Live check performed: connection, `tools/list`, and read-only tab listing.
Browser mutations are used only when a human asks for them.

---

## 4. Clinqy — real local native app

Job Pilot talks to the **real local Clinqy** native app over the same bounded
stdio JSON-RPC transport. Its `initialize` / `tools/list` handshake does **not**
launch the GUI, so discovery is safe and read-only.

| Item | Value |
|---|---|
| Executable | `/Applications/Clinqy.app/Contents/MacOS/Clinqy`; override with `JOBPILOT_CLINQY_BIN` |
| Args | `mcp` (fixed) |
| Observed server | name `clinqy`, version `0.2.0` |
| Tools | 3: `clinqy_run`, `clinqy_look`, `clinqy_stats` |

**Truthful capability map** (also served at `GET /api/connections` as
`clinqyCapabilities`):

| Capability | State | How it is reached |
|---|---|---|
| Look at the screen | native tool | `clinqy_look` (mode `page` / `read` / `url`) |
| Run statistics | native tool | `clinqy_stats` (`days`, `last`) |
| Run a native task | native tool (gated) | `clinqy_run` — preview + dry-run + explicit confirm |
| Voice (push-to-talk) | **native app only** | Clinqy menu bar — no MCP tool |
| Watch & learn (native) | native handoff | `clinqy://watch` opens the recorder |
| Native workflows / skills | native handoff | `clinqy://workflow` |
| Clinqy memories | **native app only** | Clinqy app — not an MCP tool |
| Calendar & reminders | via native task | `clinqy_run`, e.g. “add a reminder” |
| Files (search / organise) | via native task | `clinqy_run` |
| Browser page context | via `clinqy_look` | browser tabs when the Clinqy extension is connected |

**Gating rules**

- `clinqy_run` requires the task text, a preview, an optional dry-run, and
  `confirmed: true`. Without confirmation the server returns 400.
- Native tasks are **never executed automatically** by the dev workflow.
- A running task can be cancelled (`POST /api/clinqy/cancel` →
  `notifications/cancelled`), bounded by a timeout.
- Native-only features use a **fixed `clinqy://` handoff** from an allowlist
  (`clinqy://open`, `clinqy://watch`, `clinqy://stop-watching`,
  `clinqy://workflow`, `clinqy://browser`, `clinqy://reload-extension`). No
  arbitrary URL or shell command is ever opened.

Live check performed: capability discovery plus a read-only `clinqy_stats`
(`last: true`) call. No native action task was run.

---

## 5. Local memory and learnable workflows (Clinqy-inspired, ours)

Clinqy’s watch-and-learn is native-only; Job Pilot ships a **browser-side**
equivalent plus a durable memory store. Both live in the same SQLite database.

**Memory**

- `memory_remember { text, tags }`, `memory_recall { query, limit }`,
  `memory_forget { id }`.
- Retrieved by agents at the start of a session and injected by the user as
  context. This is not Clinqy’s in-app memory; it is Job Pilot’s own store.

**Workflows**

- `workflow_record_start { name }` starts recording browser actions.
- Successful `browser_click`, `browser_type`, `browser_navigate`,
  `browser_open_tab`, `browser_press_key`, `browser_scroll`, `browser_wait`,
  `browser_reload`, `browser_back`, `browser_forward` calls are captured.
- Click/type steps record the **resolved CSS selector**, not the ephemeral ref,
  so they can replay after navigation.
- `workflow_record_stop` saves the steps; `workflow_run` replays them in the
  active tab (or a tab the workflow opens). `dryRun: true` previews.
- Replay requires `confirmed: true`. Submit-like clicks still require
  `approved: true`; an unapproved one stops the replay with a clear message.
- Typed text **is stored locally**. Do not record passwords, tokens or payment
  details.
- Selectors can break when a site changes; replay reports the failing step
  instead of guessing.

---

## 6. Durable job workflow (local, in-app CRUD)

```
capture (built-in engine or Browsy snapshot)
   → review & edit fields  (before import)
   → import as job + provenance
   → assess eligibility
   → link / create company + contact (public source + verification)
   → editable factual brief
   → track next action / date / status
   → export CSV / JSON + per-job Markdown
```

- All CRUD is real and local (SQLite). Nothing is published, registered or sent.
- CSV export escapes spreadsheet formula injection (`= + - @` prefixed cells).
- Exports: `/api/export/jobs.{csv,json}`, `/api/export/pipeline.{csv,json}`,
  `/api/export/companies.csv`, `/api/export/contacts.csv`, and
  `/api/jobs/:id/brief.md`.

### Eligibility (computed on read, never destructively stored)

Eligibility is a pure, dependency-free module (`server/eligibility.js`) shared
with the browser at `/eligibility.js` (importing `/criteria.js`), so the server
and UI agree. It is **computed when read**, so editing criteria changes verdicts
without any rescoring pass over the 1,300+ existing records.

Rules, in order:

1. **Gate before ranking** — senior/staff/principal/manager/director/head/VP/
   chief/architect titles, PhD/doctorate roles, incompatible required
   experience, explicit non-India restrictions, and closed/past-deadline
   postings are **excluded**.
2. **Remote is never auto-eligible** — remote without an explicit India or
   worldwide statement is **UNKNOWN → needs review**.
3. **Title-first role family** — TA specialist / technical writer / designer
   are never promoted to software/data by a description mention.
4. **Pay / duration** are reported only when actually stated.
5. Unknown stays as **review** with visible reasons.

Buckets surfaced everywhere: **captured**, **potentially suitable**,
**needs review**, **excluded**.

---

## 7. Research workspace

Builds official careers / LinkedIn / Indeed / Unstop queries and opens them
through the browser engine (external Browsy when available). Runs and steps are
stored with checkpoints; a run can be stopped and only safe unfinished steps
resumed. Queries open pages — they do not scrape or submit.

---

## 8. Security posture

- Binds `127.0.0.1` only; loopback `Host` values only (DNS-rebinding defense).
- Cross-origin web requests are rejected before handlers run.
- Mutations require `application/json` and are body-size limited (2 MiB).
- Tool names/arguments are validated against the declared schemas.
- MCP stdio keeps stdout clean; diagnostics and credentials never appear in
  frames. Adapter audit entries redact secrets (typed text, codes).
- Credentials, private config and arbitrary paths are never served.
- External links are restricted to `http`/`https`.
- Native handoff uses only the fixed installed-app scheme allowlist.
- The extension requests `<all_urls>` so the browser tools can act on arbitrary
  postings; it only accepts commands from the loopback server and sends page
  data nowhere else.

---

## 9. Not done (by design) — remaining limitations

- No automatic application **submission** and no automated **outreach**.
- No external publishing, registration, or Google Sheets access; imports are
  paste/CSV only.
- The built-in browser engine requires the unpacked extension and a running
  Chrome. Without it, job/DB tools still work but `browser_*` tools report
  offline (external Browsy is a separate MCP server).
- Clinqy native action tasks (voice, in-app memories, native watch) are
  reachable only through the native app / fixed handoff — Job Pilot never drives
  them automatically.
- Browsy mutations are preview-and-confirm only; after an unknown outcome a
  fresh snapshot is required before repeating.
- Browser screenshots are the visible viewport, downscaled; clicks at
  coordinates use synthetic events and may not work on canvas-heavy apps.
- Learned workflows replay selectors, not vision; they break when a site’s DOM
  changes.
- The app cannot install extensions or change system permissions.
- Eligibility is a conservative, explainable classifier — **not** a guarantee
  of suitability; unknown stays review.
