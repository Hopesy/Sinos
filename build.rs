fn main() {
    println!("cargo:rerun-if-changed=ui");

    // Keep `cargo check` usable from a clean checkout where
    // the ignored Vite `dist/` directory does not exist yet; release builds
    // populate the same directory via `npm run build` first.
    let dist = std::path::Path::new("src-ui/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(dist);
    }

    tauri_build::build()
}
