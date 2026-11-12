fn main() {
    println!("cargo:rerun-if-changed=ui");

    // Keep `cargo check` usable from a clean checkout where
    // the ignored Vite `dist/` directory does not exist yet; release builds
    // populate the same directory via `npm run build` first.
    let dist = std::path::Path::new("src-ui/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(dist);
    }

    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/voice_input/apple_speech.m");
        cc::Build::new()
            .file("src/voice_input/apple_speech.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("coffee_apple_speech");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=objc");
        // Speech is available from macOS 10.15; older supported Macs keep other channels.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
    }
}
