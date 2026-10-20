# Job Pilot MCP server

Job Pilot exposes its whole cockpit as **one local MCP server**. It merges the
browser surface Job Pilot learned from Browsy, the native reach it proxies from
Clinqy, and the job workflow that is unique to this app.

```
MCP client (OpenCode · Claude Code · Codex · Cursor …)
        │  stdio JSON-RPC 2.0 (newline-delimited)
        ▼
server/mcp.js ── HTTP ── server/http.js (127.0.0.1:8787, SQLite)
                                  │
                  ┌───────────────┼────────────────┐
                  ▼               ▼                ▼
        built-in browser     Clinqy app       external Browsy
        extension (17 tools) (3 tools)        (optional, 17 tools)
```

- The HTTP server **auto-starts** on the first MCP call if it is not running.
- `stdout` is reserved for JSON-RPC; all diagnostics go to `stderr`.
- No SDK, no npm dependencies, no network egress.

---

## Register it

### OpenCode

```bash
opencode mcp add --global jobpilot -- node "$HOME/jobpilot/server/mcp.js"
# restart the OpenCode session
```

Or add the equivalent block to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "jobpilot": {
        "type": "local",
        "command": ["/absolute/path/to/node", "/Users/you/jobpilot/server/mcp.js"],
        "enabled": true
      }
    }
  }
}
```

### Claude Desktop / Claude Code / Codex / Cursor

Most clients accept:

```json
{
  "mcpServers": {
    "jobpilot": {
      "command": "node",
      "args": ["/Users/you/jobpilot/server/mcp.js"],
      "env": { "JOBPILOT_PORT": "8787" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add jobpilot -- node "$HOME/jobpilot/server/mcp.js"
```

### Run it directly

```bash
node server/cli.js mcp            # print setup + live status
node server/cli.js mcp --stdio    # run the stdio server
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `JOBPILOT_PORT` | `8787` | Loopback HTTP server port |
| `JOBPILOT_DB` | `data/jobpilot.db` | SQLite path used by the server it starts |
| `JOBPILOT_BROWSY_CLI` | `browsy` on PATH | External Browsy CLI (dashboard/capture only) |
| `JOBPILOT_CLINQY_BIN` | `/Applications/Clinqy.app/Contents/MacOS/Clinqy` | Clinqy binary |

---

## Protocol

| Item | Value |
|---|---|
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Protocol versions | `2025-06-18`, `2025-03-26`, `2024-11-05` |
| Methods | `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list` |
| Server info | name `jobpilot`, title `Job Pilot`, version `0.2.0` |
| Resources | `jobpilot://status`, `jobpilot://capabilities` |

Tool results use MCP content blocks. Screenshots add an `image` block with
`mimeType: image/jpeg` (downscaled) and a text caption. Failures set
`isError: true` with a readable message.

---

## Tools

### `jobpilot_*` — the job cockpit (17)

| Tool | Key arguments | Behavior |
|---|---|---|
| `jobpilot_status` | — | Counts, buckets, pipeline, connections, profile/resume readiness, auto-submit state |
| `jobpilot_scan` | `sources?` | Server-side scan: boards, HN, Reddit RSS, RemoteOK, individual ATS |
| `jobpilot_scan_x` | `queries?`, `accounts?`, `maxScrolls?` | X scan in the real Chrome session (extension) |
| `jobpilot_scan_reddit` | `subs?` | Reddit scan through the extension session |
| `jobpilot_list_jobs` | `minScore?`, `status?`, `source?`, `q?`, `remote?`, `sinceDays?`, `bucket?`, `limit?`, `offset?` | Filtered rows with eligibility |
| `jobpilot_get_job` | `id` | Full detail, reasons, description, notes, timeline, URL |
| `jobpilot_set_status` | `id`, `status` | new / saved / in_progress / applied / skipped / archived |
| `jobpilot_digest` | — | Markdown digest |
| `jobpilot_apply_packet` | `id` | Profile + answers + resume availability + URL (read-only) |
| `jobpilot_apply` | `id` | Opens and pre-fills; **never submits**; waits for the fill report |
| `jobpilot_fill_current` | — | Pre-fills the active tab; **never submits** |
| `jobpilot_capture` | `tabId` | Snapshot → editable capture suggestions |
| `jobpilot_import_capture` | `fields`, `captureId?` | Import reviewed fields (title required) |
| `jobpilot_rescore` | — | Re-score all jobs against current criteria |
| `jobpilot_research_plan` | `city?`, `role?`, `employer?`, `sites?`, `query?` | Create research run + steps |
| `jobpilot_research_list` | — | List research runs |
| `jobpilot_brief` | `id` | Read the factual per-job brief |

### `browser_*` — Browsy’s surface, built in (17)

`browser_list_tabs`, `browser_open_tab`, `browser_focus_tab`,
`browser_close_tab`, `browser_snapshot`, `browser_get_html`,
`browser_screenshot`, `browser_click`, `browser_type`, `browser_press_key`,
`browser_scroll`, `browser_navigate`, `browser_back`, `browser_forward`,
`browser_reload`, `browser_wait`, `browser_release`.

Built-in extensions over Browsy:

- `browser_click` / `browser_type` accept a CSS **`selector`** as an alternative
  to an ephemeral `ref` (useful for replay).
- `browser_click` accepts **`approved: true`** for submit/send/pay/delete
  controls.
- `browser_open_tab` accepts **`active: true`**.

Required flow:

```text
browser_list_tabs
  → browser_snapshot { tabId }        # refs e1…eN
  → browser_click { tabId, ref, confirmed: true }
  → browser_type  { tabId, ref, text, confirmed: true }
```

Refs expire on navigation and on the next snapshot. Unknown outcomes latch the
tab until a fresh snapshot.

### `clinqy_*` — the real macOS app (4)

| Tool | Gating |
|---|---|
| `clinqy_look { mode? }` | read-only |
| `clinqy_stats { days?, last? }` | read-only |
| `clinqy_run { task, dry?, timeout?, confirmed }` | `confirmed: true` required; `dry: true` previews |
| `clinqy_open { target }` | fixed `clinqy://` allowlist only |

### `memory_*` — durable local facts (3)

`memory_remember { text, tags? }`, `memory_recall { query?, limit? }`,
`memory_forget { id }`. Stored in SQLite; never synced.

### `workflow_*` — record and replay (5)

| Tool | Behavior |
|---|---|
| `workflow_record_start { name }` | Begin capturing browser actions |
| `workflow_record_stop` | Save steps to SQLite |
| `workflow_list` | List names + step counts |
| `workflow_run { name, dryRun?, approved?, confirmed? }` | Preview or replay |
| `workflow_delete { name }` | Delete by name |

Recorded click/type steps store the resolved **selector**, not the ref. Typed
text is stored locally — avoid secrets. Replay requires `confirmed: true`, and
submit-like clicks still require `approved: true`.

---

## Approval lifecycle

1. **Agent asks the user** (in chat) before any mutation.
2. The user approves.
3. The agent calls the tool with `confirmed: true`.
4. For submit/send/pay/delete controls, the engine returns `needsApproval`
   *without clicking*; the agent shows the target and asks again.
5. The user approves; the agent retries with `approved: true`.
6. The user reviews the form and clicks Submit in Chrome. Job Pilot never does.

Example:

```jsonc
// 1. inspect
{ "name": "browser_snapshot", "arguments": { "tabId": 7 } }

// 2. fill (mutation)
{ "name": "browser_type", "arguments": { "tabId": 7, "ref": "e4", "text": "…", "confirmed": true } }

// 3. submit button: refused first
{ "name": "browser_click", "arguments": { "tabId": 7, "ref": "e9", "confirmed": true } }
// → isError, needsApproval, target selector

// 4. only after a second explicit approval
{ "name": "browser_click", "arguments": { "tabId": 7, "ref": "e9", "confirmed": true, "approved": true } }
```

The safest application path is `jobpilot_apply`, which only pre-fills and stops
at the review bar.

---

## Failure behavior

| Situation | Result |
|---|---|
| Extension not loaded | clear `extension offline` error; non-browser tools still work |
| External Browsy not installed | dashboard/capture fall back to the built-in engine |
| Clinqy not installed | `clinqy_*` tools return a clean unavailable error |
| Browser command timeout | `unknownOutcome`; tab latched until a fresh snapshot |
| Invalid args | 400 / tool error with the schema message; no action taken |
| Local server down | MCP auto-starts it; if that fails, a clear startup error |

---

## Troubleshooting

- **Tools don’t appear in the agent** → validate the command path, restart the
  session, and check the client’s MCP logs. `node server/mcp.js` should print
  one startup line to stderr and then wait on stdin.
- **`browser_*` offline** → open `chrome://extensions`, enable Developer mode,
  Load unpacked → `~/jobpilot/extension`, keep Chrome running.
- **Port already in use** → set `JOBPILOT_PORT` in both the agent config and the
  server environment, or change `port` in `config.json`.
- **Clinqy tools fail** → open `/Applications/Clinqy.app` once, grant the
  requested macOS permissions, then retry `clinqy_stats`.
- **Workflow replay fails mid-way** → the message names the failing step; take a
  fresh snapshot, update the workflow, or record it again.

---

## Security

- Loopback-only HTTP server, loopback `Host` checks, cross-origin rejection.
- Mutating HTTP requests require `application/json` and are size-limited.
- Browser text is never sent off-device; screenshots stay in the MCP response.
- Audit entries redact typed text and secrets.
- The extension accepts commands only from `http://127.0.0.1:8787`.
- No auto-submit, no auto-outreach, no background native tasks.
