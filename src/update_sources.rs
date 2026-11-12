//! Published Sinos installers from GitHub Releases, with mandatory size and SHA-256 verification.
//! Network I/O is blocking; callers run it on a blocking worker.

use std::io::Read;
use std::time::Duration;

pub const RELEASE_URL: &str = "https://api.github.com/repos/Hopesy/Sinos/releases/latest";

#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub url: String,
    pub expect: FileEntry,
}

pub struct Opened {
    pub candidate: Candidate,
    pub reader: Box<dyn Read + Send + Sync>,
}

pub fn asset_suffix(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("Windows_x64-setup.exe"),
        ("macos", "aarch64") => Some("macOS_arm64.dmg"),
        ("macos", "x86_64") => Some("macOS_x64.dmg"),
        ("linux-deb", "aarch64") => Some("Linux_arm64.deb"),
        ("linux-deb", "x86_64") => Some("Linux_x64.deb"),
        ("linux-rpm", "aarch64") => Some("Linux_arm64.rpm"),
        ("linux-rpm", "x86_64") => Some("Linux_x64.rpm"),
        ("linux-appimage", "aarch64") => Some("Linux_arm64.AppImage"),
        ("linux-appimage", "x86_64") => Some("Linux_x64.AppImage"),
        _ => None,
    }
}

pub fn linux_package_kind(has: impl Fn(&str) -> bool) -> &'static str {
    if has("dpkg") { "linux-deb" } else if has("rpm") { "linux-rpm" } else { "linux-appimage" }
}

fn version(tag: &str) -> Result<semver::Version, String> {
    let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| "Release version is invalid")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("A stable release is required".into());
    }
    Ok(version)
}

fn trusted_asset_url(raw: &str, tag: &str, name: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else { return false };
    let expected = format!("/Hopesy/Sinos/releases/download/{tag}/{name}");
    url.scheme() == "https" && url.host_str() == Some("github.com")
        && url.username().is_empty() && url.password().is_none()
        && url.port().is_none() && url.query().is_none() && url.fragment().is_none()
        && url.path().eq_ignore_ascii_case(&expected)
}

/// Plan from one immutable public release, never from a website or mirror manifest.
pub fn plan(release: &serde_json::Value, os: &str, arch: &str, installed: &str) -> Result<Candidate, String> {
    if release["draft"].as_bool() != Some(false) || release["prerelease"].as_bool() != Some(false) {
        return Err("Release is not public and stable".into());
    }
    let tag = release["tag_name"].as_str().ok_or("Release tag is missing")?;
    let latest = version(tag)?;
    if latest <= version(installed)? { return Err("Sinos CLI is already up to date".into()); }
    let suffix = asset_suffix(os, arch).ok_or("No installer for this platform")?;
    let name = format!("Sinos.CLI_{latest}_{suffix}");
    let asset = release["assets"].as_array().ok_or("Release assets are missing")?
        .iter().find(|asset| asset["name"].as_str() == Some(name.as_str()))
        .ok_or("The installer is not available yet; please try again later")?;
    if asset["state"].as_str() != Some("uploaded") { return Err("Installer upload is incomplete".into()); }
    let size = asset["size"].as_u64().filter(|size| *size > 0).ok_or("Installer size is missing")?;
    let digest = asset["digest"].as_str().and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Installer SHA-256 is missing or invalid")?;
    let url = asset["browser_download_url"].as_str().ok_or("Installer URL is missing")?;
    if !trusted_asset_url(url, tag, &name) { return Err("Installer URL is outside the Sinos release".into()); }
    Ok(Candidate { name, url: url.into(), expect: FileEntry { size, sha256: digest.into() } })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(30))
        .redirects(5)
        .user_agent(concat!("SinosCLI/", env!("CARGO_PKG_VERSION")))
        .build()
}

pub fn resolve(os: &str) -> Result<Candidate, String> {
    let response = agent().get(RELEASE_URL).set("Accept", "application/vnd.github+json")
        .call().map_err(|error| format!("Release lookup failed: {error}"))?;
    let release = serde_json::from_reader(response.into_reader().take(2 * 1024 * 1024))
        .map_err(|error| format!("Invalid release response: {error}"))?;
    plan(&release, os, std::env::consts::ARCH, env!("CARGO_PKG_VERSION"))
}

