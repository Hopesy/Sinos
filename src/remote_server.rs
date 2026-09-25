//! Local HTTP/WebSocket bridge for the mobile companion UI.
//!
//! The desktop surface still uses Tauri IPC. This module exposes the same
//! in-memory PTY sessions through a server bound to the machine's Tailscale
//! interface. The phone stays inside the user's tailnet and never connects
//! directly to an AI provider or to the desktop's ordinary LAN interfaces.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        OriginalUri, Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    net::Ipv4Addr,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

#[path = "remote_workspace.rs"]
mod workspace;

#[derive(Clone)]
pub(crate) struct RemoteState {
    sessions: crate::terminal::SharedSession,
    app: AppHandle,
    static_dir: Option<PathBuf>,
    token: Arc<RwLock<String>>,
}

static REMOTE_TOKEN: OnceLock<Arc<RwLock<String>>> = OnceLock::new();

#[derive(Debug, Deserialize, Default)]
struct TokenQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InputRequest {
    data: String,
}

#[derive(Debug, Deserialize)]
struct PromptRequest {
    #[serde(default)] data: String,
    #[serde(default)] attachments: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AnswerRequest {
    data: String,
    expected_output: u64,
    #[serde(default)] kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PauseRequest {
    paused: bool,
}

#[derive(Debug, Deserialize)]
struct LaunchRequest {
    tool: String,
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    auth_required: bool,
    port: u16,
}

#[derive(Debug, Serialize, Clone)]
struct SessionSnapshot {
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    tool: Option<String>,
    running: bool,
    paused: bool,
    output_chunks: usize,
    activity: crate::remote_runtime::ActivitySnapshot,
    queued_count: usize,
}

#[derive(Debug, Serialize)]
struct StateResponse {
    sessions: Vec<SessionSnapshot>,
    device_name: String,
    capabilities: Vec<&'static str>,
}

/// Pairing details used by the desktop settings page. The token is only
/// exposed to the trusted Tauri frontend; the browser companion receives it
/// through the QR fragment and never gets a token-listing endpoint.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingInfo {
    pub remote_url: Option<String>,
    pub token: Option<String>,
    pub auth_enabled: bool,
    pub port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Pause { paused: bool },
    Kill,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Output {
        session_id: String,
        data: String,
        sequence: u64,
    },
    Status {
        session_id: String,
        running: bool,
        paused: bool,
    },
    Error {
        message: String,
    },
}

const REMOTE_PORT: u16 = 8787;

/// Start the browser bridge in the Tauri async runtime. Prefer the local
/// Tailscale IPv4 so a phone on the same tailnet can connect directly. The
/// loopback fallback keeps desktop-only development working when Tailscale is
/// offline.
pub fn spawn(app: AppHandle, sessions: crate::terminal::SharedSession) {
    let static_dir = resolve_static_dir(&app);
    let token = Arc::new(RwLock::new(load_remote_token()));
    let _ = REMOTE_TOKEN.set(token.clone());
    let state = RemoteState {
        sessions,
        app,
        static_dir,
        token,
    };
    crate::relay_host::start(state.clone());
    start_queue_worker(state.clone());

    tauri::async_runtime::spawn(async move {
        let bind_host = tailscale_ipv4()
            .map(|address| address.to_string())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let bind = format!("{bind_host}:{REMOTE_PORT}");
        let listener = match TcpListener::bind(&bind).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[remote] could not bind {bind}: {error}");
                return;
            }
        };

        eprintln!("[remote] mobile companion listening at http://{bind}/remote");
        eprintln!(
            "[remote] mobile pairing URL: {}",
            pairing_url_for_host(&bind_host)
        );
        if state
            .token
            .read()
            .map(|token| token.is_empty())
            .unwrap_or(true)
        {
            eprintln!("[remote] no SINOS_REMOTE_TOKEN set; tailnet access is ACL-only for now");
        }

        let router = api_router(state.clone())
            .route("/api/ws", get(websocket))
            .fallback(static_file)
            .with_state(state.clone());

        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[remote] server stopped: {error}");
        }
    });
}

fn api_router(_state: RemoteState) -> Router<RemoteState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/state", get(state_snapshot))
        .route("/api/tools", get(tool_list))
        .route("/api/launch", post(launch))
        .route("/api/sessions/:id/input", post(input))
        .route("/api/sessions/:id/prompt", post(prompt))
        .route("/api/sessions/:id/answer", post(answer))
        .route("/api/sessions/:id/pause", post(pause))
        .route("/api/sessions/:id/kill", post(kill))
        .route("/api/sessions/:id/directory", get(workspace::directory))
        .route(
            "/api/sessions/:id/file",
            get(workspace::file).post(workspace::save),
        )
        .route("/api/sessions/:id/changes", get(workspace::changes))
        .route("/api/sessions/:id/diff", get(workspace::diff))
        .route("/api/sessions/:id/chat", get(chat))
        .route("/api/sessions/:id/queue", get(queue_state).post(queue_action))
        .route("/api/sessions/:id/images", post(images))
}

#[derive(Deserialize)]
struct ChatQuery {
    cursor: Option<u64>,
    revision: Option<String>,
    before: Option<u64>,
    token: Option<String>,
}

