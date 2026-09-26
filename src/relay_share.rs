//! Temporary, single-session grants. Never persisted as paired devices.
use super::*;
use crate::remote_share::{ShareMode, ShareScope};

pub(super) struct TemporaryShare {
    invite: Invitation,
    scope: Arc<ShareScope>,
    device: Mutex<Option<Arc<Device>>>,
}
impl TemporaryShare {
    fn info(&self) -> Value {
        let device = self.device.lock().unwrap();
        let active = self.scope.active(now_ms());
        json!({"id":self.invite.public_key,"sessionId":self.scope.session_id,"mode":self.scope.mode,
            "expiresAt":self.scope.expires_at,"inviteExpiresAt":self.invite.expires_at,
            "url":if active && device.is_none() && now_ms() < self.invite.expires_at { Some(format!("{}/#share={}",self.invite.relay,self.invite.public_key)) } else { None },
            "state":if !active {"ended"} else if device.as_ref().is_some_and(|d| d.online.load(Ordering::SeqCst)) {"connected"} else if device.is_some() {"claimed"} else {"pending"}})
    }
    fn stop(&self) {
        self.scope.revoked.store(true, Ordering::SeqCst);
        if let Some(device) = self.device.lock().unwrap().as_ref() { device.stopped.store(true, Ordering::SeqCst); }
    }
}

pub(crate) async fn handle(action: &str, session_id: &str, params: &Value) -> Result<Value, String> {
    let manager = host()?;
    if action == "session.share_list" {
        return Ok(json!({"shares":manager.shares.lock().unwrap().values().filter(|share| share.scope.session_id == session_id).map(|share| share.info()).collect::<Vec<_>>()}));
    }
    if action == "session.share_revoke" {
        let share = manager.shares.lock().unwrap().get(params["id"].as_str().unwrap_or("")).filter(|share| share.scope.session_id == session_id).cloned().ok_or("SHARE_NOT_FOUND")?;
        // Native enforcement takes effect before the network cleanup. A relay
        // outage cannot leave control enabled after the owner pressed revoke.
        share.stop();
        let _ = http(&share.invite.relay, "/v1/pair/cancel", Some(json!({"publicKey":share.invite.public_key,"requestToken":share.invite.request_token})), None).await;
        return Ok(share.info());
    }
    if action != "session.share_create" { return Err("UNKNOWN_ACTION".into()); }
    let mode: ShareMode = serde_json::from_value(params["mode"].clone()).map_err(|_| "INVALID_SHARE_MODE")?;
    let minutes = params["minutes"].as_u64().filter(|value| [15, 60, 240].contains(value)).ok_or("INVALID_SHARE_DURATION")?;
    let _guard = manager.share_lock.lock().await;
    if !manager.remote.session_running(session_id) { return Err("SHARE_ENDED".into()); }
    let runtime = manager.remote.share_runtime(session_id).ok_or("SHARE_ENDED")?;
    {
        let mut shares = manager.shares.lock().unwrap();
        shares.retain(|_, share| share.scope.active(now_ms()));
        if shares.len() >= 6 { return Err("SHARE_LIMIT".into()); }
    }
    let relay = manager.relay.read().unwrap().clone();
    let secret = crypto::new_secret();
    let mut invite = Invitation { public_key: crypto::encode(secret.public_key().as_bytes()), secret,
        request_token: crypto::random_token(), relay: relay.clone(), expires_at: now_ms() + 600_000 };
    let response = http(&relay, "/v1/pair/request", Some(json!({"publicKey":invite.public_key,"requestToken":invite.request_token,"temporaryMs":minutes * 60_000})), None).await?;
    invite.expires_at = response["expiresAt"].as_u64().unwrap_or(invite.expires_at);
    let share = Arc::new(TemporaryShare { invite,
        scope: Arc::new(ShareScope { session_id: session_id.into(), mode, expires_at: response["accessExpiresAt"].as_u64().unwrap_or_else(|| now_ms() + minutes * 60_000), revoked: AtomicBool::new(false), runtime }), device: Mutex::new(None) });
    manager.shares.lock().unwrap().insert(share.invite.public_key.clone(), share.clone());
    let result = share.info();
    tauri::async_runtime::spawn(monitor(manager.clone(), share));
    Ok(result)
}

fn monitor(manager: Arc<RelayHost>, share: Arc<TemporaryShare>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        while share.scope.active(now_ms()) && manager.remote.share_session_running(&share.scope) {
            if share.device.lock().unwrap().is_none() {
                if now_ms() > share.invite.expires_at + 120_000 { break; }
                let response = http(&share.invite.relay, "/v1/pair/request", Some(json!({"publicKey":share.invite.public_key,"requestToken":share.invite.request_token,"pollOnly":true})), None).await;
                if !share.scope.active(now_ms()) { break; }
                if let Ok(response) = response {
                    if response["state"] == "authorized" {
                        let key = response["response"].as_str().and_then(|boxed| crypto::unbox_key(boxed, &share.invite.secret).ok());
                        if let (Some(key), Some(pair_id), Some(token)) = (key, response["pairId"].as_str(), response["hostToken"].as_str()) {
                            let device = Arc::new(Device {
                                credential: Credential { pair_id: pair_id.into(), relay_url: share.invite.relay.clone(), token: token.into(), content_key: crypto::encode(&key), device_name: "临时访客".into(), paired_at: now_ms(), revoked: false },
                                name: RwLock::new("临时访客".into()), stopped: AtomicBool::new(false), online: AtomicBool::new(false), state: RwLock::new("connecting".into()), share: Some(share.scope.clone()),
                            });
                            *share.device.lock().unwrap() = Some(device.clone());
                            tauri::async_runtime::spawn(manager.clone().run_device(device));
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        share.stop();
        let _ = http(&share.invite.relay, "/v1/pair/cancel", Some(json!({"publicKey":share.invite.public_key,"requestToken":share.invite.request_token})), None).await;
    })
}