pub fn open(candidate: Candidate) -> Result<Opened, String> {
    let response = agent().get(&candidate.url).call().map_err(|error| format!("Download failed: {error}"))?;
    if let Some(length) = response.header("Content-Length").and_then(|value| value.parse::<u64>().ok()) {
        if length != candidate.expect.size { return Err("Installer response size does not match the release".into()); }
    }
    Ok(Opened { candidate, reader: response.into_reader() })
}

pub fn verify(candidate: &Candidate, size: u64, sha256: &str) -> Result<(), String> {
    if size != candidate.expect.size { return Err("Installer size does not match the release".into()); }
    if !sha256.eq_ignore_ascii_case(&candidate.expect.sha256) { return Err("Installer SHA-256 does not match the release".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(suffix: &str) -> serde_json::Value {
        let name = format!("Sinos.CLI_4.0.6_{suffix}");
        json!({"tag_name":"v4.0.6","draft":false,"prerelease":false,"assets":[{
            "name":name,"state":"uploaded","size":10,"digest":format!("sha256:{}", "a".repeat(64)),
            "browser_download_url":format!("https://github.com/Hopesy/Sinos/releases/download/v4.0.6/{name}")
        }]})
    }

    #[test]
    fn all_published_platforms_and_linux_fallback() {
        for (os, arch, suffix) in [
            ("windows", "x86_64", "Windows_x64-setup.exe"),
            ("macos", "aarch64", "macOS_arm64.dmg"), ("macos", "x86_64", "macOS_x64.dmg"),
            ("linux-deb", "aarch64", "Linux_arm64.deb"), ("linux-deb", "x86_64", "Linux_x64.deb"),
            ("linux-rpm", "aarch64", "Linux_arm64.rpm"), ("linux-rpm", "x86_64", "Linux_x64.rpm"),
            ("linux-appimage", "aarch64", "Linux_arm64.AppImage"), ("linux-appimage", "x86_64", "Linux_x64.AppImage"),
        ] { assert!(plan(&release(suffix), os, arch, "4.0.5").is_ok()); }
        assert_eq!(linux_package_kind(|_| true), "linux-deb");
        assert_eq!(linux_package_kind(|p| p == "rpm"), "linux-rpm");
        assert_eq!(linux_package_kind(|_| false), "linux-appimage");
        assert!(asset_suffix("windows", "aarch64").is_none());
        assert!(asset_suffix("linux-deb", "riscv64").is_none());
    }

    #[test]
    fn only_newer_complete_public_releases_are_accepted() {
        let valid = release("Windows_x64-setup.exe");
        for installed in ["4.0.6", "4.0.7"] { assert!(plan(&valid, "windows", "x86_64", installed).is_err()); }
        assert!(plan(&valid, "macos", "aarch64", "4.0.5").is_err());
        for (key, value) in [("draft", json!(true)), ("prerelease", json!(true)), ("tag_name", json!("v4.0.7-beta")), ("tag_name", json!("latest"))] {
            let mut bad = valid.clone(); bad[key] = value;
            assert!(plan(&bad, "windows", "x86_64", "4.0.5").is_err());
        }
        for (key, value) in [("state", json!("new")), ("size", json!(0)), ("digest", json!(null)), ("digest", json!("sha256:bad"))] {
            let mut bad = valid.clone(); bad["assets"][0][key] = value;
            assert!(plan(&bad, "windows", "x86_64", "4.0.5").is_err());
        }
    }

    #[test]
    fn asset_url_is_bound_to_the_repository_tag_and_filename() {
        let valid = release("Windows_x64-setup.exe");
        let url = valid["assets"][0]["browser_download_url"].as_str().unwrap();
        for bad in [url.replace("https:", "http:"), url.replace("github.com/", "github.com.evil/"),
            url.replace("Hopesy/Sinos", "another/repo"), url.replace("download/v4.0.6/", "download/v4.0.4/"),
            format!("{url}?redirect=elsewhere"), url.replace("github.com", "user@github.com")] {
            let mut release = valid.clone(); release["assets"][0]["browser_download_url"] = json!(bad);
            assert!(plan(&release, "windows", "x86_64", "4.0.5").is_err());
        }
    }

    #[test]
    fn downloaded_bytes_must_match_both_size_and_digest() {
        let candidate = plan(&release("Windows_x64-setup.exe"), "windows", "x86_64", "4.0.5").unwrap();
        assert!(verify(&candidate, 10, &"A".repeat(64)).is_ok());
        assert!(verify(&candidate, 9, &"a".repeat(64)).is_err());
        assert!(verify(&candidate, 10, &"b".repeat(64)).is_err());
    }
}