async fn chat(
    State(state): State<RemoteState>,
    Path(id): Path<String>,
    Query(query): Query<ChatQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let binding = state.sessions.lock().ok().and_then(|map| {
        map.get(&id).map(|s| {
            let token = s.current_token();
            let source = s.current_chat_source();
            (
                s.tool_name.clone().unwrap_or_default(),
                s.cwd.clone(),
                token,
                source,
                s.mobile_runtime.clone(),
            )
        })
    });
    let Some((tool, cwd, token, source, runtime)) = binding else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Ok(mut runtime) = runtime.lock() { runtime.watching_until = std::time::Instant::now() + Duration::from_secs(15); }
    let _ = state
        .app
        .emit("mobile-chat-watch", serde_json::json!({"sessionId":id}));
    match tokio::task::spawn_blocking(move || {
        crate::server::read_mobile_chat(
            tool,
            cwd,
            token,
            source,
            query.cursor,
            query.revision,
            query.before,
        )
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "CHAT_UNAVAILABLE").into_response(),
    }
}

/// Authenticated, decrypted RPC is restricted to the companion API. Reuse the
/// same handlers, workspace confinement and revision checks as local access.
pub(crate) async fn relay_request(
    mut state: RemoteState,
    request: serde_json::Value,
) -> serde_json::Value {
    use serde_json::json;
    use tower::ServiceExt;
    let result = async {
        let action = request["action"].as_str().unwrap_or("");
        let id = request["sessionId"].as_str().unwrap_or("");
        let params = &request["params"];
        if id.len() > 128 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':')) { return Err((400, "INVALID_SESSION".to_string())); }
        if action == "terminal.read" {
            let mut offset = params["offset"].as_u64().unwrap_or(0);
            let (chunks, running, paused) = read_output(&state.sessions, id, &mut offset);
            let mut data = String::new();
            // A slow client receives the newest bounded tail, then resumes at
            // this exact sequence. Never build a multi-megabyte relay frame.
            let mut kept = Vec::new(); let mut size = 0;
            for chunk in chunks.iter().rev() { if size + chunk.len() > 131_072 { break; } size += chunk.len(); kept.push(chunk); }
            let reset = kept.len() != chunks.len();
            for chunk in kept.into_iter().rev() { data.push_str(chunk); }
            let codex = codex_page(&state.sessions, id, params["codexEpoch"].as_str(), params["codexCursor"].as_u64().unwrap_or(0));
            let claude = claude_page(&state.sessions, id, params["claudeEpoch"].as_str(), params["claudeCursor"].as_u64().unwrap_or(0));
            return Ok(json!({"data":data,"offset":offset,"running":running,"paused":paused,"reset":reset,"codex":codex,"claude":claude}));
        }
        if action == "terminal.resize" {
            let cols = params["cols"].as_u64().filter(|n| *n <= 500).ok_or((400,"INVALID_SIZE".into()))? as u16;
            let rows = params["rows"].as_u64().filter(|n| *n <= 200).ok_or((400,"INVALID_SIZE".into()))? as u16;
            resize_session(&state.sessions, id, cols, rows).map_err(|_| (400,"RESIZE_FAILED".into()))?;
            return Ok(serde_json::Value::Null);
        }
        let (method, route) = match action {
            "state" => ("GET", "/api/state".to_string()),
            "tools" => ("GET", "/api/tools".to_string()),
            "session.launch" => ("POST", "/api/launch".to_string()),
            "session.input" => ("POST", format!("/api/sessions/{id}/input")),
            "session.prompt" => ("POST", format!("/api/sessions/{id}/prompt")),
            "session.answer" => ("POST", format!("/api/sessions/{id}/answer")),
            "session.pause" => ("POST", format!("/api/sessions/{id}/pause")),
            "session.kill" => ("POST", format!("/api/sessions/{id}/kill")),
            "session.chat" => ("GET", format!("/api/sessions/{id}/chat")),
            "session.queue" => ("GET", format!("/api/sessions/{id}/queue")),
            "session.queue_action" => ("POST", format!("/api/sessions/{id}/queue")),
            "session.images" => ("POST", format!("/api/sessions/{id}/images")),
            "workspace.list" => ("GET", format!("/api/sessions/{id}/directory")),
            "workspace.read" => ("GET", format!("/api/sessions/{id}/file")),
            "workspace.save" => ("POST", format!("/api/sessions/{id}/file")),
            "workspace.changes" => ("GET", format!("/api/sessions/{id}/changes")),
            "workspace.diff" => ("GET", format!("/api/sessions/{id}/diff")),
            _ => return Err((400,"UNKNOWN_ACTION".into())),
        };
        let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for key in ["path", "cursor", "revision", "before"] {
            if let Some(value) = params.get(key).filter(|v| !v.is_null()) {
                query.append_pair(key, &value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()));
            }
        }
        query.finish()
        };
        let uri = if query.is_empty() { route } else { format!("{route}?{query}") };
        let token = crate::pair_crypto::random_token();
        state.token = Arc::new(RwLock::new(token.clone()));
        let req = axum::http::Request::builder().method(method).uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(params.to_string())).map_err(|_| (400,"INVALID_REQUEST".into()))?;
        let response = api_router(state.clone()).with_state(state).oneshot(req).await.map_err(|_| (500,"REQUEST_FAILED".into()))?;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), crate::pair_crypto::MAX_RPC_BYTES - 4096).await.map_err(|_| (413,"RESPONSE_TOO_LARGE".into()))?;
        if !status.is_success() { return Err((status.as_u16(), String::from_utf8_lossy(&bytes).chars().take(500).collect())); }
        Ok(serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }.await;
    match result {
        Ok(data) => {
            json!({"type":"response","id":request["id"],"channel":request["channel"],"status":200,"data":data})
        }
        Err((status, error)) => {
            json!({"type":"response","id":request["id"],"channel":request["channel"],"status":status,"error":error})
        }
    }
}

