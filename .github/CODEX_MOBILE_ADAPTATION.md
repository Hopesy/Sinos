# Codex mobile adaptation audit — 2026-09-25

Reference: the user-provided `codex-main` source snapshot. This audit does not
modify Codex, change terminal ownership, or replace the relay transport.

## Source contracts checked

- `tui/src/history_cell/messages.rs`: assistant `• ` gutter and two-column continuation prefix.
- `tui/src/markdown_render.rs`: rendered list markers, nesting, emphasis, tables and highlighted code.
- `tui/src/chatwidget/streaming.rs`: incremental rendered lines versus the final Markdown cell.
- `tui/src/bottom_pane/footer.rs`: status lines can temporarily yield to keyboard/queue hints.
- `tui/src/bottom_pane/request_user_input/` and approval snapshots: numbered choices, notes/navigation hints, free-form input and approval scope.
- `rollout/src/policy.rs`, `history/src/rollout_payload.rs`, `protocol/src/{items,models,protocol}.rs`: durable records, paired response/TurnItem records, context usage, model changes and rollback.
- `ext/items/src/{lib,web_search,image_generation,sleep}.rs`, `protocol/src/{user_input,dynamic_tools}.rs`: flattened extension envelopes, camelCase media, image-only turns, tool lifecycle and failure flags.
- `tui/src/history_cell/{mcp,dynamic,search,approvals,notices,plans,patches}.rs`, `tui/src/multi_agents.rs`, `tui/src/chatwidget/{compaction,tests/review_mode}.rs`: actual activity labels, error/warning/info prefixes, review and sub-agent lifecycle.

## Fixes

| Area | Cause | Change |
| --- | --- | --- |
| Lists and paragraphs | Reply gutter confused with a list; blank lines split one answer; stale VT wrap flags joined repainted rows | Codex-specific projection, preserved block boundaries, nested list markers, wrap validation |
| Live formatting | ANSI emphasis discarded; rendered code and table delimiters differ from Markdown | Restore emphasis, recognized syntax-colored code blocks and simple rendered tables; keep other terminal line breaks |
| Rendering latency | Every received frame invalidated previous unfinished decodes | Separate connection epoch, render revision and answer sequence; batch scrollback projection per frame |
| Native handoff | Plain terminal text did not match Markdown; changing keys remounted replies | Compare rendered text conservatively, retain message keys and punctuation, cache immutable native text |
| Code highlighting | Debounce restarted on every chunk and discarded all previous highlighting | Throttle tokenization; retain complete unchanged highlighted lines and render new text immediately |
| Status bar | No Codex-specific status extraction; terminal scrollback was the only state source | Persist observed status; read model/effort/cwd/token count/settings changes from native records; render outside history, including during questions |
| Native history | Only legacy response payloads recognized; line-number IDs changed after prepend | Completed TurnItems, paired-record deduplication, stable row IDs, tool result linking, explicit failure envelopes, tool-search output |
| Interaction | Notes/navigation footer and free-form questions were not recognized | Source-backed choice/text patterns with existing explicit-tap and current-sequence guards |
| Reset/reconnect | Stale questions remained displayed; old decode callbacks could race | Clear reset projection; reject discarded decoder callbacks; never replay input |
| Rollback/rebinding | Removed turns or a previously bound transcript could remain visible | Apply `thread_rolled_back`; clear native state and handoff keys when binding is lost |
| Tools and notices | `Called`/`Calling`, `■`, `⚠`, `ⓘ`, historical approvals and web actions became assistant prose | Recognize source lifecycle markers; collapse multiline details; distinguish informational/warning/error states without creating approval controls |
| Tool handoff | Matching a native call without a result could discard live terminal output | Match command or complete tool signature in reading order, preserve live output in the same tool card, defer to the final native result |
| Media | Image-only user turns vanished; MCP media could become huge base64 text | Retain typed image/audio/resource attachments; preview bounded inline passive media; link remote media on demand; label unavailable local references |
| Tool outcomes | Dynamic `success: false`, MCP `isError`, declined and background commands were misclassified | Normalize failure channels and preserve in-progress state; retain original inputs while enriching completion records |
| Plans and file changes | Native plans and patches were raw JSON/text | Read-only plan checklist; added/deleted file diff, unified update diff, move paths and raw apply_patch fallback |

