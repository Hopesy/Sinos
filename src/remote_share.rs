use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareMode { View, Control }

pub struct ShareScope {
    pub session_id: String,
    pub mode: ShareMode,
    pub expires_at: u64,
    pub revoked: AtomicBool,
    pub runtime: std::sync::Weak<std::sync::Mutex<crate::remote_runtime::Runtime>>,
}
impl ShareScope {
    pub fn active(&self, now: u64) -> bool { now < self.expires_at && !self.revoked.load(Ordering::SeqCst) }
    pub fn authorize(&self, request: &Value, now: u64) -> Result<(), &'static str> {
        if !self.active(now) { return Err("SHARE_EXPIRED"); }
        let action = request["action"].as_str().unwrap_or("");
        if matches!(action, "state" | "tools") { return Ok(()); }
        if request["sessionId"].as_str() != Some(self.session_id.as_str()) { return Err("SHARE_FORBIDDEN"); }
        if matches!(action, "terminal.read" | "session.chat") { return Ok(()); }
        if action == "session.images" && matches!(request["params"]["action"].as_str(), Some("list" | "read")) { return Ok(()); }
        if self.mode == ShareMode::Control && matches!(action, "session.prompt" | "session.answer" | "session.input" | "session.images") { return Ok(()); }
        Err("SHARE_FORBIDDEN")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shares_enforce_session_scope_read_only_expiry_and_revocation() {
        for mode in [ShareMode::View, ShareMode::Control] {
            let scope = ShareScope { session_id: "shared".into(), mode, expires_at: 100, revoked: AtomicBool::new(false), runtime: std::sync::Weak::new() };
            for action in ["terminal.read", "session.chat"] {
                assert!(scope.authorize(&json!({"action":action,"sessionId":"shared"}), 99).is_ok());
                assert_eq!(scope.authorize(&json!({"action":action,"sessionId":"other"}), 99), Err("SHARE_FORBIDDEN"));
            }
            for action in ["session.prompt", "session.input", "session.answer"] {
                assert_eq!(scope.authorize(&json!({"action":action,"sessionId":"shared"}), 99).is_ok(), mode == ShareMode::Control);
            }
            for action in ["session.launch", "session.kill", "session.pause", "terminal.resize", "workspace.read", "workspace.save", "session.share_create", "session.share_revoke", "session.queue_action", "unknown"] {
                assert_eq!(scope.authorize(&json!({"action":action,"sessionId":"shared"}), 99), Err("SHARE_FORBIDDEN"));
            }
            assert!(scope.authorize(&json!({"action":"session.images","sessionId":"shared","params":{"action":"list"}}), 99).is_ok());
            assert_eq!(scope.authorize(&json!({"action":"state"}), 100), Err("SHARE_EXPIRED"));
            scope.revoked.store(true, Ordering::SeqCst);
            assert_eq!(scope.authorize(&json!({"action":"state"}), 50), Err("SHARE_EXPIRED"));
        }
    }
}
