# Changelog

## [1.14.0](https://github.com/chrisleekr/github-app/compare/v1.13.0...v1.14.0) (2026-06-30)


### Bug Fixes

* **agent-sdk:** pass settingSources [] so SDK ignores cloned PR .claude/settings.json ([#195](https://github.com/chrisleekr/github-app/issues/195)) ([153fef3](https://github.com/chrisleekr/github-app/commit/153fef359cf88fa47dfc841716b6a1dfd95285d5))
* **check:** derive scoped-executor scan set from filesystem (dead guard) ([#208](https://github.com/chrisleekr/github-app/issues/208)) ([8b0e8ef](https://github.com/chrisleekr/github-app/commit/8b0e8ef496f166d65bcf873df2a72f44f373a72e))
* **daemon:** sweep full workspace triple on startup and crash exit ([#239](https://github.com/chrisleekr/github-app/issues/239)) ([56fa714](https://github.com/chrisleekr/github-app/commit/56fa714492c45433a0bac4889e735cafb097b157))
* **idempotency:** gate side-effecting handlers with Valkey claim to prevent redelivery duplicates ([#212](https://github.com/chrisleekr/github-app/issues/212)) ([68dacdb](https://github.com/chrisleekr/github-app/commit/68dacdbd9102246015f0cceb8ca2cdfbfaa8c209))
* **infrastructure:** patch krb5 HIGH CVE-2026-40356 in shared Docker base ([#180](https://github.com/chrisleekr/github-app/issues/180)) ([1d1bc3b](https://github.com/chrisleekr/github-app/commit/1d1bc3b0aaac0c4dbb4b3b939f7b640744243814))
* **mcp:** redact Octokit error tool-results and widen GitHub token regex ([#238](https://github.com/chrisleekr/github-app/issues/238)) ([675d610](https://github.com/chrisleekr/github-app/commit/675d610741eba78414d8b442b9f290cef129af67))
* **mcp:** wrap GitHub-touching MCP servers + state-fetchers in retryWithBackoff ([#205](https://github.com/chrisleekr/github-app/issues/205)) ([319beb9](https://github.com/chrisleekr/github-app/commit/319beb985eb3c0b6ff5d077482ac29a97776366f))
* **observability:** canonicalise child-logger entity id under entityNumber ([#178](https://github.com/chrisleekr/github-app/issues/178)) ([808ca46](https://github.com/chrisleekr/github-app/commit/808ca46e7b67741d8aacd5161c2bf425aca5e51c))
* **security:** gate LLM scanner redacted_body to deletion-only ([#206](https://github.com/chrisleekr/github-app/issues/206)) ([d52cf78](https://github.com/chrisleekr/github-app/commit/d52cf780b39fe9735aa86e829c5b1cd83bedf74a))
* **security:** set strictMcpConfig to block cloned-PR .mcp.json auto-load ([#210](https://github.com/chrisleekr/github-app/issues/210)) ([2c58ec1](https://github.com/chrisleekr/github-app/commit/2c58ec1b32fd377f2b24eb9b5bde66d53ffc2169))
* **testing:** run colocated src/**/*.test.ts in CI + add drift guard ([#204](https://github.com/chrisleekr/github-app/issues/204)) ([5990e0d](https://github.com/chrisleekr/github-app/commit/5990e0df98545e107ebea117b3532f51507e86cd))


### Features

* **agent-sdk:** block destructive Bash at runtime via PreToolUse hook ([#241](https://github.com/chrisleekr/github-app/issues/241)) ([f3132f2](https://github.com/chrisleekr/github-app/commit/f3132f2e2dd18c2c836a8fb4618c39487bbd5755))
* **observability:** add 12 structured Pino event families with Zod-strict schemas ([#251](https://github.com/chrisleekr/github-app/issues/251)) ([eaad36b](https://github.com/chrisleekr/github-app/commit/eaad36bfe43c5cb43f0f57d757c290484e332e71))
* **observability:** add queue_wait_ms to dispatcher offer/no-daemon logs ([#207](https://github.com/chrisleekr/github-app/issues/207)) ([7a5cfb0](https://github.com/chrisleekr/github-app/commit/7a5cfb09b642f9dd55df1ca1a68ea33bc970da99))
* **observability:** add structured retry.* events ([#225](https://github.com/chrisleekr/github-app/issues/225)) ([6713cbf](https://github.com/chrisleekr/github-app/commit/6713cbf6dd6446eab9756a3567b1e8440f63de95))
* **observability:** emit failed_stage and failed_stage_delta_ms on pipeline.failed ([#244](https://github.com/chrisleekr/github-app/issues/244)) ([4f2483c](https://github.com/chrisleekr/github-app/commit/4f2483cbf165f690506e83a63f25ea96d351034c))
* **observability:** emit structured idempotency events on all 4 claimDelivery outcomes ([#242](https://github.com/chrisleekr/github-app/issues/242)) ([e1e7f9e](https://github.com/chrisleekr/github-app/commit/e1e7f9eda2700aeaf01fba6055ff8f1bb6a8e172))
* **observability:** installationId on loggers + config-free MCP retry ([#189](https://github.com/chrisleekr/github-app/issues/189)) ([ba09f76](https://github.com/chrisleekr/github-app/commit/ba09f76d3a49901ac0da10ca75c76660d38d2e17)), closes [#177](https://github.com/chrisleekr/github-app/issues/177) [#184](https://github.com/chrisleekr/github-app/issues/184)
* **observability:** log + persist SDK token usage on executions ([#209](https://github.com/chrisleekr/github-app/issues/209)) ([5407dcd](https://github.com/chrisleekr/github-app/commit/5407dcdb96e3f97f8f96dc041f3903fcd32402cb))
* **observability:** log octokit rate-limit headers via hook.after ([#183](https://github.com/chrisleekr/github-app/issues/183)) ([30e1715](https://github.com/chrisleekr/github-app/commit/30e1715e865f0d4ebe1d1bed8f0e3e47920ca77b))
* **observability:** periodic fleet-state gauge snapshot ([#186](https://github.com/chrisleekr/github-app/issues/186)) ([7429460](https://github.com/chrisleekr/github-app/commit/7429460fbd896cc025cdcbabb508489455167523))
* **observability:** redact crash logs via uncaughtException/unhandledRejection handlers ([#181](https://github.com/chrisleekr/github-app/issues/181)) ([d4248f4](https://github.com/chrisleekr/github-app/commit/d4248f4719863c8754ce5673a01378c5e28e7419))
* **observability:** structured dispatcher + heartbeat log events ([#188](https://github.com/chrisleekr/github-app/issues/188)) ([c615bc4](https://github.com/chrisleekr/github-app/commit/c615bc432affda68ce947627f133af850562cbfe))
* **observability:** structured pino logger for stdio MCP servers ([#185](https://github.com/chrisleekr/github-app/issues/185)) ([5244e8a](https://github.com/chrisleekr/github-app/commit/5244e8a0859e77299f65f6e0d3beffdea86b691b))
* **observability:** structured pipeline.stage timing events with delta_ms ([#182](https://github.com/chrisleekr/github-app/issues/182)) ([4125971](https://github.com/chrisleekr/github-app/commit/4125971adc502f3e54da4c566e95b50b52588214))

## [1.13.0](https://github.com/chrisleekr/github-app-playground/compare/v1.12.2...v1.13.0) (2026-05-21)


### Bug Fixes

* **deps:** update dependency @anthropic-ai/bedrock-sdk to ^0.29.0 ([#147](https://github.com/chrisleekr/github-app-playground/issues/147)) ([eb95c64](https://github.com/chrisleekr/github-app-playground/commit/eb95c64b366fc4484be3e7afd2b26b2f03bdc7da))
* **deps:** update dependency @anthropic-ai/claude-agent-sdk to ^0.3.0 ([#154](https://github.com/chrisleekr/github-app-playground/issues/154)) ([15add8e](https://github.com/chrisleekr/github-app-playground/commit/15add8ea4d88c2cb0e9d4dd5eef6ac7284d22bb9))
* **docs:** anchor-verify src citations to catch silent line-shift rot ([#163](https://github.com/chrisleekr/github-app-playground/issues/163)) ([5a67863](https://github.com/chrisleekr/github-app-playground/commit/5a6786306bf5f50671d6f919843f48bf9fb1e5da))
* **webhook:** subscribe issue_comment.edited/.deleted for cache write-through ([#131](https://github.com/chrisleekr/github-app-playground/issues/131)) ([c84361d](https://github.com/chrisleekr/github-app-playground/commit/c84361d50b09b5df55d0e0abda88f3e808e57a9f))
* **webhook:** write-through target_cache on issues/pull_request events ([#130](https://github.com/chrisleekr/github-app-playground/issues/130)) ([#132](https://github.com/chrisleekr/github-app-playground/issues/132)) ([8b79c10](https://github.com/chrisleekr/github-app-playground/commit/8b79c10a98a88b5f18420c3d855d708af504d495))


### Features

* **prompt:** opt-in cacheable system/user prompt split ([#135](https://github.com/chrisleekr/github-app-playground/issues/135)) ([bb80ca7](https://github.com/chrisleekr/github-app-playground/commit/bb80ca78f34244b4b5288ebb25a33526133b35aa))
* **review-learnings:** explicit [@bot](https://github.com/bot) remember + autonomous capture ([#160](https://github.com/chrisleekr/github-app-playground/issues/160)) ([#162](https://github.com/chrisleekr/github-app-playground/issues/162)) ([1c4c53a](https://github.com/chrisleekr/github-app-playground/commit/1c4c53a2dbef62592accb36b1c450c3305d5f384))
* **review-learnings:** persistent per-repo review-policy directives ([#161](https://github.com/chrisleekr/github-app-playground/issues/161)) ([ba50972](https://github.com/chrisleekr/github-app-playground/commit/ba50972b20729eb534636dd5e5711dce460eaf66))
* **scheduler:** scheduled actions via .github-app.yaml ([#159](https://github.com/chrisleekr/github-app-playground/issues/159)) ([142a5bc](https://github.com/chrisleekr/github-app-playground/commit/142a5bc2472bcfd34447990fb14f333bf1eab1fb))
* **workflows:** comment-aware structured workflows via LLM discussion digest ([#148](https://github.com/chrisleekr/github-app-playground/issues/148)) ([7a6b315](https://github.com/chrisleekr/github-app-playground/commit/7a6b31558850f5bf85800dd9143c862fbb399fb1))

## [1.12.2](https://github.com/chrisleekr/github-app-playground/compare/v1.12.1...v1.12.2) (2026-05-10)


### Bug Fixes

* **mcp:** bundle all stdio servers and resolve paths from any bundle ([#125](https://github.com/chrisleekr/github-app-playground/issues/125)) ([6e34790](https://github.com/chrisleekr/github-app-playground/commit/6e34790f0ea4853b0d11029fb60a2d8ac5aeed3b))
* **security:** close cross-session prompt injection via repo_memory ([#124](https://github.com/chrisleekr/github-app-playground/issues/124)) ([001990d](https://github.com/chrisleekr/github-app-playground/commit/001990da19d7f4220112bc7d7df8cc5512db6565))

## [1.12.1](https://github.com/chrisleekr/github-app-playground/compare/v1.12.0...v1.12.1) (2026-05-10)


### Bug Fixes

* **bot:** restore inline review comments on PRs ([#123](https://github.com/chrisleekr/github-app-playground/issues/123)) ([a5d0990](https://github.com/chrisleekr/github-app-playground/commit/a5d09906a8df2cee72ed0ac9d81060ecce6febda))

## [1.12.0](https://github.com/chrisleekr/github-app-playground/compare/v1.11.1...v1.12.0) (2026-05-10)


### Bug Fixes

* **security:** sanitize attacker-controlled filenames in formatChangedFiles ([#110](https://github.com/chrisleekr/github-app-playground/issues/110)) ([bb7b91d](https://github.com/chrisleekr/github-app-playground/commit/bb7b91d46a156d889eee9e335590ed1e6beab1fa))
* **ship:** reroute iteration-0 terminal-bad verdicts to chat-thread ([#119](https://github.com/chrisleekr/github-app-playground/issues/119)) ([#120](https://github.com/chrisleekr/github-app-playground/issues/120)) ([403ec21](https://github.com/chrisleekr/github-app-playground/commit/403ec21d0162e7deee66c161e792ac0a8c3eca86))


### Features

* **ai:** tool-driven LLM with github-state MCP server ([#117](https://github.com/chrisleekr/github-app-playground/issues/117)) ([#118](https://github.com/chrisleekr/github-app-playground/issues/118)) ([2a3c1e3](https://github.com/chrisleekr/github-app-playground/commit/2a3c1e3aecd6f7ea18a5788f202edef6b3a2b178))
* **security:** harden bot against prompt-injection comment attacks ([#121](https://github.com/chrisleekr/github-app-playground/issues/121)) ([564d066](https://github.com/chrisleekr/github-app-playground/commit/564d0663499921bbe7e1b644b97e27c5e41f336d))
* **workflows:** chat-thread executor + structured-output chokepoint + OAuth gate fix ([#113](https://github.com/chrisleekr/github-app-playground/issues/113)) ([698694b](https://github.com/chrisleekr/github-app-playground/commit/698694b879218d1d291af85d25c2c2d235af44b5))

## [1.11.1](https://github.com/chrisleekr/github-app-playground/compare/v1.11.0...v1.11.1) (2026-05-08)


### Bug Fixes

* **tracking-mirror:** idempotent setState with marker-based orphan adoption ([#109](https://github.com/chrisleekr/github-app-playground/issues/109)) ([#111](https://github.com/chrisleekr/github-app-playground/issues/111)) ([7e44417](https://github.com/chrisleekr/github-app-playground/commit/7e44417e9e4e9335f6ef95b5ba922df0ebda6dbf))

## [1.11.0](https://github.com/chrisleekr/github-app-playground/compare/v1.10.2...v1.11.0) (2026-05-07)


### Bug Fixes

* **implement:** match PR author by login in PAT mode ([#108](https://github.com/chrisleekr/github-app-playground/issues/108)) ([d325639](https://github.com/chrisleekr/github-app-playground/commit/d325639cd2d15d08d0825134772abfad4ca9c97f))


### Features

* **resolve:** gate handler success on post-fix CI state ([#107](https://github.com/chrisleekr/github-app-playground/issues/107)) ([eecdedc](https://github.com/chrisleekr/github-app-playground/commit/eecdedc2c222fe5d20e955c0462cb5279df60ee5))

## [1.10.2](https://github.com/chrisleekr/github-app-playground/compare/v1.10.1...v1.10.2) (2026-05-06)


### Bug Fixes

* **executor:** drop CLAUDE_CODE_SUBPROCESS_ENV_SCRUB to unblock CLI startup ([#106](https://github.com/chrisleekr/github-app-playground/issues/106)) ([52ab202](https://github.com/chrisleekr/github-app-playground/commit/52ab20222673ae305355b3b02a38b4d680f03884))

## [1.10.1](https://github.com/chrisleekr/github-app-playground/compare/v1.10.0...v1.10.1) (2026-05-06)


### Bug Fixes

* **executor:** capture Claude CLI stderr via SDK callback ([#105](https://github.com/chrisleekr/github-app-playground/issues/105)) ([3482443](https://github.com/chrisleekr/github-app-playground/commit/348244354ad291d3b633e75bb0a32ebc7ce1c866))

## [1.10.0](https://github.com/chrisleekr/github-app-playground/compare/v1.9.1...v1.10.0) (2026-05-05)


### Bug Fixes

* **orchestrator:** constant-time bearer-token check + rotation slot ([#76](https://github.com/chrisleekr/github-app-playground/issues/76)) ([#103](https://github.com/chrisleekr/github-app-playground/issues/103)) ([cae53bd](https://github.com/chrisleekr/github-app-playground/commit/cae53bdf865c6836ea49fb141750a1099172615c))


### Features

* **bot:** PAT override + artifact sandbox + secret-exfil hardening ([#104](https://github.com/chrisleekr/github-app-playground/issues/104)) ([e0d5894](https://github.com/chrisleekr/github-app-playground/commit/e0d5894e5c4d8f38d323f9d4d87a8b56b14cf890))

## [1.9.1](https://github.com/chrisleekr/github-app-playground/compare/v1.9.0...v1.9.1) (2026-05-04)


### Reverts

* **workflow:** revert SLSA provenance + SBOM attestations ([#99](https://github.com/chrisleekr/github-app-playground/issues/99)) ([9696492](https://github.com/chrisleekr/github-app-playground/commit/96964920a490e076b3866ba0916687ccb8bfd055))

## [1.9.0](https://github.com/chrisleekr/github-app-playground/compare/v1.8.0...v1.9.0) (2026-05-03)


### Bug Fixes

* **checkout:** fetch PR base branch so origin/<baseBranch> resolves (closes [#74](https://github.com/chrisleekr/github-app-playground/issues/74)) ([#96](https://github.com/chrisleekr/github-app-playground/issues/96)) ([71f83a6](https://github.com/chrisleekr/github-app-playground/commit/71f83a6600e4a49b45295e0886b6c9072af21e88))
* **fetcher:** paginate GraphQL connections + MAX_FETCHED_* caps (closes [#66](https://github.com/chrisleekr/github-app-playground/issues/66)) ([#95](https://github.com/chrisleekr/github-app-playground/issues/95)) ([f728ecd](https://github.com/chrisleekr/github-app-playground/commit/f728ecdf16fd31feefa78aba0cbacf61a7292129))
* **triage:** accept note-only evidence; raise research max-turns to 200 ([#97](https://github.com/chrisleekr/github-app-playground/issues/97)) ([3b6036c](https://github.com/chrisleekr/github-app-playground/commit/3b6036cffa5b73aefcd8fb0b788bb526ac401df3))
* **workflow:** fix release.yml ([#98](https://github.com/chrisleekr/github-app-playground/issues/98)) ([cb43d69](https://github.com/chrisleekr/github-app-playground/commit/cb43d69064e9ed8fe4061525287ac0cb7b969314))


### Features

* **workflows:** publish SLSA provenance + SBOM attestations on every release tag (closes [#58](https://github.com/chrisleekr/github-app-playground/issues/58)) ([#94](https://github.com/chrisleekr/github-app-playground/issues/94)) ([95856bc](https://github.com/chrisleekr/github-app-playground/commit/95856bc2768694ed7b6da8103f5e8261b199bfa6))

## [1.8.0](https://github.com/chrisleekr/github-app-playground/compare/v1.7.0...v1.8.0) (2026-05-02)


### Bug Fixes

* **logger:** redact paths and scrub err.* before pino emits (closes [#52](https://github.com/chrisleekr/github-app-playground/issues/52)) ([#89](https://github.com/chrisleekr/github-app-playground/issues/89)) ([641f138](https://github.com/chrisleekr/github-app-playground/commit/641f1385a8ccbd9d549609e42859858c9ea1c8ea))
* **security:** redact raw error messages from public PR comments ([#90](https://github.com/chrisleekr/github-app-playground/issues/90)) ([cc70949](https://github.com/chrisleekr/github-app-playground/commit/cc709494e117c8d41f72e56e017dbeeaf3d71d83))


### Features

* **workflows:** unify bot reply format and harden research/resolve guards ([#91](https://github.com/chrisleekr/github-app-playground/issues/91)) ([7d39fb4](https://github.com/chrisleekr/github-app-playground/commit/7d39fb498fa9fd60079d57a564d44ec3345589e5))

## [1.7.0](https://github.com/chrisleekr/github-app-playground/compare/v1.6.1...v1.7.0) (2026-05-01)


### Bug Fixes

* **idempotency:** scope durable check with since=triggerTimestamp (closes [#33](https://github.com/chrisleekr/github-app-playground/issues/33)) ([#69](https://github.com/chrisleekr/github-app-playground/issues/69)) ([5f1c1fa](https://github.com/chrisleekr/github-app-playground/commit/5f1c1fa519c40128f9d18c360413ef262356bb11))


### Features

* **ship:** pr shepherding scaffolding + flag-gated trigger surfaces ([#75](https://github.com/chrisleekr/github-app-playground/issues/75)) ([928811b](https://github.com/chrisleekr/github-app-playground/commit/928811b21ccf594952439afa6d30652f69e08278))
* **ship:** scoped commands (US5) + remove SHIP_USE_TRIGGER_SURFACES_V2 flag ([#77](https://github.com/chrisleekr/github-app-playground/issues/77)) ([33132a3](https://github.com/chrisleekr/github-app-playground/commit/33132a3ffa968f169d0692450700dc445a6e2290))
* **ship:** wire ship iteration loop, tickle scheduler, and four scoped executors ([#79](https://github.com/chrisleekr/github-app-playground/issues/79)) ([43da9aa](https://github.com/chrisleekr/github-app-playground/commit/43da9aa0568c5b8cd2817b70e91f257aa260a5f5))

## [1.6.1](https://github.com/chrisleekr/github-app-playground/compare/v1.6.0...v1.6.1) (2026-04-27)


### Bug Fixes

* **triage:** raise verdict details cap to 50k sanity bound ([#67](https://github.com/chrisleekr/github-app-playground/issues/67)) ([4634ff7](https://github.com/chrisleekr/github-app-playground/commit/4634ff7cc8f0dd8c92541500781b706b2c6d2d80))

## [1.6.0](https://github.com/chrisleekr/github-app-playground/compare/v1.5.0...v1.6.0) (2026-04-26)


### Bug Fixes

* **pipeline:** abort SDK query on timeout and daemon cancel ([#62](https://github.com/chrisleekr/github-app-playground/issues/62)) ([94a103a](https://github.com/chrisleekr/github-app-playground/commit/94a103a64330c2976d91a6663eb81cc7ad04d049))


### Features

* **triage:** tighten bug reproduction methodology in agent prompt ([#64](https://github.com/chrisleekr/github-app-playground/issues/64)) ([5416bb9](https://github.com/chrisleekr/github-app-playground/commit/5416bb9c6674fbc0edb2ac10cc5864281ed90a97))

## [1.5.0](https://github.com/chrisleekr/github-app-playground/compare/v1.4.0...v1.5.0) (2026-04-26)


### Features

* **workflows:** cascade PR retargeting + bounded review/resolve loop ([#63](https://github.com/chrisleekr/github-app-playground/issues/63)) ([3079014](https://github.com/chrisleekr/github-app-playground/commit/3079014a21b5c7a4a22e077caa0b23d23b21a9dc))

## [1.4.0](https://github.com/chrisleekr/github-app-playground/compare/v1.3.2...v1.4.0) (2026-04-26)


### Features

* **workflows:** up-front tracking comments, trigger reactions, parent cascade ([#61](https://github.com/chrisleekr/github-app-playground/issues/61)) ([befe07c](https://github.com/chrisleekr/github-app-playground/commit/befe07caff9e0f9b7b1984103e989a1bd3732a2c))

## [1.3.2](https://github.com/chrisleekr/github-app-playground/compare/v1.3.1...v1.3.2) (2026-04-26)


### Bug Fixes

* **triage:** remove 500-char cap on verdict summary ([#60](https://github.com/chrisleekr/github-app-playground/issues/60)) ([ed3c657](https://github.com/chrisleekr/github-app-playground/commit/ed3c657d5a93bc4d6379f0b6dd844cb71188e1ae))

## [1.3.1](https://github.com/chrisleekr/github-app-playground/compare/v1.3.0...v1.3.1) (2026-04-26)


### Bug Fixes

* **auth:** prevent empty ANTHROPIC_API_KEY from shadowing real OAuth token ([#59](https://github.com/chrisleekr/github-app-playground/issues/59)) ([d7001ef](https://github.com/chrisleekr/github-app-playground/commit/d7001efc0e4ea6125b86dfda93fba08b9e8464b5))

## [1.3.0](https://github.com/chrisleekr/github-app-playground/compare/v1.2.2...v1.3.0) (2026-04-25)


### Bug Fixes

* **review:** forward installation token, post inline findings, and stream progress ([#57](https://github.com/chrisleekr/github-app-playground/issues/57)) ([7ee4861](https://github.com/chrisleekr/github-app-playground/commit/7ee486117ed5dec000413c99b632df783fba4e55))
* **workflows:** make end-to-end runs survive without mid-run caps or stale state ([#55](https://github.com/chrisleekr/github-app-playground/issues/55)) ([35ee605](https://github.com/chrisleekr/github-app-playground/commit/35ee605f3f4cc447fe3f6bec4f9d4ae711f150b4))


### Features

* **workflows:** add label-dispatched bot workflow foundation ([#49](https://github.com/chrisleekr/github-app-playground/issues/49)) ([1b18779](https://github.com/chrisleekr/github-app-playground/commit/1b187792c5e1a8f78ae08e820e2281a11414a161))

## [1.2.2](https://github.com/chrisleekr/github-app-playground/compare/v1.2.1...v1.2.2) (2026-04-20)


### Bug Fixes

* **orchestrator:** await Valkey connect before flipping isReady ([#37](https://github.com/chrisleekr/github-app-playground/issues/37)) ([372af9d](https://github.com/chrisleekr/github-app-playground/commit/372af9dd272e1a7a1e8890f4738c77d05dace76f))

## [1.2.1](https://github.com/chrisleekr/github-app-playground/compare/v1.2.0...v1.2.1) (2026-04-20)


### Bug Fixes

* **ci:** resolve gitleaks false positives and add dedicated secrets-scan workflow ([#36](https://github.com/chrisleekr/github-app-playground/issues/36)) ([a27df4b](https://github.com/chrisleekr/github-app-playground/commit/a27df4bb58524d732b86cbfb43d13a94a53cf19f))

## [1.2.0](https://github.com/chrisleekr/github-app-playground/compare/v1.1.1...v1.2.0) (2026-04-19)


### Features

* split orchestrator/daemon images, default Opus 4.7, fix PEM parsing ([#32](https://github.com/chrisleekr/github-app-playground/issues/32)) ([70b4b32](https://github.com/chrisleekr/github-app-playground/commit/70b4b328c2e60525c7e59ddbf1396fd3606acb00))

## [1.1.1](https://github.com/chrisleekr/github-app-playground/compare/v1.1.0...v1.1.1) (2026-04-18)


### Bug Fixes

* **deploy:** set NODE_ENV=production during build and bundle daemon entrypoint ([#31](https://github.com/chrisleekr/github-app-playground/issues/31)) ([87ae7e2](https://github.com/chrisleekr/github-app-playground/commit/87ae7e2b2a3b30bca3401121346f50ddfded059f))

## [1.1.0](https://github.com/chrisleekr/github-app-playground/compare/v1.0.0...v1.1.0) (2026-04-17)


### Bug Fixes

* **orchestrator:** use IN ${db(ids)} in repo-knowledge to fix Bun.sql array binding ([#26](https://github.com/chrisleekr/github-app-playground/issues/26)) ([d5e1b17](https://github.com/chrisleekr/github-app-playground/commit/d5e1b17f412e009c880d740a68c03cdadba8fe0f))
* **research:** update schedule ([ac300d5](https://github.com/chrisleekr/github-app-playground/commit/ac300d5eeba73fe318b73f6fe5cbb393e4dc3cb5))


### Features

* **auth:** add CLAUDE_CODE_OAUTH_TOKEN support with ALLOWED_OWNERS allowlist ([#10](https://github.com/chrisleekr/github-app-playground/issues/10)) ([445d354](https://github.com/chrisleekr/github-app-playground/commit/445d354487ae46bd6a82772a74c09822621456b0))
* **ci:** add scheduled research workflow with claude-code-action ([#9](https://github.com/chrisleekr/github-app-playground/issues/9)) ([f67c5db](https://github.com/chrisleekr/github-app-playground/commit/f67c5dbcd8edb5584b7ab4a08a51d69767f2aad4))
* **core:** extract inline pipeline and add database foundation for dual-mode dispatch ([#13](https://github.com/chrisleekr/github-app-playground/issues/13)) ([f05e818](https://github.com/chrisleekr/github-app-playground/commit/f05e8182f5f01c85473f7c68af063dbcd9de8e20))
* **daemon:** add persistent repo memory, env var injection, and dev E2E tooling ([#14](https://github.com/chrisleekr/github-app-playground/issues/14)) ([585156f](https://github.com/chrisleekr/github-app-playground/commit/585156f2db6ee8ef889122018e07f20fa132d3e6))
* triage-dispatch-modes Slice B — setup + foundational (T001-T013) ([#18](https://github.com/chrisleekr/github-app-playground/issues/18)) ([d0533eb](https://github.com/chrisleekr/github-app-playground/commit/d0533eb55ef9a0319288063f1dd9ecd55013e83d))
* triage-dispatch-modes Slice C — US1 MVP label/keyword routing (T014-T026) ([#19](https://github.com/chrisleekr/github-app-playground/issues/19)) ([2b345ee](https://github.com/chrisleekr/github-app-playground/commit/2b345ee365c7070c79413429757a3327610ad893))
* **triage:** Slice D — US2 auto-mode probabilistic dispatch ([#20](https://github.com/chrisleekr/github-app-playground/issues/20)) ([457eb4e](https://github.com/chrisleekr/github-app-playground/commit/457eb4ee321fcce5ed8ae210f813787d4c28ac09))
* **triage:** Slice E (part 1) — isolated-job capacity gate + pending queue + drainer ([#21](https://github.com/chrisleekr/github-app-playground/issues/21)) ([7653b0d](https://github.com/chrisleekr/github-app-playground/commit/7653b0db655bd70dbea180c288e0e03553867923))
* **triage:** slice E part 2 — isolated-job completion watcher (T042/T046–T049) ([#22](https://github.com/chrisleekr/github-app-playground/issues/22)) ([c0e86dd](https://github.com/chrisleekr/github-app-playground/commit/c0e86dd897dba34133b87ba9cd1e97c15936e161))
* **triage:** slice F — US4 telemetry aggregates + log contract (T050–T054) ([#24](https://github.com/chrisleekr/github-app-playground/issues/24)) ([bb7fa9f](https://github.com/chrisleekr/github-app-playground/commit/bb7fa9f7f9df76e20cc2608c06f28b892383d2ff))

## 1.0.0 (2026-02-19)


### Bug Fixes

* **deps:** upgrade zod to v4, prepar e npm publish, fix CI peer-dep conflict ([#3](https://github.com/chrisleekr/github-app-playground/issues/3)) ([84564a8](https://github.com/chrisleekr/github-app-playground/commit/84564a8c9a2a5f4b9f5722ce77db383168efd47c))
