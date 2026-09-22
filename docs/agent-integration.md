# Agent integration

Nekyia can provide historical context to another coding agent without making a
model call itself. The recommended workflow is search, inspect, then hand off
only after checking the result's quality state. This document describes the
stable, versioned machine-readable interface; for the human-facing CLI workflow,
see the handoff section in the [README](../README.md).

## Search

```bash
nek search "tenant retry budget" --json
```

The result is a JSON array. Every row contains `contractVersion: 1`, a stable
`uid`, the client and native session id, ranking fields, source paths, launch
capability, and a `quality` object. Branch on fields and limitation codes, not
on human-readable messages:

```json
{
  "contractVersion": 1,
  "uid": "claude:session-id",
  "capability": "resume",
  "quality": {
    "missing": false,
    "truncated": false,
    "degraded": false,
    "fileDetail": "ordered",
    "eventsTruncated": false
  },
  "limitations": []
}
```

Important limitation codes include:

- `source-missing`: the original transcript is gone, but the indexed copy remains;
- `content-truncated`: the configured size cap stopped extraction;
- `content-degraded`: parsing or reading lost part of the source;
- `file-events-unordered`: only file paths, not operation order, are known;
- `file-events-truncated`: the event ceiling stopped the operation log;
- `not-launchable`: the store was detected but no verified launch is available.

## Structured context

Once a UID is selected, request structured indexed context:

```bash
nek show claude:session-id --json --max-chars 12000
```

The response contains prompts, assistant prose, ordered dialogue when the index
has it, file paths, ordered file events, provenance, quality, and limitations.
User prompts are retained when possible even when the character budget is too
small for assistant prose. A limitation is emitted when content is removed by
the budget.

This is historical evidence, not a resumed native session. It does not contain
tool output, file snapshots, or native tool state. The current repository and
current instructions take precedence over it.

## Handoff

Preview a fresh target session before launching it:

```bash
nek handoff claude:session-id --to codex --dry-run --json --max-chars 12000
```

The handoff remains deterministic and model-free in Nekyia. The target client
may send the resulting prompt to its configured model provider, so prompts and
paths in the output are sensitive data and may incur token costs.

## Errors

Commands that support JSON return one bounded object for command-level errors:

```json
{
  "version": 1,
  "error": {
    "code": "session-not-found",
    "message": "no session with uid claude:session-id"
  }
}
```

Exit status still distinguishes success (`0`), runtime failure (`1`), and
invalid arguments (`2`). Keep stdout reserved for the JSON document. A command
that does not support JSON keeps its normal human-readable diagnostics.

## Compatibility and privacy

Check `contractVersion` before consuming fields. New fields are additive within
version 1; a future incompatible shape will increment the version. Do not paste
JSON output into public bug reports without reviewing prompts, paths, and source
provenance first.
