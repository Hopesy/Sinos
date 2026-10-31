//! Small engineering tasks in a user-selected workspace, without hidden processes.
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_FILE_BYTES: u64 = 1_000_000;

fn workspace_path(cwd: &str, relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    let root = crate::agent::canonical_directory(cwd)?;
    let normalized = relative.replace('\\', "/");
    if normalized.contains(':') {
        return Err("Use a workspace-relative path".into());
    }
    let mut path = root.clone();
    for part in Path::new(&normalized).components() {
        match part {
            Component::Normal(name) => path.push(name),
            Component::CurDir => {}
            _ => return Err("Path must stay inside the chosen workspace".into()),
        }
    }
    if path == root && !allow_root {
        return Err("Specify a file path inside the workspace".into());
    }
    let exists = path.exists();
    let checked = if exists {
        path.canonicalize()
    } else {
        path.parent()
            .ok_or("Missing parent directory")?
            .canonicalize()
    }
    .map_err(|_| "Path or parent directory does not exist")?;
    if !checked.starts_with(&root) {
        return Err("Path resolves outside the chosen workspace".into());
    }
    // Editing an internal symlink must replace its target, not the link itself.
    Ok(if exists { checked } else { path })
}

fn read_text(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Path is not a file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return Err("Read supports UTF-8 text files up to 1 MB".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

fn replace_text(path: &Path, text: &str) -> Result<(), String> {
    let permissions = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    if permissions.readonly() {
        return Err("File is read-only".into());
    }
    let temp = path.with_file_name(format!(".coffee-agent-edit-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.set_permissions(permissions).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        crate::agent::replace_file(&temp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

#[tauri::command]
pub fn agent_workspace_tool(name: String, arguments: Value) -> Result<Value, String> {
    if !matches!(
        name.as_str(),
        "workspace_list" | "file_read" | "file_create" | "file_edit"
    ) {
        return Err("Workspace tool is not allowed".into());
    }
    crate::agent::validate_tool(&name, &arguments)?;
    let cwd = arguments["cwd"]
        .as_str()
        .ok_or("Specify the workspace directory")?;
    let relative = arguments["path"].as_str().unwrap_or("");
    let path = workspace_path(cwd, relative, name == "workspace_list")?;
    match name.as_str() {
        "workspace_list" => {
            let mut entries = fs::read_dir(&path)
                .map_err(|e| e.to_string())?
                .take(201)
                .map(|entry| {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let kind = entry.file_type().map_err(|e| e.to_string())?;
                    Ok(json!({"name":entry.file_name().to_string_lossy(), "kind":if kind.is_symlink() {"link"} else if kind.is_dir() {"directory"} else {"file"}}))
                })
                .collect::<Result<Vec<Value>, String>>()?;
            let truncated = entries.len() > 200;
            entries.truncate(200);
            entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            Ok(json!({"path":relative,"entries":entries,"truncated":truncated}))
        }
        "file_read" => {
            let text = read_text(&path)?;
            let start = arguments["startLine"].as_u64().unwrap_or(1) as usize;
            let limit = arguments["limit"].as_u64().unwrap_or(100) as usize;
            let lines: Vec<_> = text.split_inclusive('\n').collect();
            let selected = lines
                .iter()
                .skip(start - 1)
                .take(limit)
                .copied()
                .collect::<Vec<_>>()
                .join("");
            let truncated = selected.chars().count() > 20_000;
            Ok(
                json!({"path":relative,"startLine":start,"totalLines":lines.len(),"content":selected.chars().take(20_000).collect::<String>(),"truncated":truncated}),
            )
        }
        "file_create" => {
            let content = arguments["content"].as_str().ok_or("Missing content")?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| {
                    format!("Could not create a new file (existing files are preserved): {e}")
                })?;
            file.write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
            Ok(json!({"path":relative,"created":true,"bytes":content.len()}))
        }
        "file_edit" => {
            let text = read_text(&path)?;
            let old = arguments["oldText"].as_str().ok_or("Missing oldText")?;
            let new = arguments["newText"].as_str().ok_or("Missing newText")?;
            if text.matches(old).count() != 1 {
                return Err(
                    "oldText must match exactly once; read the file and include more context"
                        .into(),
                );
            }
            let updated = text.replacen(old, new, 1);
            if updated.len() as u64 > MAX_FILE_BYTES {
                return Err("Edited file exceeds 1 MB".into());
            }
            replace_text(&path, &updated)?;
            Ok(json!({"path":relative,"edited":true}))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engineering_tools_preserve_files_and_require_exact_edits() {
        let root = std::env::temp_dir().join(format!("coffee-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let run = |name: &str, mut args: Value| {
            args["cwd"] = json!(root.to_string_lossy());
            agent_workspace_tool(name.into(), args)
        };
        run(
            "file_create",
            json!({"path":"code.txt","content":"你好\nrepeat\nrepeat\nunique\n"}),
        )
        .unwrap();
        assert!(run(
            "file_create",
            json!({"path":"code.txt","content":"overwrite"})
        )
        .is_err());
        for old in ["repeat", "missing", ""] {
            assert!(run(
                "file_edit",
                json!({"path":"code.txt","oldText":old,"newText":"wrong"})
            )
            .is_err());
        }
        assert!(fs::read_to_string(root.join("code.txt"))
            .unwrap()
            .contains("unique"));
        run(
            "file_edit",
            json!({"path":"code.txt","oldText":"unique\n","newText":""}),
        )
        .unwrap();
        let result = run(
            "file_read",
            json!({"path":"code.txt","startLine":2,"limit":1}),
        )
        .unwrap();
        assert_eq!(result["content"], "repeat\n");
        assert_eq!(result["totalLines"], 3);
        run("file_create", json!({"path":"empty.txt","content":""})).unwrap();
        assert_eq!(
            run("workspace_list", json!({})).unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for path in ["../escape.txt", "/escape.txt", "C:\\escape.txt", "."] {
            assert!(run("file_create", json!({"path":path,"content":"wrong"})).is_err());
        }
        assert!(run("file_read", json!({"path":"code.txt","startLine":0})).is_err());
        assert!(run("shell_exec", json!({})).is_err());
        run(
            "file_create",
            json!({"path":"windows.txt","content":"one\r\ntwo\r\nthree\r\n"}),
        )
        .unwrap();
        let original = run(
            "file_read",
            json!({"path":"windows.txt","startLine":1,"limit":2}),
        )
        .unwrap();
        assert_eq!(original["content"], "one\r\ntwo\r\n");
        run(
            "file_edit",
            json!({"path":"windows.txt","oldText":original["content"],"newText":"changed\r\n"}),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("windows.txt")).unwrap(),
            "changed\r\nthree\r\n"
        );
        assert!(run(
            "file_create",
            json!({"path":"missing/child.txt","content":""})
        )
        .is_err());
        assert!(!root.join("missing").exists());
        fs::write(root.join("binary.txt"), [0, 255]).unwrap();
        assert!(run("file_read", json!({"path":"binary.txt"})).is_err());
        assert!(agent_workspace_tool("workspace_list".into(), json!({"cwd":""})).is_err());
        // Remove only the exact UUID directory created by this test.
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_original_and_removes_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let root = std::env::temp_dir().join(format!("coffee-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("code.txt");
        fs::write(&path, "original\n").unwrap();
        // Reads and writes are allowed, but the final atomic replacement is denied.
        let locked = OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0).open(&path).unwrap();
        let edit = || agent_workspace_tool("file_edit".into(), json!({
            "cwd":root.to_string_lossy(), "path":"code.txt", "oldText":"original", "newText":"updated"
        }));
        assert!(edit().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original\n");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        drop(locked);
        edit().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated\n");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_only_file_is_preserved_without_creating_temporary_files() {
        let root = std::env::temp_dir().join(format!("coffee-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("code.txt");
        fs::write(&path, "original\n").unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut read_only = original_permissions.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        assert!(agent_workspace_tool("file_edit".into(), json!({
            "cwd":root.to_string_lossy(), "path":"code.txt", "oldText":"original", "newText":"updated"
        })).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original\n");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::set_permissions(&path, original_permissions).unwrap();
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn editing_internal_symlink_preserves_link_and_target_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("coffee-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("code.txt");
        fs::write(&path, "original\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink("code.txt", root.join("link.txt")).unwrap();
        agent_workspace_tool("file_edit".into(), json!({
            "cwd":root.to_string_lossy(), "path":"link.txt", "oldText":"original", "newText":"updated"
        })).unwrap();
        assert!(fs::symlink_metadata(root.join("link.txt")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated\n");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_escape_the_workspace() {
        let root = std::env::temp_dir().join(format!("coffee-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), root.join("outside")).unwrap();
        assert!(workspace_path(root.to_str().unwrap(), "outside/file.txt", false).is_err());
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(root).unwrap();
    }
}
