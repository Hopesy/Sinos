//! Outbound encrypted companion connection. Credentials stay in the native host.
use crate::{pair_crypto as crypto, remote_server::RemoteState};
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

const DEFAULT_RELAY: &str = "https://sinos-relay.zhlhopefil.workers.dev";

struct RelayScope {
    service: &'static str,
    config_file: &'static str,
    default_url: &'static str,
}

fn relay_scope(debug: bool) -> RelayScope {
    if debug {
        RelayScope { service: "coffee-cli-debug", config_file: "relay-url-debug", default_url: "http://127.0.0.1:8788" }
    } else {
        RelayScope { service: "coffee-cli", config_file: "relay-url", default_url: DEFAULT_RELAY }
    }
}

fn credential_account(pair_id: Option<&str>) -> String {
    match pair_id {
        Some(id) => format!("mobile-{id}"),
        None => "paired-mobile-devices".into(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CloseAction { Retry, Replaced, Revoked }

fn close_action(code: Option<u16>, reason: Option<&str>) -> CloseAction {
    if code == Some(1008) {
        CloseAction::Revoked
    } else if code == Some(1000) && reason == Some("replaced") {
        CloseAction::Replaced
    } else {
        CloseAction::Retry
    }
}

// A connection must survive a full 30 seconds to reset successive failures.
fn retry_delay(attempt: &mut u32, connected: Option<Duration>) -> Duration {
    if connected.is_some_and(|elapsed| elapsed >= Duration::from_secs(30)) {
        *attempt = 0;
    }
    let seconds = (1u64 << (*attempt).min(5)).min(30);
    *attempt = attempt.saturating_add(1);
    Duration::from_secs(seconds)
}
static HOST: OnceLock<Arc<RelayHost>> = OnceLock::new();
#[path = "relay_share.rs"]
pub(crate) mod sharing;
#[path = "relay_socket.rs"]
mod connection;

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
    name: RwLock<String>,
    stopped: AtomicBool,
    displaced: AtomicBool,
    online: AtomicBool,
    state: RwLock<String>,
    share: Option<Arc<crate::remote_share::ShareScope>>,
}
impl Device {
    fn new(credential: Credential, share: Option<Arc<crate::remote_share::ShareScope>>) -> Self {
        Self {
            name: RwLock::new(credential.device_name.clone()),
            stopped: AtomicBool::new(credential.revoked),
            displaced: AtomicBool::new(false),
            credential,
            online: AtomicBool::new(false),
            state: RwLock::new("connecting".into()),
            share,
        }
    }
    fn active(&self) -> bool {
        !self.stopped.load(Ordering::SeqCst) && !self.displaced.load(Ordering::SeqCst)
            && self.share.as_ref().map(|share| share.active(now_ms())).unwrap_or(true)
    }
    fn handle_close(&self, action: CloseAction) {
        match action {
            CloseAction::Retry => {}
            CloseAction::Revoked => {
                self.stopped.store(true, Ordering::SeqCst);
                self.online.store(false, Ordering::SeqCst);
            }
            CloseAction::Replaced => {
                let mut state = self.state.write().unwrap();
                self.displaced.store(true, Ordering::SeqCst);
                self.online.store(false, Ordering::SeqCst);
                *state = "replaced".into();
            }
        }
    }
    fn saved_credential(&self) -> Credential {
        let mut credential = self.credential.clone();
        credential.device_name = self.name.read().unwrap().clone();
        credential.revoked = self.stopped.load(Ordering::SeqCst);
        credential
    }
    fn rename(&self, name: String, persist: impl FnOnce(&Credential) -> Result<(), String>) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("设备备注须为 1–60 个字符，不能包含换行或控制字符".into());
        }
        let mut credential = self.saved_credential();
        credential.device_name = name.into();
        // Only update the display after persistence succeeds. Existing sockets
        // keep their identity and keys; renaming never interrupts a session.
        persist(&credential)?;
        *self.name.write().unwrap() = name.into();
        Ok(())
    }
}
// Called under credential_lock so rename/revoke cannot race the snapshot.
fn resume_owner(old: &Arc<Device>, load: impl FnOnce(&str) -> Result<Credential, String>) -> Result<Option<Arc<Device>>, String> {
    if old.stopped.load(Ordering::SeqCst) {
        return Err("设备已撤销，无法接管".into());
    }
    let state = old.state.read().unwrap();
    if state.as_str() != "replaced" || !old.displaced.load(Ordering::SeqCst) {
        return Ok(None);
    }
    // Another process may have renamed or revoked this pairing since startup.
    // Re-read the authoritative record; never save the displaced owner's cache.
    let saved = load(&old.credential.pair_id)?;
    if saved.revoked {
        old.stopped.store(true, Ordering::SeqCst);
        return Err("设备已撤销，无法接管".into());
    }
    if saved.pair_id != old.credential.pair_id || saved.relay_url != old.credential.relay_url
        || saved.token != old.credential.token || saved.content_key != old.credential.content_key {
        return Err("配对信息已变化，请重新配对".into());
    }
    Ok(Some(Arc::new(Device::new(saved, None))))
}

