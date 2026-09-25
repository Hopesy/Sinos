//! A local bridge between the official Codex TUI and its owned app-server.
//! It observes the same JSON-RPC connection; it never starts a second thread,
//! submits prompts, answers approvals, or exposes provider credentials to phones.
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    Message,
};

const JOURNAL_BYTES: usize = 8 * 1024 * 1024;
const PAGE_BYTES: usize = 196_608;
const ITEM_BYTES: usize = 160_000;
pub const AUTH_ENV: &str = "SINOS_CODEX_BRIDGE_TOKEN";

#[derive(Clone, Serialize)]
pub struct Event {
    pub sequence: u64,
    pub message: Value,
}
#[derive(Serialize)]
pub struct Page {
    pub epoch: String,
    pub cursor: u64,
    pub reset: bool,
    pub online: bool,
    pub complete: bool,
    pub has_more: bool,
    pub thread_id: Option<String>,
    pub events: Vec<Event>,
}
pub struct Journal {
    epoch: String,
    sequence: u64,
    bytes: usize,
    events: VecDeque<(Event, usize)>,
    root: Option<String>,
    owner: Option<u64>,
    pending: HashMap<(u64, String), String>,
    online: bool,
    complete: bool,
    bootstrap: Option<Value>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            bytes: 0,
            events: VecDeque::new(),
            root: None,
            owner: None,
            pending: HashMap::new(),
            online: false,
            complete: true,
            bootstrap: None,
        }
    }
}
impl Journal {
    pub fn thread_id(&self) -> Option<String> {
        self.root.clone()
    }
    pub fn page(&self, epoch: Option<&str>, cursor: u64) -> Page {
        let first = self
            .events
            .front()
            .map_or(self.sequence + 1, |(e, _)| e.sequence);
        let reset = epoch != Some(self.epoch.as_str())
            || cursor > self.sequence
            || cursor.saturating_add(1) < first;
        let start = if reset { 0 } else { cursor };
        let mut size = 0;
        let mut events = Vec::new();
        for (event, bytes) in &self.events {
            if event.sequence <= start {
                continue;
            }
            if size + bytes > PAGE_BYTES && !events.is_empty() {
                break;
            }
            size += bytes;
            events.push(event.clone());
        }
        let cursor = events.last().map_or(self.sequence, |e| e.sequence);
        Page {
            epoch: self.epoch.clone(),
            cursor,
            has_more: cursor < self.sequence,
            reset,
            online: self.online,
            complete: self.complete,
            thread_id: self.root.clone(),
            events,
        }
    }
    fn push(&mut self, message: Value) {
        let bytes = message.to_string().len();
        // Never silently present a truncated structured stream as authoritative.
        // VT/native history remain available if a single item or backlog is too big.
        if bytes > ITEM_BYTES {
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
        while self.bytes > JOURNAL_BYTES || self.events.len() > 16000 {
            if let Some((_, size)) = self.events.pop_front() {
                self.bytes -= size;
                self.complete = false;
            }
        }
    }
    fn client(&mut self, connection: u64, message: &Value) {
        let method = message["method"].as_str().unwrap_or("");
        if matches!(method, "thread/start" | "thread/resume" | "thread/fork")
            && !message["id"].is_null()
        {
            if self.pending.len() < 32 {
                self.pending
                    .insert((connection, message["id"].to_string()), method.into());
            }
        }
    }
    fn server(&mut self, connection: u64, message: &Value) -> Option<(String, Value)> {
        if message.get("id").is_some() && message.get("method").is_none() {
            if self
                .pending
                .remove(&(connection, message["id"].to_string()))
                .is_some()
            {
                let result = &message["result"];
                if let Some(id) = result["thread"]["id"].as_str() {
                    if self.root.as_deref() != Some(id) || self.owner != Some(connection) {
                        self.epoch = uuid::Uuid::new_v4().to_string();
                        self.events.clear();
                        self.bytes = 0;
                        self.sequence = 0;
                        self.complete = true;
                    }
                    self.root = Some(id.to_owned());
                    self.owner = Some(connection);
                    self.online = true;
                    let params = json!({"threadId":id,"model":result["model"],"effort":result["reasoningEffort"],"cwd":result["cwd"],"status":result["thread"]["status"]});
                    self.bootstrap = Some(params.clone());
                    self.push(json!({"method":"sinos/thread","params":params}));
                    // Reattaching an active turn needs the content emitted before attachment.
                    if let Some(turns) = result["thread"]["turns"].as_array() {
                        if let Some(turn) = turns.last().filter(|t| t["status"] == "inProgress") {
                            let mut event = json!({"method":"turn/started","params":{"threadId":id,"turn":turn}});
                            sanitize(&mut event);
                            self.push(event);
                        }
                    }
                    return Some(("sinos/thread".into(), params));
                }
            }
            return None;
        }
        let method = message["method"].as_str()?;
        let params = &message["params"];
        if self.owner != Some(connection)
            || self.root.as_deref() != params["threadId"].as_str()
            || self.root.is_none()
        {
            return None;
        }
        // Explicit allowlist: never relay account/auth, raw reasoning, hook prompts,
        // environment/configuration responses or unrelated/sub-agent threads.
        if !matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "turn/plan/updated"
                | "turn/diff/updated"
                | "item/started"
                | "item/completed"
                | "item/agentMessage/delta"
                | "item/plan/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/summaryPartAdded"
                | "item/commandExecution/outputDelta"
                | "item/fileChange/outputDelta"
                | "item/fileChange/patchUpdated"
                | "item/mcpToolCall/progress"
                | "thread/tokenUsage/updated"
                | "thread/settings/updated"
                | "thread/status/changed"
                | "thread/reverted"
                | "thread/compacted"
                | "error"
                | "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/tool/requestUserInput"
                | "serverRequest/resolved"
        ) {
            return None;
        }
        if matches!(params["item"]["type"].as_str(), Some("hookPrompt")) {
            return None;
        }
        if let Some(bootstrap) = self.bootstrap.as_mut() {
            if method == "thread/settings/updated" {
                for key in ["model", "effort", "cwd"] {
                    if let Some(value) = params["threadSettings"].get(key) {
                        bootstrap[key] = value.clone();
                    }
                }
            } else if method == "thread/status/changed" {
                bootstrap["status"] = params["status"].clone();
            }
        }
        if method == "turn/started" && !self.complete {
            self.epoch = uuid::Uuid::new_v4().to_string();
            self.events.clear();
            self.bytes = 0;
            self.sequence = 0;
            self.complete = true;
            if let Some(p) = self.bootstrap.clone() {
                self.push(json!({"method":"sinos/thread","params":p}));
            }
        }
        let mut observed = message.clone();
        sanitize(&mut observed);
        // Revert only carries threadId, not the removed turn IDs. Disk history
        // contains the rollback count; resume authority at the next turn.
        if method == "thread/reverted" {
            self.complete = false;
        }
        self.push(observed);
        Some((method.to_string(), params.clone()))
    }
    fn disconnected(&mut self, connection: u64) -> bool {
        self.pending.retain(|(owner, _), _| *owner != connection);
        if self.owner == Some(connection) {
            self.online = false;
            self.owner = None;
            true
        } else {
            false
        }
    }
}

