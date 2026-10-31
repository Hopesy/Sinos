//! Desktop alerts and bounded taskbar overlays; no helper shells or processes.
use tauri::Manager;

pub(crate) fn initialize(app: &tauri::AppHandle) {
    #[cfg(windows)]
    app.manage(windows_toast::Toasts::default());
    #[cfg(not(windows))]
    let _ = app;
}

fn badge_label(count: u32) -> String {
    if count > 99 { "99+".into() } else { count.to_string() }
}

/// A tiny numeric RGBA overlay, independent of font installation and DPI.
fn badge_image(count: u32) -> Vec<u8> {
    const DIGITS: [[u8; 5]; 11] = [
        [7,5,5,5,7], [2,6,2,2,7], [7,1,7,4,7], [7,1,7,1,7], [5,5,7,1,1],
        [7,4,7,1,7], [7,4,7,5,7], [7,1,1,1,1], [7,5,7,5,7], [7,5,7,1,7], [0,2,7,2,0],
    ];
    let mut pixels = vec![0; 48 * 48 * 4];
    for y in 0..48 { for x in 0..48 {
        let distance = ((x as f32 - 23.5).powi(2) + (y as f32 - 23.5).powi(2)).sqrt();
        let alpha = ((24.0 - distance).clamp(0.0, 1.0) * 255.0) as u8;
        pixels[(y * 48 + x) * 4..(y * 48 + x) * 4 + 4].copy_from_slice(&[210, 48, 64, alpha]);
    } }
    let label = badge_label(count);
    let scale = if label.len() == 1 { 6 } else if label.len() == 2 { 5 } else { 3 };
    let left = (48 - (label.len() * 4 - 1) * scale) / 2;
    let top = (48 - 5 * scale) / 2;
    for (index, ch) in label.bytes().enumerate() {
        let glyph = &DIGITS[if ch == b'+' { 10 } else { (ch - b'0') as usize }];
        for (row, bits) in glyph.iter().enumerate() { for col in 0..3 {
            if bits & (1 << (2 - col)) == 0 { continue; }
            for dy in 0..scale { for dx in 0..scale {
                let pixel = ((top + row * scale + dy) * 48 + left + (index * 4 + col) * scale + dx) * 4;
                pixels[pixel..pixel + 4].copy_from_slice(&[255; 4]);
            } }
        } }
    }
    pixels
}

#[tauri::command]
pub fn set_task_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window unavailable")?;
    #[cfg(windows)]
    window.set_overlay_icon((count > 0).then(|| tauri::image::Image::new_owned(badge_image(count), 48, 48))).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    window.set_badge_count((count > 0).then_some(i64::from(count))).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("sinos-main-tray") {
        let label = if count > 0 { format!("Sinos CLI · {count}") } else { "Sinos CLI".into() };
        let _ = tray.set_tooltip(Some(label));
    }
    Ok(())
}

#[tauri::command]
pub async fn show_desktop_notification(app: tauri::AppHandle, session_id: String, title: String, body: String) -> Result<bool, String> {
    if session_id.len() > 256 || title.len() > 256 || body.len() > 2048 { return Err("Notification too large".into()); }
    #[cfg(windows)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || { let _ = tx.send(windows_toast::show(&handle, session_id, title, body).map_err(|e| e.to_string())); }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    { let _ = (app, session_id, title, body); Ok(false) }
}

#[cfg(windows)]
mod windows_toast {
    use std::{collections::VecDeque, sync::{Mutex, OnceLock, atomic::{AtomicU64, Ordering}}};
    use tauri::{Emitter, Manager};
    use windows::{core::{HSTRING, IInspectable, PCWSTR, w}, Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler, UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager}};

    #[derive(Default)]
    pub struct Toasts(Mutex<VecDeque<ToastNotification>>);
    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn register() -> windows::core::Result<()> {
        use windows::Win32::System::Registry::*;
        let mut key = HKEY::default();
        unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, w!("Software\\Classes\\AppUserModelId\\com.sinos.cli"), 0, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None).ok()?;
            let value: Vec<u8> = "Sinos CLI\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
            let result = RegSetValueExW(key, w!("DisplayName"), 0, REG_SZ, Some(&value)).ok();
            let _ = RegCloseKey(key);
            result
        }
    }
    fn escape(text: &str) -> String {
        text.chars().filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t')).collect::<String>()
            .replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }
    pub fn show(app: &tauri::AppHandle, session: String, title: String, body: String) -> windows::core::Result<bool> {
        static REGISTERED: OnceLock<()> = OnceLock::new();
        if REGISTERED.get().is_none() { register()?; let _ = REGISTERED.set(()); }
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("com.sinos.cli"))?;
        if notifier.Setting()? != NotificationSetting::Enabled { return Ok(false); }
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>", escape(&title), escape(&body))))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&HSTRING::from(format!("{:016x}", NEXT.fetch_add(1, Ordering::Relaxed))))?;
        toast.SetGroup(&HSTRING::from("sinos-sessions"))?;
        let handle = app.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
            crate::desktop_lifecycle::restore(&handle);
            if !session.is_empty() { let _ = handle.emit_to("main", "desktop-notification-activated", &session); }
            Ok(())
        }))?;
        // Cap the live WinRT objects and their activation closures. Evicted
        // notifications are withdrawn, so old callbacks cannot accumulate.
        let old = {
            let state = app.state::<Toasts>();
            let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
            queue.push_back(toast.clone());
            if queue.len() > 32 { queue.pop_front() } else { None }
        };
        if let Some(old) = old { let _ = notifier.Hide(&old); }
        notifier.Show(&toast)?;
        Ok(true)
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn titles_and_body_are_xml_text() {
            assert_eq!(super::escape("a<&\"'\0中文"), "a&lt;&amp;&quot;&apos;中文");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn badge_numbers_are_bounded_and_have_transparent_corners() {
        for count in [1, 2, 3, 9, 10, 99, 100, u32::MAX] {
            let pixels = badge_image(count);
            assert_eq!(pixels.len(), 48 * 48 * 4);
            assert_eq!(pixels[3], 0);
            assert!(pixels.chunks_exact(4).any(|p| p == [255; 4]));
        }
        assert_eq!(badge_label(99), "99");
        assert_eq!(badge_label(100), "99+");
        assert_ne!(badge_image(1), badge_image(2));
    }
}
