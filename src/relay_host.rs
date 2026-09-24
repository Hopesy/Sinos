//! Outbound encrypted companion connection. Credentials stay in the native host.
use crate::{pair_crypto as crypto, remote_server::RemoteState};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_RELAY: &str = "https://sinos-relay.zhlhopefil.workers.dev";
static HOST: OnceLock<Arc<RelayHost>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    pair_id: String,
    relay_url: String,
    token: String,
    content_key: String,
    device_name: String,
    paired_at: u64,
    #[serde(default)]
    revoked: bool,
}
struct Device {
    credential: Credential,
    stopped: AtomicBool,
    online: AtomicBool,
    state: RwLock<String>,
}
#[derive(Clone)]
struct Invitation {
    public_key: String,
    secret: crypto_box::SecretKey,
    request_token: String,
    relay: String,
    expires_at: u64,
}
struct RelayHost {
    remote: RemoteState,
    relay: RwLock<String>,
    devices: RwLock<HashMap<String, Arc<Device>>>,
    invitation: Mutex<Option<Invitation>>,
    error: Mutex<Option<String>>,
    pairing_lock: tokio::sync::Mutex<()>,
    credential_lock: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDeviceInfo {
    pair_id: String,
    device_name: String,
    relay_url: String,
    paired_at: u64,
    online: bool,
    state: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    relay_url: String,
    invite_url: Option<String>,
    expires_at: Option<u64>,
    devices: Vec<RelayDeviceInfo>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConnectionTest {
    latency_ms: u64,
}

fn test_relay_connection(relay_url: &str) -> Result<RelayConnectionTest, String> {
    use std::io::Read;
    let relay = normalize_relay(relay_url)?;
    let started = Instant::now();
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .redirects(0)
        .build()
        .get(&format!("{relay}/v1/health"))
        .set("Accept", "application/json")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, _) => format!("中继返回 HTTP {status}，请检查地址或服务状态"),
            ureq::Error::Transport(_) => "无法连接中继，请检查地址、网络或证书后重试".into(),
        })?;
    if response.status() != 200 {
        return Err(format!("中继返回 HTTP {}，请填写最终的中继地址", response.status()));
    }
    let mut raw = String::new();
    response.into_reader().take(4097).read_to_string(&mut raw)
        .map_err(|_| "无法读取中继响应，请重试".to_string())?;
    if raw.len() > 4096 {
        return Err("该地址未返回有效的 Sinos 中继响应".into());
    }
    let health: Value = serde_json::from_str(&raw)
        .map_err(|_| "该地址未返回有效的 Sinos 中继响应".to_string())?;
    if health["ok"] != true || health["protocol"] != "coffee-v1" {
        return Err("该地址不是兼容的 Sinos 中继，请检查部署版本".into());
    }
    Ok(RelayConnectionTest { latency_ms: started.elapsed().as_millis() as u64 })
}

