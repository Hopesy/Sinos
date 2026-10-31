# Upstream integration record

## Current integration — 2026-10-31

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