fn sanitize(message: &mut Value) {
    fn item(value: &mut Value) {
        if value["type"] == "reasoning" {
            if let Some(value) = value.as_object_mut() {
                value.remove("content");
            }
        }
    }
    let Some(params) = message.get_mut("params") else {
        return;
    };
    if let Some(value) = params.get_mut("item") {
        item(value);
    }
    if let Some(items) = params
        .get_mut("turn")
        .and_then(|turn| turn.get_mut("items"))
        .and_then(Value::as_array_mut)
    {
        items.retain(|value| value["type"] != "hookPrompt");
        for value in items {
            item(value);
        }
    }
}

pub struct Bridge {
    pub endpoint: String,
    pub journal: Arc<Mutex<Journal>>,
    pub process_id: Arc<Mutex<Option<u32>>>,
    pub auth_token: String,
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

#[cfg(unix)]
struct EngineGroup(u32);
#[cfg(unix)]
impl Drop for EngineGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGTERM);
        }
    }
}

fn command(program: &str, env: &[(String, String)]) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = if program.to_ascii_lowercase().ends_with(".exe") {
        std::process::Command::new(program)
    } else {
        let mut c = std::process::Command::new(
            std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
        );
        c.args(["/d", "/c", program]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    cmd
}

/// Preserve custom wrappers/endpoints and noninteractive commands. Support is
/// probed once per binary, without altering any Codex configuration or daemon.
pub fn supported(program: &str, args: &[String], env: &[(String, String)]) -> bool {
    let stem = std::path::Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if stem != "codex"
        || args.iter().any(|a| {
            matches!(
                a.as_str(),
                "--remote"
                    | "--no-daemon"
                    | "--remote-auth-token-env"
                    | "--oss"
                    | "--local-provider"
                    | "-p"
                    | "--profile"
                    | "exec"
                    | "review"
                    | "app-server"
                    | "--help"
                    | "-h"
                    | "--version"
                    | "-V"
            ) || a.starts_with("--remote=")
                || a.starts_with("--profile=")
                || a.starts_with("--remote-auth-token-env=")
                || a.starts_with("--local-provider=")
                || (a.starts_with("-p") && !a.starts_with("--"))
        })
    {
        return false;
    }
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, bool>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(value) = cache.lock().ok().and_then(|c| c.get(program).copied()) {
        return value;
    }
    let result = (|| {
        let mut child = command(program, env)
            .arg("--help")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        #[cfg(windows)]
        let _job = crate::terminal::windows_job::session_job(child.id());
        #[cfg(unix)]
        let _group = EngineGroup(child.id());
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if child.try_wait().ok()?.is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().ok()?;
        let help = String::from_utf8_lossy(&output.stdout);
        Some(
            output.status.success()
                && help.contains("--remote <ADDR>")
                && help.contains("--remote-auth-token-env"),
        )
    })()
    .unwrap_or(false);
    if let Ok(mut c) = cache.lock() {
        c.insert(program.into(), result);
    }
    result
}

fn server_args(args: &[String]) -> Vec<String> {
    let mut out = vec!["app-server".into()];
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if matches!(
            arg.as_str(),
            "-c" | "--config" | "--enable" | "--disable" | "--code-mode-host"
        ) {
            if let Some(value) = args.next() {
                out.extend([arg.clone(), value.clone()]);
            }
        } else if arg.starts_with("--config=")
            || arg.starts_with("-c")
            || arg.starts_with("--code-mode-host=")
            || arg.starts_with("--enable=")
            || arg.starts_with("--disable=")
            || arg == "--strict-config"
        {
            out.push(arg.clone());
        }
    }
    out
}

