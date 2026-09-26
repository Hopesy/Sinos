//! Desktop image input: screenshots and Windows Explorer's CF_HDROP file list.
use std::path::Path;

fn image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
            )
        })
}

pub(crate) fn validate_images(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.len() > 32 {
        return Err("IMAGE_TOO_MANY".into());
    }
    let mut images = Vec::new();
    for path in paths {
        if !image_path(&path) {
            continue;
        }
        if path.chars().any(char::is_control) {
            return Err("IMAGE_INVALID_PATH".into());
        }
        let meta = std::fs::metadata(&path).map_err(|_| "IMAGE_FILE_UNAVAILABLE")?;
        if !meta.is_file() {
            return Err("IMAGE_FILE_UNAVAILABLE".into());
        }
        if meta.len() == 0 {
            return Err("IMAGE_FILE_EMPTY".into());
        }
        if meta.len() > 25 * 1024 * 1024 {
            return Err("IMAGE_TOO_LARGE".into());
        }
        if !images.contains(&path) {
            images.push(path);
        }
    }
    Ok(images)
}

#[cfg(windows)]
mod native {
    use windows::Win32::{
        Foundation::HWND,
        System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            RegisterClipboardFormatW,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };
    const CF_HDROP: u32 = 15;
    pub(super) fn files() -> Result<Vec<String>, String> {
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP).is_err() {
                return Ok(vec![]);
            }
            let mut opened = false;
            for _ in 0..8 {
                if OpenClipboard(HWND::default()).is_ok() {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !opened {
                return Err("IMAGE_CLIPBOARD_BUSY".into());
            }
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    unsafe {
                        let _ = CloseClipboard();
                    }
                }
            }
            let _guard = Guard;
            let data = GetClipboardData(CF_HDROP).map_err(|_| "IMAGE_CLIPBOARD_BUSY")?;
            let drop = HDROP(data.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            if count > 32 {
                return Err("IMAGE_TOO_MANY".into());
            }
            let mut paths = Vec::new();
            for i in 0..count {
                let len = DragQueryFileW(drop, i, None) as usize;
                if len == 0 || len > 32767 {
                    return Err("IMAGE_INVALID_PATH".into());
                }
                let mut path = vec![0u16; len + 1];
                let read = DragQueryFileW(drop, i, Some(&mut path)) as usize;
                if read != len {
                    return Err("IMAGE_INVALID_PATH".into());
                }
                paths.push(String::from_utf16(&path[..read]).map_err(|_| "IMAGE_INVALID_PATH")?);
            }
            Ok(paths)
        }
    }
    pub(super) fn bitmap_available() -> bool {
        unsafe {
            let png = RegisterClipboardFormatW(windows::core::w!("PNG"));
            [2, 8, 17, png]
                .into_iter()
                .filter(|v| *v != 0)
                .any(|format| IsClipboardFormatAvailable(format).is_ok())
        }
    }
}

#[tauri::command]
pub(crate) async fn clipboard_has_image(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let _ = app;
            // Only inspect formats/filenames; never encode/save a screenshot on right click.
            Ok(native::bitmap_available() || native::files()?.iter().any(|path| image_path(path)))
        }
        #[cfg(not(windows))]
        {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            Ok(app.clipboard().read_image().is_ok())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn read_clipboard_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let images = tauri::async_runtime::spawn_blocking(|| validate_images(native::files()?))
            .await
            .map_err(|e| e.to_string())??;
        if !images.is_empty() {
            return Ok(images);
        }
    }
    #[cfg(windows)]
    let expected_image = native::bitmap_available();
    let image = crate::server::read_clipboard_image(app).await?;
    #[cfg(windows)]
    if expected_image && image.is_none() {
        return Err("IMAGE_CLIPBOARD_BUSY".into());
    }
    Ok(image.into_iter().collect())
}

#[tauri::command]
pub(crate) async fn prepare_image_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || validate_images(paths))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unicode_spaces_and_multiple_images_and_reports_missing_files() {
        let dir = std::env::temp_dir().join(format!("sinos-images-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("截图 one.PNG").to_string_lossy().into_owned();
        let second = dir.join("two.jpeg").to_string_lossy().into_owned();
        for path in [&first, &second] {
            std::fs::write(path, b"fixture").unwrap();
        }
        assert_eq!(
            validate_images(vec![
                first.clone(),
                second.clone(),
                first.clone(),
                "note.txt".into()
            ])
            .unwrap(),
            vec![first.clone(), second]
        );
        assert_eq!(
            validate_images(vec![dir.join("gone.webp").to_string_lossy().into_owned()]),
            Err("IMAGE_FILE_UNAVAILABLE".into())
        );
        assert_eq!(
            validate_images(vec![first; 33]),
            Err("IMAGE_TOO_MANY".into())
        );
        std::fs::remove_dir_all(&dir).unwrap(); // Only the UUID test directory above.
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes a synthetic Windows Explorer file-list clipboard"]
    fn reads_real_windows_explorer_image_clipboard() {
        let dir =
            std::env::temp_dir().join(format!("sinos-image-clipboard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = vec![
            dir.join("截图 one.png").to_string_lossy().into_owned(),
            dir.join("two.jpg").to_string_lossy().into_owned(),
        ];
        for path in &paths {
            std::fs::write(path, b"fixture").unwrap();
        }
        let fixture = dir.join("paths.json");
        std::fs::write(&fixture, serde_json::to_string(&paths).unwrap()).unwrap();
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$imageFiles = New-Object System.Collections.Specialized.StringCollection
$testPaths = Get-Content -Raw -Encoding utf8 -LiteralPath $env:SINOS_IMAGE_FIXTURE | ConvertFrom-Json
foreach ($imagePath in $testPaths) { [void]$imageFiles.Add($imagePath) }
[System.Windows.Forms.Clipboard]::SetFileDropList($imageFiles)
"#;
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
            .env("SINOS_IMAGE_FIXTURE", fixture)
            .status()
            .unwrap();
        let read = native::files();
        let validated = read.clone().and_then(validate_images);
        std::fs::remove_dir_all(&dir).unwrap(); // Only the UUID fixture directory.
        assert!(status.success());
        assert_eq!(read.unwrap(), paths);
        assert_eq!(validated.unwrap(), paths);
    }
}
