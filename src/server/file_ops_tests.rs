use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let id = EDITOR_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("sinos-link-tests-{}-{id}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
fn text(path: &std::path::Path) -> String { path.to_string_lossy().into_owned() }
fn directory_link(target: &std::path::Path, link: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"]).arg(link).arg(target)
            .creation_flags(0x08000000).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn deleting_and_renaming_links_never_operates_on_the_external_target() {
    let fixture = Fixture::new(); let root = fixture.path("workspace"); let external = fixture.path("external");
    std::fs::create_dir(&root).unwrap(); std::fs::create_dir(&external).unwrap();
    std::fs::write(external.join("keep.txt"), "user data").unwrap();
    let link = root.join("link"); directory_link(&external, &link);
    fs_rename(text(&link), "renamed".into(), text(&root)).unwrap();
    fs_delete(text(&root.join("renamed")), text(&root)).unwrap();
    assert_eq!(std::fs::read_to_string(external.join("keep.txt")).unwrap(), "user data");
    assert!(!root.join("renamed").exists());
}

#[test]
fn dangling_links_are_deletable_and_still_block_destination_overwrites() {
    let fixture = Fixture::new(); let root = fixture.path("workspace"); std::fs::create_dir(&root).unwrap();
    let link = root.join("dangling"); directory_link(&fixture.path("missing"), &link);
    let source = root.join("source"); std::fs::write(&source, "keep").unwrap();
    assert_eq!(fs_rename(text(&source), "dangling".into(), text(&root)).unwrap_err(), "FS_DESTINATION_EXISTS");
    fs_delete(text(&link), text(&root)).unwrap();
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(std::fs::read_to_string(source).unwrap(), "keep");
}

#[test]
fn linked_parents_cannot_escape_the_workspace() {
    let fixture = Fixture::new(); let root = fixture.path("workspace"); let external = fixture.path("external");
    std::fs::create_dir(&root).unwrap(); std::fs::create_dir(&external).unwrap();
    std::fs::write(external.join("keep.txt"), "keep").unwrap();
    directory_link(&external, &root.join("alias"));
    assert_eq!(fs_delete(text(&root.join("alias/keep.txt")), text(&root)).unwrap_err(), "FS_PATH_OUTSIDE_WORKSPACE");
    assert!(fs_delete(text(&root), text(&root)).is_err());
    assert!(external.join("keep.txt").exists());
}

#[test]
fn failed_directory_creation_never_rolls_back_someone_elses_destination() {
    let fixture = Fixture::new(); let source = fixture.path("source"); let target = fixture.path("target");
    std::fs::create_dir(&source).unwrap(); std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep.txt"), "keep").unwrap();
    assert!(copy_dir_all(&source, &target).is_err());
    assert_eq!(std::fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
}

#[cfg(unix)]
#[test]
fn recursive_copy_preserves_dangling_and_external_links_without_following_them() {
    let fixture = Fixture::new(); let root = fixture.path("workspace"); let source = root.join("source"); let target = root.join("target");
    std::fs::create_dir_all(&source).unwrap(); std::fs::create_dir(&target).unwrap();
    std::fs::write(fixture.path("outside.txt"), "external").unwrap();
    std::os::unix::fs::symlink(fixture.path("outside.txt"), source.join("file-link")).unwrap();
    std::os::unix::fs::symlink("missing", source.join("dangling")).unwrap();
    fs_paste("copy".into(), text(&source), text(&target), text(&root)).unwrap();
    for name in ["file-link", "dangling"] {
        let copied = target.join("source").join(name);
        assert!(std::fs::symlink_metadata(&copied).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(copied).unwrap(), std::fs::read_link(source.join(name)).unwrap());
    }
    fs_delete(text(&source.join("file-link")), text(&root)).unwrap();
    assert_eq!(std::fs::read_to_string(fixture.path("outside.txt")).unwrap(), "external");
}

#[cfg(unix)]
#[test]
fn copying_an_unsupported_entry_rolls_back_only_the_new_directory() {
    let fixture = Fixture::new(); let source = fixture.path("source"); let dest = fixture.path("dest");
    std::fs::create_dir(&source).unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(source.join("socket")).unwrap();
    assert!(copy_dir_all(&source, &dest).is_err());
    assert!(!dest.exists()); assert!(source.join("socket").exists());
}
