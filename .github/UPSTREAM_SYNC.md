# Upstream integration record

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