## Second-pass output coverage

All **19** `TurnItem` variants in this source snapshot have an explicit handling
decision. This is a protocol coverage inventory, not a claim of lossless terminal
reconstruction. New variants in a later Codex release require another audit.

| Source variant | Mobile conversion |
| --- | --- |
| `UserMessage` | Text plus image/audio attachments, including image-only turns |
| `AgentMessage` | Markdown reply; paired raw-response mirror deduplication |
| `FunctionCallOutput` | Link to tool call by ID, preserve orphan result for paginated tails |
| `HookPrompt` | Intentionally hidden internal hook instruction |
| `Plan` | Markdown plan text; `update_plan` tool arguments become a checklist |
| `Reasoning` | Collapsible public summary; raw/encrypted reasoning excluded |
| `CommandExecution` | Command/result card with exit status and in-progress state |
| `DynamicToolCall` | Namespaced tool card with typed content and success/error handling |
| `CollabAgentToolCall` | Sub-task tool card with receiver metadata and outcomes |
| `SubAgentActivity` | Started/interacted/interrupted/completed status record |
| `WebSearch` | Search/open-page/find-in-page arguments and complete persisted results |
| `ImageView` | Viewed-image path/status; local bytes are not available in this record |
| `Extension` | All three declared kinds: `web.search`, `image_gen.generation`, `clock.sleep` |
| `ImageGeneration` | Prompt/saved path, inline image if present, explicit failure |
| `EnteredReviewMode` | Review target/hint card |
| `ExitedReviewMode` | Review summary, findings and exact file/line locations |
| `FileChange` | Add/delete/update/move presentation; failure and decline retained |
| `McpToolCall` | Text, inline media, resource references, structured result and error state |
| `ContextCompaction` | Context-compaction status record |

Legacy `ResponseItem` support includes messages/reasoning, function/custom calls
and outputs, tool search, local shell, web search and image generation. Legacy
end-event support includes MCP, patch, web/image, review, sub-agent, context
compaction and turn interruption. `thread_rolled_back` edits the timeline;
model/settings/token events update the footer rather than becoming messages.
Agent-to-agent envelopes, system/developer instructions, configuration controls,
encrypted compaction data and hook prompts are deliberately excluded.

Fixtures use wire shapes and visible strings from the source, including MCP
errors/multimedia, `web_action_labels_and_missing_details`, local-image-only
messages, plan updates, approvals, compaction and review banners. Unknown or
truncated tool signatures are retained rather than merged by title alone.

## Validation

Final second-pass frontend suite: **221 tests across 39 files**; source/config
ESLint and all six repository regression runners pass. Desktop, phone and
Android frontend builds, Capacitor Android asset sync, and `cargo check` pass.
The Android check is a frontend build/sync, not a Gradle APK build or device test.

Automated coverage includes synthetic VT replays derived from Codex source
snapshots, continuous partial output, stale/out-of-order callbacks, CJK/list
layout, 1,050-row scrollback, model changes, native handoff DOM identity,
paginated/legacy records, rollback, command failures and streaming code tokens.
Existing Claude/menu/input guard regressions remain in the suite.

Browser smoke checks used actual ChatView/VT/Markdown components and a local
synthetic transport at 390×844 and 360×480: nested lists, table, copyable code,
70 numbered items, persistent model/context footer, and interactive choices.
No real command or approval was sent. Temporary preview files were removed.
Second-pass browser checks at 390×844 and 360×480 verified the actual plan,
long-path/moved-file diff and failed MCP cards, including expansion and scrolling.

## Structured live transport

Supported newly launched Codex terminals now run the official TUI against an
owned local `codex app-server --listen ws://127.0.0.1:<port>`. A Sinos loopback
WebSocket proxy observes that same session's v2 JSON-RPC traffic. The TUI's
configuration/trust discovery and session connections share one engine;
connection-scoped request IDs prevent a helper connection from claiming or
duplicating the active thread's events. This does not create a second mobile
conversation and does not modify the user's Codex config or shared daemon.

