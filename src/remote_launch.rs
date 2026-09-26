use std::path::{Path, PathBuf};

pub fn desktop() -> Option<PathBuf> {
    dirs::desktop_dir().or_else(|| dirs::home_dir().map(|home| home.join("Desktop")))
}

pub fn prepare_directory(requested: Option<&str>) -> Result<String, String> {
    let desktop = desktop().ok_or("CWD_UNAVAILABLE")?;
    prepare(requested, &desktop, dirs::home_dir().as_deref())
        .map(|path| path.to_string_lossy().into_owned())
}

fn prepare(requested: Option<&str>, desktop: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let input = requested.unwrap_or("").trim();
    let path = if input.is_empty() {
        desktop.to_path_buf()
    } else if input == "~" || input.starts_with("~/") || input.starts_with("~\\") {
        home.ok_or("CWD_UNAVAILABLE")?.join(input.get(2..).unwrap_or(""))
    } else {
        let path = PathBuf::from(input);
        if path.is_absolute() { path } else { desktop.join(path) }
    };
    if path.is_file() { return Err("CWD_NOT_DIRECTORY".into()); }
    std::fs::create_dir_all(&path).map_err(|error| format!("CWD_CREATE_FAILED: {error}"))?;
    if !path.is_dir() { return Err("CWD_NOT_DIRECTORY".into()); }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_launch_defaults_to_desktop_and_creates_requested_directories() {
        let root = std::env::temp_dir().join(format!("sinos-launch-{}", uuid::Uuid::new_v4()));
        let desktop = root.join("Desktop");
        assert_eq!(prepare(None, &desktop, Some(&root)).unwrap(), desktop);
        assert_eq!(prepare(Some("  "), &desktop, Some(&root)).unwrap(), desktop);
        let nested = desktop.join("new project").join("child");
        assert_eq!(prepare(Some(nested.to_str().unwrap()), &desktop, Some(&root)).unwrap(), nested);
        assert!(nested.is_dir());
        assert_eq!(prepare(Some("relative"), &desktop, Some(&root)).unwrap(), desktop.join("relative"));
        assert_eq!(prepare(Some("~/project"), &desktop, Some(&root)).unwrap(), root.join("project"));
        let file = desktop.join("existing.txt");
        std::fs::write(&file, "keep").unwrap();
        assert_eq!(prepare(Some(file.to_str().unwrap()), &desktop, Some(&root)).unwrap_err(), "CWD_NOT_DIRECTORY");
        assert!(prepare(Some(file.join("child").to_str().unwrap()), &desktop, Some(&root)).unwrap_err().starts_with("CWD_CREATE_FAILED"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
