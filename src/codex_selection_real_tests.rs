//! Explicit opt-in: copy and image input with the installed Codex TUI.
//! Isolated CODEX_HOME, no model calls, never reads the user's clipboard value.
use super::*;
use std::io::{Read, Write};

#[test]
#[ignore = "requires SINOS_TEST_CODEX and node; writes synthetic clipboard text"]
fn real_codex_mouse_selection_copies_without_xterm_selection() {
    run_real_codex(false);
}

#[test]
#[ignore = "requires SINOS_TEST_CODEX and node; attaches local fixture images without submitting"]
fn real_codex_accepts_multiple_unicode_image_paths() {
    run_real_codex(true);
}

fn run_real_codex(check_images: bool) {
    let program = std::env::var("SINOS_TEST_CODEX").expect("set SINOS_TEST_CODEX");
    let home = std::env::temp_dir().join(format!("sinos-copy-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    let path = serde_json::to_string(&home.to_string_lossy()).unwrap();
    let model = if check_images {
        "gpt-6-sol"
    } else {
        "sinos-test"
    };
    std::fs::write(
        home.join("config.toml"),
        format!(
            r#"
model = "{model}"
model_provider = "sinos-test"
check_for_update_on_startup = false
[model_providers.sinos-test]
name = "Sinos copy fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[projects.{path}]
trust_level = "trusted"
"#
        ),
    )
    .unwrap();
    let env = vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
    let bridge = start(
        &program,
        &[],
        home.to_str(),
        &env,
        Arc::new(Mutex::new(crate::remote_runtime::Runtime::new())),
    )
    .unwrap();
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = portable_pty::CommandBuilder::new(std::env::var("COMSPEC").unwrap());
    cmd.args([
        "/d",
        "/c",
        &program,
        "--remote",
        &bridge.endpoint,
        "--remote-auth-token-env",
        AUTH_ENV,
    ]);
    cmd.env(AUTH_ENV, &bridge.auth_token);
    cmd.env("CODEX_HOME", &home);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(&home);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    let job = crate::terminal::windows_job::session_job(child.process_id().unwrap());
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let reply = writer.clone();
    let frames = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = frames.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = [0; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let valid = std::str::from_utf8(&pending)
                .map(|s| s.len())
                .unwrap_or_else(|e| e.valid_up_to());
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            if text.contains("\x1b[6n") {
                let mut w = reply.lock().unwrap();
                let _ = w.write_all(b"\x1b[1;1R");
                let _ = w.flush();
            }
            if !text.is_empty() {
                captured.lock().unwrap().push(text);
            }
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    // Thread creation can precede the TUI's startup dialogs/model catalogue.
    // Wait for its actual composer/banner before injecting the copy probe.
    while std::time::Instant::now() < deadline {
        let output = frames.lock().unwrap().join("");
        if output.contains(if check_images { "GPT-6-Sol" } else { model })
            && output.contains("\x1b[?2004h")
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(700));
    let probe = format!(
        "SINOS_COPY_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let send = |data: &str| {
        let mut w = writer.lock().unwrap();
        w.write_all(data.as_bytes()).unwrap();
        w.flush().unwrap();
    };
    if !check_images {
        send(&format!("\x1b[200~{probe}\x1b[201~"));
    }
    std::thread::sleep(Duration::from_millis(700));
    let fixture = home.join("frames.json");
    std::fs::write(
        &fixture,
        json!({"frames":*frames.lock().unwrap(),"probe":probe}).to_string(),
    )
    .unwrap();
    // Decode actual PTY output using the same xterm version as the desktop UI.
    let script = r#"
globalThis.self = globalThis;
const { readFileSync } = await import('node:fs');
const { Terminal } = await import('./src-ui/node_modules/@xterm/xterm/lib/xterm.mjs');
const fixture = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const term = new Terminal({cols:100, rows:30, allowProposedApi:true});
for (const frame of fixture.frames) await new Promise(resolve=>term.write(frame,resolve));
const buffer=term.buffer.active; let result=null;
for(let y=0;y<30;y++){ const line=buffer.getLine(buffer.viewportY+y)?.translateToString(true)||''; const x=line.indexOf(fixture.probe); if(x>=0) result={x:x+1,y:y+1,mouse:term.modes.mouseTrackingMode}; }
console.log(JSON.stringify(result));term.dispose();
"#;
    let decoded = std::process::Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(&fixture)
        .output()
        .unwrap();
    let position: Value = serde_json::from_slice(&decoded.stdout).unwrap_or(Value::Null);
    let mut copied = false;
    if let (Some(x), Some(y)) = (position["x"].as_u64(), position["y"].as_u64()) {
        send(&format!("\x1b[<0;{x};{y}M"));
        send(&format!(
            "\x1b[<32;{};{y}M\x1b[<0;{};{y}m",
            x + probe.len() as u64,
            x + probe.len() as u64
        ));
        std::thread::sleep(Duration::from_millis(400));
        // This is the report produced by createCodexTerminalSelection.read().
        send(&format!("\x1b[<2;{x};{y}M\x1b[<2;{x};{y}m"));
        std::thread::sleep(Duration::from_millis(800));
        // Return only an equality result, never print clipboard contents.
        copied = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("if ((Get-Clipboard -Raw) -eq '{probe}') {{ exit 0 }} else {{ exit 1 }}"),
            ])
            .output()
            .unwrap()
            .status
            .success();
    }
    let attachments = if check_images {
        // Exercise the same separate, quoted bracketed pastes used by desktop
        // image input. No Enter: attaching files must not start a model request.
        let first_image = home.join("截图 one.png");
        let second_image = home.join("截图 two.png");
        let mut png_bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[255; 16])
                .unwrap();
        }
        for image in [&first_image, &second_image] {
            std::fs::write(image, &png_bytes).unwrap();
        }
        send("\x15"); // Clear the synthetic text draft after copying it.
        for image in [&first_image, &second_image] {
            send(&format!(
                "\x1b[200~\"{}\" \x1b[201~",
                image.to_string_lossy()
            ));
            std::thread::sleep(Duration::from_millis(200));
        }
        std::thread::sleep(Duration::from_millis(1200));
        std::fs::write(
            &fixture,
            json!({"frames":*frames.lock().unwrap()}).to_string(),
        )
        .unwrap();
        let image_decoder = r#"
globalThis.self = globalThis;
const { readFileSync } = await import('node:fs');
const { Terminal } = await import('./src-ui/node_modules/@xterm/xterm/lib/xterm.mjs');
const fixture = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const term = new Terminal({cols:100, rows:30, allowProposedApi:true});
for (const frame of fixture.frames) await new Promise(resolve=>term.write(frame,resolve));
const buffer=term.buffer.active; const lines=[];
for(let y=0;y<buffer.length;y++) lines.push(buffer.getLine(y)?.translateToString(true)||'');
const text=lines.join('\n');
console.log(JSON.stringify({first:text.includes('[Image #1]'),second:text.includes('[Image #2]'),lines}));
term.dispose();
"#;
        let image_output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", image_decoder])
            .arg(&fixture)
            .output()
            .unwrap();
        serde_json::from_slice::<Value>(&image_output.stdout).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let page = bridge.journal.lock().unwrap().page(None, 0);
    let _ = child.kill();
    drop(job);
    drop(writer);
    drop(pair.master);
    drop(bridge);
    let _ = child.wait();
    let _ = reader_thread.join();
    std::fs::create_dir_all("target/mobile-repro").unwrap();
    let capture = if check_images {
        "target/mobile-repro/codex-images-probe.json"
    } else {
        "target/mobile-repro/codex-copy-probe.json"
    };
    std::fs::write(capture, json!({"position":position,"copied":copied,"attachments":attachments,"frames":*frames.lock().unwrap(),"probe":probe}).to_string()).unwrap();
    // This path is solely the UUID scratch directory created above.
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        !page
            .events
            .iter()
            .any(|e| e.message["method"] == "turn/started"),
        "copy must not submit a prompt"
    );
    if !check_images {
        assert_ne!(
            position["mouse"], "none",
            "real TUI must own mouse input: {position}"
        );
        assert!(copied, "actual Codex selection did not reach the Windows clipboard; see codex-copy-probe.json; decoder: {}", String::from_utf8_lossy(&decoded.stderr));
    } else {
        assert_eq!(
            attachments["first"], true,
            "first image was not attached: {attachments}"
        );
        assert_eq!(
            attachments["second"], true,
            "second image was not attached: {attachments}"
        );
    }
}