/// A read-only probe from the desktop's network; never creates an invitation
/// or saves the address, so testing cannot disturb an existing pairing.
#[tauri::command]
pub async fn relay_test_connection(relay_url: String) -> Result<RelayConnectionTest, String> {
    tokio::task::spawn_blocking(move || test_relay_connection(&relay_url))
        .await.map_err(|_| "连接测试中断，请重试".to_string())?
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn host() -> Result<Arc<RelayHost>, String> {
    HOST.get()
        .cloned()
        .ok_or_else(|| "移动端服务尚未启动".into())
}

pub fn normalize_relay(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value.trim()).map_err(|_| "请输入完整的 HTTPS 中继地址")?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (parsed.scheme() != "https"
        && !(cfg!(debug_assertions) && local && parsed.scheme() == "http"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("中继必须使用 HTTPS 根地址（开发模式可用 localhost）".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|p| p.join(".coffee-cli/relay-url"))
}
fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("coffee-cli", "paired-mobile-devices")
        .map_err(|_| "无法访问系统凭据库".into())
}
fn load_credentials() -> Result<Vec<Credential>, String> {
    match credential_entry()?.get_password() {
        Ok(raw) => {
            let ids: Vec<String> =
                serde_json::from_str(&raw).map_err(|_| "配对记录损坏，请重新配对")?;
            ids.iter()
                .map(|id| {
                    let raw = keyring::Entry::new("coffee-cli", &format!("mobile-{id}"))
                        .map_err(|_| "无法访问设备凭据")?
                        .get_password()
                        .map_err(|_| "无法读取设备凭据")?;
                    serde_json::from_str(&raw).map_err(|_| "设备凭据损坏".into())
                })
                .collect()
        }
        Err(keyring::Error::NoEntry) => Ok(vec![]),
        Err(_) => Err("无法读取系统凭据库，已保存的设备暂不可用".into()),
    }
}
fn save_credentials(values: &[Credential]) -> Result<(), String> {
    // Windows limits each credential blob to 2.5 KB. Store keys individually.
    for value in values {
        let raw = serde_json::to_string(value).map_err(|_| "无法保存配对记录")?;
        keyring::Entry::new("coffee-cli", &format!("mobile-{}", value.pair_id))
            .map_err(|_| "无法访问设备凭据")?
            .set_password(&raw)
            .map_err(|_| "无法保存设备凭据")?;
    }
    let raw = serde_json::to_string(&values.iter().map(|v| &v.pair_id).collect::<Vec<_>>())
        .map_err(|_| "无法保存配对记录")?;
    credential_entry()?
        .set_password(&raw)
        .map_err(|_| "无法写入系统凭据库，配对未保存".into())
}
async fn http(
    relay: &str,
    path: &str,
    body: Option<Value>,
    token: Option<String>,
) -> Result<Value, String> {
    let url = format!("{}{}", normalize_relay(relay)?, path);
    tokio::task::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(12))
            .redirects(0)
            .build();
        let deleting = body.is_none();
        let result = if let Some(body) = body {
            agent
                .post(&url)
                .set("Content-Type", "application/json")
                .send_string(&body.to_string())
        } else {
            let mut req = agent.delete(&url);
            if let Some(token) = token {
                req = req.query("token", &token);
            }
            req.call()
        };
        // A lost successful DELETE response must not strand the device in the
        // settings list forever: a rejected token is already unable to connect.
        if deleting && matches!(&result, Err(ureq::Error::Status(401, _))) {
            return Ok(json!({"ok":true}));
        }
        let response = result.map_err(|_| "无法连接中继或配对已失效，请检查中继地址")?;
        let raw = response.into_string().map_err(|_| "无法读取中继响应")?;
        serde_json::from_str(&raw).map_err(|_| "中继响应格式不正确".to_string())
    })
    .await
    .map_err(|_| "中继请求任务中断".to_string())?
}

pub fn start(remote: RemoteState) {
    let relay = config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| normalize_relay(&s).ok())
        .unwrap_or_else(|| DEFAULT_RELAY.into());
    let manager = Arc::new(RelayHost {
        remote,
        relay: RwLock::new(relay),
        devices: RwLock::new(HashMap::new()),
        invitation: Mutex::new(None),
        error: Mutex::new(None),
        pairing_lock: tokio::sync::Mutex::new(()),
        credential_lock: tokio::sync::Mutex::new(()),
    });
    if HOST.set(manager.clone()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = manager.credential_lock.lock().await;
        let credentials = tokio::task::spawn_blocking(load_credentials).await;
        match credentials {
            Ok(Ok(values)) => {
                for value in values {
                    manager.attach(value);
                }
            }
            Ok(Err(error)) => *manager.error.lock().unwrap() = Some(error),
            Err(_) => {}
        }
    });
}

#[tauri::command]
pub fn relay_status() -> Result<RelayStatus, String> {
    Ok(host()?.status())
}

