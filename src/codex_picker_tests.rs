use super::*;

fn list_request() -> Value {
    json!({"id":12,"method":"thread/list","params":{"cwd":null,"sourceKinds":["cli","vscode"],"limit":25,"cursor":null,"archived":false,"searchTerm":"fixture"}})
}

#[test]
fn repairs_only_missing_cwd_on_the_secondary_history_connection() {
    let mut journal = Journal { root: Some("active".into()), owner: Some(1), bootstrap: Some(json!({"cwd":"C:\\projects\\current"})), ..Journal::default() };
    let mut scope = PickerScope::default();
    let mut request = list_request();
    assert!(!scope.repair(1, &journal, &mut request));
    assert_eq!(request, list_request());
    assert!(scope.repair(2, &journal, &mut request));
    assert_eq!(request["params"]["cwd"], "C:\\projects\\current");
    assert_eq!(request["params"]["searchTerm"], "fixture");
    let mut page = list_request(); page["params"]["cursor"] = json!("next-page");
    journal.bootstrap = Some(json!({"cwd":"C:\\projects\\changed"}));
    assert!(scope.repair(2, &journal, &mut page));
    assert_eq!(page["params"]["cwd"], request["params"]["cwd"], "pagination keeps the same filter");
    let mut reopened = list_request();
    assert!(PickerScope::default().repair(3, &journal, &mut reopened));
    assert_eq!(reopened["params"]["cwd"], "C:\\projects\\changed");
    let mut startup = list_request();
    assert!(!PickerScope::default().repair(2, &Journal::default(), &mut startup), "startup --all remains global");
    let mut agents = json!({"method":"thread/list","params":{"sourceKinds":["subAgent"],"cwd":null}});
    assert!(!scope.repair(2, &journal, &mut agents));
    let mut prompt = json!({"method":"turn/start","params":{"threadId":"active","input":[]}});
    assert!(!scope.repair(2, &journal, &mut prompt));
}

#[test]
fn respects_explicit_cwd_and_the_all_toggle_of_cwd_aware_clients() {
    let journal = Journal { root: Some("active".into()), owner: Some(1), bootstrap: Some(json!({"cwd":"/project"})), ..Journal::default() };
    for cwd in [json!("/chosen"), json!(["/project", "/worktree"])] {
        let mut scope = PickerScope::default();
        let mut request = list_request(); request["params"]["cwd"] = cwd.clone();
        assert!(!scope.repair(2, &journal, &mut request));
        assert_eq!(request["params"]["cwd"], cwd);
        let mut all = list_request();
        assert!(!scope.repair(2, &journal, &mut all));
        assert!(all["params"]["cwd"].is_null());
    }
}

/// Actual installed Codex app-server, isolated CODEX_HOME, synthetic history,
/// no model requests and no user history or configuration touched.
#[test]
#[ignore = "requires SINOS_TEST_CODEX; exercises the real app-server history store"]
fn real_resume_picker_is_scoped_without_losing_pagination_or_global_queries() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
    async fn call(socket: &mut Socket, request: Value) -> Value {
        let id = request["id"].clone();
        socket.send(Message::Text(request.to_string().into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let frame = socket.next().await.unwrap().unwrap();
                if let Ok(text) = frame.to_text() {
                    let value: Value = serde_json::from_str(text).unwrap();
                    if value["id"] == id && value.get("method").is_none() {
                        assert!(value.get("error").is_none(), "RPC failed: {value}");
                        return value["result"].clone();
                    }
                }
            }
        }).await.unwrap()
    }
    async fn connect(bridge: &Bridge) -> Socket {
        let mut request = bridge.endpoint.as_str().into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {}", bridge.auth_token).parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        call(&mut socket, json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"sinos_picker_fixture","version":"1.0"},"capabilities":{"experimentalApi":true}}})).await;
        socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
        socket
    }
    let program = std::env::var("SINOS_TEST_CODEX").expect("set SINOS_TEST_CODEX");
    let home = std::env::temp_dir().join(format!("sinos-picker-fixture-{}", uuid::Uuid::new_v4()));
    let current = home.join("project-a");
    let other = home.join("project-b");
    let sessions = home.join("sessions/2026/09/26");
    for path in [&current, &other, &sessions] { std::fs::create_dir_all(path).unwrap(); }
    for (index, cwd) in [&current, &other, &current].into_iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = format!("2026-09-26T01:00:0{index}Z");
        let meta = json!({"timestamp":timestamp,"type":"session_meta","payload":{"id":id,"session_id":id,"timestamp":timestamp,"cwd":cwd,"originator":"codex_cli_rs","cli_version":"0.157.1","source":"cli","model_provider":"openai"}});
        let user = json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"user_message","message":format!("fixture history {index}"),"images":[]}});
        std::fs::write(sessions.join(format!("rollout-2026-09-26T01-00-0{index}-{id}.jsonl")), format!("{meta}\n{user}\n")).unwrap();
    }
    let env = vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
    let bridge = start(&program, &[], current.to_str(), &env, Arc::new(Mutex::new(crate::remote_runtime::Runtime::new()))).unwrap();
    let pid = bridge.process_id.clone();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        // Before a live thread exists, the same null-cwd request is unrestricted.
        let mut startup = connect(&bridge).await;
        let global = call(&mut startup, list_request()).await;
        assert_eq!(global["data"].as_array().unwrap().len(), 3, "both projects must be present in the fixture");
        let started = call(&mut startup, json!({"id":13,"method":"thread/start","params":{"ephemeral":true,"cwd":current}})).await;
        assert!(started["thread"]["id"].is_string());
        let mut picker = connect(&bridge).await;
        let mut request = list_request(); request["params"]["limit"] = json!(1);
        let first = call(&mut picker, request.clone()).await;
        assert_eq!(first["data"].as_array().unwrap().len(), 1);
        assert_eq!(first["data"][0]["cwd"], current.to_string_lossy().as_ref());
        assert!(first["nextCursor"].is_string());
        request["id"] = json!(14); request["params"]["cursor"] = first["nextCursor"].clone();
        let second = call(&mut picker, request).await;
        assert_eq!(second["data"].as_array().unwrap().len(), 1);
        assert_eq!(second["data"][0]["cwd"], current.to_string_lossy().as_ref());
        assert!(second["nextCursor"].is_null());
        let still_global = call(&mut startup, list_request()).await;
        assert_eq!(still_global["data"].as_array().unwrap().len(), 3);
        let mut modern = connect(&bridge).await;
        let mut explicit = list_request(); explicit["params"]["cwd"] = json!(other);
        let chosen = call(&mut modern, explicit).await;
        assert_eq!(chosen["data"].as_array().unwrap().len(), 1);
        assert_eq!(chosen["data"][0]["cwd"], other.to_string_lossy().as_ref());
        assert_eq!(call(&mut modern, list_request()).await["data"].as_array().unwrap().len(), 3);
        drop(bridge);
        tokio::time::timeout(Duration::from_secs(8), async { while pid.lock().unwrap().is_some() { tokio::time::sleep(Duration::from_millis(30)).await; } }).await.unwrap();
    });
    // Delete only the UUID directory created by this test, after the engine exits.
    assert!(home.starts_with(std::env::temp_dir()) && home.file_name().unwrap().to_string_lossy().starts_with("sinos-picker-fixture-"));
    std::fs::remove_dir_all(home).unwrap();
}