/// Read the current pairing state for the desktop settings page.
pub fn pairing_info() -> RemotePairingInfo {
    let token = REMOTE_TOKEN
        .get_or_init(|| Arc::new(RwLock::new(load_remote_token())))
        .read()
        .ok()
        .map(|value| value.clone())
        .unwrap_or_default();
    RemotePairingInfo {
        remote_url: configured_remote_url(),
        auth_enabled: !token.is_empty(),
        token: (!token.is_empty()).then_some(token),
        port: REMOTE_PORT,
    }
}

/// Generate and persist a new application-level pairing token. Existing QR
/// codes stop working immediately because all requests are checked against
/// the shared token on every request.
pub fn create_pairing_token() -> Result<RemotePairingInfo, String> {
    let shared = REMOTE_TOKEN
        .get_or_init(|| Arc::new(RwLock::new(load_remote_token())))
        .clone();
    let token = uuid::Uuid::new_v4().simple().to_string();
    persist_remote_token(&token)?;
    *shared.write().map_err(|error| error.to_string())? = token;
    Ok(pairing_info())
}

/// Invalidate old links and sockets without falling back to unauthenticated access.
pub fn revoke_pairing_token() -> Result<RemotePairingInfo, String> {
    create_pairing_token()
}

fn remote_token_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".coffee-cli").join("remote-token"))
}

fn load_remote_token() -> String {
    if let Ok(value) = std::env::var("SINOS_REMOTE_TOKEN") {
        if !value.trim().is_empty() {
            return value.trim().to_string();
        }
    }
    remote_token_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn persist_remote_token(token: &str) -> Result<(), String> {
    let Some(path) = remote_token_path() else {
        return Err("无法定位用户配置目录".to_string());
    };
    if token.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, token).map_err(|error| error.to_string())
}

fn configured_remote_url() -> Option<String> {
    if let Ok(value) = std::env::var("SINOS_REMOTE_URL") {
        if let Some(url) = normalize_remote_url(&value) {
            return Some(url);
        }
    }
    tailscale_serve_url()
        .and_then(|url| normalize_remote_url(&url))
        .or_else(|| tailscale_ipv4().map(|address| pairing_url_for_host(&address.to_string())))
}

fn pairing_url_for_host(host: &str) -> String {
    format!("http://{host}:{REMOTE_PORT}/remote")
}

/// Read the machine's Tailscale IPv4 without requiring a browser login or a
/// Tailscale Serve configuration. The value is validated before it is used as
/// a bind address, so command output can never become part of the listener.
fn tailscale_ipv4() -> Option<Ipv4Addr> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.trim().parse::<Ipv4Addr>().ok())
}

fn normalize_remote_url(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let value = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    if value.ends_with("/remote") {
        Some(value)
    } else {
        Some(format!("{value}/remote"))
    }
}

fn tailscale_serve_url() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["serve", "status", "--json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let web = value.get("Web")?.as_object()?;
    let (host, config) = web.iter().next()?;
    let host = host.trim_end_matches('/');
    let base = if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{host}")
    };
    let path = config
        .get("Handlers")
        .and_then(serde_json::Value::as_object)
        .and_then(|handlers| handlers.keys().next())
        .filter(|path| path.as_str() != "/")
        .map(|path| path.trim_end_matches('/'))
        .unwrap_or("");
    Some(format!("{base}{path}"))
}

async fn health(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(HealthResponse {
        ok: true,
        auth_required: state
            .token
            .read()
            .map(|token| !token.is_empty())
            .unwrap_or(false),
        port: REMOTE_PORT,
    })
    .into_response()
}

async fn state_snapshot(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(StateResponse {
        sessions: snapshot_sessions(&state.sessions),
        device_name: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "Sinos Desktop".into()),
        capabilities: vec!["activity", "message_queue", "answer_text", "answer_multiselect", "image_attachments_v1", "codex_events_v1", "claude_events_v1"],
    })
    .into_response()
}

async fn tool_list(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(crate::tools::list_tools()).into_response()
}

async fn launch(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Json(request): Json<LaunchRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if crate::tools::find(&request.tool).is_none() {
        return (StatusCode::BAD_REQUEST, "unknown tool").into_response();
    }
    if let Some(cwd) = request.cwd.as_deref() {
        if !FsPath::new(cwd).is_dir() {
            return (StatusCode::BAD_REQUEST, "cwd is not a directory").into_response();
        }
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    let payload = crate::launch::LaunchRequest {
        tool: request.tool,
        cwd: request.cwd,
        session_id: Some(session_id.clone()),
    };
    match state.app.emit("launch-request", payload) {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "session_id": session_id })),
        )
            .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

