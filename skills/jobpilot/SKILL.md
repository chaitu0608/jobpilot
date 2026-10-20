---
name: jobpilot
description: Use Job Pilot when the user wants to search, triage, capture, track, or apply to jobs, or to inspect and operate job postings in their real Chrome session. Covers job discovery, eligibility, application pre-fill (never auto-submit), Clinqy native tasks, local memory, and recorded browser workflows. Requires the jobpilot MCP server.
---

# Job Pilot

Job Pilot is a local-first job-search cockpit exposed through the `jobpilot`
MCP server. It combines Browsy-style browser tools, Clinqy native reach, and a
durable job database on `127.0.0.1:8787`.

## When to use

- “Find me backend roles in Bangalore / remote.”
- “What jobs should I look at today?”
- “Capture this posting / import it / track it.”
- “Fill this application.” (pre-fill only)
- “What’s my status / digest / stats?”
- “Remember that I prefer …”
- “Record this application flow and replay it.”
- “Look at my screen / run a native task.” (Clinqy, gated)

## Workflow

1. **Orient** — call `jobpilot_status`; if the profile is incomplete, tell the
   user to run `node server/cli.js setup` in `~/jobpilot`.
2. **Find** — `jobpilot_list_jobs` (filters, buckets) or `jobpilot_digest`.
   Trigger `jobpilot_scan` / `jobpilot_scan_x` / `jobpilot_scan_reddit` only when
   the user asks for fresh jobs.
3. **Inspect a posting** — `browser_list_tabs` then `browser_snapshot`. Prefer
   snapshots over screenshots.
4. **Capture** — `jobpilot_capture { tabId }`, show the suggested fields, let
   the user correct them, then `jobpilot_import_capture`. Never invent facts.
5. **Prepare** — `jobpilot_apply_packet` then `jobpilot_apply` (fills the form
   and stops). Or `browser_type` for individual fields.
6. **Human submits** — never submit, send, pay or delete. Show the review bar
   and ask the user to review and click Submit.
7. **Record the outcome** — `jobpilot_set_status` only after the user confirms
   what actually happened.
8. **Remember** — use `memory_remember` for enduring preferences, and
   `memory_recall` at the start of later sessions.

## Safety rules (hard)

- Mutating browser tools require `confirmed: true`, and only after the user
  approved the specific action in chat.
- Submit-like clicks return `needsApproval`; ask again and retry with
  `approved: true` only after a second explicit approval.
- `clinqy_run` can control any Mac app: require `confirmed: true`; prefer
  `dry: true` first.
- Never type passwords, payment details, government IDs or captcha answers.
  Skip demographic questions.
- After an unknown browser outcome, take a fresh `browser_snapshot` before
  retrying; do not repeat a mutation blind.
- Workflows store typed text locally; warn the user before recording anything
  sensitive.
- Do not auto-apply to LinkedIn/Indeed Easy Apply; use the direct apply link.

## Tool cheat sheet

| Need | Tool |
|---|---|
| Overview | `jobpilot_status` |
| List / filter jobs | `jobpilot_list_jobs` |
| One job | `jobpilot_get_job` |
| Today’s digest | `jobpilot_digest` |
| Scan sources | `jobpilot_scan`, `jobpilot_scan_x`, `jobpilot_scan_reddit` |
| Tabs / page | `browser_list_tabs`, `browser_snapshot`, `browser_get_html` |
| Click / type | `browser_click`, `browser_type` (ref or selector) |
| Capture → import | `jobpilot_capture`, `jobpilot_import_capture` |
| Application | `jobpilot_apply_packet`, `jobpilot_apply`, `jobpilot_fill_current` |
| Status | `jobpilot_set_status` |
| Research | `jobpilot_research_plan`, `jobpilot_research_list` |
| Memory | `memory_remember`, `memory_recall`, `memory_forget` |
| Workflows | `workflow_record_start`, `workflow_record_stop`, `workflow_list`, `workflow_run`, `workflow_delete` |
| Clinqy | `clinqy_look`, `clinqy_stats`, `clinqy_run`, `clinqy_open` |

In OpenCode, MCP tools are called as `tools.jobpilot.<tool_name>` inside the
`execute` tool. In other clients they appear under the `jobpilot` server with
their plain names.

## Notes

- Browser tools need the unpacked extension loaded in Chrome. Job/DB tools do
  not.
- External Browsy is optional; the built-in engine serves the same 17 tools.
- Data stays in `~/jobpilot/data/jobpilot.db` and never leaves the machine.
- Full reference: `~/jobpilot/docs/mcp.md` and
  `~/jobpilot/docs/capabilities.md`.
