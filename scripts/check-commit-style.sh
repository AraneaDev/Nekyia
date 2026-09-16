#!/usr/bin/env bash
# One definition of what a commit subject may look like, for this repository.
#
# release-please reads the subject that lands on main to build the changelog and
# choose the next version, so a subject it cannot parse is not a style slip: the
# change silently misses the changelog, and a fix that should have moved the
# version leaves it where it was.
#
# This repository squash merges, so the subject release-please eventually reads
# is the pull request title, not any of the commits inside it. CI therefore
# checks the title, and the commit-msg hook checks what you type locally. Both
# call this one script, so neither can drift from the other.
#
#   tools/check-commit-style.sh "fix: stop gating on a window that has ended"
#   tools/check-commit-style.sh --file .git/COMMIT_EDITMSG
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  printf 'usage: check-commit-style.sh <subject> | --file <path>\n' >&2
  exit 2
}

# No argument is a caller that got it wrong; an empty argument is a message with
# nothing in it, which is a different thing and not this script's to judge. Both
# look identical through "${1:-}", so the count is what separates them.
[ "$#" -gt 0 ] || usage

subject=
case "$1" in
  --file)
    [ -n "${2:-}" ] || usage
    [ -f "$2" ] || {
      printf 'check-commit-style: no such file: %s\n' "$2" >&2
      exit 2
    }
    # The subject is the first line of what will be kept. A message being edited
    # carries git's comments above it, and a template can push the real subject
    # further down still.
    subject=$(grep -v '^#' "$2" | sed '/^[[:space:]]*$/d' | head -1)
    ;;
  *) subject=$1 ;;
esac

# Nothing to judge. An empty message aborts the commit on its own, and saying so
# twice helps nobody.
[ -n "$subject" ] || exit 0

# Git writes these itself, or writes them to be consumed by a later rebase, and
# release-please's own release subject is exempt as belt and braces. None of
# them reach main in a form this rule should judge.
case "$subject" in
  'Merge '* | 'Revert "'* | 'fixup!'* | 'squash!'* | 'amend!'* | 'chore(main): release '*) exit 0 ;;
esac

# The types release-please recognises, read from its own config so a type this
# check accepts and release-please does not -- exactly the failure this check
# exists to prevent -- cannot happen. jq is installed by the job that calls this
# in CI; the commit-msg hook may run on a machine without it, so that one case
# falls back to the conventional set, which is a superset of any sane config.
types='build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
config="$ROOT/release-please-config.json"
if command -v jq >/dev/null 2>&1 && [ -f "$config" ]; then
  from_config=$(jq -r '.packages["."]["changelog-sections"][]?.type' "$config" 2>/dev/null |
    tr -d '\r' | grep -E '^[a-z]+$' | sort -u | paste -sd'|' -)
  # A config without changelog-sections says nothing about types, so the
  # conventional set stands rather than being narrowed to nothing.
  [ -n "$from_config" ] && types="$from_config"
fi

fail() {
  printf '\n  %s\n\n' "$1" >&2
  printf '    %s\n\n' "$subject" >&2
  printf '  Conventional commits, because release-please builds the changelog\n' >&2
  printf '  and the next version number from them:\n\n' >&2
  printf '    feat: add the accounts view\n' >&2
  printf '    fix: do not gate on a window that has already ended\n' >&2
  printf '    docs(readme): link the project site\n' >&2
  printf '    feat!: a break, or use a BREAKING CHANGE: trailer\n\n' >&2
  printf '  Types: %s\n\n' "$(printf '%s' "$types" | tr '|' ' ')" >&2
  exit 1
}

# A type, an optional scope, an optional ! for a break, then ": " and something
# to say. Anchored at both ends so a subject that merely mentions a type
# somewhere does not pass.
if ! printf '%s' "$subject" |
  grep -Eq "^(${types})(\([a-z0-9][a-z0-9._/-]*\))?!?: .+"; then
  fail "This subject does not start with a conventional commit type."
fi

# House style: no em dashes, in code, comments, output strings or commit
# messages. A comma or two short sentences instead.
case "$subject" in
  *—*) fail "This subject contains an em dash. Use a comma, or two sentences." ;;
esac

exit 0