async fn input(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Path(id): Path<String>,
    Json(request): Json<InputRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match write_input(&state.sessions, &id, &request.data) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

async fn prompt(
    State(state): State<RemoteState>,
    Path(id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    Json(request): Json<PromptRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(text) = crate::remote_runtime::image_prompt_text(&request.data, !request.attachments.is_empty()) else { return StatusCode::BAD_REQUEST.into_response(); };
    let handles = state.sessions.lock().ok().and_then(|map| map.get(&id).map(|s| (s.mobile_runtime.clone(), s.writer_lock.clone(), s.paused.clone(), s.tool_name.clone())));
    let Some((runtime, writer, paused, tool)) = handles else { return StatusCode::NOT_FOUND.into_response(); };
    let Ok(mut runtime) = runtime.lock() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
    if !request.attachments.is_empty() && !image_tool(tool.as_deref()) { return image_error("IMAGE_UNSUPPORTED"); }
    // Uploading may take long enough for another client to start a turn.
    // Do not paste an image prompt into an active turn or permission menu.
    if !request.attachments.is_empty() && matches!(runtime.activity.state, crate::remote_runtime::Activity::Working | crate::remote_runtime::Activity::Waiting) { return (StatusCode::CONFLICT, "SESSION_BUSY").into_response(); }
    let attachments = match runtime.images.metadata(&request.attachments) { Ok(value) => value, Err(error) => return image_error(error) };
    let text = crate::remote_images::ImageStore::prompt(&text, &attachments);
    let data = format!("\x1b[200~{text}\x1b[201~\r");
    if paused.load(std::sync::atomic::Ordering::Relaxed) { return (StatusCode::CONFLICT, "SESSION_BUSY").into_response(); }
    // Retain even on an uncertain partial write: the CLI may already refer
    // to the file. Removing the composer preview cannot invalidate it.
    runtime.images.retain(&attachments);
    runtime.submitted();
    use std::io::Write;
    let result = writer.lock().map_err(|_| ()).and_then(|mut writer| writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|_| ()));
    match result {
        Ok(()) => {
            let _ = state.app.emit(
                "mobile-chat-prompt",
                serde_json::json!({"sessionId":id, "text":text}),
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => { runtime.interrupted(); StatusCode::INTERNAL_SERVER_ERROR.into_response() },
    }
}

fn image_tool(tool: Option<&str>) -> bool { matches!(tool, Some("claude" | "codex")) }
fn image_error(error: &'static str) -> Response {
    let status = match error { "IMAGE_NOT_FOUND" => StatusCode::NOT_FOUND, "IMAGE_IN_USE" | "IMAGE_CONFLICT" | "IMAGE_OFFSET" => StatusCode::CONFLICT, "IMAGE_TOO_LARGE" | "IMAGE_STORAGE_FULL" => StatusCode::PAYLOAD_TOO_LARGE, "IMAGE_WRITE_FAILED" => StatusCode::INTERNAL_SERVER_ERROR, _ => StatusCode::BAD_REQUEST };
    (status, error).into_response()
}
async fn images(State(state): State<RemoteState>, Path(id): Path<String>, Query(query): Query<TokenQuery>, headers: HeaderMap, Json(request): Json<crate::remote_images::ImageRequest>) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) { return StatusCode::UNAUTHORIZED.into_response(); }
    let handles = state.sessions.lock().ok().and_then(|map| map.get(&id).map(|s| (s.mobile_runtime.clone(), s.tool_name.clone())));
    let Some((runtime, tool)) = handles else { return StatusCode::NOT_FOUND.into_response(); };
    if !image_tool(tool.as_deref()) { return image_error("IMAGE_UNSUPPORTED"); }
    // PNG decoding and disk I/O must not block the network executor.
    match tokio::task::spawn_blocking(move || {
        let mut runtime = runtime.lock().map_err(|_| "IMAGE_WRITE_FAILED")?;
        if request.action == "remove" && runtime.queue.iter().any(|item| item.attachments.iter().any(|image| image.id == request.id)) { return Err("IMAGE_IN_USE"); }
        runtime.images.handle(request)
    }).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => image_error(error),
        Err(_) => image_error("IMAGE_WRITE_FAILED"),
    }
}

async fn queue_state(State(state): State<RemoteState>, Path(id): Path<String>, Query(query): Query<TokenQuery>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) { return StatusCode::UNAUTHORIZED.into_response(); }
    let runtime = state.sessions.lock().ok().and_then(|map| map.get(&id).map(|s| s.mobile_runtime.clone()));
    let Some(runtime) = runtime else { return StatusCode::NOT_FOUND.into_response(); };
    let Ok(mut runtime) = runtime.lock() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
    runtime.watching_until = std::time::Instant::now() + Duration::from_secs(15);
    Json(serde_json::json!({"messages":runtime.queue,"activity":runtime.activity,"held":runtime.held()})).into_response()
}

async fn queue_action(State(state): State<RemoteState>, Path(id): Path<String>, Query(query): Query<TokenQuery>, headers: HeaderMap, Json(request): Json<crate::remote_runtime::QueueRequest>) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) { return StatusCode::UNAUTHORIZED.into_response(); }
    let handles = state.sessions.lock().ok().and_then(|map| map.get(&id).map(|s| (s.mobile_runtime.clone(), s.writer_lock.clone(), s.paused.clone())));
    let Some((runtime, writer, paused)) = handles else { return StatusCode::NOT_FOUND.into_response(); };
    let Ok(mut runtime) = runtime.lock() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
    runtime.watching_until = std::time::Instant::now() + Duration::from_secs(15);
    let result = match request.action.as_str() {
        "enqueue" => runtime.enqueue(&request),
        "edit" | "remove" | "hold" | "release" => runtime.mutate(&request),
        "send" => {
            if paused.load(std::sync::atomic::Ordering::Relaxed) || matches!(runtime.activity.state, crate::remote_runtime::Activity::Working | crate::remote_runtime::Activity::Waiting) { Err("SESSION_BUSY") }
            else {
                match runtime.claim(Some(&request.id), request.expected_revision) {
                    Ok(item) => deliver_queued(&state.app, &id, &writer, &mut runtime, item),
                    Err(error) => Err(error),
                }
            }
        }
        _ => Err("INVALID_ACTION"),
    };
    match result {
        Ok(()) => Json(serde_json::json!({"messages":runtime.queue,"activity":runtime.activity,"held":runtime.held()})).into_response(),
        Err(error) => (if matches!(error, "QUEUE_CONFLICT" | "SESSION_BUSY" | "DELIVERY_UNCERTAIN" | "MESSAGE_NOT_FOUND") { StatusCode::CONFLICT } else { StatusCode::BAD_REQUEST }, error).into_response(),
    }
}