#[tauri::command]
pub async fn relay_create_pairing(relay_url: String) -> Result<RelayStatus, String> {
    let manager = host()?;
    let _guard = manager.pairing_lock.lock().await;
    let relay = normalize_relay(&relay_url)?;
    if manager.devices.read().unwrap().len() >= 16 {
        return Err("请先移除不用的设备（最多 16 台）".into());
    }
    manager.cancel_invitation().await?;
    let secret = crypto::new_secret();
    let mut invite = Invitation {
        public_key: crypto::encode(secret.public_key().as_bytes()),
        secret,
        request_token: crypto::random_token(),
        relay: relay.clone(),
        expires_at: now_ms() + 60_000,
    };
    let registered = http(
        &relay,
        "/v1/pair/request",
        Some(json!({ "publicKey": invite.public_key, "requestToken": invite.request_token })),
        None,
    )
    .await?;
    invite.expires_at = registered["expiresAt"].as_u64().unwrap_or(invite.expires_at);
    if let Some(path) = config_path() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法保存中继地址")?;
        }
        std::fs::write(path, &relay).map_err(|_| "无法保存中继地址")?;
    }
    *manager.relay.write().unwrap() = relay;
    *manager.error.lock().unwrap() = None;
    *manager.invitation.lock().unwrap() = Some(invite.clone());
    let worker = manager.clone();
    tauri::async_runtime::spawn(async move {
        worker.poll_invite(invite).await;
    });
    Ok(manager.status())
}

#[tauri::command]
pub async fn relay_cancel_pairing() -> Result<RelayStatus, String> {
    let manager = host()?;
    let _guard = manager.pairing_lock.lock().await;
    manager.cancel_invitation().await?;
    Ok(manager.status())
}

#[tauri::command]
pub async fn relay_revoke_device(pair_id: String) -> Result<RelayStatus, String> {
    let manager = host()?;
    let _guard = manager.credential_lock.lock().await;
    let device = manager
        .devices
        .read()
        .unwrap()
        .get(&pair_id)
        .cloned()
        .ok_or("设备不存在")?;
    // Stop accepting local actions immediately, even while the relay is unreachable.
    device.stopped.store(true, Ordering::SeqCst);
    device.online.store(false, Ordering::SeqCst);
    let stopped: Vec<_> = manager
        .devices
        .read()
        .unwrap()
        .values()
        .map(|d| {
            let mut c = d.credential.clone();
            c.revoked = d.stopped.load(Ordering::SeqCst);
            c
        })
        .collect();
    tokio::task::spawn_blocking(move || save_credentials(&stopped))
        .await
        .map_err(|_| "无法保存设备状态")??;
    http(
        &device.credential.relay_url,
        &format!("/v1/pair/{pair_id}"),
        None,
        Some(device.credential.token.clone()),
    )
    .await?;
    let remaining: Vec<_> = manager
        .devices
        .read()
        .unwrap()
        .iter()
        .filter(|(id, _)| *id != &pair_id)
        .map(|(_, d)| {
            let mut c = d.credential.clone();
            c.revoked = d.stopped.load(Ordering::SeqCst);
            c
        })
        .collect();
    tokio::task::spawn_blocking(move || save_credentials(&remaining))
        .await
        .map_err(|_| "无法保存设备状态")??;
    manager.devices.write().unwrap().remove(&pair_id);
    let _ = keyring::Entry::new("coffee-cli", &format!("mobile-{pair_id}"))
        .and_then(|e| e.delete_credential());
    Ok(manager.status())
}

