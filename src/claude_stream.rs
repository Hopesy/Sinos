//! Read-only function hooks in the official interactive Claude process. The
//! loopback collector is per terminal; existing PTY input/approval stays intact.
use crate::codex_stream::{Event, Page};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub const URL_ENV: &str = "SINOS_CLAUDE_BRIDGE_URL";
pub const TOKEN_ENV: &str = "SINOS_CLAUDE_BRIDGE_TOKEN";
pub const HOOKS_ENV: &str = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";
const MAX_ITEM: usize = 160_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub struct Journal {
    epoch: String,
    sequence: u64,
    bytes: usize,
    events: VecDeque<(Event, usize)>,
    session: Option<String>,
    metadata: Option<Value>,
    complete: bool,
    incoming: u64,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            bytes: 0,
            events: VecDeque::new(),
            session: None,
            metadata: None,
            complete: true,
            incoming: 0,
        }
    }
}
impl Journal {
    pub fn session_id(&self) -> Option<String> {
        self.session.clone()
    }
    fn packet(&mut self, body: &Value) {
        let Some(sequence) = body["sequence"].as_u64() else {
            return;
        };
        if sequence <= self.incoming {
            return;
        }
        if sequence != self.incoming + 1 {
            self.complete = false;
        }
        self.incoming = sequence;
        if let Some(events) = body["events"].as_array().filter(|a| a.len() <= 64) {
            for event in events {
                self.observe(event);
            }
        }
    }
    fn reset(&mut self) {
        self.epoch = uuid::Uuid::new_v4().to_string();
        self.events.clear();
        self.bytes = 0;
        self.sequence = 0;
        self.complete = true;
    }
    fn push(&mut self, message: Value) {
        let bytes = message.to_string().len();
        if bytes > MAX_ITEM {
            self.complete = false;
            return;
        }
        self.sequence += 1;
        self.bytes += bytes;
        self.events.push_back((
            Event {
                sequence: self.sequence,
                message,
            },
            bytes,
        ));
        while self.bytes > MAX_BYTES || self.events.len() > 16000 {
            if let Some((_, bytes)) = self.events.pop_front() {
                self.bytes -= bytes;
                self.complete = false;
            }
        }
    }
    fn observe(&mut self, event: &Value) {
        // Copy only the visible, documented fields. Unknown/opaque/signed
        // events, credentials and plugin metadata never cross the relay.
        let Some(kind) = event["kind"].as_str() else {
            return;
        };
        if kind == "gap" {
            self.complete = false;
            return;
        }
        if kind == "end"
            && self.session.as_deref() == event["session"].as_str()
            && matches!(event["reason"].as_str(), Some("clear" | "resume"))
        {
            self.reset();
            self.session = None;
            self.metadata = None;
            return;
        }
        let fields: &[&str] = match kind {
            "session" => &["session", "model", "cwd", "percent"],
            "start" => &["turn", "text"],
            "text" | "thinking" | "input" => &["turn", "step", "index", "model", "text"],
            "tool" => &["turn", "step", "index", "model", "id", "name"],
            "step" => &["turn", "step", "model"],
            "result" => &["turn", "id", "text", "failed"],
            "complete" => &["turn", "reason"],
            _ => return,
        };
        if kind == "session" {
            let Some(id) = event["session"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() < 160)
            else {
                return;
            };
            if self.session.as_deref() != Some(id) {
                self.reset();
                self.session = Some(id.into());
            }
        } else if self.session.is_none() {
            return;
        }
        if kind == "start" && !self.complete {
            self.reset();
            if let Some(metadata) = self.metadata.clone() {
                self.push(metadata);
            }
        }
        let mut clean = json!({"kind":kind});
        for key in fields {
            if let Some(value) = event.get(*key) {
                if value.is_string() || value.is_boolean() || value.is_number() {
                    clean[*key] = value.clone();
                }
            }
        }
        if kind == "session" {
            self.metadata = Some(clean.clone());
        }
        self.push(clean);
    }
    pub fn page(&self, epoch: Option<&str>, cursor: u64) -> Page {
        let first = self
            .events
            .front()
            .map_or(self.sequence + 1, |(event, _)| event.sequence);
        let reset = epoch != Some(self.epoch.as_str())
            || cursor > self.sequence
            || cursor.saturating_add(1) < first;
        let mut bytes = 0;
        let events: Vec<_> = self
            .events
            .iter()
            .filter(|(event, _)| reset || event.sequence > cursor)
            .take_while(|(_, size)| {
                bytes += size;
                bytes <= 196_608
            })
            .map(|(event, _)| event.clone())
            .collect();
        let cursor = events.last().map_or(self.sequence, |event| event.sequence);
        Page {
            epoch: self.epoch.clone(),
            cursor,
            reset,
            online: self.session.is_some(),
            complete: self.complete,
            has_more: cursor < self.sequence,
            thread_id: self.session.clone(),
            events,
        }
    }
}