pub fn start(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &[(String, String)],
    runtime: Arc<Mutex<crate::remote_runtime::Runtime>>,
) -> anyhow::Result<Bridge> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let endpoint = format!("ws://127.0.0.1:{}", listener.local_addr()?.port());
    let reservation = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let engine_endpoint = format!("ws://127.0.0.1:{}", reservation.local_addr()?.port());
    let engine_token = uuid::Uuid::new_v4().simple().to_string();
    let digest = format!("{:x}", Sha256::digest(engine_token.as_bytes()));
    let mut cmd = command(program, env);
    cmd.args(server_args(args))
        .args([
            "--listen",
            &engine_endpoint,
            "--ws-auth",
            "capability-token",
            "--ws-token-sha256",
            &digest,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let journal = Arc::new(Mutex::new(Journal::default()));
    let pid = Arc::new(Mutex::new(None));
    let bridge = Bridge {
        endpoint,
        auth_token: token.clone(),
        journal: journal.clone(),
        process_id: pid.clone(),
        stop: stop.clone(),
    };
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let run = async {
            let listener = TcpListener::from_std(listener)?;
            drop(reservation);
            let mut child = tokio::process::Command::from(cmd)
                .kill_on_drop(true)
                .spawn()?;
            let child_pid = child.id();
            if let Ok(mut p) = pid.lock() {
                *p = child_pid;
            }
            #[cfg(windows)]
            let _job = child_pid
                .and_then(|pid| crate::terminal::windows_job::session_job(pid))
                .ok_or_else(|| std::io::Error::other("Cannot own Codex process tree"))?;
            #[cfg(unix)]
            let _group = child_pid.map(EngineGroup);
            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
            let mut request = engine_endpoint
                .as_str()
                .into_client_request()
                .map_err(std::io::Error::other)?;
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {engine_token}")
                    .parse()
                    .map_err(std::io::Error::other)?,
            );
            let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
            loop {
                if stop.load(Ordering::Acquire)
                    || child.try_wait()?.is_some()
                    || tokio::time::Instant::now() > deadline
                {
                    return Err(std::io::Error::other(
                        "Codex app-server failed to become ready",
                    ));
                }
                if let Ok(Ok((mut probe, _))) = tokio::time::timeout(
                    Duration::from_millis(300),
                    tokio_tungstenite::connect_async(request.clone()),
                )
                .await
                {
                    let _ = probe.close(None).await;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let _ = ready_tx.send(Ok::<(), String>(()));
            // The official TUI opens separate connections for config/trust
            // discovery and its live session. All must reach the SAME engine.
            let mut clients = tokio::task::JoinSet::new();
            let mut connection = 0;
            loop {
                if stop.load(Ordering::Acquire) || child.try_wait()?.is_some() {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                    _ = clients.join_next(), if !clients.is_empty() => {},
                    accepted = listener.accept() => {
                        let (stream, _) = accepted?;
                        if clients.len() >= 8 { continue; }
                        connection += 1;
                        let id = connection;
                        let expected = format!("Bearer {token}");
                        let request = request.clone();
                        let journal = journal.clone(); let runtime = runtime.clone();
                        clients.spawn(async move {
                            let handshake = tokio_tungstenite::accept_hdr_async(stream, move |request: &Request, response: Response| {
                                if request.uri().path() == "/" && request.headers().get("authorization").is_some_and(|value| value == expected.as_str()) && !request.headers().contains_key("origin") { Ok(response) }
                                else { let mut rejected = ErrorResponse::new(Some("Forbidden".into())); *rejected.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN; Err(rejected) }
                            });
                            let Ok(Ok(socket)) = tokio::time::timeout(Duration::from_secs(2), handshake).await else { return; };
                            let Ok(Ok((engine, _))) = tokio::time::timeout(Duration::from_secs(2), tokio_tungstenite::connect_async(request)).await else { return; };
                            let (mut ui_send, mut ui_read) = socket.split();
                            let (mut engine_send, mut engine_read) = engine.split();
                            loop {
                                tokio::select! {
                                    message = engine_read.next() => {
                                        let Some(Ok(message)) = message else { break; };
                                        if let Message::Text(text) = &message {
                                            if let Ok(value) = serde_json::from_str::<Value>(text) {
                                                let activity = journal.lock().ok().and_then(|mut j| j.server(id, &value));
                                                if let Some((method, params)) = activity { if let Ok(mut r) = runtime.lock() { r.observe_codex(&method, &params); } }
                                            }
                                        }
                                        let closing = message.is_close();
                                        if !matches!(tokio::time::timeout(Duration::from_secs(3), ui_send.send(message)).await, Ok(Ok(()))) || closing { break; }
                                    },
                                    message = ui_read.next() => {
                                        let Some(Ok(message)) = message else { break; };
                                        if let Message::Text(text) = &message {
                                            if let Ok(value) = serde_json::from_str::<Value>(text) { if let Ok(mut j) = journal.lock() { j.client(id, &value); } }
                                        }
                                        let closing = message.is_close();
                                        if !matches!(tokio::time::timeout(Duration::from_secs(3), engine_send.send(message)).await, Ok(Ok(()))) || closing { break; }
                                    }
                                }
                            }
                            if journal.lock().ok().is_some_and(|mut j| j.disconnected(id)) {
                                if let Ok(mut r) = runtime.lock() { r.codex_disconnected(); }
                            }
                        });
                    }
                }
            }
            clients.abort_all();
            while clients.join_next().await.is_some() {}
            #[cfg(unix)]
            if let Some(pid) = child_pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
            }
            let _ = child.kill().await;
            Ok::<(), std::io::Error>(())
        };
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => {
                if let Err(error) = rt.block_on(run) {
                    let _ = ready_tx.send(Err(error.to_string()));
                }
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
            }
        }
        if let Ok(mut j) = journal.lock() {
            j.online = false;
        }
        if let Ok(mut p) = pid.lock() {
            *p = None;
        }
        if let Ok(mut r) = runtime.lock() {
            r.codex_disconnected();
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(6))
        .map_err(|_| anyhow::anyhow!("Codex bridge startup timed out"))?
        .map_err(anyhow::Error::msg)?;
    Ok(bridge)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bound() -> Journal {
        let mut j = Journal::default();
        bind(&mut j, "root");
        j.online = true;
        j
    }
    fn bind(j: &mut Journal, id: &str) {
        j.client(1, &json!({"id":1,"method":"thread/start"}));
        j.server(1, &json!({"id":1,"result":{"thread":{"id":id,"status":{"type":"idle"}},"model":"test-model","reasoningEffort":"high","cwd":"/work"}}));
    }
    fn event(method: &str, fields: Value) -> Value {
        let mut params = json!({"threadId":"root","turnId":"turn"});
        params
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        json!({"method":method,"params":params})
    }
    #[test]
    fn filters_private_data_and_foreign_threads_including_bootstrap() {
        let mut j = bound();
        assert!(j
            .server(
                1,
                &event("item/reasoning/textDelta", json!({"delta":"private"}))
            )
            .is_none());
        assert!(j
            .server(
                1,
                &event(
                    "item/agentMessage/delta",
                    json!({"threadId":"other","delta":"foreign"})
                )
            )
            .is_none());
        assert!(j
            .server(
                1,
                &event(
                    "item/completed",
                    json!({"item":{"id":"h","type":"hookPrompt","prompt":"internal"}})
                )
            )
            .is_none());
        j.server(1, &event("turn/completed", json!({"turn":{"id":"turn","status":"completed","items":[{"id":"r","type":"reasoning","content":["private"],"summary":["public"]},{"id":"h","type":"hookPrompt","prompt":"internal"}]}})));
        j.client(1, &json!({"id":2,"method":"thread/resume"}));
        j.server(1, &json!({"id":2,"result":{"thread":{"id":"root","turns":[{"id":"active","status":"inProgress","items":[{"id":"r","type":"reasoning","content":["private"],"summary":["public"]}]}]}}}));
        let text = serde_json::to_string(&j.page(None, 0)).unwrap();
        for excluded in ["private", "internal", "foreign", "hookPrompt"] {
            assert!(!text.contains(excluded));
        }
        assert!(text.contains("public"));
    }
    #[test]
    fn pages_are_ordered_replayable_and_thread_switch_resets() {
        let mut j = bound();
        for _ in 0..5 {
            j.server(
                1,
                &event(
                    "item/agentMessage/delta",
                    json!({"itemId":"a","delta":"x".repeat(70000)}),
                ),
            );
        }
        let first = j.page(None, 0);
        assert!(first.reset && first.has_more);
        let mut cursor = first.cursor;
        let mut count = first.events.len();
        while cursor < j.sequence {
            let page = j.page(Some(&first.epoch), cursor);
            assert!(!page.reset);
            assert_eq!(page.events[0].sequence, cursor + 1);
            cursor = page.cursor;
            count += page.events.len();
        }
        assert_eq!(count, 6);
        assert!(j.page(Some(&first.epoch), cursor).events.is_empty());
        assert!(j.page(Some(&first.epoch), cursor + 1).reset);
        bind(&mut j, "new-root");
        let next = j.page(Some(&first.epoch), cursor);
        assert!(next.reset);
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.thread_id.as_deref(), Some("new-root"));
    }
    #[test]
    fn oversize_and_revert_require_history_until_a_new_turn() {
        let mut j = bound();
        j.server(
            1,
            &event(
                "thread/settings/updated",
                json!({"threadSettings":{"model":"updated-model","effort":"low","cwd":"/new"}}),
            ),
        );
        j.server(
            1,
            &event(
                "item/agentMessage/delta",
                json!({"itemId":"a","delta":"x".repeat(ITEM_BYTES)}),
            ),
        );
        assert!(!j.page(None, 0).complete);
        let epoch = j.epoch.clone();
        j.server(
            1,
            &event(
                "turn/started",
                json!({"turn":{"id":"next","items":[],"status":"inProgress"}}),
            ),
        );
        assert!(j.complete);
        assert_ne!(epoch, j.epoch);
        assert_eq!(j.events[0].0.message["params"]["model"], "updated-model");
        assert_eq!(j.events[0].0.message["params"]["cwd"], "/new");
        j.server(1, &event("thread/reverted", json!({})));
        assert!(!j.complete);
    }
    #[test]
    fn backlog_overflow_is_explicit() {
        let mut j = bound();
        for _ in 0..90 {
            j.server(
                1,
                &event(
                    "item/commandExecution/outputDelta",
                    json!({"itemId":"c","delta":"x".repeat(100000)}),
                ),
            );
        }
        assert!(!j.complete);
        assert!(j.bytes <= JOURNAL_BYTES);
        assert!(j.page(Some(&j.epoch), 0).reset);
    }
    #[test]
    fn untracked_responses_cannot_change_root() {
        let mut j = bound();
        j.server(
            1,
            &json!({"id":5,"result":{"thread":{"id":"foreign"},"accessToken":"private"}}),
        );
        assert_eq!(j.thread_id().as_deref(), Some("root"));
        assert_eq!(j.events.len(), 1);
    }
    #[test]
    fn helper_connections_cannot_duplicate_events_or_claim_another_connections_rpc() {
        let mut j = bound();
        j.client(2, &json!({"id":10,"method":"thread/resume"}));
        j.server(3, &json!({"id":10,"result":{"thread":{"id":"foreign"}}}));
        j.server(
            3,
            &event(
                "item/agentMessage/delta",
                json!({"itemId":"a","delta":"duplicate"}),
            ),
        );
        assert_eq!(j.events.len(), 1);
        assert!(!j.disconnected(3));
        assert!(j.online);
        assert!(j.disconnected(1));
        assert!(!j.online);
        j.server(2, &json!({"id":10,"result":{"thread":{"id":"root"}}}));
        assert_eq!(j.owner, Some(2));
        assert!(j.online);
    }
    #[test]
    fn forwards_server_configuration_without_the_tui_prompt() {
        let args = [
            "-c",
            "model_provider=\"custom\"",
            "--enable",
            "foo",
            "--config=x=1",
            "resume",
            "thread-id",
            "a prompt",
        ]
        .map(String::from);
        assert_eq!(
            server_args(&args),
            [
                "app-server",
                "-c",
                "model_provider=\"custom\"",
                "--enable",
                "foo",
                "--config=x=1"
            ]
        );
        assert!(!supported("custom-wrapper", &[], &[]));
        assert!(!supported(
            "codex",
            &["--remote=ws://localhost:99".into()],
            &[]
        ));
        assert!(!supported(
            "codex",
            &["--profile".into(), "work".into()],
            &[]
        ));
    }
    /// Explicit local smoke test. No turn/start, prompt, approval, or API task.
    #[test]
    #[ignore = "requires an installed modern Codex CLI; set SINOS_TEST_CODEX"]
    fn real_cli_bridge_roundtrip_and_shutdown() {
        let program = std::env::var("SINOS_TEST_CODEX")
            .expect("set SINOS_TEST_CODEX to an installed Codex executable or cmd shim");
        let home = std::env::temp_dir().join(format!("sinos-codex-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let env = vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
        assert!(supported(&program, &[], &env));
        let runtime = Arc::new(Mutex::new(crate::remote_runtime::Runtime::new()));
        let args = vec!["-c".into(), "model=\"sinos bridge model\"".into()];
        let bridge = start(&program, &args, home.to_str(), &env, runtime).unwrap();
        let pid = bridge.process_id.clone();
        let journal = bridge.journal.clone();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            // A client without the per-terminal bearer credential cannot connect.
            assert!(tokio_tungstenite::connect_async(&bridge.endpoint).await.is_err());
            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
            let mut request = bridge.endpoint.as_str().into_client_request().unwrap();
            request.headers_mut().insert("authorization", format!("Bearer {}", bridge.auth_token).parse().unwrap());
            let mut browser_request = request.clone();
            browser_request.headers_mut().insert("origin", "https://example.com".parse().unwrap());
            assert!(tokio_tungstenite::connect_async(browser_request).await.is_err());
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            socket.send(Message::Text(json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"sinos_bridge_test","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}).to_string().into())).await.unwrap();
            let response = tokio::time::timeout(Duration::from_secs(15), socket.next()).await.unwrap().unwrap().unwrap();
            let response: Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
            assert_eq!(response["id"], 0, "initialize response");
            assert!(response.get("result").is_some(), "initialize failed: {response}");
            socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({"id":1,"method":"thread/start","params":{"ephemeral":true,"cwd":home}}).to_string().into())).await.unwrap();
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let frame = socket.next().await.unwrap().unwrap();
                    let message: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                    if message["id"] == 1 {
                        assert!(message["result"]["thread"]["id"].is_string(), "thread/start failed: {message}"); break;
                    }
                }
            }).await.unwrap();
            assert!(journal.lock().unwrap().thread_id().is_some());
            let page = journal.lock().unwrap().page(None, 0);
            assert!(page.online && page.complete);
            assert_eq!(page.events[0].message["params"]["model"], "sinos bridge model", "quoted CLI configuration must survive Windows command forwarding");
            // Closing the owning terminal must also terminate the app-server.
            drop(bridge);
            tokio::time::timeout(Duration::from_secs(8), async {
                while pid.lock().unwrap().is_some() { tokio::time::sleep(Duration::from_millis(50)).await; }
            }).await.unwrap();
        });
        assert!(!journal.lock().unwrap().online);
        // This is an explicitly-created UUID test directory, never a user home.
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    #[ignore = "requires an installed Codex CLI; launches an isolated TUI without sending a prompt"]
    fn real_tui_uses_the_same_structured_thread() {
        use std::io::{Read, Write};
        let program = std::env::var("SINOS_TEST_CODEX").expect("set SINOS_TEST_CODEX");
        let home =
            std::env::temp_dir().join(format!("sinos-codex-tui-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        // Private test home; a provider with no credentials or reachable API.
        // No turn is ever submitted. Trust applies only to this empty directory.
        let path = serde_json::to_string(&home.to_string_lossy()).unwrap();
        std::fs::write(
            home.join("config.toml"),
            format!(
                r#"
model = "sinos-test"
model_provider = "sinos-test"
check_for_update_on_startup = false
[model_providers.sinos-test]
name = "Sinos offline test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.{path}]
trust_level = "trusted"
"#
            ),
        )
        .unwrap();
        let env = vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
        let bridge = start(
            &program,
            &[],
            home.to_str(),
            &env,
            Arc::new(Mutex::new(crate::remote_runtime::Runtime::new())),
        )
        .unwrap();
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
            let mut cmd = portable_pty::CommandBuilder::new(std::env::var("COMSPEC").unwrap());
            cmd.args(["/d", "/c", &program]);
            cmd
        };
        #[cfg(not(windows))]
        let mut cmd = portable_pty::CommandBuilder::new(&program);
        cmd.args([
            "--remote",
            &bridge.endpoint,
            "--remote-auth-token-env",
            AUTH_ENV,
            "--cd",
            home.to_str().unwrap(),
            "--no-alt-screen",
        ]);
        cmd.env(AUTH_ENV, &bridge.auth_token);
        cmd.cwd(&home);
        cmd.env("CODEX_HOME", &home);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        #[cfg(windows)]
        let job = crate::terminal::windows_job::session_job(child.process_id().unwrap());
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
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
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                let mut out = captured.lock().unwrap();
                if out.len() < 128000 {
                    out.push_str(&text);
                }
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        while bridge.journal.lock().unwrap().thread_id().is_none()
            && std::time::Instant::now() < deadline
        {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let page = bridge.journal.lock().unwrap().page(None, 0);
        let engine_pid = bridge.process_id.clone();
        let _ = child.kill();
        #[cfg(windows)]
        drop(job);
        drop(pair.master);
        drop(bridge);
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while engine_pid.lock().unwrap().is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.wait();
        let result = page.thread_id.is_some() && page.online && page.complete;
        let output = output.lock().unwrap().clone();
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            result,
            "isolated Codex TUI did not start its thread: {output}"
        );
        assert_eq!(
            page.events
                .iter()
                .filter(|e| e.message["method"] == "turn/started")
                .count(),
            0,
            "test must not submit a turn"
        );
        assert!(engine_pid.lock().unwrap().is_none());
    }
}
