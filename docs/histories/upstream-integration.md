# Upstream integration record

## Source integration — 2026-11-12

Integration target: Coffee-CLI `main` at
`23b290bf5e01849bea2d6a99657491da88aacafd`, 364 commits after the previous
integration point `3176d7473cceee22d05b34779a37033ad8fa2cb8`.
Sinos starts from `c1d07566a8163cd6d72a36bd1350192b8bad7432` (`v4.0.5`).
Upstream ancestry is retained through a merge commit. Version `4.0.5` was
kept during source integration; formal release preparation targets `4.0.6`.

### Imported behavior

- Native OpenCode and Pi conversations, including models, permissions/questions,
  streaming tools and orchestration support.
- Conversation/worker worktrees, branch merge controls, coordinator roles,
  worker steering/recovery and per-conversation assistant selection.
- Scheduled automations, voice input and microphone/source settings, pre-input
  notes, turn usage/cost summaries and refreshable bundled model prices.
- Claude cold-context continuation, titles and prompt suggestions; Codex plan and
  continuation controls; richer DeepSeek tool/subagent interaction.
- Verified Agent task experiences, memory recovery, new conversations, terminal
  and conversation path links, custom notification sounds, full-window settings,
  expanded themes, bundled JetBrains Mono and window geometry persistence.
- Multilingual website documentation and routes; platform-specific installer
  download/open behavior.

### Sinos compatibility decisions

- Retain Sinos CLI / Sinos Agent identity and `Hopesy/Sinos` feedback. Preserve
  upstream and third-party attribution in NOTICE, licenses and source notices.
- Keep model keys, messaging tokens and saved SSH passwords in the OS keyring.
  Model settings expose `hasApiKey`, never the stored secret. Optional keys for
  local model services remain supported.
- Update metadata, release notes and installers use only `Hopesy/Sinos` GitHub
  Releases. Installer downloads require published stable metadata, matching
  platform/tag URLs, nonzero size and SHA-256. Mirror-release and static-version
  workflows remain excluded; Linux keeps AppImage fallback.
- Preserve Cloudflare/mobile transport, shared PTY identity and replay behavior,
  editor/image tabs, startup reveal, tray close behavior and task notifications.
  Existing Terminal defaults and saved launch-mode preferences remain intact.
- Extend generation-aware startup cancellation, late-start cleanup, Windows
  per-session Job Objects and hidden conversation rendering to OpenCode/Pi.
- Preserve legacy Antigravity JSONL alongside the new SQLite index, retaining
  readable transcripts and avoiding duplicate history/count entries.
- Preserve the final upstream decision to leave automatic tab restoration off.
- Keep release quality gates, platform artifacts and synchronized installer
  script copies; no release, tag, commit or push is part of this source task.

### Integration regression fixes

- Restore complete German/Spanish translation strings and unique native/frontend
  Antigravity resume presets; assert preset uniqueness in the unified runner.
- Release keyboard focus for DeepSeek, OpenCode and Pi while Settings is open,
  retaining visible/background content. Expanded keyboard regressions exercise
  all five native conversation types, modal ownership and IME composition.
- Keep Sinos's scoped xterm link-hover pointer alongside the new global arrow
  policy, with an explicit selector-scoped regression.
- Give continuation prompt files private unique ownership and automatic cleanup
  on cancelled/failed startup; validate OpenCode's announced loopback URL by its
  parsed authority before using its session credential.
- Adapt speech mock routing to Sinos's retained axum 0.7 without changing provider
  request paths or weakening the HTTP/status/redaction assertions.
- Update browser fixtures for pre-input, Basalt resources and the actual Sinos
  Agent icon; keep both existing and incoming interaction assertions.

### Initial local validation — Windows (before release review)