Both loopback listeners require separate random bearer credentials. The TUI
receives its token through `--remote-auth-token-env`; the engine receives only
its SHA-256 credential digest as a CLI argument. The proxy rejects browser
Origins. Phones use the existing paired local/Cloudflare encrypted transport,
never the app-server port. No new public deployment is needed.

`CodexEventStream.ts` consumes original agent/plan Markdown deltas, public
reasoning summaries, command output, patch updates, MCP progress, plan steps,
completed typed items, model/context updates and activity/approval state.
Markdown reaches the actual ChatView during generation; completed items
replace the same message IDs. Native history provides earlier turns and disk
handoff. Reconnect pages use epoch/sequence cursors and suppress duplicate
delivery. The UI retains the last complete Markdown while reconnecting.

The journal only admits an explicit allowlist for the active root thread.
Account/auth responses, unrelated subagents, hook prompts and raw reasoning
are excluded, including nested items in turn snapshots. The bounded journal
(8 MiB / 16,000 events) explicitly loses authority on overflow, an oversized
item (>160,000 serialized bytes), or `thread/reverted`, whose protocol only
provides a thread ID. VT/native history takes over until the next turn resets
the journal. Pages are bounded to 192 KiB before transport envelopes.

Closing/destroying the terminal stops the owned engine; pause/resume affects
both process trees. Windows uses a per-engine kill-on-close Job Object, Unix
uses an owned process group. The startup probe checks engine readiness before
redirecting the TUI. Unsupported binaries, custom wrapper commands, explicit
remote/daemon overrides, profiles and explicit OSS/local-provider launches
retain the existing path.
Already-running terminals need a new launch to attach this transport.

Validation adds source-shaped reducer/UI/relay fixtures, including partial
lists/code, streamed tools, request ID isolation, replay, gaps, rollback,
overflow, private-data filtering and native handoff. Explicit ignored Rust
smoke tests can be run with `SINOS_TEST_CODEX` set to the CLI executable/shim:
`cargo test codex_stream::tests::real_ -- --ignored --nocapture`.
They use separate temporary Codex homes, perform real protocol and ConPTY TUI
startup, verify the shared thread and shutdown, and never submit a model turn.

Final streaming verification: **244 frontend tests / 40 files**, source/config
ESLint, all six regression runners, `cargo check`, desktop/phone/Android frontend
builds and Capacitor asset sync pass. All nine event-bridge tests pass, including
both real Codex 0.157 smoke tests with
quoted CLI config forwarding, rejected missing credentials/browser Origins,
official TUI startup and engine cleanup. No real model prompt was submitted.

Full Rust suite: **179 passed, 3 failed, 5 ignored**. All three failures concern
Windows directory junctions (workspace escape error classification, Orca
overlay links, history traversal). They reproduce unchanged on clean HEAD
`8bcbff0360d1e4514067f23764f714d88d57b6b8` with the same failures, including
Windows error 448 (untrusted mount point). The temporary baseline worktree was
removed. This change does not weaken filesystem checks to bypass that local
environment restriction. Logs are under `target/codex-stream-*.log`.

## Boundaries

Codex explicitly does **not** persist per-token Markdown deltas. Unsupported or
already-running sessions therefore reconstruct live presentation from VT and
reconcile with native Markdown. Original language tags, uncolored code fences,
OSC link labels and complex wrapped tables cannot always be recovered in that
fallback. Supported structured sessions receive original Markdown directly.

The TUI `/raw` mode removes role gutters; structured events keep their roles,
while fallback sessions rely on native records. Interactive choice widgets
still use the existing PTY menu decoder and output-sequence-guarded input;
structured approval events update activity but never auto-answer requests.
Realtime voice sessions and external MCP app interfaces need dedicated UI;
capturing a structured connection does not imply every protocol method has a
mobile renderer. Cumulative turn diffs are not duplicated when per-file patch
items already provide the diff cards.

Inline image/audio previews are capped at 8 MiB and limited to passive formats.
Local image paths/file IDs without bytes are shown as attachment references,
not fetched from arbitrary desktop paths. Generated images without saved bytes,
external MCP app interfaces, and platform-dependent audio codecs need their own
transport/rendering support; the UI does not imply that these have been fetched.

Source-backed replay and browser checks are not a physical Android/Cloudflare
end-to-end test. No release, relay deployment, or active-session restart is part
of this change.
