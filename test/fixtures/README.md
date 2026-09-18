# Test fixtures

I keep these fixtures sanitized while preserving each client's real storage shape. You can regenerate the SQLite databases with `bun run scripts/make-fixtures.ts`.

Every path in them points into an invented home directory, `/home/dev/work/`, and every prompt and reply is made up. When I add a fixture, I keep it that way: no real paths, hostnames, usernames or session text.

The `SECRET_TOOL_OUTPUT_MUST_NOT_BE_INDEXED` marker guards the privacy exclusion that keeps tool output out of the searchable index.