- Desktop build, ESLint, application/tooling TypeScript checks: passed.
- `npm test`: **379 Vitest tests in 64 files** and **71/71 script regressions** passed.
- `npm run test:browser`: **39/39 browser scripts** passed on the complete rerun.
- Production dependency audit: **0 vulnerabilities**. The full dependency install
  reported 12 moderate vulnerabilities including development dependencies.
- `cargo check --locked`, correctness/suspicious Clippy checks and `cargo build
  --locked`: passed. Ordinary Clippy style warnings remain outside this change's
  cleanup scope.
- `cargo test --locked --no-fail-fast`: **746 passed, 0 failed, 29 ignored**.
- Current compiled executable with `COFFEE_TEST_EXE`: **1/1 native orchestration
  protocol script** passed against local mock services.
- Phone and Android frontend builds plus Capacitor sync: passed.
- Relay typecheck and **3 local unit tests** passed. Local Workers/Durable Objects
  integration passed: encrypted pairing, concurrent claims, reconnect, cancellation
  and stale credential rejection. No production relay deployment was performed.
- Website language-generation check, installed-version five-language release notes,
  synchronized installer scripts, clipboard-wrapper checks and Git whitespace/
  conflict checks: passed.
- Real vendor accounts, live speech services/microphones, system clipboard/native
  notification interactions, physical mobile devices, non-Windows native builds
  and remote five-platform Review/Release CI remain unverified. The 29 ignored
  Rust tests retain their explicit live-tool/account/device/benchmark opt-ins.
- That source-validation phase did not package or publish a release.

### Release review and fixes — 2026-11-12

- Protect ignored files during Worktree cleanup. Resolve the actual Git branch
  when restoring history, and coordinate creation/reopen/cleanup/sweeping with
  leases and deletion tickets so stale cleanup cannot remove a reopened workspace.
  The same protection covers orchestration workers and shared tabs.
- Keep the voice stop control visible during availability refresh; manual edits,
  deletion and sending cancel recording and discard late transcription events.
- Preserve exact Claude/Codex continuation prompts through startup exhaustion or
  first-send failure, with explicit retry/cancel and stale-generation isolation.
- Give simultaneous DeepSeek steer messages unique atomic staging files rather
  than collapsing different message IDs onto a shared temporary file.
- Expire timed Pi dialogs without waiting for another stream event, reject stale
  backend responses, and clear dialogs on abort, settlement and close. Pi emits
  no event for an extension's independent AbortSignal cancellation and no original
  timeout start timestamp; those unobservable protocol cases remain constrained
  by subsequent session events and locally received deadlines.
- Include Worktree routing in history-cache validation and refresh identity.
  Reject malformed cached/remote price rows and tiers before cost rendering.
- Correct obsolete mirror-entry wording while retaining the GitHub-only update
  path and third-party source notices. Regressions enter the unified runners.
- Targeted regressions were reproduced before fixes and rerun after them. The
  complete `v4.0.6` release validation and remote CI checks follow separately.

### Release preflight checkpoint — 2026-11-13

Current TODOs and acceptance gaps are maintained in the [release plan](../exec-plans/active/2026-11-13-release-v4.0.6.md); current compatibility rules are in [the design topic](../design/upstream-compatibility.md). Results below describe this dated checkpoint.

- Release metadata and all five bundled changelog sections target `4.0.6`.
  `cargo check` regenerated the root package version in Cargo.lock.
- Desktop build, ESLint, **382 Vitest tests in 64 files**, **72/72 script
  regressions**, and **39/39 browser scripts** passed. Production dependency
  auditing reports **0 vulnerabilities**.
- Locked Cargo check and correctness/suspicious Clippy checks passed; ordinary
  style warnings remain. Full Rust regression: **753 passed, 29 ignored**.
- Validation runs serially after memory pressure interrupted the first attempt.
  Test artifacts stay under `.Sinos-temp/test-artifacts`. Set
  `GIT_CEILING_DIRECTORIES` to the absolute `.Sinos-temp` path for these runs:
  otherwise non-repository fixtures inherit this checkout's Git root and ignore
  rules. The initial 10 fixture-isolation failures were reproduced, and the
  complete suite passed with the discovery boundary; assertions were unchanged.
