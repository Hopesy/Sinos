//! Native close preference: available before the WebView mounts and shared by
//! custom window buttons, OS close requests and the tray's explicit Quit action.
use serde::{Deserialize, Serialize};
use std::{io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, Manager};

const TRAY_ID: &str = "sinos-main-tray";
const SHOW_ID: &str = "sinos-tray-show";
const QUIT_ID: &str = "sinos-tray-quit";

#[derive(Default)]
struct StartupReveal(AtomicBool);
impl StartupReveal {
    fn claim(&self) -> bool { !self.0.swap(true, Ordering::SeqCst) }
}
pub(crate) fn claim_startup_reveal(app: &tauri::AppHandle) -> bool { app.state::<StartupReveal>().claim() }
pub(crate) fn mark_window_handled(app: &tauri::AppHandle) { app.state::<StartupReveal>().claim(); }

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences { close_to_tray: bool }

struct PreferenceStore { path: Option<PathBuf>, value: Mutex<Preferences> }
impl PreferenceStore {
    fn load(path: Option<PathBuf>) -> Self {
        let value = path.as_ref().and_then(|p| std::fs::read(p).ok())
            .and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default();
        Self { path, value: Mutex::new(value) }
    }
    fn enabled(&self) -> bool { self.value.lock().unwrap().close_to_tray }
    fn save(&self, enabled: bool) -> Result<(), String> {
        let mut value = self.value.lock().unwrap();
        let path = self.path.as_ref().ok_or("Application configuration directory unavailable")?;
        let next = Preferences { close_to_tray: enabled };
        save(path, &next)?;
        *value = next;
        Ok(())
    }
}
fn save(path: &Path, value: &Preferences) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid preference path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.flush().and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

struct TrayLabels { show: MenuItem<tauri::Wry>, quit: MenuItem<tauri::Wry> }

#[derive(Debug, PartialEq)]
pub(crate) enum CloseAction { CloseDetached, Hide, Exit }
fn close_action(main: bool, enabled: bool, tray_available: bool, macos: bool) -> CloseAction {
    if !main { CloseAction::CloseDetached }
    else if (enabled && tray_available) || macos { CloseAction::Hide }
    else { CloseAction::Exit }
}
pub(crate) fn action(app: &tauri::AppHandle, label: &str) -> CloseAction {
    let enabled = app.try_state::<PreferenceStore>().is_some_and(|s| s.enabled());
    close_action(label == "main", enabled, app.tray_by_id(TRAY_ID).is_some(), cfg!(target_os = "macos"))
}
pub(crate) fn restore(app: &tauri::AppHandle) {
    mark_window_handled(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
    }
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    app.manage(StartupReveal::default());
    app.manage(PreferenceStore::load(app.path().app_config_dir().ok().map(|p| p.join("desktop-preferences.json"))));
    // A real restore/quit route exists before close-to-tray can be enabled.
    // Tray failure leaves ordinary close behavior available on Windows/Linux.
    if let Err(error) = create_tray(app) { eprintln!("[tray] Could not create system tray icon: {error}"); }
}
fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_ID, "Show Sinos CLI", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Sinos CLI").menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW_ID => restore(app),
            QUIT_ID => app.exit(0), // Always exits; ExitRequested performs session cleanup.
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) { restore(tray.app_handle()); }
        });
    if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
    builder.build(app)?; // Tauri's resource table retains the registered icon.
    app.manage(TrayLabels { show, quit });
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosePreference { close_to_tray: bool, tray_available: bool }
#[tauri::command]
pub fn get_close_preference(app: tauri::AppHandle) -> ClosePreference {
    ClosePreference { close_to_tray: app.state::<PreferenceStore>().enabled(), tray_available: app.tray_by_id(TRAY_ID).is_some() }
}
#[tauri::command]
pub async fn set_close_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<ClosePreference, String> {
    if enabled && app.tray_by_id(TRAY_ID).is_none() { return Err("System tray unavailable".into()); }
    let writer = app.clone();
    tauri::async_runtime::spawn_blocking(move || writer.state::<PreferenceStore>().save(enabled)).await.map_err(|e| e.to_string())??;
    Ok(get_close_preference(app))
}
#[tauri::command]
pub fn set_tray_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    let Some(labels) = app.try_state::<TrayLabels>() else { return Ok(()); };
    let (show, quit) = match language.as_str() {
        "zh-CN" => ("显示 Sinos CLI", "退出"), "zh-TW" => ("顯示 Sinos CLI", "結束"),
        "ja" => ("Sinos CLI を表示", "終了"), "ko" => ("Sinos CLI 표시", "종료"),
        _ => ("Show Sinos CLI", "Quit"),
    };
    labels.show.set_text(show).and_then(|_| labels.quit.set_text(quit)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_reveal_runs_once_even_when_user_hides_during_startup() {
        let reveal = StartupReveal::default();
        assert!(reveal.claim());
        assert!(!reveal.claim()); // Native fallback or late WebView callback after hiding.
        let hidden = StartupReveal::default();
        hidden.claim(); // User hides or restores through the native window/tray.
        assert!(!hidden.claim());
    }
    #[test]
    fn close_routes_preserve_detached_windows_and_native_mac_dock_behavior() {
        for enabled in [false, true] { for tray in [false, true] { for mac in [false, true] {
            assert_eq!(close_action(false, enabled, tray, mac), CloseAction::CloseDetached);
            let expected = if mac || enabled && tray { CloseAction::Hide } else { CloseAction::Exit };
            assert_eq!(close_action(true, enabled, tray, mac), expected);
        } } }
    }
    #[test]
    fn preference_is_opt_in_persistent_and_survives_replacement() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("preferences.json");
        let store = PreferenceStore::load(Some(path.clone())); assert!(!store.enabled());
        store.save(true).unwrap(); assert!(PreferenceStore::load(Some(path.clone())).enabled());
        store.save(false).unwrap(); assert!(!PreferenceStore::load(Some(path.clone())).enabled());
        std::fs::write(&path, "bad json").unwrap(); assert!(!PreferenceStore::load(Some(path)).enabled());
    }
    #[test]
    fn failed_save_preserves_active_preference() {
        let dir = tempfile::tempdir().unwrap(); let parent = dir.path().join("blocked");
        std::fs::write(&parent, "occupied").unwrap();
        let store = PreferenceStore { path: Some(parent.join("prefs.json")), value: Mutex::new(Preferences { close_to_tray: true }) };
        assert!(store.save(false).is_err()); assert!(store.enabled());
    }
}
