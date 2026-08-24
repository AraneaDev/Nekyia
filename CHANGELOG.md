# Changelog

## [0.0.6](https://github.com/AraneaDev/Nekyia/compare/v0.0.5...v0.0.6) (2026-08-24)


### Features

* find and resume GitHub Copilot CLI sessions ([4d0025c](https://github.com/AraneaDev/Nekyia/commit/4d0025c53b23e38ab7c04e038eed28e8fb55d6c6))


### Fixes

* stop reading stdin while the launched client runs ([2273f62](https://github.com/AraneaDev/Nekyia/commit/2273f62839bd2dc3e9684d78d49ba2d8ff85e7ed))

## [0.0.5](https://github.com/AraneaDev/Nekyia/compare/v0.0.4...v0.0.5) (2026-08-24)


### Features

* give the picker a visual hierarchy ([ba3d3ad](https://github.com/AraneaDev/Nekyia/commit/ba3d3adf5c925b3209e8157e392806a3f88975ce))
* let colour carry meaning in the picker ([98b37b2](https://github.com/AraneaDev/Nekyia/commit/98b37b28e9c482ea3c251a81cf4baec8bcaffa6d))
* let tab narrow to the project you are looking at ([ff8fe65](https://github.com/AraneaDev/Nekyia/commit/ff8fe65763d2eaa0fa06e4e3e1303a3d79ca93e3))
* open a session's history and read through it ([b09481e](https://github.com/AraneaDev/Nekyia/commit/b09481ef55b2fd98cb617829f885473d030239fc))
* say what to do when nothing came up, and where this came from ([d00cc5f](https://github.com/AraneaDev/Nekyia/commit/d00cc5fc3f5f337bacd1e5c85ddcfb1febd42939))
* show the session, not just its name, in the detail view ([1aa057b](https://github.com/AraneaDev/Nekyia/commit/1aa057b3276edb6f2cce028d2280750d672de9ac))
* show where you are in the list, and name the keys again ([ee8d9b5](https://github.com/AraneaDev/Nekyia/commit/ee8d9b5d681d9e4a2c85eafa602c173352a6b00d))


### Fixes

* index what was asked, not what the harness wrote around it ([60f16cf](https://github.com/AraneaDev/Nekyia/commit/60f16cf68bdff55398a4f90d6819bc062b15731c))
* keep the picker inside the terminal it is drawn in ([217803d](https://github.com/AraneaDev/Nekyia/commit/217803d1933ea28962c55ca2a4e52f0c5a5cbd9f))
* lay the picker out against the terminal width too ([32a6e12](https://github.com/AraneaDev/Nekyia/commit/32a6e12d2011d2b3f7a860f6496df4a4ee9a4815))
* put the preview under the list, as the design has it ([b5987ed](https://github.com/AraneaDev/Nekyia/commit/b5987ed78730d7f702c44cea77954689aa924bf2))


### Documentation

* capture every interface state, from the running picker ([e5aefe8](https://github.com/AraneaDev/Nekyia/commit/e5aefe84c0d29c03727fd46de6a74dee8458485a))
* show the picker at the top of the README ([a96022e](https://github.com/AraneaDev/Nekyia/commit/a96022ebe74d1534a8f707a9c1f461fef984d115))

## [0.0.4](https://github.com/AraneaDev/Nekyia/compare/v0.0.3...v0.0.4) (2026-08-24)


### Documentation

* install a release with one command that works ([#4](https://github.com/AraneaDev/Nekyia/issues/4)) ([c4dd68a](https://github.com/AraneaDev/Nekyia/commit/c4dd68a0e6315e277f500ef6e7424b4d98b222c8))

## [0.0.3](https://github.com/AraneaDev/Nekyia/compare/v0.0.2...v0.0.3) (2026-08-24)


### Documentation

* keep the README install version in sync with each release ([#2](https://github.com/AraneaDev/Nekyia/issues/2)) ([96c986c](https://github.com/AraneaDev/Nekyia/commit/96c986c25469f8a30c57fda495d78352a1cb3c00))

## [0.0.2](https://github.com/AraneaDev/Nekyia/compare/v0.0.1...v0.0.2) (2026-08-24)


### Tests

* assert the version invariant instead of the literal 0.0.1 ([8f1c837](https://github.com/AraneaDev/Nekyia/commit/8f1c837ca35b95d95629d8b9edbd2d4d5587e429))
* resolve temp dirs so macOS symlinks keep the suite green ([a6505da](https://github.com/AraneaDev/Nekyia/commit/a6505da57f92861ba929cd930f861dce56d2a8ca))

## 0.0.1 (2026-08-24)

This pre-release is the first public build of Nekyia.

### Features

- Search and rank sessions from six agent CLIs in one local index.
- Resume verified clients and create deterministic handovers for search-tier clients.
- Use an interactive picker or scriptable search, show, doctor, privacy, and indexing commands.
- Keep all indexing and search local, with no network calls, API key, or telemetry.
