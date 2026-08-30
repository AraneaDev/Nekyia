# Recovery census

Measured on 2026-08-30 with `scripts/recovery-census.ts`, over this machine's own
session store: 1048 claude sessions, 97 codex sessions. Counts only. No path, prompt or
file content was read into this document.

A call counts only when its input actually names a file. Codex has always been counted
that way, one `*** ... File:` patch header at a time, and claude is now gated the same
way, so the two clients' columns measure the same thing. Calls that name no file at all,
`Bash` most of all, are not operations whose kind went unrecognised; they are calls this
census is not about.

## Kind coverage

How often an operation is knowable from the tool call that names a file.

| client | calls | read | write | edit | unknown |
|---|---|---|---|---|---|
| claude | 15881 | 6747 | 1672 | 6956 | 506 |
| codex | 1988 | 0 | 452 | 1517 | 0 |

For claude that is 42.5% read, 10.5% write, 43.8% edit and 3.2% unknown.

Tools dominating the unknown bucket (claude only; codex has no unknown bucket):
mcp__chaos__audit_code_resilience 322, mcp__chaos-mcp__audit_code_resilience 65,
mcp__chaos__estimate_audit 52, mcp__knossos__scan_project 41,
mcp__chaos-mcp__estimate_audit 10, Artifact 7,
mcp__plugin_context-mode_context-mode__ctx_execute_file 3, StructuredOutput 2,
mcp__argos__sql_add_database 1, mcp__argos__sql_update_database 1. None of these is a
file-editing tool the current `CLAUDE_TOOL_KINDS` map is missing. The bucket is MCP
tools that take a path as an argument and do something other than editing with it, and
what any one of them did to the file is opaque to this census by construction, not by an
omission in the map.

Codex also logs 19 `Delete File` operations (1.0% of its calls), a kind this table has
no column for. They are real and counted by the script, just not representable in the
read/write/edit/unknown shape above.

## Byte reconstructibility

How often the pre-edit content of a file is really in the transcript.

| client | whole file | patch against an unverified base | mention only |
|---|---|---|---|
| claude | 1672 | 6956 | 7253 |
| codex | 452 | 1536 | 0 |

## What this means

For claude, the largest single shape is "mention" at 45.7%, just ahead of "patch" at
43.8%, with whole-file capture at 10.5%. Nearly all of that mention bucket is `Read`:
the transcript records that a file was opened and nothing about what was in it. For
codex, the dominant shape is "patch" at 77.3%: even where the kind is known, what the
transcript holds is a diff against a base state the census never sees, not the file as
it stood before the edit.

Between the two clients, patch-against-an-unverified-base and mention-only together come
to 89.5% of claude's calls and 77.3% of codex's, dwarfing whole-file capture either way.
So a `recover` command has to ship as an evidence dump of whatever the transcript
actually contains, and it must never use the word restore.