fn resume_in_map(devices: &mut HashMap<String, Arc<Device>>, pair_id: &str, load: impl FnOnce(&str) -> Result<Credential, String>) -> Result<Option<Arc<Device>>, String> {
    let old = devices.get(pair_id).cloned().ok_or("设备不存在")?;
    let fresh = resume_owner(&old, load)?;
    if let Some(device) = &fresh {
        devices.insert(pair_id.to_string(), device.clone());
    }
    Ok(fresh)
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
    shares: Mutex<HashMap<String, Arc<sharing::TemporaryShare>>>,
    share_lock: tokio::sync::Mutex<()>,
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
pub(crate) fn now_ms() -> u64 {
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
    dirs::home_dir().map(|p| p.join(".coffee-cli").join(relay_scope(cfg!(debug_assertions)).config_file))
}
fn credential_entry(pair_id: Option<&str>) -> Result<keyring::Entry, String> {
    keyring::Entry::new(relay_scope(cfg!(debug_assertions)).service, &credential_account(pair_id))
        .map_err(|_| "无法访问系统凭据库".into())
}
fn load_credential(pair_id: &str) -> Result<Credential, String> {
    let raw = credential_entry(Some(pair_id))?.get_password().map_err(|_| "无法读取设备凭据")?;
    serde_json::from_str(&raw).map_err(|_| "设备凭据损坏".into())
}
fn load_credentials() -> Result<Vec<Credential>, String> {
    match credential_entry(None)?.get_password() {
        Ok(raw) => {
            let ids: Vec<String> =
                serde_json::from_str(&raw).map_err(|_| "配对记录损坏，请重新配对")?;
            ids.iter().map(|id| load_credential(id)).collect()
        }
        Err(keyring::Error::NoEntry) => Ok(vec![]),
        Err(_) => Err("无法读取系统凭据库，已保存的设备暂不可用".into()),
    }
}
fn save_credentials(values: &[Credential]) -> Result<(), String> {
    // Windows limits each credential blob to 2.5 KB. Store keys individually.
    for value in values {
        save_credential(value)?;
    }
    let raw = serde_json::to_string(&values.iter().map(|v| &v.pair_id).collect::<Vec<_>>())
        .map_err(|_| "无法保存配对记录")?;
    credential_entry(None)?
        .set_password(&raw)
        .map_err(|_| "无法写入系统凭据库，配对未保存".into())
}
fn save_credential(value: &Credential) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|_| "无法保存配对记录")?;
    credential_entry(Some(&value.pair_id))?
        .set_password(&raw)
        .map_err(|_| "无法保存设备凭据".into())
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
        .unwrap_or_else(|| relay_scope(cfg!(debug_assertions)).default_url.into());
    let manager = Arc::new(RelayHost {
        remote,
        relay: RwLock::new(relay),
        devices: RwLock::new(HashMap::new()),
        invitation: Mutex::new(None),
        error: Mutex::new(None),
        pairing_lock: tokio::sync::Mutex::new(()),
        credential_lock: tokio::sync::Mutex::new(()),
        shares: Mutex::new(HashMap::new()),
        share_lock: tokio::sync::Mutex::new(()),
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
pub async fn relay_rename_device(pair_id: String, device_name: String) -> Result<RelayStatus, String> {
    let manager = host()?;
    let _guard = manager.credential_lock.lock().await;
    let device = manager.devices.read().unwrap().get(&pair_id).cloned().ok_or("设备不存在")?;
    tokio::task::spawn_blocking(move || device.rename(device_name, save_credential))
        .await.map_err(|_| "无法保存设备备注")??;
    Ok(manager.status())
}

#[tauri::command]
pub async fn relay_resume_device(pair_id: String) -> Result<RelayStatus, String> {
    let manager = host()?;
    let _guard = manager.credential_lock.lock().await;
    let owner = manager.clone();
    let fresh = tokio::task::spawn_blocking(move || {
        let mut devices = owner.devices.write().unwrap();
        resume_in_map(&mut devices, &pair_id, load_credential)
    }).await.map_err(|_| "无法读取设备凭据")??;
    if let Some(device) = fresh {
        let worker = manager.clone();
        tauri::async_runtime::spawn(async move { worker.run_device(device).await; });
    }
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
        .map(|d| d.saved_credential())
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
        .map(|(_, d)| d.saved_credential())
        .collect();
    tokio::task::spawn_blocking(move || save_credentials(&remaining))
        .await
        .map_err(|_| "无法保存设备状态")??;
    manager.devices.write().unwrap().remove(&pair_id);
    if let Ok(entry) = credential_entry(Some(&pair_id)) {
        let _ = entry.delete_credential();
    }
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
                device_name: d.name.read().unwrap().clone(),
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
                    .map(|d| d.saved_credential())
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
        let device = Arc::new(Device::new(credential, None));
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
        while device.active() {
            *device.state.write().unwrap() = "connecting".into();
            let mut connected_at = None;
            let _ = self.run_socket(device.clone(), &mut connected_at).await;
            device.online.store(false, Ordering::SeqCst);
            if !device.active() {
                break;
            }
            *device.state.write().unwrap() = "offline".into();
            let wait = retry_delay(&mut attempt, connected_at.map(|started: Instant| started.elapsed()));
            tokio::time::sleep(wait).await;
        }
    }
    async fn run_socket(&self, device: Arc<Device>, connected_at: &mut Option<Instant>) -> Result<(), String> {
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
        *connected_at = Some(Instant::now());
        let remote = self.remote.clone();
        let share = device.share.clone();
        connection::run(socket, device, move |request| {
            crate::remote_server::relay_request(remote.clone(), request, share.clone())
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_device() -> Arc<Device> {
        Arc::new(Device::new(Credential {
            pair_id: "pair".into(), relay_url: DEFAULT_RELAY.into(), token: "token".into(),
            content_key: "key".into(), device_name: "original".into(), paired_at: 42, revoked: false,
        }, None))
    }

    #[test]
    fn close_replacement_and_revocation_are_distinct_and_terminal() {
        assert_eq!(close_action(Some(1000), Some("replaced")), CloseAction::Replaced);
        assert_eq!(close_action(Some(1008), Some("revoked")), CloseAction::Revoked);
        assert_eq!(close_action(Some(1008), Some("replaced")), CloseAction::Revoked);
        for (code, reason) in [(Some(1000), Some("other")), (Some(1001), Some("replaced")), (None, None)] {
            assert_eq!(close_action(code, reason), CloseAction::Retry);
        }
        let device = test_device();
        device.online.store(true, Ordering::SeqCst);
        device.handle_close(CloseAction::Replaced);
        assert!(!device.active());
        assert!(!device.online.load(Ordering::SeqCst));
        assert_eq!(&*device.state.read().unwrap(), "replaced");
        assert!(!device.saved_credential().revoked);
        let revoked = test_device();
        revoked.handle_close(CloseAction::Revoked);
        assert!(!revoked.active());
        assert!(revoked.saved_credential().revoked);
        assert!(resume_owner(&revoked, |_| panic!("revoked device must not load credentials")).is_err());
    }

    #[test]
    fn resume_uses_a_new_owner_and_preserves_latest_identity() {
        let old = test_device();
        let mut devices = HashMap::from([("pair".into(), old.clone())]);
        assert!(resume_in_map(&mut devices, "pair", |_| Ok(old.saved_credential())).unwrap().is_none());
        *old.state.write().unwrap() = "connected".into();
        assert!(resume_in_map(&mut devices, "pair", |_| Ok(old.saved_credential())).unwrap().is_none());
        old.handle_close(CloseAction::Replaced);
        old.rename("新名字".into(), |_| Ok(())).unwrap();
        let new = resume_in_map(&mut devices, "pair", |_| Ok(old.saved_credential())).unwrap().unwrap();
        assert!(Arc::ptr_eq(devices.get("pair").unwrap(), &new));
        assert!(!Arc::ptr_eq(&old, &new));
        assert!(!old.active());
        assert!(new.active());
        assert_eq!(&*new.state.read().unwrap(), "connecting");
        let saved = new.saved_credential();
        assert_eq!((saved.pair_id.as_str(), saved.token.as_str(), saved.content_key.as_str(), saved.device_name.as_str(), saved.paired_at, saved.revoked),
            ("pair", "token", "key", "新名字", 42, false));
        assert!(resume_in_map(&mut devices, "pair", |_| Ok(old.saved_credential())).unwrap().is_none());
        new.stopped.store(true, Ordering::SeqCst);
        assert!(resume_in_map(&mut devices, "pair", |_| Ok(old.saved_credential())).is_err());
        assert!(Arc::ptr_eq(devices.get("pair").unwrap(), &new));
    }

    #[test]
    fn takeover_reloads_other_instances_remarks_and_revocation() {
        let old = test_device();
        old.handle_close(CloseAction::Replaced);
        let mut persisted = old.saved_credential();
        persisted.device_name = "renamed in another instance".into();
        let mut devices = HashMap::from([("pair".into(), old.clone())]);
        assert!(resume_in_map(&mut devices, "pair", |_| Err("keyring unavailable".into())).is_err());
        assert!(Arc::ptr_eq(devices.get("pair").unwrap(), &old));
        let new = resume_in_map(&mut devices, "pair", |id| {
            assert_eq!(id, "pair");
            Ok(persisted.clone())
        }).unwrap().unwrap();
        assert_eq!(old.saved_credential().device_name, "original");
        assert_eq!(new.saved_credential().device_name, persisted.device_name);
        new.handle_close(CloseAction::Replaced);
        persisted.revoked = true;
        assert!(resume_in_map(&mut devices, "pair", |_| Ok(persisted)).is_err());
        assert!(!new.active());
        assert!(new.saved_credential().revoked);
    }

    #[test]
    fn reconnect_backoff_counts_short_closes_and_saturates_until_stable() {
        let mut attempts = 0;
        for expected in [1, 2, 4, 8, 16, 30, 30] {
            assert_eq!(retry_delay(&mut attempts, None), Duration::from_secs(expected));
        }
        attempts = u32::MAX;
        assert_eq!(retry_delay(&mut attempts, Some(Duration::from_secs(29))), Duration::from_secs(30));
        assert_eq!(attempts, u32::MAX);
        assert_eq!(retry_delay(&mut attempts, Some(Duration::from_secs(30))), Duration::from_secs(1));
        assert_eq!(retry_delay(&mut attempts, None), Duration::from_secs(2));
    }

    #[test]
    fn relay_scopes_keep_release_compatibility_and_debug_separate() {
        let release = relay_scope(false);
        let debug = relay_scope(true);
        assert_eq!((release.service, release.config_file, release.default_url),
            ("coffee-cli", "relay-url", "https://sinos-relay.zhlhopefil.workers.dev"));
        assert_ne!(debug.service, release.service);
        assert_ne!(debug.config_file, release.config_file);
        assert_eq!(debug.default_url, "http://127.0.0.1:8788");
        assert_eq!(credential_account(None), "paired-mobile-devices");
        assert_eq!(credential_account(Some("abc")), "mobile-abc");
        assert_eq!(normalize_relay("https://test.example").unwrap(), "https://test.example");
    }

    #[test]
    fn device_rename_preserves_connection_identity_and_survives_later_saves() {
        let device = Device {
            credential: Credential { pair_id: "same-pair".into(), relay_url: DEFAULT_RELAY.into(), token: "test-token".into(), content_key: "test-key".into(), device_name: "Android 手机".into(), paired_at: 123, revoked: false },
            name: RwLock::new("Android 手机".into()), stopped: AtomicBool::new(false), displaced: AtomicBool::new(false), online: AtomicBool::new(true), state: RwLock::new("connected".into()), share: None,
        };
        device.rename(" 我的 Pixel · Chrome ".into(), |saved| {
            assert_eq!(saved.device_name, "我的 Pixel · Chrome");
            assert_eq!(saved.pair_id, "same-pair");
            assert_eq!(saved.token, "test-token");
            assert_eq!(saved.content_key, "test-key");
            assert_eq!(saved.paired_at, 123);
            assert!(!saved.revoked);
            Ok(())
        }).unwrap();
        assert!(device.online.load(Ordering::SeqCst));
        assert_eq!(device.saved_credential().device_name, "我的 Pixel · Chrome");
        assert!(device.rename("未保存".into(), |_| Err("storage failed".into())).is_err());
        assert_eq!(device.saved_credential().device_name, "我的 Pixel · Chrome");
        for invalid in [" ".into(), "中".repeat(61), "两个\n名字".into()] {
            assert!(device.rename(invalid, |_| panic!("invalid names must not touch storage")).is_err());
        }
        device.stopped.store(true, Ordering::SeqCst);
        let saved = device.saved_credential();
        assert!(saved.revoked);
        assert_eq!(saved.device_name, "我的 Pixel · Chrome");
    }

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