fn deliver_queued(app: &AppHandle, id: &str, writer: &Mutex<Box<dyn std::io::Write + Send>>, runtime: &mut crate::remote_runtime::Runtime, item: crate::remote_runtime::QueuedPrompt) -> Result<(), &'static str> {
    use std::io::Write;
    let ids: Vec<_> = item.attachments.iter().map(|image| image.id.clone()).collect();
    let attachments = match runtime.images.metadata(&ids) { Ok(value) => value, Err(_) => { runtime.delivery_failed(item); return Err("DELIVERY_UNCERTAIN"); } };
    let text = crate::remote_images::ImageStore::prompt(&item.text, &attachments);
    runtime.images.retain(&attachments);
    let data = format!("\x1b[200~{text}\x1b[201~\r");
    let result = writer.lock().map_err(|_| ()).and_then(|mut writer| writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|_| ()));
    if result.is_err() { runtime.delivery_failed(item); return Err("DELIVERY_UNCERTAIN"); }
    let _ = app.emit("mobile-chat-prompt", serde_json::json!({"sessionId":id,"text":text}));
    Ok(())
}

fn start_queue_worker(state: RemoteState) {
    // Lives on the desktop, independently of phone tab visibility or network.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let handles = state.sessions.lock().map(|map| map.iter().map(|(id, s)| (
            id.clone(), s.tool_name.clone().unwrap_or_default(), s.cwd.clone(),
            s.current_token(), s.current_chat_source(),
            s.mobile_runtime.clone(), s.writer_lock.clone(), s.paused.clone(),
        )).collect::<Vec<_>>()).unwrap_or_default();
        for (id, tool, cwd, token, source, shared, writer, paused) in handles {
            let (cursor, revision, source_id, input_revision) = {
                let Ok(runtime) = shared.lock() else { continue; };
                if runtime.queue.is_empty() && runtime.watching_until < std::time::Instant::now() { continue; }
                (runtime.cursor, runtime.log_revision.clone(), runtime.source_id.clone(), runtime.input_revision)
            };
            let _ = state.app.emit("mobile-chat-watch", serde_json::json!({"sessionId":id}));
            // Only these adapters expose completion records we can prove.
            // Other CLIs still get their queue and explicit manual delivery.
            let mut verified_log = false;
            if matches!(tool.as_str(), "claude" | "codex") {
                let mut read = crate::server::read_mobile_chat(tool.clone(), cwd.clone(), token.clone(), source.clone(), cursor, revision, None);
                if read.as_ref().is_ok_and(|v| v["bound"] == true && source_id.is_some() && v["sourceId"].as_str() != source_id.as_deref()) {
                    read = crate::server::read_mobile_chat(tool, cwd, token, source, None, None, None);
                }
                if let Ok(value) = read {
                    verified_log = value["bound"] == true;
                    if value["bound"] == true && value["unchanged"] != true {
                        let Ok(mut runtime) = shared.lock() else { continue; };
                        if runtime.source_id.is_some() && runtime.source_id.as_deref() != value["sourceId"].as_str() { runtime.changed_source(); }
                        // A submit during disk I/O must not be completed by
                        // the old snapshot returned from that read.
                        let seed = value["append"] != true || runtime.input_revision != input_revision;
                        runtime.observe_log(value["data"].as_str().unwrap_or(""), seed);
                        runtime.cursor = value["cursor"].as_u64();
                        runtime.log_revision = value["revision"].as_str().map(str::to_owned);
                        runtime.source_id = value["sourceId"].as_str().map(str::to_owned);
                    }
                }
            }
            let Ok(mut runtime) = shared.lock() else { continue; };
            if !verified_log || paused.load(std::sync::atomic::Ordering::Relaxed) || !runtime.ready() { continue; }
            if let Ok(item) = runtime.claim(None, None) { let _ = deliver_queued(&state.app, &id, &writer, &mut runtime, item); }
        }
    });
}