- Host memory pressure interrupted the isolated Windows executable build before
  the final native protocol check. On 2026-11-13 the user directed native builds,
  tests and packaging to GitHub Actions and requested removal of local Rust tools
  and caches. The existing Release quality/platform jobs cover the native protocol
  checks; their results remain pending, alongside remote five-platform Review,
  installer download/hash/MSI verification and publication. GitHub login is still
  required. The project release instructions now record this execution policy.

### Relay reconnect fix and held candidate — 2026-11-13

- Pushed release candidate `55fc03a8b17682f15c88c2ee9f77186fd7dbf415`
  (`v4.0.6`). Public GitHub results: [Review passed](https://github.com/Hopesy/Sinos/actions/runs/43367687223),
  [Android passed](https://github.com/Hopesy/Sinos/actions/runs/43367687199), and
  [Release quality failed](https://github.com/Hopesy/Sinos/actions/runs/43367677674)
  with exit 1. Packaging and asset verification were skipped; the full failure
  log requires normal GitHub authentication and remains uninspected.
- After a Cloudflare quota notice, source inspection found that desktop
  `1000/replaced` closes reset retry backoff and reconnected after one second.
  Debug and installed builds shared saved relay credentials, enabling repeated
  mutual eviction while both ran, even without a phone connected. The earlier
  side-by-side debug preview could trigger this defect. Attribution of the full
  Cloudflare daily request total still requires account-side metrics.
- The user requested these fixes before proceeding with release. The candidate
  remains unpublished with its pushed tag preserved; use a new version/tag for
  the eventual release. Current TODOs remain in the same release plan.
- The fix stops displaced owners, adds explicit desktop takeover with a fresh
  owner and preserved pairing identity, retains backoff across short closes,
  and separates debug relay configuration/keyring service from production.
  Frontend pairing waits for the native scope. Formal compatibility and test
  entrypoints are recorded in [the relay design](../design/relay.md).
- Evidence under `.Sinos-temp/relay-reconnect/`: the targeted UI regressions
  first exposed 3 failures and then passed all 8 tests. The real component
  Chromium regression passed with an inspected screenshot. Relay typecheck,
  3 unit tests, and actual local Workers/DO integration passed, including exact
  host replacement and encrypted handoff to the existing guest connection.
  The local helper's first readiness timeout came from ANSI-colored log parsing;
  stripping terminal control sequences fixed that helper without changing the
  Worker or assertions. Both helper runs and storage were loopback-only.
- Full frontend build and lint passed, with **385 Vitest tests in 64 files**,
  **73/73 unit scripts**, and **40/40 browser scripts**. Production dependency
  audit found **0 vulnerabilities**. The new browser regression is automatically
  discovered by the unified browser runner. Remote native verification remains
  pending in the active plan. Rust was not reinstalled, production relay
  configuration was not deployed, and the installed application/user sessions
  were left running.
- Follow-up review identified a close/heartbeat/write race during awaited RPCs,
  stale cross-process device remarks during takeover, and an editable relay
  field before initial status. The transport loop now reads control frames
  independently of ordered RPCs and pending writes, takeover reloads the saved
  credential, and initial address editing/probing waits for the native scope.
  Four transport-loop regressions cover stalled RPCs, pending/failing sends,
  write order and old-channel queue disposal; a credential-loader regression covers other-instance remarks
  and revocation. Native execution remains pending on GitHub. The startup UI
  regression failed before the additional guard and passed after it.
- The follow-up full frontend run passed build/lint but one unchanged syntax-
  highlighting Vitest timed out (384 passed / 1 failed). Its isolated run passed;
  the complete single-worker rerun passed all **385 tests**, followed by
  **73/73 scripts**. The browser run was interrupted when the session ended;
  after the user's continuation request, a full rerun passed **40/40 scripts**.
  Assertions and timeouts remained unchanged. This local result does not
  identify the earlier Release CI failure; its authenticated logs remain outstanding.
- Committed and pushed the fix as `d3f4104c7dedb96424d4a2f23fc8c7d4f4f05ccd`
  after the user explicitly approved the public `Hopesy/Sinos` destination.
  [Review](https://github.com/Hopesy/Sinos/actions/runs/43399496887) and
  [Android](https://github.com/Hopesy/Sinos/actions/runs/43399497008) were triggered.
  Review subsequently failed: frontend's Browser interaction regression tests
  and Windows' Native regression tests report exit code 1. Public job pages gate
  detailed logs behind sign-in; normal `gh` authentication remains unavailable,
  so the failing assertions and root causes are still unconfirmed. Android's
  result remains pending verification. The remote `v4.0.6` tag was verified
  unchanged at `55fc03a8`; no release tag was created and no Release published.

### Retired Coffee brand assets — 2026-11-15

- The user requested removal of remaining Coffee brand images and related entrypoints.
  Removed unused Windows Store tiles, the old iOS/Android icon trees, duplicate
  intermediate icon sources and the retired `rebuild-icons.py` pipeline. Its
  active desktop ICO sizes and website favicon generation now live in the Sinos
  generator, including all ten Windows sizes from 16 to 256 pixels. Current
  desktop bundle icons and the active Capacitor Android vector assets remain Sinos.
- Replaced the coffee-cup/bean file theme with 19 Sinos SVGs generated from the
  canonical brand mark. The saved `coffee` theme ID resolves through the shared
  file-icon helper, including Explorer, Changes and settings previews; its visible
  label is Sinos. The mobile welcome screen and drawer now use the same product mark.
  The mobile home-screen PNG also contained the old cup; it is now regenerated from
  the canonical source and checked against the same-size desktop image.
- Removed seven Coffee screenshots/animations from the website. The homepage uses
  a capture of the current Sinos frontend with its full title visible; regenerated
  all ten language homepages. Corrected three-language uninstall commands and the
  inherited credential-storage description. Runtime log labels, a worktree error
  and the quota client's User-Agent now use the Sinos name.
- Compatibility directories, persisted IDs, native protocols, migration detectors,
  third-party logos, copyright and upstream notices are retained. Brand source and
  generation rules are documented in the compatibility topic.
- Validation on the worktree above `d3f4104c`: desktop, phone and Android frontend
  builds, Capacitor sync and ESLint passed; **386 Vitest tests / 64 files** and
  **74/74 unified scripts** passed. The brand regression first failed on the old
  resource path, then passed with saved-theme mapping and real isolated generation.
  The desktop icon generator was also run in an isolated fixture; all eight bundle
  files decoded and retired assets were not recreated. Browser checks confirmed
  the existing theme selection, mobile logos and updated website image, with
  inspected screenshots. Evidence: `.Sinos-temp/branding-cleanup/`.
- The original intermittent desktop-overlay report remains under investigation.
  This cleanup has no Windows Shell setting changes. Native execution of the
  branding-string edits remains assigned to remote CI. No commit, push, tag or
  publication was performed in this slice.

## Historical integration — 2026-10-31

Merged Coffee-CLI `main` through
`3176d7473cceee22d05b34779a37033ad8fa2cb8` (202 commits since the previous
integration point `c356dc2849b42827094c286bfea99fe44a9a254f`). The upstream
remote is `https://github.com/edison7009/Coffee-CLI.git`.
The Sinos merge parent is `233720d5` (`fix(companion): remove legacy Tailscale
direct transport`). This integration records upstream ancestry in a merge
commit so subsequent updates can use Git's normal merge base.

### Imported behavior

- Native Claude, Codex and DeepSeek Harness conversations, permission/question
  controls, streaming messages, model/effort controls and conversation navigation.
- Built-in Agent, messaging settings, orchestration, native MCP runtime and
  dynamically nested session splits.
- Usage dashboards, richer history, project Git/PR/CI status, review tabs, tool
  settings, skills/memory management and updated tool support.
- Windows ConPTY runtime resources, terminal input/status reconciliation,
  background IPC scheduling, startup rendering and directory validation fixes.
- Unified unit, browser and native protocol runners; release quality gates and
  bundled runtime license/manifest checks.

### Sinos compatibility decisions

- Keep the Sinos package/product identity, version `4.0.2`, Windows startup
  window configuration, AppImage artifacts and existing distribution endpoints.
  Release notes resolve published releases from `Hopesy/Sinos`, matching the
  installed version. The static version file and its writer workflow stay removed.
- Retain Cloudflare relay, encrypted mobile RPC, Android packaging, shared PTY
  session IDs, output sequence/buffer, pause/resume, image input and queued-input
  validation. Tailscale, the legacy port 8787 listener and direct transport remain
  removed by `233720d5`.
- Claude/Codex default to Terminal in Sinos; Desktop remains an explicit persisted
  choice. Phone launches explicitly use Terminal and the phone-reserved session
  ID. Native desktop conversations use upstream's native stores; mobile sharing
  continues through the existing PTY session path.
- Keep hidden conversation processing while a phone watches another tab, desktop
  editor/image tabs and their focus rules, terminal/conversation switching,
  current-screen interaction validation and terminal cursor fixes.
- Retain Antigravity and the existing transcript tool set, workspace filesystem
  boundary checks, root/overwrite protection and per-project Git tracking controls.
- Adopt upstream's hook maintenance policy: startup maintains presentation/npm
  configuration and preserves existing hook entries. Automatic legacy Orca hook
  cleanup from the September integration is superseded by this upstream policy.
- Preserve the website demo assets referenced by the retained Sinos landing page.
  Installer copies in `install/` and `Web-Home/` remain synchronized.
- Resolve compatible dependency audit fixes, including Monaco's DOMPurify
  override. The production dependency audit reports zero vulnerabilities.

### Local validation

- Windows: `cargo check --locked`, `cargo build --locked`, Clippy correctness/
  suspicious lints, and Rust tests: **467 passed, 16 ignored**.
- Frontend Vitest: **348 tests in 58 files passed**; unified script regressions:
  **50/50 passed**, including Sinos mobile launch/hidden-tab coverage.
- Browser interactions: **22/22 scripts passed** across the full run and focused
  reruns after fixing review layout and adapting Explorer preview/editor checks.
- Compiled native orchestration protocol: **1/1 passed**, using local mock services.
- Desktop and phone production builds, Android frontend build/Capacitor sync,
  ESLint and production dependency audit passed.
- Browser fixtures exercise actual components with isolated filesystem/protocol
  services. Physical Android, live Cloudflare/mobile connectivity, real vendor
  accounts and non-Windows native builds await their respective environments.
  Packaging and public release are separate from this source integration.

### Post-merge regression fixes — 2026-10-31

- Give each native Windows Claude session its own kill-on-close Job Object.
  Attach the suspended launcher before resuming it so early descendants inherit
  the job; close, failed initialization and launcher exit release the process
  tree even when a reader retains the session or a writer holds stdin.
- Keep every visible split PTY transcript active, with keyboard confirmation
  routed to the focused pane. Phone subscribers still keep hidden transcripts
  active when desktop utility pages cover them.
- Filter DeepSeek Harness from the phone tool list and reject cached launch
  requests before preparing directories. The phone displays a desktop-only
  explanation while retaining the launch form.
- Keep Explorer file previews and filesystem refresh available with Git tracking
  disabled, while leaving Git polling paused.
- Preserve unread native replies while editor or image tabs cover conversations;
  acknowledge them when the conversation panes become visible again.
- Reveal the main window from a committed React effect after two animation
  frames, with cancellation for StrictMode cleanup. Both tool-registry and UI
  scale initialization gate mounting; the existing native fallback remains.

Follow-up validation on Windows: `cargo check --locked`, correctness/suspicious
Clippy checks, **469 Rust tests passed / 16 ignored**, **349 Vitest tests in 58
files passed**, **51/51 regression scripts passed**, and focused Changes review
and session split browser suites passed. Desktop/phone production builds,
Android frontend build/Capacitor sync, ESLint and `git diff --check` passed.
The process cleanup regression launches an isolated real Windows process tree,
holds the input lock during closure, and verifies a separate session survives.
Version remains `4.0.2`.

### Second review fixes — 2026-10-31

- Give modal dialogs ownership of keyboard input. Settings consumes Escape,
  preserves IME composition and suspends native/PTY pane shortcuts while keeping
  the panes visible. Session handlers also check dialog targets and consumed
  events, including permission cards that listen during event capture.
- Extend the per-session Windows Job Object to Codex and DeepSeek Harness.
  Suspended launchers join their job before resuming; closure and launcher exit
  release descendants even when stdin is busy or a reader retains the session.
- Cancel native startup by tab ID and generation before blocking-pool dispatch.
  Check cancellation before spawning and under the session registration lock;
  shutdown also cancels pending launches. Closing a session releases pending
  protocol replies and sends frontend cleanup immediately after its retain grace
  period, with a second cleanup for late successful startup responses.
- Track DeepSeek model switches and stop/restart operations as the current
  startup lifecycle. Validate client identity and generation after async work so
  a closed or replaced tab cannot register a late orphan runtime or retry.
- Merge DeepSeek history into the latest live state, preserving exit errors,
  approvals and newer messages. Publish readiness only after current-generation
  restoration finishes and the process remains alive.
- Mark DeepSeek unread replies only for a live matching turn that completes
  successfully. Failed, interrupted, duplicate and historical completions leave
  reply markers unchanged.

Validation: **473 Rust tests passed / 16 ignored**, `cargo check --locked`,
correctness/suspicious Clippy checks, **349 Vitest tests in 58 files passed**,
**53/53 unified regression scripts passed**, desktop production build, ESLint
and `git diff --check`. New unified regressions cover **21 lifecycle cases** and
**6 keyboard/focus groups**. Focused browser suites for Codex conversations,
DeepSeek welcome, session splits, question Enter handling and Claude effort
controls all passed (**5/5**). Real isolated Windows process tests passed for
all three native tools, including busy stdin and independent session survival.
The frontend/browser tests use controlled native transport; vendor accounts and
non-Windows native execution were outside this local validation. Version remains
`4.0.2`.

## Historical integration — 2026-09-25

The record below describes the earlier selective integration. Current decisions
above take precedence, particularly upstream ancestry and hook maintenance.

Reviewed on 2026-09-25 against Coffee-CLI `c356dc2849b42827094c286bfea99fe44a9a254f`.
Comparison base: `31af493147f8eedbda6ed188d53efffd04d004ad`.
Sinos starting revision: `81c7d9496d42de4f78f3e1e1bc8b5823207e7084`.

This is a selective integration, not a merge of the entire upstream tree.
Use this record when comparing future upstream changes; the common Git ancestor
does not indicate which fixes have already been ported.

| Sinos commit | Integrated behavior |
| --- | --- |
| `7264045` | Claude OSC spinner states (`1a21e30`), macOS input (`4c02467`), Shiki initialization (`f1c35f4`), conversation tables (`8e6142d`), history keys (`142497a`), Goose icon color (`31d0d49`) |
| `bb8be3e` | Stable history file cache and final cache fixes through `487bfb8`, Claude custom titles (`7dd8bb0`), Codex session-index names (`7543ef9`) |
| `76edaa4` | Terminal geometry, WebGL lifecycle, session-scoped state, live diff and retained conversation scroll owner (`8814e29`, `f6bb8ac`, `1de0487`, `c29d773`, `8ad9c64`) |
| `878c6f9` | Claude/Codex/Kimi desktop interaction parsing and cards (`3606051`, `2566ceb`, `e10a942`), adapted with current-screen validation and cancellable response writes |
| `d49aeef` | OMP history/resume/native title (`cff9f80`), CodeBuddy launch/config/history/resume (`f8ab54f`), conversation navigation centering (`e10a942`), Kimi screen status and completion-chime debounce; preserves existing tool support |
| `ccb75f4` | Adaptive themes and light/glass/terminal refinements (`5781a15`, `28fc8d2`, `38d8417`, `b295c3d`, `3e55a12`), adapted for Monaco, mobile and Android with saved-preference migration and live system appearance |
| `a34e9ed` | Orca configuration cleanup (`2f40aa2`), preserving user sessions, authentication, mixed hooks and JSONC formatting |
| `f4f83c2` | Link operations (`e1edbb7`), adapted to workspace boundaries, root protection, overwrite refusal and copy rollback ownership |
| `038c874` | Tool documentation and mobile runtime regression coverage for OMP and current Claude title frames |

The native build alignment from `5acb3cd` and corresponding frontend/native
regression workflows are included alongside these groups. No version or release
tag changes are part of this integration.

## Compatibility decisions

- Retain mobile runtime, output sequence/buffer, pause/resume, Cloudflare relay,
  Android packaging and the mobile launch session ID.
- Keep background conversation processing when a phone watches a hidden tab.
  Preserve desktop editor focus rules and existing terminal cursor fixes.
- Preserve the existing conversation tool set and Grok/native activity handling.
  Limit the new desktop interaction parser to source-verified tool protocols.
  Mobile answers still pass through the existing backend snapshot validation.
- Retain workspace boundary checks, root protection, overwrite refusal and the
  current directory refresh implementation. Final links can be copied, renamed
  or deleted as entries; linked parent paths cannot escape the workspace. Copy
  preserves links rather than traversing their targets. Unknown reparse points
  remain unsupported; Windows link creation follows OS privilege requirements.
- Retain Sinos hook forwarding and Windows shell detection. Cleanup only removes
  positively identified legacy artifacts and is tested against isolated fixtures.
- Keep notification status separate from mobile queue authorization. OMP native
  title support does not grant automatic queued-input delivery to new tools.
- Keep Sinos identity, version, distribution workflows, Capacitor, Monaco and the
  dynamic release-availability endpoint. Do not restore static `version.json`.
- The upstream experimental incremental-tail history cache was reverted upstream;
  the integrated final cache reparses files that have changed.

## Deliberately excluded changes

The seven follow-up groups (themes, OMP, CodeBuddy, Orca cleanup, link operations,
conversation navigation and status/notification refinements) are integrated.
Upstream Antigravity feature removal, conversation-tool narrowing, removal of
mobile runtime fields, and upstream identity/version/distribution replacements
remain excluded to preserve Sinos capabilities. These are intentional decisions,
not unresolved merge conflicts.

## Validation

- `cd src-ui && npm test` covers existing desktop/mobile behavior and new parser,
  response, card and terminal geometry fixtures.
- `cd src-ui && npm run test:regressions` checks Shiki, history caching, renderer
  lifecycle, conversation virtualization, diff updates and mobile host ownership.
- Desktop, phone and Android frontend builds remain separate build targets.
- Review CI runs frontend checks and native check/tests on Windows, macOS and Linux.
  Android CI builds a debug APK on main pushes; release publishing remains separate.
- Follow-up local validation: 175 frontend tests, all six regression runners,
  source ESLint, desktop/phone/Android frontend builds, `cargo check`, and 174
  native tests passed (three environment-dependent tests remain ignored).
- Browser checks cover desktop light mode and the mobile appearance component at
  390px, including live system light/dark switching. This is not an end-to-end
  Cloudflare, physical Android or live CLI session test.
