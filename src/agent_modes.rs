//! Work preferences are independent of model credentials and the model form.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkModes {
    pub sentinel: bool,
    pub project_manager: bool,
    pub expert_config: bool,
}

fn read_file(path: &Path) -> Result<WorkModes, String> {
    if !path.exists() { return Ok(WorkModes::default()); }
    let bytes = std::fs::read(path).map_err(|_| "Could not read Agent work preferences")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Agent work preferences".into())
}

pub fn read(app: &AppHandle) -> Result<WorkModes, String> {
    let _lock = LOCK.lock().map_err(|_| "Agent work preferences are unavailable")?;
    read_file(&crate::agent::data_dir(app)?.join("work-modes.json"))
}

fn save_file(path: &Path, mode: &str, enabled: bool) -> Result<WorkModes, String> {
    let mut modes = read_file(path)?;
    match mode {
        "sentinel" => modes.sentinel = enabled,
        "projectManager" => modes.project_manager = enabled,
        "expertConfig" => modes.expert_config = enabled,
        _ => return Err("Unknown Agent work preference".into()),
    }
    let parent = path.parent().ok_or("Invalid Agent work preferences path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create Agent data directory")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(&modes).map_err(|_| "Could not serialize Agent work preferences")?)
        .map_err(|_| "Could not save Agent work preferences")?;
    crate::agent::replace_file(&temp, path)?;
    Ok(modes)
}

#[tauri::command]
pub fn agent_get_work_modes(app: AppHandle) -> Result<WorkModes, String> { read(&app) }

#[tauri::command]
pub fn agent_set_work_mode(app: AppHandle, mode: String, enabled: bool) -> Result<WorkModes, String> {
    let modes = {
        let _lock = LOCK.lock().map_err(|_| "Agent work preferences are unavailable")?;
        save_file(&crate::agent::data_dir(&app)?.join("work-modes.json"), &mode, enabled)?
    };
    if mode == "sentinel" { crate::agent_sentinel::settings_changed(&app, enabled); }
    let _ = app.emit("agent-work-modes", modes);
    Ok(modes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_preferences_are_opt_in_and_toggling_preserves_other_modes() {
        let root = std::env::temp_dir().join(format!("coffee-modes-{}", uuid::Uuid::new_v4()));
        let path = root.join("work-modes.json");
        assert_eq!(read_file(&path).unwrap(), WorkModes::default());
        assert!(save_file(&path, "sentinel", true).unwrap().sentinel);
        assert!(save_file(&path, "projectManager", true).unwrap().project_manager);
        let saved = save_file(&path, "expertConfig", true).unwrap();
        assert!(saved.sentinel && saved.project_manager && saved.expert_config);
        let saved = save_file(&path, "sentinel", false).unwrap();
        assert!(!saved.sentinel && saved.project_manager && saved.expert_config);
        assert_eq!(read_file(&path).unwrap(), saved);
        let before = std::fs::read(&path).unwrap();
        assert!(save_file(&path, "unknown", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_preferences_are_not_silently_overwritten() {
        let root = std::env::temp_dir().join(format!("coffee-modes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("work-modes.json");
        std::fs::write(&path, b"invalid").unwrap();
        assert!(read_file(&path).is_err());
        assert!(save_file(&path, "sentinel", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid");
        std::fs::remove_dir_all(root).unwrap();
    }
}