async fn answer(
    State(state): State<RemoteState>,
    Path(id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    Json(mut request): Json<AnswerRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Text answers use one bounded bracketed paste. Both forms require the
    // exact observed screen and cannot be implicitly retried after a write.
    if !prepare_answer(&mut request) { return StatusCode::BAD_REQUEST.into_response(); }
    let handles = state.sessions.lock().ok().and_then(|map| map.get(&id).map(|session| (
        session.writer_lock.clone(), session.output_buffer.clone(),
        session.output_sequence.clone(), session.paused.clone(),
        session.answered_output_sequence.clone(),
    )));
    let Some((writer, buffer, sequence, paused, answered)) = handles else { return StatusCode::NOT_FOUND.into_response(); };
    let Ok(_snapshot_guard) = buffer.lock() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); };
    match write_answer(&writer, &sequence, &paused, &answered, &request) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err("STALE_INTERACTION") => (StatusCode::CONFLICT, "STALE_INTERACTION").into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn prepare_answer(request: &mut AnswerRequest) -> bool {
    if request.kind.as_deref() == Some("text") {
        if request.data.len() > 16_384 || request.data.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')) { return false; }
        let Ok(text) = crate::remote_runtime::clean_prompt(&request.data) else { return false; };
        request.data = format!("\x1b[200~{text}\x1b[201~\r");
        true
    } else { request.kind.is_none() && valid_answer_keys(&request.data) }
}

/// Caller holds the output buffer lock, so the snapshot cannot advance while
/// its choice is claimed. No implicit retry after a partially written answer.
fn write_answer(
    writer: &Mutex<Box<dyn std::io::Write + Send>>,
    sequence: &std::sync::atomic::AtomicU64,
    paused: &std::sync::atomic::AtomicBool,
    answered: &std::sync::atomic::AtomicU64,
    request: &AnswerRequest,
) -> Result<(), &'static str> {
    use std::sync::atomic::Ordering;
    if sequence.load(Ordering::Relaxed) != request.expected_output || answered.load(Ordering::Relaxed) == request.expected_output || paused.load(Ordering::Relaxed) {
        return Err("STALE_INTERACTION");
    }
    use std::io::Write;
    let mut writer = writer.lock().map_err(|_| "WRITE_FAILED")?;
    answered.store(request.expected_output, Ordering::Relaxed);
    writer.write_all(request.data.as_bytes()).and_then(|_| writer.flush()).map_err(|_| "WRITE_FAILED")
}

fn valid_answer_keys(data: &str) -> bool {
    if matches!(data, "y\r" | "n\r") { return true; }
    let Some(mut keys) = data.strip_suffix('\r') else { return false; };
    if keys.len() > if keys.contains(' ') { 80 } else { 24 } { return false; }
    while !keys.is_empty() {
        let Some(rest) = keys.strip_prefix("\x1b[A").or_else(|| keys.strip_prefix("\x1b[B")).or_else(|| keys.strip_prefix(' ')) else { return false; };
        keys = rest;
    }
    true
}

async fn pause(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Path(id): Path<String>,
    Json(request): Json<PauseRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match set_paused(&state.sessions, &id, request.paused) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn kill(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let sender = {
        let map = match state.sessions.lock() {
            Ok(map) => map,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        map.get(&id).map(|session| session.kill_tx.clone())
    };
    match sender {
        Some(sender) => {
            let _ = sender.send(());
            StatusCode::NO_CONTENT.into_response()
        }
        None => (StatusCode::NOT_FOUND, "session not found").into_response(),
    }
}

async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Recheck the credential for the lifetime of the socket, including rotation.
    let credential = query.token.clone().or_else(|| {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_owned)
    });
    ws.on_upgrade(move |socket| websocket_session(socket, state, query.session_id, credential))
        .into_response()
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    session_id: String,
    token: Option<String>,
}

async fn websocket_session(
    mut socket: WebSocket,
    state: RemoteState,
    session_id: String,
    credential: Option<String>,
) {
    let mut output_offset = 0u64;
    let mut codex_epoch: Option<String> = None;
    let mut codex_cursor = 0;
    let mut claude_epoch: Option<String> = None;
    let mut claude_cursor = 0;
    loop {
        if !authorized(&state, &HeaderMap::new(), credential.as_deref()) {
            let _ = socket.send(server_error("PAIRING_EXPIRED".into())).await;
            let _ = socket.close().await;
            return;
        }
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !authorized(&state, &HeaderMap::new(), credential.as_deref()) { return; }
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Input { data }) => {
                                if let Err(error) = write_input(&state.sessions, &session_id, &data) {
                                    if socket.send(server_error(error)).await.is_err() { break; }
                                }
                            }
                            Ok(ClientMessage::Resize { cols, rows }) => {
                                if let Err(error) = resize_session(&state.sessions, &session_id, cols, rows) {
                                    if socket.send(server_error(error)).await.is_err() { break; }
                                }
                            }
                            Ok(ClientMessage::Pause { paused }) => {
                                if let Err(error) = set_paused(&state.sessions, &session_id, paused) {
                                    if socket.send(server_error(error)).await.is_err() { break; }
                                }
                            }
                            Ok(ClientMessage::Kill) => {
                                let sender = state.sessions.lock().ok().and_then(|map| map.get(&session_id).map(|s| s.kill_tx.clone()));
                                if let Some(sender) = sender { let _ = sender.send(()); }
                            }
                            Err(error) => {
                                if socket.send(server_error(format!("invalid message: {error}"))).await.is_err() { break; }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(80)) => {
                if !authorized(&state, &HeaderMap::new(), credential.as_deref()) { return; }
                let (chunks, running, paused) = read_output(&state.sessions, &session_id, &mut output_offset);
                if !chunks.is_empty() {
                    if socket.send(server_output(&session_id, chunks.concat(), output_offset)).await.is_err() { return; }
                }
                if let Some(page) = codex_page(&state.sessions, &session_id, codex_epoch.as_deref(), codex_cursor) {
                    codex_epoch = Some(page.epoch.clone()); codex_cursor = page.cursor;
                    if socket.send(Message::Text(serde_json::json!({"type":"codex","session_id":session_id,"page":page}).to_string())).await.is_err() { return; }
                }
                if let Some(page) = claude_page(&state.sessions, &session_id, claude_epoch.as_deref(), claude_cursor) {
                    claude_epoch = Some(page.epoch.clone()); claude_cursor = page.cursor;
                    if socket.send(Message::Text(serde_json::json!({"type":"claude","session_id":session_id,"page":page}).to_string())).await.is_err() { return; }
                }
                if socket.send(server_status(&session_id, running, paused)).await.is_err() { return; }
                if !running { return; }
            }
        }
    }
}

