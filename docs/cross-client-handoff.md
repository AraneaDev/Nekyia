# Cross-client handoff implementation notes

Implemented against `caee428` (0.0.19). This checkout already has `planCli`,
`PlanTarget`, `tui/text.ts`, and `sessions.cycleClient()`: no prerequisite refactor
from the supplied review was needed.

## Contract decisions

- Both CLI and TUI call `buildHandoffPlan`. It rejects native-resume plans, even if
  an adapter returns one when given a brief. Same-client handoff is allowed.
- `buildBrief` is unchanged, including ordered turns, missing-source notices,
  and prompt preservation for impossible or zero character budgets.
- JSON is the implementation plan's `{ cmd, args, cwd, briefChars }` shape and
  requires `--dry-run` at both entry points. It includes the full brief in `args`.
- Dry-run inspects the planned command without requiring the target executable.
  Normal CLI execution closes the read-only database before validation/spawn.
- The TUI offers other adapters with brief templates, independently of whether
  their history roots exist. It captures the source UID when opened. Planning or
  preflight errors keep the target selection available; Escape from confirmation
  returns to that selection, then Escape returns to the session list.
  Compact confirmations scroll with Up/Down or Page Up/Page Down while keeping
  the launch and cancel hints visible.
- The existing launcher remains responsible for executable resolution, inherited
  stdio, signals, and child exit status. Brief launches now have a conservative
  128 KiB UTF-8 argv/environment check and an actionable OS `E2BIG` fallback.
  Prompt text is never shortened to satisfy that transport limit.

## Target template verification

Checked on 2026-09-14. These checks establish CLI argument contracts; they do not
claim a completed provider-backed conversation in every client.

| Target | Fresh interactive command | Evidence |
| --- | --- | --- |
| Claude Code | `claude <brief>` | Installed `claude --help`: positional prompt, interactive by default |
| Codex | `codex <brief>` | Installed `codex --help`: positional prompt, interactive without a subcommand |
| Antigravity | `agy --prompt-interactive <brief>` | Installed `agy --help`: execute an initial prompt interactively and continue |
| Copilot | `copilot --interactive <brief>` | [Official CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference); `--prompt` executes and exits |
| OpenCode | `opencode --prompt <brief>` | [Official TUI CLI reference](https://opencode.ai/docs/cli/); positional argument is a project directory |
| Kilo | `kilo --prompt <brief>` | [Official CLI reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference) |
| Codebuff | `codebuff --cwd <cwd> <brief>` | [CLI parser](https://github.com/CodebuffAI/codebuff/blob/main/cli/src/cli-args.ts) retains positional text as `initialPrompt`; [entry point](https://github.com/CodebuffAI/codebuff/blob/main/cli/src/index.tsx) passes it into the interactive app |

Copilot, OpenCode, Kilo, and Codebuff were not installed in the implementation
environment. Their contracts were checked against official documentation/source.
The built-in template test checks every target with multiline Unicode context.
A controlled child test checks actual argv delivery, cwd, and exit status without
sending user history to a model provider. Freebuff's current CLI does not accept
initial prompt arguments, so it is not an interchangeable handoff executable for
the Codebuff template.

The reverse Codex-to-Claude path was also exercised with the real Claude Code
2.1.270 interactive CLI: a synthetic Codex-format transcript was indexed, then
handed off using the built-in Claude template. Claude opened in the recorded
temporary directory, returned the exact Unicode marker from the brief, and answered
a follow-up identifying Codex as the source. The test workspace remained unchanged.
This smoke test used `CLAUDE_CODE_SAFE_MODE=1` to disable local hooks, plugins, and
MCP customizations; it verifies the handoff and interactive continuation, not those
customizations. The CLI regression suite also covers indexed Codex-to-Claude export.

## Deliberate limits

The index is a snapshot. Handoff does not automatically reindex, reconstruct tool
state, restore files, check out historical branches, or perform native transcript
conversion. The deterministic brief is historical evidence, not a semantic summary
of unfinished work. Repeated handoffs may nest earlier briefs inside retained user
prompts. General prompt transports, lineage/deduplication, and semantic summarization
remain outside this feature.
