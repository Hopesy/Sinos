//! Session-scoped workspace API. The phone never supplies an arbitrary root.
use super::{authorized, RemoteState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path as FsPath, PathBuf};

const MOBILE_FILE_LIMIT: u64 = 512 * 1024;

#[derive(Deserialize, Default)]
pub(super) struct WorkspaceQuery {
    token: Option<String>,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
pub(super) struct SaveRequest {
    content: String,
    expected_revision: String,
    line_ending: String,
    has_utf8_bom: bool,
}

fn workspace(
    state: &RemoteState,
    headers: &HeaderMap,
    query: &WorkspaceQuery,
    id: &str,
) -> Result<PathBuf, Response> {
    if !authorized(state, headers, query.token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }
    let cwd = state
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(id).map(|s| s.cwd.clone()))
        .ok_or_else(|| (StatusCode::NOT_FOUND, "SESSION_NOT_FOUND").into_response())?;
    std::fs::canonicalize(cwd)
        .map_err(|_| (StatusCode::NOT_FOUND, "WORKSPACE_UNAVAILABLE").into_response())
}

fn relative_path(root: &FsPath, relative: &str, missing: bool) -> Result<PathBuf, String> {
    let path = FsPath::new(relative);
    // Reject Windows separators on every host as well as native traversal.
    if relative.split(['/', '\\']).any(|c| c == "..")
        || path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }
    let joined = root.join(path);
    let resolved = match std::fs::canonicalize(&joined) {
        Ok(path) => path,
        Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => {
            // Deleted files still need a diff. Resolve their nearest surviving
            // ancestor so links cannot escape the session's workspace.
            let mut ancestor = joined.as_path();
            let mut tail = Vec::new();
            while !ancestor.exists() {
                tail.push(ancestor.file_name().ok_or("FILE_UNAVAILABLE")?.to_owned());
                ancestor = ancestor.parent().ok_or("FILE_UNAVAILABLE")?;
            }
            let mut resolved = std::fs::canonicalize(ancestor).map_err(|_| "FILE_UNAVAILABLE")?;
            for name in tail.into_iter().rev() {
                resolved.push(name);
            }
            resolved
        }
        Err(_) => return Err("FILE_UNAVAILABLE".into()),
    };
    if !resolved.starts_with(root) {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }
    Ok(resolved)
}

