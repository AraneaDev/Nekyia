# Recovery census

Measured on 2026-08-30 with `scripts/recovery-census.ts`, over this machine's own
session store: 1049 claude sessions, 97 codex sessions. Counts only. No path, prompt or
file content was read into this document.

A call counts only when its input actually names a file. Codex has always been counted
that way, one `*** ... File:` patch header at a time, and claude is gated the same way, so
the two clients' columns measure the same thing. Calls that name no file at all, `Bash`
most of all, are not operations whose kind went unrecognised; they are calls this census
is not about.

## Kind coverage

How often an operation is knowable from the tool call that names a file.

| client | calls | read | write | edit | delete | unknown |
|---|---|---|---|---|---|---|
| claude | 15894 | 6749 | 1678 | 6961 | 0 | 506 |
| codex | 1988 | 0 | 452 | 1517 | 19 | 0 |

For claude that is 42.5% read, 10.6% write, 43.8% edit and 3.2% unknown.

The unknown bucket is 506 calls across 12 tools, none of whose names suggest a file edit.
They are MCP and utility tools that take a path and do something other than editing with
it, and what any one of them did to the file is opaque to this census by construction,
not by an omission in the `CLAUDE_TOOL_KINDS` map. The tool names are this machine's
installed inventory, so only their shape is reported.

## Byte reconstructibility, by call

How often a call's own input carries content.

| client | whole file | patch against an unverified base | mention only |
|---|---|---|---|
| claude | 1678 | 6961 | 7255 |
| codex | 452 | 1536 | 0 |

**This table reads tool inputs only, and on its own it is misleading about recovery.** A
`Read` names a file in its input and returns the file in its result, so counting inputs
alone files every read under "mention". An earlier version of this document stopped here
and concluded that a recovery command would usually have only a fragment to work with.
That conclusion did not survive looking at the results.

## Per-file coverage

The question a recovery command actually faces is not what share of calls carry content.
It is: for one file that is gone, is there anything to hand back? So this counts one row
per distinct file per session, takes the best evidence found anywhere in that session, and
includes tool results.

`whole` is a `Write` input carrying content, an `apply_patch` `Add File` body, or a `Read`
result whose call asked for no window. `fragment` is a windowed `Read`, an `Edit`'s
old and new strings, or an `apply_patch` `Update` hunk. `none` is a file named by a call
that carries no content either way.

| client | distinct files | whole | fragment | none |
|---|---|---|---|---|
| claude | 7241 | 5199 (71.8%) | 1522 (21.0%) | 520 (7.2%) |
| codex | 656 | 435 (66.3%) | 216 (32.9%) | 5 (0.8%) |

So 92.8% of the files a claude session touched have something recoverable in the
transcript, and 71.8% have a whole copy as of the moment the agent last looked.

## Git overlap

Content git also holds is not worth recovering from a transcript, so the number that
decides whether a recovery command is worth building is how much of this content git does
not have. Asked only of files with whole or fragment evidence.

| client | files with content | tracked by git | untracked | could not check |
|---|---|---|---|---|
| claude | 6721 | 3511 (52.2%) | 2259 (33.6%) | 951 (14.1%) |
| codex | 651 | 581 (89.2%) | 70 (10.8%) | 0 |

Codex work is almost entirely inside git repositories. Claude work is not: a third of the
files it touched with recoverable content are files git cannot give back.

Two limits worth stating rather than hiding. Tracked status is read as of now, not as of
when the session ran, which is the honest cost of measuring after the fact. And a session
whose directory no longer exists counts as "could not check" rather than as untracked,
because guessing there would inflate the one number this decision rests on. Some of those
951 are presumably directories that were themselves deleted, which is the very case a
recovery command exists for.

## What this means

The pessimistic reading of the by-call table does not survive the per-file one. For a
file a claude session touched, there is usually a whole copy in the transcript, and a
third of those files are ones git never had.

That supports a narrow command and not a broad one. What is feasible is returning the last
known contents of a named file, with provenance, newest first. What is not feasible is
reconstructing a working tree by replaying patches against bases nothing can verify, and
the `fragment` column is the reason: for a fifth of claude's files and a third of codex's,
a diff is all there is.

Two caveats bound even the narrow command. Coverage is opportunistic, since only files the
agent actually opened are present at all. And a copy is as of the moment the agent last
read it, so it can be hours stale and competes with an editor's own undo history, which is
often better. A command built on this must say which file, from which session, at which
turn, and never imply the result is current.
