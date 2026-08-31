# Changelog

## [0.0.15](https://github.com/AraneaDev/Nekyia/compare/v0.0.14...v0.0.15) (2026-08-31)


### Documentation

* point the badge at the renamed /tools section ([#37](https://github.com/AraneaDev/Nekyia/issues/37)) ([8604a12](https://github.com/AraneaDev/Nekyia/commit/8604a128700e14369a2bc25c0c7fbc7e9cf94296))

## [0.0.14](https://github.com/AraneaDev/Nekyia/compare/v0.0.13...v0.0.14) (2026-08-30)


### Features

* add nekyia timeline for directory file history ([7a64346](https://github.com/AraneaDev/Nekyia/commit/7a64346c20b357ed5be0541636c826aa38a49781))
* add schema version 4 for ordered file events ([a44b33d](https://github.com/AraneaDev/Nekyia/commit/a44b33d5426298b740bf7bdab4c2dde64ee70833))
* ask git which files it already has ([167b97c](https://github.com/AraneaDev/Nekyia/commit/167b97c67e0fcf32e35ec847a9566d2069d185f5))
* query file events under a directory ([6654217](https://github.com/AraneaDev/Nekyia/commit/665421707cf64065537058430563e8bcc88a001a))
* read operation kinds from claude and codex tool calls ([727f667](https://github.com/AraneaDev/Nekyia/commit/727f667b8722c66d52ee2c3fa199ce60aabd9900))
* show file operations in order when inspecting a session ([ad9f9d5](https://github.com/AraneaDev/Nekyia/commit/ad9f9d57802127fe90bcc78dceb6300ad91091a4))
* store ordered file events for a hydrated session ([518b08b](https://github.com/AraneaDev/Nekyia/commit/518b08bf02ba361a460440ab9dc138fd63160f5c))


### Fixes

* address Coderabbit review feedback ([e537b43](https://github.com/AraneaDev/Nekyia/commit/e537b43429bebe917795f2277701480e24f298c0))
* keep the file event log independent of the file cap ([aac0fc3](https://github.com/AraneaDev/Nekyia/commit/aac0fc36cf51da8f090dfc32fbd9748e13138be9))
* keep the file list complete past the event cap ([d674cff](https://github.com/AraneaDev/Nekyia/commit/d674cff67bebf7590a7cb756e2c333ee7b1ea42f))
* make the timeline honest about what it prints ([93e366e](https://github.com/AraneaDev/Nekyia/commit/93e366e066750ac7bb4a608b51c2ff5f77bcb5c4))
* treat null stdout as unreadable output ([0498b1c](https://github.com/AraneaDev/Nekyia/commit/0498b1c3ff7c9c44d98b8c8b6beb24f03cf346a9))


### Performance

* serve directory candidates from the path indices ([7c77004](https://github.com/AraneaDev/Nekyia/commit/7c7700415073d6e82574b7bccd0118c55ebfcff2))


### Documentation

* count only path-naming calls in the recovery census ([60ca140](https://github.com/AraneaDev/Nekyia/commit/60ca140030dd3280c1bace050d9a229642807df6))
* keep the census evidence at the decision it supports ([bba9502](https://github.com/AraneaDev/Nekyia/commit/bba9502de2b558e3dddb5f44446d172c476cca20))
* measure per-file recovery coverage against git ([0c779b5](https://github.com/AraneaDev/Nekyia/commit/0c779b5f8abc57ca23de9849aaf95c2eaceaeb06))
* measure what session stores can actually recover ([042e28f](https://github.com/AraneaDev/Nekyia/commit/042e28f722576864b7dd9321bc032fb7aab9fe99))
* resolve coderabbit docstring review comments ([fe0abea](https://github.com/AraneaDev/Nekyia/commit/fe0abea05a9c8bff76aaf69e5b2cb2fe81041b55))
* rewrite generic docstrings with context-aware descriptions ([904f434](https://github.com/AraneaDev/Nekyia/commit/904f434582f51d917cec604f15f706c882583149))
* say that a session can be asked what it did ([a8aef43](https://github.com/AraneaDev/Nekyia/commit/a8aef432ba2567c8a91a0f462ce23b2882183266))
* scope the census conclusions to the store it measured ([5b6df31](https://github.com/AraneaDev/Nekyia/commit/5b6df3164691862841826a06f3dda3c7370993e5))
* show what a timeline looks like ([5548fd4](https://github.com/AraneaDev/Nekyia/commit/5548fd4af8c0b266a3d52f68965b2cb81b44b804))

## [0.0.13](https://github.com/AraneaDev/Nekyia/compare/v0.0.12...v0.0.13) (2026-08-28)


### Continuous integration

* move off the actions still running on Node 20 ([#33](https://github.com/AraneaDev/Nekyia/issues/33)) ([c0bb447](https://github.com/AraneaDev/Nekyia/commit/c0bb44793a5d761d844471e1c5f620dd22939d93))

## [0.0.12](https://github.com/AraneaDev/Nekyia/compare/v0.0.11...v0.0.12) (2026-08-27)


### Documentation

* link the README to the project page ([c4f2105](https://github.com/AraneaDev/Nekyia/commit/c4f21053a790875a50bf6c8629341e7d5fcd5304))

## [0.0.11](https://github.com/AraneaDev/Nekyia/compare/v0.0.10...v0.0.11) (2026-08-25)


### Documentation

* keep one key table, and correct what the rest claimed ([dedd020](https://github.com/AraneaDev/Nekyia/commit/dedd020a85b51952bcbd194c53715d9f2414493b))

## [0.0.10](https://github.com/AraneaDev/Nekyia/compare/v0.0.9...v0.0.10) (2026-08-25)


### Documentation

* describe the picker as it now behaves ([54b0e58](https://github.com/AraneaDev/Nekyia/commit/54b0e581ed925a2dad64d724e1a0ec25fc11c9b8))

## [0.0.9](https://github.com/AraneaDev/Nekyia/compare/v0.0.8...v0.0.9) (2026-08-25)


### Features

* **cli:** ask which sessions touched one exact file ([ada4d96](https://github.com/AraneaDev/Nekyia/commit/ada4d9621221e3aaa6578564179f018f563f2176))
* **picker:** open where the sessions are, and offer only the clients you have ([3bfb9a4](https://github.com/AraneaDev/Nekyia/commit/3bfb9a40d70bacf7744f41633dbc0d6c81b275ac))


### Fixes

* **codex:** recover the files a patch call touched ([e338348](https://github.com/AraneaDev/Nekyia/commit/e338348b740e44ba67d4001f995e5164f89b4d8d))

## [0.0.8](https://github.com/AraneaDev/Nekyia/compare/v0.0.7...v0.0.8) (2026-08-25)


### Features

* **picker:** read a session's history as the conversation it was ([a48e680](https://github.com/AraneaDev/Nekyia/commit/a48e6805f6580c59cb51f2f7d8f866a5d718494e))


### Fixes

* **codex:** find the sessions Codex actually writes ([5ccf030](https://github.com/AraneaDev/Nekyia/commit/5ccf030bf3f86131cc388ba3bf98396ad91cbe5a))


### Performance

* **picker:** read the session table once per picker, not once per keystroke ([b8906bf](https://github.com/AraneaDev/Nekyia/commit/b8906bfd716c4ce4da10fdbd1080c68c11e5376f))
* **picker:** stop preparing preview text the pane will not show ([150c363](https://github.com/AraneaDev/Nekyia/commit/150c3638719f3293e1ce8eb2ecedbe0a44d51b6e))

## [0.0.7](https://github.com/AraneaDev/Nekyia/compare/v0.0.6...v0.0.7) (2026-08-25)


### Features

* **doctor:** tell a size cap apart from an unreadable transcript ([aa15d4f](https://github.com/AraneaDev/Nekyia/commit/aa15d4f3c2d14b2376d4c3d10bc46f4ace091b44))


### Fixes

* **brief:** say what the handover left out ([f17b9b4](https://github.com/AraneaDev/Nekyia/commit/f17b9b49ecad740672bf5fa360c5617a1f9a17f8))
* **config:** cover a directory's children, and recover an abandoned guard ([25a6b75](https://github.com/AraneaDev/Nekyia/commit/25a6b75cf013348429a12a9d6331af9c65bce0a0))
* **db:** wait for a concurrent writer instead of failing at once ([ab7df5d](https://github.com/AraneaDev/Nekyia/commit/ab7df5de9ff915e26deb81dfd14ed10c8797c6ed))
* **formats:** charge bytes once, bound recovered paths, and reject unusable ids ([1885f30](https://github.com/AraneaDev/Nekyia/commit/1885f30c3388afc5148a155ac3c92187b5642dc5))
* **formats:** reject an unsafe id taken from a Claude transcript filename ([03db389](https://github.com/AraneaDev/Nekyia/commit/03db3890e6b65c31190256d7886fc1b1544ba19c))
* **index:** stop a failed hydration from erasing a session ([953c43e](https://github.com/AraneaDev/Nekyia/commit/953c43ea13f4d9ed9fe683575d6cc163a15051a7))
* **privacy:** delete excluded sessions instead of only flagging them ([4d085e2](https://github.com/AraneaDev/Nekyia/commit/4d085e252af989cbafe289f483c6ac0a98196b7a))
* **resume:** hand the terminal's signals to the launched client ([fe9536f](https://github.com/AraneaDev/Nekyia/commit/fe9536f6bc5ca56710562168df4b1f914d364f07))
* **search:** sanitize session titles before printing them ([ee496f6](https://github.com/AraneaDev/Nekyia/commit/ee496f65e2733cae0466783f06759087569031a2))
* **tui:** keep the picker honest about what it is showing ([a51ae01](https://github.com/AraneaDev/Nekyia/commit/a51ae01f9a430fc569dee751650b9de26bd6d660))


### Performance

* **cli:** keep ink off the startup path of the plain commands ([0e6deed](https://github.com/AraneaDev/Nekyia/commit/0e6deed1db73427244c0f782e947eca59c9a619d))
* **search:** stop parsing provenance the search path never reads ([475e66d](https://github.com/AraneaDev/Nekyia/commit/475e66d30a13b3653e454023704547e1b5450bb2))


### Tests

* cover the error paths the command layer reports through ([51e805e](https://github.com/AraneaDev/Nekyia/commit/51e805e3b0b005b533c70f06d2c46a1909f6786a))
* resolve temporary roots so macOS symlinks do not fail two tests ([b68e472](https://github.com/AraneaDev/Nekyia/commit/b68e4721331e53eed6e18c9f335cb13dfb252e50))


### Continuous integration

* require a conventional pull request title ([f6ab49e](https://github.com/AraneaDev/Nekyia/commit/f6ab49e6553a382b57cf695f6cc88f4e773f25ef))


### Refactoring

* **config:** drop an origin and a setting nothing could reach ([06f7530](https://github.com/AraneaDev/Nekyia/commit/06f7530e3df9cd838e10edd7dd41c92fcb00a31a))

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