impl RelayHost {
    async fn cancel_invitation(&self) -> Result<(), String> {
        let invite = self.invitation.lock().unwrap().take();
        if let Some(invite) = invite {
            http(&invite.relay, "/v1/pair/cancel",
                Some(json!({"publicKey":invite.public_key,"requestToken":invite.request_token})), None).await?;
        }
        Ok(())
    }
    fn status(&self) -> RelayStatus {
        let invite = self
            .invitation
            .lock()
            .unwrap()
            .clone()
            .filter(|i| i.expires_at > now_ms());
        let mut devices: Vec<_> = self
            .devices
            .read()
            .unwrap()
            .values()
            .map(|d| RelayDeviceInfo {
                pair_id: d.credential.pair_id.clone(),
                device_name: d.credential.device_name.clone(),
                relay_url: d.credential.relay_url.clone(),
                paired_at: d.credential.paired_at,
                online: d.online.load(Ordering::SeqCst),
                state: if d.stopped.load(Ordering::SeqCst) {
                    "revoked".into()
                } else {
                    d.state.read().unwrap().clone()
                },
            })
            .collect();
        devices.sort_by_key(|d| d.paired_at);
        RelayStatus {
            relay_url: self.relay.read().unwrap().clone(),
            invite_url: invite
                .as_ref()
                .map(|i| format!("{}/#pk={}", i.relay, i.public_key)),
            expires_at: invite.map(|i| i.expires_at),
            devices,
            error: self.error.lock().unwrap().clone(),
        }
    }
    fn current_invite(&self, invite: &Invitation) -> bool {
        // A phone can claim at second 59. Keep the secret long enough to fetch
        // that accepted claim; pollOnly prevents extending the invitation TTL.
        now_ms() < invite.expires_at.saturating_add(120_000)
            && self
                .invitation
                .lock()
                .unwrap()
                .as_ref()
                .map(|i| i.public_key == invite.public_key)
                .unwrap_or(false)
    }
    async fn poll_invite(self: Arc<Self>, invite: Invitation) {
        while self.current_invite(&invite) {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if !self.current_invite(&invite) { return; }
            let response = http(
                &invite.relay,
                "/v1/pair/request",
                Some(json!({"publicKey": invite.public_key, "requestToken": invite.request_token, "pollOnly":true})),
                None,
            )
            .await;
            // Cancellation, refresh and accepting a claim are serialized all
            // the way through credential persistence, not just the HTTP poll.
            let _pairing_guard = self.pairing_lock.lock().await;
            if !self.current_invite(&invite) {
                return;
            }
            let Ok(response) = response else { continue };
            if response["state"] != "authorized" {
                continue;
            }
            let outcome = async {
                let key = crypto::unbox_key(
                    response["response"].as_str().ok_or("无效配对响应")?,
                    &invite.secret,
                )?;
                let credential = Credential {
                    pair_id: response["pairId"].as_str().ok_or("无效设备编号")?.into(),
                    relay_url: invite.relay.clone(),
                    token: response["hostToken"].as_str().ok_or("无效设备凭据")?.into(),
                    content_key: crypto::encode(&key),
                    device_name: response["deviceName"].as_str().unwrap_or("手机").into(),
                    paired_at: now_ms(),
                    revoked: false,
                };
                let _guard = self.credential_lock.lock().await;
                if !self.current_invite(&invite) {
                    return Err("配对已取消".into());
                }
                let mut stored: Vec<_> = self
                    .devices
                    .read()
                    .unwrap()
                    .values()
                    .map(|d| {
                        let mut c = d.credential.clone();
                        c.revoked = d.stopped.load(Ordering::SeqCst);
                        c
                    })
                    .collect();
                if stored.len() >= 16 {
                    return Err("请先移除不用的设备（最多 16 台）".into());
                }
                stored.push(credential.clone());
                tokio::task::spawn_blocking(move || save_credentials(&stored))
                    .await
                    .map_err(|_| "无法保存设备")??;
                self.attach(credential);
                Ok::<_, String>(())
            }
            .await;
            {
                let mut pending = self.invitation.lock().unwrap();
                if pending.as_ref().map(|i| i.public_key == invite.public_key).unwrap_or(false) {
                    *pending = None;
                }
            }
            if let Err(error) = outcome {
                *self.error.lock().unwrap() = Some(error);
                // The phone has already claimed. If local secure storage fails,
                // explicitly invalidate that claim instead of leaving it waiting.
                let _ = http(&invite.relay, "/v1/pair/cancel",
                    Some(json!({"publicKey":invite.public_key,"requestToken":invite.request_token})), None).await;
            }
            return;
        }
        let mut pending = self.invitation.lock().unwrap();
        if pending.as_ref().map(|i| i.public_key == invite.public_key).unwrap_or(false) {
            *pending = None;
        }
    }
    fn attach(self: &Arc<Self>, credential: Credential) {
        if normalize_relay(&credential.relay_url).is_err()
            || crypto::decode(&credential.content_key)
                .map(|k| k.len() != 32)
                .unwrap_or(true)
        {
            return;
        }
        let stopped = credential.revoked;
        let device = Arc::new(Device {
            credential,
            stopped: AtomicBool::new(stopped),
            online: AtomicBool::new(false),
            state: RwLock::new("connecting".into()),
        });
        let id = device.credential.pair_id.clone();
        if let Some(old) = self.devices.write().unwrap().insert(id, device.clone()) {
            old.stopped.store(true, Ordering::SeqCst);
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_device(device).await;
        });
    }
    async fn run_device(self: Arc<Self>, device: Arc<Device>) {
        let mut attempt = 0u32;
        while !device.stopped.load(Ordering::SeqCst) {
            *device.state.write().unwrap() = "connecting".into();
            let result = self.run_socket(device.clone()).await;
            device.online.store(false, Ordering::SeqCst);
            if device.stopped.load(Ordering::SeqCst) {
                break;
            }
            *device.state.write().unwrap() = "offline".into();
            if result.is_ok() {
                attempt = 0;
            }
            let wait = (1u64 << attempt.min(5)).min(30);
            attempt += 1;
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    }
    async fn run_socket(&self, device: Arc<Device>) -> Result<(), String> {
        let mut url = url::Url::parse(&device.credential.relay_url).map_err(|_| "INVALID_URL")?;
        let secure = url.scheme() == "https";
        url.set_scheme(if secure { "wss" } else { "ws" })
            .map_err(|_| "INVALID_URL")?;
        url.set_path(&format!("/v1/pair/{}", device.credential.pair_id));
        url.query_pairs_mut()
            .append_pair("role", "host")
            .append_pair("token", &device.credential.token);
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(12),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        .map_err(|_| "CONNECT_TIMEOUT")?
        .map_err(|_| "CONNECT_FAILED")?;
        let key = crypto::decode(&device.credential.content_key)?;
        let (mut sink, mut source) = socket.split();
        let (replies, mut outgoing) = mpsc::channel::<(Value, bool)>(16);
        let limit = Arc::new(tokio::sync::Semaphore::new(8));
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        let mut last_seen = Instant::now();
        let mut channel = uuid::Uuid::new_v4().to_string();
        let mut received_seq = 0u64;
        *device.state.write().unwrap() = "connected".into();
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if device.stopped.load(Ordering::SeqCst) { let _ = sink.close().await; return Ok(()); }
                    if last_seen.elapsed() > Duration::from_secs(25) { return Err("HEARTBEAT_TIMEOUT".into()); }
                    sink.send(Message::Text("ping".into())).await.map_err(|_| "SEND_FAILED")?;
                }
                Some((reply, allow_chunks)) = outgoing.recv() => {
                    if device.stopped.load(Ordering::SeqCst) { return Ok(()); }
                    // Drop work from a replaced phone connection.
                    if reply["channel"] != channel { continue; }
                    for frame in crypto::seal_reply(&key, &reply, allow_chunks)? {
                        if device.stopped.load(Ordering::SeqCst) { return Ok(()); }
                        sink.send(Message::Binary(frame.into())).await.map_err(|_| "SEND_FAILED")?;
                    }
                }
                message = source.next() => {
                    let Some(Ok(message)) = message else { return Err("DISCONNECTED".into()) };
                    last_seen = Instant::now();
                    match message {
                        Message::Text(text) => {
                            if text == "pong" { continue; }
                            let Ok(control) = serde_json::from_str::<Value>(&text) else { continue };
                            match control["type"].as_str() {
                                Some("peer-joined") => {
                                    device.online.store(true, Ordering::SeqCst);
                                    channel = uuid::Uuid::new_v4().to_string(); received_seq = 0;
                                    let hello = crypto::seal(&key, &json!({"type":"hello", "protocol":"coffee-v1", "channel":channel}))?;
                                    sink.send(Message::Binary(hello.into())).await.map_err(|_| "SEND_FAILED")?;
                                }
                                Some("peer-left") => { device.online.store(false, Ordering::SeqCst); }
                                Some("revoked") => { device.stopped.store(true, Ordering::SeqCst); return Ok(()); }
                                _ => {}
                            }
                        }
                        Message::Binary(frame) => {
                            let Ok(request) = crypto::open(&key, &frame) else { continue };
                            if device.stopped.load(Ordering::SeqCst) { return Ok(()); }
                            let seq = request["seq"].as_u64().unwrap_or(0);
                            if request["channel"] != channel || seq <= received_seq { continue; }
                            received_seq = seq;
                            if request["type"] != "request" { continue; }
                            let id = request["id"].as_str().unwrap_or("");
                            if id.is_empty() || id.len() > 64 { continue; }
                            // Keep terminal keystrokes and other writes in wire
                            // order. Spawning one task per key can reorder them.
                            if matches!(request["action"].as_str(), Some("session.input" | "session.prompt" | "session.answer" | "session.queue_action" | "session.images" | "session.pause" | "session.kill" | "session.launch" | "workspace.save" | "terminal.resize")) {
                                let allow_chunks = request["acceptChunks"].as_bool().unwrap_or(false);
                                let response = crate::remote_server::relay_request(self.remote.clone(), request).await;
                                for frame in crypto::seal_reply(&key, &response, allow_chunks)? {
                                    if device.stopped.load(Ordering::SeqCst) { return Ok(()); }
                                    sink.send(Message::Binary(frame.into())).await.map_err(|_| "SEND_FAILED")?;
                                }
                                continue;
                            }
                            let Ok(permit) = limit.clone().try_acquire_owned() else {
                                let _ = replies.try_send((json!({"type":"response", "channel":channel, "id":id, "status":429, "error":"TOO_MANY_REQUESTS"}), false)); continue;
                            };
                            let remote = self.remote.clone(); let tx = replies.clone(); let active = device.clone();
                            tokio::spawn(async move {
                                let _permit = permit;
                                if active.stopped.load(Ordering::SeqCst) { return; }
                                let allow_chunks = request["acceptChunks"].as_bool().unwrap_or(false);
                                let response = crate::remote_server::relay_request(remote, request).await;
                                let _ = tx.send((response, allow_chunks)).await;
                            });
                        }
                        Message::Ping(bytes) => { sink.send(Message::Pong(bytes)).await.map_err(|_| "SEND_FAILED")?; }
                        Message::Close(frame) => {
                            if frame.map(|f| u16::from(f.code) == 1008).unwrap_or(false) { device.stopped.store(true, Ordering::SeqCst); }
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_test_requires_a_compatible_health_response() {
        use std::{io::{Read, Write}, net::TcpListener};
        for (status, body, expected_ok) in [
            (200, r#"{"ok":true,"protocol":"coffee-v1"}"#.to_string(), true),
            (200, r#"{"ok":true,"protocol":"other"}"#.to_string(), false),
            (200, r#"{"ok":false,"protocol":"coffee-v1"}"#.to_string(), false),
            (200, "<html>Not a relay</html>".to_string(), false),
            (200, " ".repeat(4097), false),
            (503, r#"{"ok":true,"protocol":"coffee-v1"}"#.to_string(), false),
            (302, String::new(), false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = [0; 8192];
                let read = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /v1/health HTTP/1.1\r\n"));
                let reply = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(reply.as_bytes()).unwrap();
            });
            let result = test_relay_connection(&format!("http://{address}"));
            server.join().unwrap();
            assert_eq!(result.is_ok(), expected_ok, "HTTP {status}");
        }
    }

    #[test]
    fn relay_origin_never_accepts_credentials_query_or_insecure_remote_hosts() {
        assert_eq!(
            normalize_relay("https://relay.example/").unwrap(),
            "https://relay.example"
        );
        for value in [
            "http://relay.example",
            "https://user:pass@relay.example",
            "https://relay.example/path",
            "https://relay.example/?token=x",
            "file:///tmp/x",
        ] {
            assert!(normalize_relay(value).is_err(), "{value}");
        }
    }
}
