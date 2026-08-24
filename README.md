# Nekyia

## What it does

Every agent CLI keeps its history somewhere different. I built Nekyia so you can search those histories at once, see the work from your current directory, and resume the right session when the client supports exact resume. For a search-tier client, Nekyia starts a fresh session with a deterministic brief and labels it as briefed, never resumed.

## Install

Nekyia requires [Bun](https://bun.sh/) 1.1 or newer.

```sh
bun install -g nekyia
```

This installs both `nekyia` and the shorter `nek` command.

## Use

```sh
nekyia                     # open the interactive picker
nekyia search reconnect    # search without the picker
nekyia last                # launch the latest session in this directory
nekyia index               # refresh the local index
nekyia doctor              # inspect clients, stores, and parse problems
```

In the picker:

| Key | Action |
|---|---|
| Type | Search indexed session text |
| Up and down | Move through results |
| Enter | Resume, or confirm a new briefed session |
| Tab | Switch between this directory and everywhere |
| Ctrl+F | Cycle the client filter |
| Ctrl+P | Copy the first indexed prompt |
| Ctrl+Y | Copy the resume command when one exists |
| Escape | Cancel or quit |

`nekyia search <query>` accepts `--client`, `--file`, `--sort`, `--all`, `--limit`, and `--json`. Run `nekyia --help` for the complete command list.

## Supported clients

The table reflects the tier that actually ships. Resume means the command can attach to the selected session by ID. Search means Nekyia starts the client fresh with an indexed handover, because exact attachment was not confirmed. Support here means the client store was installed and tested, not guessed from a likely path. Kilo shares opencode's tested store format, but its executable was not installed during command verification, so I do not claim exact resume for it.

| Client | Tier | Command Nekyia runs |
|---|---|---|
| Claude Code | Resume | `claude --resume <id>` |
| Codex | Resume | `codex resume <id>` |
| Antigravity CLI, agy | Resume | `agy --conversation <id>` |
| opencode | Search | `opencode <brief>` |
| Kilo Code | Search | `kilo <brief>` |
| Codebuff / freebuff | Search | `codebuff --cwd <cwd> <brief>` |

Search-tier clients always start fresh briefed sessions. They do not recover tool state or file snapshots, and sending the brief can cost tokens. I only promote a client to resume after I can verify attachment to the requested ID. See the [roadmap](#roadmap) for clients that still need hands-on verification.

## How it works

The first phase discovers cheap metadata and fingerprints without loading whole transcripts. The second phase hydrates only new or changed sessions into a local SQLite FTS index. Nekyia indexes your prompts and selected assistant prose, but excludes tool output because file dumps and command results are noisy, large, and can contain unrelated private data.

## Privacy

Nekyia makes no network requests. There is no network service, no API key, and no telemetry. The deterministic brief uses no model call.

The index reads transcripts that are already on your disk and aggregates their paths and text locally. An indexed copy can survive deletion of the source transcript. Use `nekyia forget <uid>` to purge one indexed session, `nekyia prune --missing` to purge sessions whose sources disappeared, and `nekyia exclude <glob>` followed by `nekyia index --rebuild` to keep matching directories out of the rebuilt index.

Nekyia does not promise secret redaction or index encryption. Review output before you paste it into a public issue.

## Adding a client

User manifests live in `~/.config/nekyia/clients/*.json`. Each manifest uses schema version 1 and describes roots, a storage format, a tier, and the command template. A minimal flat JSONL manifest looks like this:

```json
{
  "schema": 1,
  "id": "my-client",
  "name": "My client",
  "roots": ["~/.local/share/my-client"],
  "format": "jsonl-transcript",
  "tier": "search",
  "jsonl": {
    "glob": "sessions/*.jsonl",
    "variant": "generic",
    "generic": {
      "idFrom": "filename",
      "cwdPath": "cwd",
      "tsPath": "timestamp",
      "rolePath": "role",
      "textPath": "text",
      "userRoles": ["user"],
      "assistantRoles": ["assistant"]
    }
  },
  "brief": {
    "cmd": "my-client",
    "args": ["{prompt}"],
    "cwd": "{cwd}"
  }
}
```

`nekyia doctor --sniff` inspects likely unsupported stores without declaring them supported. `nekyia doctor --sniff --emit-manifest ./my-client.json` writes a non-overwriting draft for the first store it can describe. Inspect and test the draft before moving it into your user manifest directory or contributing it.

## Roadmap

These clients need hands-on testing before I ship a built-in manifest: Aider, Goose, Crush, Cursor CLI, GitHub Copilot CLI, Qwen Code, Continue CLI, Droid, Amazon Q Developer CLI, Plandex, OpenHands, Amp, Warp Agent, Grok CLI, Rovo Dev, Auggie, Trae, Cline CLI, and Zed.

I also plan compiled standalone binaries via `bun build --compile` for Linux and macOS on x64 and arm64. They are not part of this release, so Bun is currently required.

## Licence

Nekyia is available under the [MIT licence](LICENSE).