fn failure(error: String) -> Response {
    (StatusCode::BAD_REQUEST, error).into_response()
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

pub(super) async fn directory(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<String>,
) -> Response {
    let root = match workspace(&state, &headers, &query, &id) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let dir = relative_path(&root, &query.path, false)?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in std::fs::read_dir(dir).map_err(|_| "DIRECTORY_UNAVAILABLE")? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let Ok(resolved) = entry.path().canonicalize() else {
                continue;
            };
            if !resolved.starts_with(&root) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if entries.len() == 1000 {
                truncated = true;
                break;
            }
            entries.push(Entry {
                name,
                path: entry
                    .path()
                    .strip_prefix(&root)
                    .map_err(|_| "PATH_OUTSIDE_WORKSPACE")?
                    .to_string_lossy()
                    .replace('\\', "/"),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(serde_json::json!({ "entries": entries, "truncated": truncated }))
    })
    .await;
    match result {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(error)) => failure(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn file(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<String>,
) -> Response {
    let root = match workspace(&state, &headers, &query, &id) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || {
        let path = relative_path(&root, &query.path, false)?;
        if std::fs::metadata(&path)
            .map_err(|_| "FILE_UNAVAILABLE")?
            .len()
            > MOBILE_FILE_LIMIT
        {
            return Err("FILE_TOO_LARGE".into());
        }
        crate::server::read_editor_file(
            path.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        )
    })
    .await;
    match result {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(error)) => failure(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn save(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<String>,
    Json(request): Json<SaveRequest>,
) -> Response {
    let root = match workspace(&state, &headers, &query, &id) {
        Ok(root) => root,
        Err(response) => return response,
    };
    if request.content.len() as u64 > MOBILE_FILE_LIMIT {
        return failure("FILE_TOO_LARGE".into());
    }
    let result = tokio::task::spawn_blocking(move || {
        let path = relative_path(&root, &query.path, false)?;
        crate::server::write_editor_file(
            path.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            request.content,
            request.expected_revision,
            request.line_ending,
            request.has_utf8_bom,
        )
    })
    .await;
    match result {
        Ok(Ok(body @ crate::server::EditorSaveResponse::Conflict { .. })) => {
            (StatusCode::CONFLICT, Json(body)).into_response()
        }
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(error)) => failure(error),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn changes(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<String>,
) -> Response {
    let root = match workspace(&state, &headers, &query, &id) {
        Ok(root) => root,
        Err(response) => return response,
    };
    match crate::git::git_changes(root.to_string_lossy().into_owned()).await {
        crate::git::GitChanges::Ok {
            repo_root,
            branch,
            uncommitted,
            untracked,
            ..
        } => {
            let files: Vec<_> = uncommitted.into_iter().chain(untracked).filter_map(|entry| {
                let repo = FsPath::new(&repo_root).canonicalize().ok()?;
                let path = relative_path(&repo, &entry.rel, true).ok()?;
                let rel = path.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
                Some(serde_json::json!({ "path": rel, "status": entry.status, "added": entry.added, "deleted": entry.deleted }))
            }).collect();
            Json(serde_json::json!({ "state": "ok", "branch": branch, "files": files }))
                .into_response()
        }
        crate::git::GitChanges::NoGit => {
            Json(serde_json::json!({ "state": "no_git", "files": [] })).into_response()
        }
        crate::git::GitChanges::NotRepo => {
            Json(serde_json::json!({ "state": "not_repo", "files": [] })).into_response()
        }
    }
}

pub(super) async fn diff(
    State(state): State<RemoteState>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<String>,
) -> Response {
    let root = match workspace(&state, &headers, &query, &id) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let path = match relative_path(&root, &query.path, true) {
        Ok(path) => path,
        Err(error) => return failure(error),
    };
    let crate::git::GitChanges::Ok { repo_root, .. } =
        crate::git::git_changes(root.to_string_lossy().into_owned()).await
    else {
        return failure("NOT_REPOSITORY".into());
    };
    let repo = match FsPath::new(&repo_root).canonicalize() {
        Ok(repo) => repo,
        Err(_) => return failure("NOT_REPOSITORY".into()),
    };
    let rel = match path.strip_prefix(repo) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => return failure("PATH_OUTSIDE_WORKSPACE".into()),
    };
    let before = crate::git::git_show_file(repo_root, format!("HEAD:{rel}"))
        .await
        .unwrap_or_default();
    if before.len() as u64 > MOBILE_FILE_LIMIT || before.contains('\0') {
        return failure("FILE_TOO_LARGE_OR_BINARY".into());
    }
    let after = match tokio::task::spawn_blocking(move || -> Result<String, String> {
        if !path.exists() {
            return Ok(String::new());
        }
        if std::fs::metadata(&path)
            .map_err(|_| "FILE_UNAVAILABLE")?
            .len()
            > MOBILE_FILE_LIMIT
        {
            return Err("FILE_TOO_LARGE".into());
        }
        let text = std::fs::read_to_string(path).map_err(|_| "EDITOR_UNSUPPORTED_ENCODING")?;
        if text.contains('\0') {
            return Err("EDITOR_BINARY_FILE".into());
        }
        Ok(text)
    })
    .await
    {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => return failure(error),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    Json(serde_json::json!({ "before": before, "after": after, "path": query.path }))
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_rejects_traversal_and_allows_deleted_files() {
        let root = std::env::temp_dir().join(format!("sinos-mobile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        assert!(relative_path(&root, "../secret", true).is_err());
        assert!(relative_path(&root, "..\\secret", true).is_err());
        assert!(relative_path(&root, root.to_str().unwrap(), false).is_err());
        assert_eq!(
            relative_path(&root, "removed/f.txt", true).unwrap(),
            root.join("removed/f.txt")
        );
        std::fs::remove_dir(root).unwrap();
    }
}
