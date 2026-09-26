//! Opt-in end-to-end tests of the real TUI against a loopback-only fake model.
use super::*;
use std::io::{Read, Write};

#[test]
#[ignore = "requires SINOS_TEST_CODEX; isolated TUI and local fake Responses API"]
fn real_mobile_prompt_streams_a_turn() {
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::atomic::AtomicUsize;
    async fn model(
        State(requests): State<Arc<AtomicUsize>>,
        Json(request): Json<Value>,
    ) -> axum::response::Response {
        requests.fetch_add(1, Ordering::SeqCst);
        let input = request["input"].as_array().cloned().unwrap_or_default();
        let title = input.iter().any(|item| {
            item["role"] == "user"
                && item["content"].as_array().is_some_and(|content| {
                    content.iter().any(|block| {
                        block["text"]
                            .as_str()
                            .is_some_and(|text| text.starts_with("Generate a concise,"))
                    })
                })
        });
        let planned = input
            .iter()
            .any(|item| item["call_id"] == "plan-call" && item["type"] == "function_call_output");
        let approved = input.iter().any(|item| {
            item["call_id"] == "approval-call" && item["type"] == "function_call_output"
        });
        let text = "1. **First**\n2. Second\n\n```ts\nconst x = 1;\n```";
        let mut events =
            vec![json!({"type":"response.created","response":{"id":"sinos-response"}})];
        if title {
            events.push(json!({"type":"response.output_item.done","item":{"type":"message","id":"title","role":"assistant","content":[{"type":"output_text","text":"{\"title\":\"Verify mobile streaming\"}"}]}}));
        } else if !planned {
            events.push(json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"plan-call","name":"update_plan","arguments":"{\"plan\":[{\"step\":\"Verify mobile streaming\",\"status\":\"in_progress\"}]}"}}));
        } else if !approved {
            let command = if cfg!(windows) {
                "Write-Output sinos-mobile-fixture"
            } else {
                "printf sinos-mobile-fixture"
            };
            events.push(json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"approval-call","name":"exec_command","arguments":json!({"cmd":command,"sandbox_permissions":"require_escalated","justification":"May I run the isolated mobile fixture command?"}).to_string()}}));
        } else {
            events.extend([
            json!({"type":"response.output_item.added","item":{"type":"reasoning","id":"r1","summary":[]}}),
            json!({"type":"response.reasoning_summary_text.delta","delta":"Checking the mobile fixture.","summary_index":0}),
            json!({"type":"response.output_item.done","item":{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"Checking the mobile fixture."}]}}),
            json!({"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","delta":"1. **First**\n"}),
            json!({"type":"response.output_text.delta","delta":"2. Second\n\n```ts\nconst x = 1;\n```"}),
            json!({"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","content":[{"type":"output_text","text":text}]}}),
        ]);
        }
        events.push(json!({"type":"response.completed","response":{"id":"sinos-response","usage":{"input_tokens":20,"output_tokens":25,"total_tokens":45}}}));
        let stream = futures_util::stream::iter(events).then(|event| async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            Ok::<_, std::convert::Infallible>(format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            ))
        });
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream))
            .unwrap()
    }
    let requests = Arc::new(AtomicUsize::new(0));
    let received = requests.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let api = format!("http://{}/v1", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let _ = axum::serve(
                    tokio::net::TcpListener::from_std(listener).unwrap(),
                    Router::new()
                        .route("/v1/responses", post(model))
                        .with_state(received),
                )
                .with_graceful_shutdown(async move {
                    while !stopped.load(Ordering::Acquire) {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await;
            });
    });
    let program = std::env::var("SINOS_TEST_CODEX").expect("set SINOS_TEST_CODEX");
    let home =
        std::env::temp_dir().join(format!("sinos-codex-mobile-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    let path = serde_json::to_string(&home.to_string_lossy()).unwrap();
    std::fs::write(
        home.join("config.toml"),
        format!(
            r#"
model = "sinos-test"
model_provider = "sinos-test"
check_for_update_on_startup = false
approval_policy = "on-request"
sandbox_mode = "read-only"
tools.update_plan.enabled = true
[model_providers.sinos-test]
name = "Sinos local fixture"
base_url = "{api}"
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
    #[cfg(windows)]
    let mut cmd = {
        let mut c = portable_pty::CommandBuilder::new(std::env::var("COMSPEC").unwrap());
        c.args(["/d", "/c", &program]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = portable_pty::CommandBuilder::new(&program);
    cmd.args([
        "--remote",
        &bridge.endpoint,
        "--remote-auth-token-env",
        AUTH_ENV,
        "--no-alt-screen",
    ]);
    cmd.env(AUTH_ENV, &bridge.auth_token);
    cmd.env("CODEX_HOME", &home);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(&home);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    #[cfg(windows)]
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
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while bridge.journal.lock().unwrap().thread_id().is_none()
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(700));
    let user_thread = bridge.journal.lock().unwrap().thread_id();
    let mobile_prompt = "Sinos mobile fixture\n第二行\n\n参考图片：\n- C:\\Temp\\sinos-fixture.png";
    // Reproduce the production mobile prompt, including its paste/Enter timing.
    {
        let mut w = writer.lock().unwrap();
        crate::remote_input::paste_and_submit(w.as_mut(), mobile_prompt).unwrap();
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut streamed = false;
    let mut approval_frames = None;
    let mut continued = false;
    while std::time::Instant::now() < deadline {
        let page = bridge.journal.lock().unwrap().page(None, 0);
        let delta = page
            .events
            .iter()
            .any(|e| e.message["method"] == "item/agentMessage/delta");
        let done = page
            .events
            .iter()
            .rev()
            .find(|e| {
                matches!(
                    e.message["method"].as_str(),
                    Some("turn/started" | "turn/completed")
                )
            })
            .is_some_and(|e| e.message["method"] == "turn/completed");
        streamed |= delta && !done;
        if approval_frames.is_none()
            && page
                .events
                .iter()
                .any(|e| e.message["method"] == "item/commandExecution/requestApproval")
        {
            // Cancel our fixture's request; never run a command or approve an
            // escalation just to test the mobile confirmation presentation.
            std::thread::sleep(Duration::from_millis(400));
            approval_frames = Some(frames.lock().unwrap().clone());
            let mut w = writer.lock().unwrap();
            w.write_all(b"\x1b").unwrap();
            w.flush().unwrap();
        }
        if done && approval_frames.is_some() && !continued {
            continued = true;
            let mut w = writer.lock().unwrap();
            crate::remote_input::paste_and_submit(w.as_mut(), "Continue mobile fixture").unwrap();
            std::thread::sleep(Duration::from_millis(200));
        } else if done
            && continued
            && page
                .events
                .iter()
                .filter(|e| e.message["method"] == "turn/started")
                .count()
                >= 2
        {
            break;
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    let page = bridge.journal.lock().unwrap().page(None, 0);
    let _ = child.kill();
    #[cfg(windows)]
    drop(job);
    drop(writer);
    drop(pair.master);
    drop(bridge);
    let _ = child.wait();
    let _ = reader_thread.join();
    stop.store(true, Ordering::Release);
    let _ = server.join();
    let capture = json!({"cols":100,"rows":30,"frames":*frames.lock().unwrap(),"approvalFrames":approval_frames,"page":page,"streamed":streamed,"requests":requests.load(Ordering::SeqCst)});
    std::fs::create_dir_all("target/mobile-repro").unwrap();
    std::fs::write("target/mobile-repro/codex-tui.json", capture.to_string()).unwrap();
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        requests.load(Ordering::SeqCst) > 0,
        "mobile prompt was pasted but never submitted; see target/mobile-repro/codex-tui.json"
    );
    assert_eq!(
        page.thread_id, user_thread,
        "background title generation must not steal mobile's user thread"
    );
    assert!(
        !page
            .events
            .iter()
            .any(|e| e.message.to_string().contains("Generate a concise")),
        "internal title prompts must never reach mobile chat"
    );
    assert!(page
        .events
        .iter()
        .any(|e| e.message["params"]["item"]["type"] == "userMessage"
            && e.message["params"]["item"]["content"][0]["text"] == mobile_prompt),
        "mobile prompt must retain its text, line breaks and attachment footer");
    assert!(
        streamed,
        "visible Markdown must arrive before turn completion"
    );
    assert!(
        approval_frames.is_some(),
        "real command confirmation must be presented"
    );
    assert!(
        page.events
            .iter()
            .any(|e| e.message["method"] == "turn/plan/updated"),
        "tool plan must reach mobile"
    );
    assert!(
        page.events
            .iter()
            .any(|e| e.message["method"] == "turn/completed"),
        "fixture turn must finish"
    );
}