#[derive(Clone)]
struct Collector {
    token: String,
    journal: Arc<Mutex<Journal>>,
}
async fn collect(
    State(state): State<Collector>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    if headers.contains_key("origin")
        || headers.get("authorization").and_then(|h| h.to_str().ok()) != Some(state.token.as_str())
    {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(events) = body["events"].as_array().filter(|a| a.len() <= 64) else {
        return StatusCode::BAD_REQUEST;
    };
    let Ok(mut journal) = state.journal.lock() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let _ = events;
    journal.packet(&body);
    StatusCode::NO_CONTENT
}

pub struct Bridge {
    pub endpoint: String,
    pub token: String,
    pub plugin: PathBuf,
    pub journal: Arc<Mutex<Journal>>,
    stop: Arc<AtomicBool>,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
impl Bridge {
    pub fn stop_handle(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
}

fn command(program: &str, env: &[(String, String)]) -> std::process::Command {
    #[cfg(windows)]
    let mut command = if program.to_ascii_lowercase().ends_with(".exe") {
        std::process::Command::new(program)
    } else {
        let mut c = std::process::Command::new(
            std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
        );
        c.args(["/d", "/c", program]);
        c
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .envs(env.iter().cloned())
        .env(HOOKS_ENV, "1")
        .stdin(std::process::Stdio::null());
    command
}
pub fn eligible(program: &str, args: &[String], env: &[(String, String)]) -> bool {
    let stem = std::path::Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let disabled = env
        .iter()
        .rev()
        .find(|(k, _)| k == HOOKS_ENV)
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(HOOKS_ENV).ok());
    stem.eq_ignore_ascii_case("claude")
        && !disabled
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "off"))
        && !args.iter().any(|a| {
            matches!(
                a.split('=').next().unwrap_or(""),
                "--" | "-p"
                    | "--print"
                    | "--bare"
                    | "--disable-slash-commands"
                    | "--help"
                    | "-h"
                    | "--version"
                    | "-v"
                    | "--sdk-url"
                    | "--remote-control"
                    | "--rc"
                    | "--remote"
                    | "--bg"
                    | "--background"
                    | "--plugin-dir"
            ) || (a.starts_with("-p") && !a.starts_with("--"))
                || matches!(
                    a.as_str(),
                    "plugin"
                        | "plugins"
                        | "auth"
                        | "mcp"
                        | "update"
                        | "install"
                        | "doctor"
                        | "attach"
                        | "remote-control"
                )
        })
}

pub fn start(program: &str, env: &[(String, String)]) -> anyhow::Result<Bridge> {
    let plugin = std::env::temp_dir().join(format!("sinos-claude-mobile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&plugin)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o700))?;
    }
    let setup = || -> anyhow::Result<()> {
        std::fs::create_dir(plugin.join(".claude-plugin"))?;
        std::fs::create_dir(plugin.join("hooks"))?;
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            include_str!("claude-mobile/.claude-plugin/plugin.json"),
        )?;
        std::fs::write(
            plugin.join("hooks/hooks.json"),
            include_str!("claude-mobile/hooks/hooks.json"),
        )?;
        std::fs::write(
            plugin.join("hooks/register.ts"),
            include_str!("claude-mobile/hooks/register.ts"),
        )?;
        let mut child = command(program, env)
            .args(["plugin", "validate"])
            .arg(&plugin)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        #[cfg(windows)]
        let _job = crate::terminal::windows_job::session_job(child.id());
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("Claude hook capability probe timed out");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let result = child.wait_with_output()?;
        let text = String::from_utf8_lossy(&result.stdout);
        anyhow::ensure!(
            result.status.success() && text.contains("turn.step") && text.contains("$.http.fetch"),
            "Claude does not support the mobile event hooks"
        );
        Ok(())
    };
    if let Err(error) = setup() {
        let _ = std::fs::remove_dir_all(&plugin);
        return Err(error);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let endpoint = format!("http://127.0.0.1:{}/events", listener.local_addr()?.port());
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let journal = Arc::new(Mutex::new(Journal::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let state = Collector {
        token: format!("Bearer {token}"),
        journal: journal.clone(),
    };
    let stopped = stop.clone();
    let directory = plugin.clone();
    std::thread::Builder::new()
        .name("claude-mobile".into())
        .spawn(move || {
            let file = directory.join("events.json");
            let journal = state.journal.clone();
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(async move {
                    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                        return;
                    };
                    let app = Router::new()
                        .route("/events", post(collect))
                        .layer(DefaultBodyLimit::max(196_608))
                        .with_state(state);
                    let _ = axum::serve(listener, app)
                        .with_graceful_shutdown(async move {
                            let mut modified = None;
                            while !stopped.load(Ordering::Acquire) {
                                // File IPC also works when Claude disables nonessential
                                // network traffic. Partial writes are retried, never shown.
                                if let Ok(meta) = std::fs::symlink_metadata(&file) {
                                    if meta.is_file()
                                        && !meta.file_type().is_symlink()
                                        && meta.len() <= 196_608
                                        && meta.modified().ok() != modified
                                    {
                                        use std::io::Read;
                                        let mut bytes = Vec::new();
                                        if let Ok(handle) = std::fs::File::open(&file) {
                                            let _ = handle.take(196_609).read_to_end(&mut bytes);
                                        }
                                        if bytes.len() <= 196_608 {
                                            if let Ok(Value::Array(packets)) =
                                                serde_json::from_slice(&bytes)
                                            {
                                                if let Ok(mut journal) = journal.lock() {
                                                    for packet in packets.iter().take(64) {
                                                        journal.packet(packet);
                                                    }
                                                }
                                                modified = meta.modified().ok();
                                            }
                                        }
                                    }
                                }
                                tokio::time::sleep(Duration::from_millis(25)).await;
                            }
                        })
                        .await;
                });
            }
            let _ = std::fs::remove_dir_all(directory);
        })?;
    Ok(Bridge {
        endpoint,
        token,
        plugin,
        journal,
        stop,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_replays_deduplicates_and_filters_fields() {
        let mut journal = Journal::default();
        journal.observe(&json!({"kind":"session","session":"a","model":"test","apiKey":"secret"}));
        journal.observe(&json!({"kind":"opaque","text":"private"}));
        journal.observe(&json!({"kind":"start","turn":"t1","text":"Hi"}));
        journal.observe(
            &json!({"kind":"text","turn":"t1","step":0,"index":0,"text":"1. First\n2. Second"}),
        );
        journal.observe(&json!({"kind":"thinking","turn":"t1","step":0,"index":1,"text":"Visible thought","signature":"secret","encryptedContent":"private"}));
        let page = journal.page(None, 0);
        assert!(page.online && page.complete && page.reset);
        assert_eq!(page.events.len(), 4);
        assert!(!serde_json::to_string(&page).unwrap().contains("secret"));
        assert!(!serde_json::to_string(&page).unwrap().contains("private"));
        assert_eq!(page.events.last().unwrap().message["text"], "Visible thought");
        assert!(journal
            .page(Some(&page.epoch), page.cursor)
            .events
            .is_empty());
        journal.observe(&json!({"kind":"session","session":"b"}));
        assert_ne!(journal.page(None, 0).epoch, page.epoch);
    }
    #[test]
    fn oversized_or_missing_events_fall_back_until_next_turn() {
        let mut journal = Journal::default();
        journal.observe(&json!({"kind":"session","session":"a"}));
        journal.observe(&json!({"kind":"text","text":"x".repeat(MAX_ITEM)}));
        assert!(!journal.page(None, 0).complete);
        journal.observe(&json!({"kind":"start","turn":"t2","text":"Hi"}));
        let page = journal.page(None, 0);
        assert!(page.complete);
        assert_eq!(page.events[0].message["kind"], "session");
        journal.observe(&json!({"kind":"gap"}));
        assert!(!journal.page(None, 0).complete);
    }
    #[test]
    fn collector_requires_private_capability_and_rejects_browser_origins() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let state = Collector {
                    token: "Bearer test".into(),
                    journal: Arc::new(Mutex::new(Journal::default())),
                };
                let body = json!({"sequence":1,"events":[{"kind":"session","session":"a"}]});
                let mut headers = HeaderMap::new();
                assert_eq!(
                    collect(State(state.clone()), headers.clone(), Json(body.clone())).await,
                    StatusCode::UNAUTHORIZED
                );
                headers.insert("authorization", "Bearer test".parse().unwrap());
                headers.insert("origin", "http://localhost".parse().unwrap());
                assert_eq!(
                    collect(State(state.clone()), headers.clone(), Json(body.clone())).await,
                    StatusCode::UNAUTHORIZED
                );
                headers.remove("origin");
                assert_eq!(
                    collect(State(state), headers, Json(body)).await,
                    StatusCode::NO_CONTENT
                );
            });
    }
    #[test]
    fn preserves_explicit_modes_and_disabled_hooks() {
        assert!(eligible("claude", &[], &[]));
        assert!(!eligible("claude", &[], &[(HOOKS_ENV.into(), "0".into())]));
        for mode in [
            "--print",
            "--bare",
            "--sdk-url=x",
            "--plugin-dir=x",
            "--rc",
            "-phello",
        ] {
            assert!(!eligible("claude", &[mode.into()], &[]));
        }
    }
    #[test]
    #[ignore = "requires current Claude CLI; isolated official TUI with a local fake model"]
    fn real_tui_loads_read_only_mobile_hooks() {
        use std::io::{Read, Write};
        // Real API protocol, served entirely on loopback with fake credentials.
        // No provider request, paid turn, workspace file or user config is used.
        async fn fake_model(Json(request): Json<Value>) -> axum::response::Response {
            use axum::response::IntoResponse;
            let message = json!({"id":"msg_sinos_fixture","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":0}});
            if request["stream"] != true {
                return Json(json!({"id":"msg_sinos_fixture","type":"message","role":"assistant","model":"claude-test","content":[{"type":"text","text":"fixture"}],"stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":1}})).into_response();
            }
            let events = vec![
                json!({"type":"message_start","message":message}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking the isolated fixture."}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"fixture-opaque-signature"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"1. **First**\n"}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"2. Second\n\n```ts\n"}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"const x = 1;\n```\n"}}),
                json!({"type":"content_block_stop","index":1}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}),
                json!({"type":"message_stop"}),
            ];
            let stream = futures_util::stream::iter(events.into_iter().map(|event| {
                format!(
                    "event: {}\ndata: {}\n\n",
                    event["type"].as_str().unwrap(),
                    event
                )
            }));
            let stream = futures_util::StreamExt::then(stream, |event| async {
                tokio::time::sleep(Duration::from_millis(180)).await;
                Ok::<_, std::convert::Infallible>(event)
            });
            axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(axum::body::Body::from_stream(stream))
                .unwrap()
        }
        let fixture_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        fixture_listener.set_nonblocking(true).unwrap();
        let api = format!(
            "http://127.0.0.1:{}",
            fixture_listener.local_addr().unwrap().port()
        );
        let fixture_stop = Arc::new(AtomicBool::new(false));
        let stop = fixture_stop.clone();
        let fixture = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let listener = tokio::net::TcpListener::from_std(fixture_listener).unwrap();
                    let _ = axum::serve(
                        listener,
                        Router::new().route("/v1/messages", post(fake_model)),
                    )
                    .with_graceful_shutdown(async move {
                        while !stop.load(Ordering::Acquire) {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    })
                    .await;
                });
        });
        let program = std::env::var("SINOS_TEST_CLAUDE").expect("set SINOS_TEST_CLAUDE");
        let home = std::env::temp_dir().join(format!("sinos-claude-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let path = home.to_string_lossy().into_owned();
        let config = json!({"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.282","theme":"dark","customApiKeyResponses":{"approved":["sk-ant-sinos-test"],"rejected":[]},"projects":{path.clone():{"hasTrustDialogAccepted":true},path.replace('\\',"/"):{"hasTrustDialogAccepted":true}}});
        std::fs::write(home.join(".claude.json"), config.to_string()).unwrap();
        let env = vec![
            ("CLAUDE_CONFIG_DIR".into(), path.clone()),
            ("ANTHROPIC_BASE_URL".into(), api),
            ("ANTHROPIC_API_KEY".into(), "sk-ant-sinos-test".into()),
            (
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                "1".into(),
            ),
            ("ANTHROPIC_AUTH_TOKEN".into(), "".into()),
            ("CLAUDE_CODE_OAUTH_TOKEN".into(), "".into()),
        ];
        let bridge = start(&program, &env).unwrap();
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        #[cfg(windows)]
        let mut cmd = {
            let mut c = portable_pty::CommandBuilder::new(std::env::var("COMSPEC").unwrap());
            c.args(["/d", "/c", &program]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = portable_pty::CommandBuilder::new(&program);
        cmd.arg("--debug-file");
        cmd.arg(home.join("debug.log"));
        cmd.arg("--plugin-dir");
        cmd.arg(&bridge.plugin);
        cmd.cwd(&home);
        for (key, value) in &env {
            cmd.env(key, value);
        }
        cmd.env(HOOKS_ENV, "1");
        cmd.env(URL_ENV, &bridge.endpoint);
        cmd.env(TOKEN_ENV, &bridge.token);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        #[cfg(windows)]
        let job = crate::terminal::windows_job::session_job(child.process_id().unwrap());
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let reply = writer.clone();
        let output = Arc::new(Mutex::new(String::new()));
        let captured = output.clone();
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]);
                if text.contains("\x1b[6n") {
                    let mut writer = reply.lock().unwrap();
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                let mut out = captured.lock().unwrap();
                if out.len() < 128000 {
                    out.push_str(&text);
                }
            }
        });
        std::thread::sleep(Duration::from_secs(3));
        {
            let mut writer = writer.lock().unwrap();
            crate::remote_input::paste_and_submit(writer.as_mut(), "Sinos mobile fixture").unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        let mut streamed = false;
        while std::time::Instant::now() < deadline {
            let page = bridge.journal.lock().unwrap().page(None, 0);
            let text = page.events.iter().any(|e| e.message["kind"] == "text");
            let done = page.events.iter().any(|e| e.message["kind"] == "complete");
            streamed |= text && !done;
            if done || child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let page = bridge.journal.lock().unwrap().page(None, 0);
        if let Ok(projects) = std::fs::read_dir(home.join("projects")) {
            for project in projects.flatten() {
                let log = project
                    .path()
                    .join(format!("{}.jsonl", page.thread_id.as_deref().unwrap_or("")));
                if let Ok(text) = std::fs::read_to_string(log) {
                    let identities: Vec<_> = text
                        .lines()
                        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                        .filter(|row| row["type"] == "user")
                        .map(|row| json!({"uuid":row["uuid"],"turnId":row["turnId"]}))
                        .collect();
                    let _ = std::fs::write(
                        "target/claude-research/native-identity.json",
                        serde_json::to_string(&identities).unwrap(),
                    );
                }
            }
        }
        // /clear must detach the previous session immediately, before a new
        // model turn. This also verifies command/session lifecycle hooks.
        {
            let mut writer = writer.lock().unwrap();
            writer.write_all(b"/clear\r").unwrap();
            writer.flush().unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while bridge.journal.lock().unwrap().session_id() == page.thread_id
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        let cleared = bridge.journal.lock().unwrap().session_id() != page.thread_id;
        let _ = child.kill();
        #[cfg(windows)]
        drop(job);
        let _ = child.wait();
        let screen = output.lock().unwrap().clone();
        let _ = std::fs::write("target/claude-research/tui-output.txt", &screen);
        let _ = std::fs::copy(
            home.join("debug.log"),
            "target/claude-research/tui-debug.log",
        );
        let _ = std::fs::write(
            "target/claude-research/tui-events.json",
            serde_json::to_string_pretty(&page).unwrap(),
        );
        drop(bridge);
        let _ = std::fs::remove_dir_all(&home);
        fixture_stop.store(true, Ordering::Release);
        let _ = fixture.join();
        assert!(
            page.thread_id.is_some(),
            "TUI hooks did not initialize; inspect target/claude-research/tui-output.txt"
        );
        assert!(
            streamed,
            "original Markdown must arrive before turn completion"
        );
        let text: String = page
            .events
            .iter()
            .filter(|e| e.message["kind"] == "text")
            .filter_map(|e| e.message["text"].as_str())
            .collect();
        assert_eq!(
            text,
            "1. **First**\n2. Second\n\n```ts\nconst x = 1;\n```\n"
        );
        assert!(page.events.iter().any(|event| event.message["kind"] == "thinking" && event.message["text"] == "Checking the isolated fixture."));
        assert!(!serde_json::to_string(&page).unwrap().contains("fixture-opaque-signature"));
        assert!(cleared, "/clear must stop projecting the old session");
    }
}
