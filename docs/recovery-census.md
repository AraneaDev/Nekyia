# Recovery census

Measured on 2026-08-30 with `scripts/recovery-census.ts`, over this machine's own
session store: 1049 claude sessions, 97 codex sessions. Counts only. No path, prompt or
file content was read into this document.

**This is one developer's machine, and an atypical one.** The store belongs to the author
of this tool, whose work is spread across scratch directories, throwaway worktrees, plans
and notes that live outside any repository, which is not how most of this tool's users
work. Every percentage below describes that store and nothing wider. Read them as a
demonstration that the script measures what it claims to, and as a rough sense of the
shape, never as a population figure. The script is here so anyone can run it against their
own store and get numbers that actually apply to them.

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

This table is the least trustworthy one here, and it errs in both directions at once.

It overstates the gap, because this store is unusually full of work outside repositories,
and because `git ls-files` does not list ignored files, so a build artifact or a log counts
as untracked exactly like a lost source file would. It understates the gap, because
"tracked" means git knows the file, not that git holds the version that was lost: a
tracked file with hours of uncommitted work has a stale copy in git and its recent state
only in the transcript. Neither error can be separated out from a single machine.

The "could not check" column is directories that no longer exist or were never
repositories. On this machine many are throwaway worktrees, which is housekeeping rather
than loss.

## What this measures, and what it does not

The pessimistic reading of the by-call table does not survive the per-file one. For a file
a claude session on this machine touched, there is usually a whole copy in the transcript.
That much is a fact about transcripts rather than about this store, because it follows
from what the tools record: a read returns the file it was given.

The rest does not generalise. How much of that content git already holds depends entirely
on how a given person works, and one developer's ratio says nothing about anyone else's.
This document deliberately stops short of concluding that a recovery command is or is not
worth building, because that conclusion needs a population this census does not have.

What the numbers do bound is the shape such a command could take. Returning the last known
contents of a named file, with provenance, is supported by the `whole` column. Reconstructing
a working tree by replaying patches against bases nothing can verify is not, and the
`fragment` column is the reason: for a fifth of claude's files here and a third of codex's,
a diff is all there is.

Two caveats hold whoever is measured. Coverage is opportunistic, since only files the agent
actually opened are present at all. And a copy is as of the moment the agent last read it,
so it can be hours stale and competes with an editor's own undo history, which is often
better. Anything built on this must say which file, from which session, at which turn, and
never imply the result is current.
