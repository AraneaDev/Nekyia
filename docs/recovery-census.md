# Recovery census

Measured on 2026-08-30 with `scripts/recovery-census.ts`, over this machine's own
session store: 1029 claude sessions, 97 codex sessions. Counts only. No path, prompt or
file content was read into this document.

## Kind coverage

How often an operation is knowable from the tool call that names a file.

| client | calls | read | write | edit | unknown |
|---|---|---|---|---|---|
| claude | 62360 | 6673 | 1650 | 6870 | 47167 |
| codex | 1988 | 0 | 452 | 1517 | 0 |

Tools dominating the unknown bucket (claude only; codex has no unknown bucket): Bash
42516, Agent 909, mcp__chaos__audit_code_resilience 322, AskUserQuestion 296,
ToolSearch 285, TaskUpdate 239, WebFetch 232,
mcp__plugin_context-mode_context-mode__ctx_execute 212, WebSearch 211, SendMessage 210.
None of these is a file-editing tool the current `CLAUDE_TOOL_KINDS` map is missing;
`Bash` alone accounts for the large majority of the bucket, and a shell command's file
effects are opaque to this census by construction, not by an omission in the map.

Codex also logs 19 `Delete File` operations (1.0% of its calls), a kind this table has
no column for. They are real and counted by the script, just not representable in the
read/write/edit/unknown shape above.

## Byte reconstructibility

How often the pre-edit content of a file is really in the transcript.

| client | whole file | patch against an unverified base | mention only |
|---|---|---|---|
| claude | 1860 | 6870 | 53630 |
| codex | 452 | 1536 | 0 |

## What this means

For claude, the dominant shape is "mention": 86.0% of calls only name a file, with
neither its prior nor its resulting content anywhere in the transcript, so a recovery
command has nothing to hand back for the great majority of operations it could even
list. For codex, the dominant shape is "patch" at 77.3%: even where the kind is known,
what the transcript holds is a diff against a base state the census never sees, not the
file as it stood before the edit. Between the two clients, patch-against-an-unverified-
base and mention-only together dwarf whole-file capture, so a `recover` command has to
ship as an evidence dump of whatever the transcript actually contains, and it must never
use the word restore.