fn server_output(session_id: &str, data: String, sequence: u64) -> Message {
    Message::Text(
        serde_json::to_string(&ServerMessage::Output {
            session_id: session_id.to_string(),
            data,
            sequence,
        })
        .unwrap_or_default()
        .into(),
    )
}

fn codex_page(sessions: &crate::terminal::SharedSession, id: &str, epoch: Option<&str>, cursor: u64) -> Option<crate::codex_stream::Page> {
    let journal = sessions.lock().ok()?.get(id)?.codex_bridge.as_ref()?.journal.clone();
    let page = journal.lock().ok()?.page(epoch, cursor);
    Some(page)
}

fn claude_page(sessions: &crate::terminal::SharedSession, id: &str, epoch: Option<&str>, cursor: u64) -> Option<crate::codex_stream::Page> {
    let journal = sessions.lock().ok()?.get(id)?.claude_bridge.as_ref()?.journal.clone();
    let page = journal.lock().ok()?.page(epoch, cursor);
    Some(page)
}

fn server_status(session_id: &str, running: bool, paused: bool) -> Message {
    Message::Text(
        serde_json::to_string(&ServerMessage::Status {
            session_id: session_id.to_string(),
            running,
            paused,
        })
        .unwrap_or_default()
        .into(),
    )
}

fn server_error(message: String) -> Message {
    Message::Text(
        serde_json::to_string(&ServerMessage::Error { message })
            .unwrap_or_default()
            .into(),
    )
}

fn snapshot_sessions(sessions: &crate::terminal::SharedSession) -> Vec<SessionSnapshot> {
    let Ok(map) = sessions.lock() else {
        return Vec::new();
    };
    let snapshots: Vec<_> = map.iter()
        .map(|(id, session)| (SessionSnapshot {
            id: id.clone(),
            cwd: session.cwd.clone(),
            cols: session
                ._master
                .try_lock()
                .ok()
                .and_then(|m| m.as_ref().and_then(|m| m.get_size().ok()))
                .map(|s| s.cols)
                .unwrap_or(120),
            rows: session
                ._master
                .try_lock()
                .ok()
                .and_then(|m| m.as_ref().and_then(|m| m.get_size().ok()))
                .map(|s| s.rows)
                .unwrap_or(30),
            tool: session.tool_name.clone(),
            running: true,
            paused: session.paused.load(std::sync::atomic::Ordering::Relaxed),
            output_chunks: session
                .output_buffer
                .lock()
                .map(|buffer| buffer.len())
                .unwrap_or(0),
            activity: crate::remote_runtime::Runtime::new().activity,
            queued_count: 0,
        }, session.mobile_runtime.clone()))
        .collect();
    // Queue writes can wait for the PTY. Never hold the global session map
    // while waiting for their activity lock, so other tabs stay responsive.
    drop(map);
    snapshots.into_iter().map(|(mut snapshot, runtime)| {
        if let Ok(runtime) = runtime.lock() { snapshot.activity = runtime.activity.clone(); snapshot.queued_count = runtime.queue.len(); }
        snapshot
    }).collect()
}

fn read_output(
    sessions: &crate::terminal::SharedSession,
    id: &str,
    offset: &mut u64,
) -> (Vec<String>, bool, bool) {
    let Ok(map) = sessions.lock() else {
        return (Vec::new(), false, false);
    };
    let Some(session) = map.get(id) else {
        return (Vec::new(), false, false);
    };
    let paused = session.paused.load(std::sync::atomic::Ordering::Relaxed);
    let Ok(buffer) = session.output_buffer.lock() else {
        return (Vec::new(), true, paused);
    };
    let sequence = session.output_sequence.load(std::sync::atomic::Ordering::Relaxed);
    if sequence == *offset {
        return (Vec::new(), true, paused);
    }
    let delta = sequence.saturating_sub(*offset) as usize;
    let start = buffer.len().saturating_sub(delta);
    let chunks = buffer[start..].to_vec();
    *offset = sequence;
    (chunks, true, paused)
}

fn write_input(
    sessions: &crate::terminal::SharedSession,
    id: &str,
    data: &str,
) -> Result<(), String> {
    let (writer, runtime) = {
        let map = sessions.lock().map_err(|error| error.to_string())?;
        map.get(id)
            .map(|session| (session.writer_lock.clone(), session.mobile_runtime.clone()))
            .ok_or_else(|| "session not found".to_string())?
    };
    let mut runtime = runtime.lock().map_err(|_| "Activity unavailable")?;
    if data.contains('\x03') { runtime.interrupted(); }
    use std::io::Write;
    let mut writer = writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn resize_session(
    sessions: &crate::terminal::SharedSession,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if !(20..=500).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("invalid terminal size".into());
    }
    let master = sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .map(|s| s._master.clone())
        .ok_or("session not found")?;
    let guard = master.lock().map_err(|e| e.to_string())?;
    let master = guard.as_ref().ok_or("terminal closed")?;
    crate::server::resize_terminal_pty(master.as_ref(), cols, rows)
}

fn set_paused(
    sessions: &crate::terminal::SharedSession,
    id: &str,
    paused: bool,
) -> Result<(), String> {
    let (pid, engine, paused_state) = {
        let map = sessions.lock().map_err(|error| error.to_string())?;
        let session = map.get(id).ok_or_else(|| "session not found".to_string())?;
        (
            session
                .process_id
                .ok_or_else(|| "process is unavailable".to_string())?,
            session.codex_bridge.as_ref().and_then(|b| b.process_id.lock().ok().and_then(|p| *p)),
            session.paused.clone(),
        )
    };
    crate::terminal::pause_processes(pid, engine, paused)?;
    paused_state.store(paused, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

fn authorized(state: &RemoteState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let token = match state.token.read() {
        Ok(token) => token,
        Err(_) => return false,
    };
    if token.is_empty() {
        return true;
    }
    let supplied = query_token.or_else(|| {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
    });
    supplied == Some(token.as_str())
}

async fn static_file(State(state): State<RemoteState>, OriginalUri(uri): OriginalUri) -> Response {
    let Some(root) = state.static_dir else {
        return (StatusCode::NOT_FOUND, "remote UI is not built").into_response();
    };
    let request_path = uri.path().trim_start_matches('/');
    let relative =
        if request_path.is_empty() || request_path == "remote" || request_path == "remote/" {
            PathBuf::from("remote/index.html")
        } else {
            let stripped = request_path.strip_prefix("remote/").unwrap_or(request_path);
            PathBuf::from(stripped)
        };
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        )
    }) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let candidate = root.join(relative);
    let path = if candidate.is_file() {
        candidate
    } else {
        root.join("remote/index.html")
    };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, content_type(&path))
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => (StatusCode::NOT_FOUND, "remote UI asset not found").into_response(),
    }
}

fn content_type(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn resolve_static_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("src-ui").join("dist"));
    }
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("src-ui").join("dist"));
        candidates.push(resource.join("dist"));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

#[cfg(test)]
mod conversation_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.0.lock().unwrap().extend_from_slice(bytes); Ok(bytes.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    #[test]
    fn projected_choice_is_written_once_and_rejects_stale_or_paused_screens() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer: Mutex<Box<dyn std::io::Write + Send>> = Mutex::new(Box::new(RecordingWriter(bytes.clone())));
        let sequence = AtomicU64::new(42);
        let paused = AtomicBool::new(false);
        let answered = AtomicU64::new(u64::MAX);
        let mut request = AnswerRequest { data: "\x1b[B\r".into(), expected_output: 41, kind: None };
        assert_eq!(write_answer(&writer, &sequence, &paused, &answered, &request), Err("STALE_INTERACTION"));
        assert!(bytes.lock().unwrap().is_empty());
        request.expected_output = 42;
        assert!(write_answer(&writer, &sequence, &paused, &answered, &request).is_ok());
        assert_eq!(write_answer(&writer, &sequence, &paused, &answered, &request), Err("STALE_INTERACTION"));
        assert_eq!(*bytes.lock().unwrap(), b"\x1b[B\r");
        sequence.store(43, Ordering::Relaxed); request.expected_output = 43;
        paused.store(true, Ordering::Relaxed);
        assert_eq!(write_answer(&writer, &sequence, &paused, &answered, &request), Err("STALE_INTERACTION"));
        assert_eq!(*bytes.lock().unwrap(), b"\x1b[B\r");
    }
    #[test]
    fn choice_endpoint_rejects_commands_pastes_and_excessive_navigation() {
        for invalid in ["npm test\r", "\x03", "\x1b[200~yes\x1b[201~\r", "\r\r", "\x1b[C\r", "\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r"] { assert!(!valid_answer_keys(invalid)); }
        for valid in ["\r", "y\r", "n\r", "\x1b[A\r", "\x1b[B\x1b[B\r"] { assert!(valid_answer_keys(valid)); }
    }
    #[test]
    fn text_answers_preserve_multiline_input_and_share_the_once_only_screen_guard() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer: Mutex<Box<dyn std::io::Write + Send>> = Mutex::new(Box::new(RecordingWriter(bytes.clone())));
        let sequence = AtomicU64::new(8); let paused = AtomicBool::new(false); let answered = AtomicU64::new(u64::MAX);
        let mut request = AnswerRequest { data: "使用浅色\n增加留白".into(), expected_output: 8, kind: Some("text".into()) };
        assert!(prepare_answer(&mut request));
        assert!(write_answer(&writer, &sequence, &paused, &answered, &request).is_ok());
        assert_eq!(*bytes.lock().unwrap(), "\x1b[200~使用浅色\n增加留白\x1b[201~\r".as_bytes());
        assert_eq!(write_answer(&writer, &sequence, &paused, &answered, &request), Err("STALE_INTERACTION"));
        for value in [" ", "text\x03", "\x1b[201~escape", &"x".repeat(16_385)] {
            assert!(!prepare_answer(&mut AnswerRequest { data: value.into(), expected_output: 8, kind: Some("text".into()) }));
        }
        assert!(prepare_answer(&mut AnswerRequest { data: " \x1b[B \r".into(), expected_output: 8, kind: None }));
    }
}
