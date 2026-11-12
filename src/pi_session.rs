//! Pi desktop conversations: one `pi --mode rpc` runtime per Sinos CLI tab.
//! Pi reads JSONL commands on stdin and writes responses, session events and extension
//! dialog requests on stdout; every tab owns its Session through `--session-id`.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, mpsc}, time::Duration};
use tauri::{Emitter, Manager, State};

type Reply = mpsc::Sender<Result<Value, String>>;

/// Deadlines use the monotonic clock and are checked atomically with consuming a reply.
#[derive(Default)]
struct DialogRegistry(HashMap<String, Option<std::time::Instant>>);
impl DialogRegistry {
    fn insert(&mut self, id: &str, timeout: Option<f64>, now: std::time::Instant) {
        self.0.retain(|_, deadline| deadline.is_none_or(|end| now < end));
        // Pi uses Node timers: zero disables the timer; negative, sub-millisecond and
        // values above the signed 32-bit limit fire after one millisecond.
        let deadline = timeout.filter(|n| n.is_finite() && *n != 0.0).map(|n| {
            let millis = if !(1.0..=2147483647.0).contains(&n) { 1 } else { n as u64 };
            now + Duration::from_millis(millis)
        });
        self.0.insert(id.to_owned(), deadline);
    }
    fn take(&mut self, id: &str, now: std::time::Instant) -> bool {
        self.0.remove(id).is_some_and(|deadline| deadline.is_none_or(|end| now < end))
    }
    fn clear(&mut self) { self.0.clear(); }
    #[cfg(test)]
    fn contains(&self, id: &str) -> bool { self.0.contains_key(id) }
    #[cfg(test)]
    fn is_empty(&self) -> bool { self.0.is_empty() }
}
struct Session {
    generation: String,
    native_id: String,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    #[cfg(windows)]
    job: Mutex<Option<crate::terminal::windows_job::SessionJob>>,
    closed: AtomicBool,
    pending: Mutex<HashMap<String, Reply>>,
    /// Extension dialogs waiting for an answer, so a stale or repeated reply is refused.
    dialogs: Mutex<DialogRegistry>,
    stderr: Mutex<String>,
}
#[derive(Default)]
pub struct PiSessions(Mutex<HashMap<String, Arc<Session>>>, crate::session_start::SessionStarts);

impl PiSessions {
    fn register(&self, id: &str, pending: &crate::session_start::PendingStart, session: &Arc<Session>) -> Result<(), String> {
        let mut map = self.0.lock().unwrap();
        if let Err(error) = pending.check() {
            drop(map);
            session.stop();
            let _ = session.child.lock().unwrap().wait(); // No exit watcher owns an unregistered child.
            return Err(error);
        }
        if map.contains_key(id) {
            drop(map);
            session.stop();
            let _ = session.child.lock().unwrap().wait();
            return Err("This tab already owns a Pi session".into());
        }
        map.insert(id.to_owned(), session.clone());
        Ok(())
    }
    fn remove(&self, id: &str, generation: &str) -> Option<Arc<Session>> {
        // Cancel before taking the registration lock, including launches still queued in the blocking pool.
        self.1.cancel(id, generation);
        let mut map = self.0.lock().unwrap();
        if map.get(id).is_some_and(|s| s.generation == generation) { map.remove(id) } else { None }
    }
}

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        if self.closed.load(Ordering::SeqCst) { return Err("Pi connection is closed".into()); }
        let input = input.as_mut().ok_or("Pi connection is closed")?;
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn respond(&self, request_id: &str, response: &Value) -> Result<(), String> {
        // Wait for stdin before checking the deadline, otherwise a blocked writer can
        // send an answer after Pi's timer has already fired.
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let mut dialogs = self.dialogs.lock().map_err(|e| e.to_string())?;
        if !dialogs.take(request_id, std::time::Instant::now()) { return Err("This Pi request has ended".into()); }
        drop(dialogs); // Shutdown and incoming events must not wait for a blocked stdin write.
        if self.closed.load(Ordering::SeqCst) { return Err("Pi connection is closed".into()); }
        let input = input.as_mut().ok_or("Pi connection is closed")?;
        let mut record = json!({"type":"extension_ui_response","id":request_id});
        for key in ["value", "confirmed", "cancelled"] { if let Some(value) = response.get(key) { record[key] = value.clone(); } }
        serde_json::to_writer(&mut *input, &record).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn stop(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Release the whole process tree even when a reader retains this Session or stdin is busy.
        #[cfg(windows)]
        drop(self.job.lock().unwrap().take());
        let _ = self.child.lock().unwrap().kill();
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
        for (_, reply) in self.pending.lock().unwrap().drain() { let _ = reply.send(Err("Pi connection is closed".into())); }
        self.dialogs.lock().unwrap().clear();
    }
    fn request(&self, mut command: Value, timeout: Duration) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let kind = command["type"].as_str().unwrap_or("command").to_string();
        command["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.closed.load(Ordering::SeqCst) { return Err("Pi connection is closed".into()); }
            pending.insert(id.clone(), tx);
        }
        if kind == "abort" { self.dialogs.lock().unwrap().clear(); }
        let result = self.write(&command).and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("Pi request timed out: {kind}"))?);
        self.pending.lock().unwrap().remove(&id);
        result
    }
    /// Routes one stdout record: responses settle their request, everything else is an event for the tab.
    fn receive(&self, record: Value) -> Option<Value> {
        if record["type"] == "response" {
            if let Some(reply) = record["id"].as_str().and_then(|id| self.pending.lock().unwrap().remove(id)) {
                let result = if record["success"] == true { Ok(record["data"].clone()) }
                    else { Err(record["error"].as_str().unwrap_or("Pi request failed").to_string()) };
                let _ = reply.send(result);
                return None;
            }
            // A parse failure has no id; there is nothing to settle.
            return None;
        }
        if record["type"] == "extension_ui_request" && DIALOGS.contains(&record["method"].as_str().unwrap_or("")) {
            if let Some(id) = record["id"].as_str() { self.dialogs.lock().unwrap().insert(id, record["timeout"].as_f64(), std::time::Instant::now()); }
        } else if record["type"] == "agent_settled" {
            self.dialogs.lock().unwrap().clear();
        }
        Some(record)
    }
}
/// Extension dialog methods that block Pi until the client answers.
const DIALOGS: [&str; 4] = ["select", "confirm", "input", "editor"];
/// Commands the conversation sends. Session switching, export and raw bash stay out of the webview's reach.
const COMMANDS: [&str; 15] = ["prompt", "steer", "follow_up", "abort", "get_state", "get_messages", "get_session_stats", "get_available_models",
    "get_available_thinking_levels", "set_model", "set_thinking_level", "compact", "get_commands", "set_session_name", "new_session"];

fn get(sessions: &PiSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let s = sessions.0.lock().unwrap().get(id).cloned().ok_or("Pi session is not running")?;
    if s.generation != generation { return Err("Pi session has changed".into()); }
    Ok(s)
}
fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    // Worker results read only these; streaming deltas need not take the coordinator's lock.
    if matches!(event["type"].as_str(), Some("message_end" | "agent_end" | "agent_settled")) { crate::orchestration::native_event(id, "pi", &session.generation, &event); }
    let _ = app.emit("pi-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

fn find_on_path(bin: &str) -> Option<String> {
    #[cfg(windows)]
    let (path, names) = (crate::windows_path::terminal_path(), vec![format!("{bin}.cmd"), format!("{bin}.exe"), bin.to_string()]);
    #[cfg(not(windows))]
    let (path, names) = (std::env::var("PATH").unwrap_or_default(), vec![bin.to_string()]);
    std::env::split_paths(&path).flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file()).map(|candidate| candidate.to_string_lossy().into_owned())
}

/// A command preset may hold terminal session flags; this client picks the Session itself.
fn rpc_args(args: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for arg in args {
        if std::mem::take(&mut skip) { continue; }
        match arg.as_str() {
            "-c" | "--continue" | "-r" | "--resume" | "--no-session" => {}
            "--session" | "--session-id" | "--fork" | "--mode" => skip = true,
            _ if arg.starts_with("--session=") || arg.starts_with("--session-id=") || arg.starts_with("--fork=") || arg.starts_with("--mode=") => {}
            _ => out.push(arg),
        }
    }
    out
}

/// The user's command override, then `pi` on PATH.
fn executable() -> Option<(String, Vec<String>)> {
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get("pi").command);
    let args = rpc_args(args);
    if let Some(custom) = custom.filter(|custom| custom != "pi") {
        if Path::new(&custom).is_absolute() { return Some((custom, args)); }
        return find_on_path(&custom).map(|bin| (bin, args.clone())).or(Some((custom, vec![])));
    }
    find_on_path("pi").map(|bin| (bin, args))
}

/// Pi session IDs: letters, numbers, `.`, `_` and `-`.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, pending: crate::session_start::PendingStart) -> Result<Value, String> {
    pending.check()?;
    let config = crate::tool_config::get("pi");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let resume_token = resume_token.filter(|t| !t.trim().is_empty());
    if resume_token.as_deref().is_some_and(|token| !valid_id(token)) { return Err("Invalid Pi session ID".into()); }
    let (bin, prefix) = executable().ok_or("Pi is not installed")?;
    // `--session-id` opens this folder's Session with the ID or creates it, so a tab restored before
    // its first message (no session file yet) still starts.
    let native_id = resume_token.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let lower = bin.to_ascii_lowercase();
        command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()));
            c.args(["/d", "/c", &bin]); c
        } else { Command::new(&bin) };
        command.creation_flags(0x08000000).env("PATH", crate::windows_path::terminal_path());
    }
    #[cfg(not(windows))]
    { command = Command::new(&bin); }
    command.args(&prefix).args(["--mode", "rpc", "--session-id", &native_id]).args(&config.extra_args)
        .current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    pending.check()?;
    #[cfg(windows)]
    let (mut child, job) = crate::terminal::windows_job::spawn_session(&mut command).map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start Pi: {e}")))?;
    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start Pi: {e}")))?;
    let (stdout, stderr, input) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take().unwrap());
    let session = Arc::new(Session { generation, native_id, child: Mutex::new(child), input: Mutex::new(Some(input)),
        #[cfg(windows)] job: Mutex::new(Some(job)),
        closed: AtomicBool::new(false), pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::new(String::new()) });
    app.state::<PiSessions>().register(&id, &pending, &session)?;
    let s = session.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = s.stderr.lock().unwrap(); tail.push_str(&line); tail.push('\n');
            if tail.len() > 8192 { let cut = tail.char_indices().find(|(i, _)| *i >= tail.len() - 4096).map(|(i, _)| i).unwrap_or(0); tail.drain(..cut); }
        }
    });
    let s = session.clone(); let reader_app = app.clone(); let reader_id = id.clone();
    std::thread::spawn(move || {
        // RPC framing splits records on LF only, which `lines()` does; a stray CR is trimmed.
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(line.trim_end_matches('\r')) {
                if let Some(event) = s.receive(record) { emit(&reader_app, &reader_id, &s, event); }
            }
        }
    });
    let s = session.clone(); let watcher_app = app.clone(); let watcher_id = id.clone();
    std::thread::spawn(move || {
        let code = loop {
            // Release the process lock before sleeping so close can kill immediately.
            let status = s.child.lock().unwrap().try_wait();
            match status {
                Ok(Some(status)) => break status.code(), Err(_) => break None,
                _ => std::thread::sleep(Duration::from_millis(150)),
            }
        };
        for (_, tx) in s.pending.lock().unwrap().drain() { let _ = tx.send(Err("Pi process exited".into())); }
        s.stop();
        crate::orchestration::native_exit(&watcher_id, "pi", &s.generation);
        let _ = watcher_app.emit("pi-session-event", json!({"id":watcher_id,"generation":s.generation,"event":{"type":"coffee_exit","code":code,"detail":s.stderr.lock().unwrap().as_str()}}));
        let sessions = watcher_app.state::<PiSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        // The first answer waits for Pi to load its extensions, packages and models.
        let state = session.request(json!({"type":"get_state"}), Duration::from_secs(90))?;
        let models = session.request(json!({"type":"get_available_models"}), Duration::from_secs(30)).map(|data| data["models"].clone()).unwrap_or(json!([]));
        let messages = if resume_token.is_some() { session.request(json!({"type":"get_messages"}), Duration::from_secs(60)).map(|data| data["messages"].clone()).unwrap_or(json!([])) } else { json!([]) };
        pending.check()?;
        if session.closed.load(Ordering::SeqCst) { return Err("Pi process exited".into()); }
        Ok(json!({"sessionId":session.native_id,"cwd":cwd,"state":state,"models":models,"messages":messages}))
    })();
    if result.is_err() { session.stop(); }
    result.map_err(|error: String| {
        let detail = session.stderr.lock().unwrap().trim().to_string();
        if error.contains("exited") && !detail.is_empty() { detail } else { error }
    })
}

#[tauri::command]
pub async fn pi_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let pending = app.state::<PiSessions>().1.begin(&id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token, pending)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pi_session_request(sessions: State<'_, PiSessions>, id: String, generation: String, command: Value) -> Result<Value, String> {
    let kind = command["type"].as_str().unwrap_or("").to_string();
    if !COMMANDS.contains(&kind.as_str()) { return Err("Unsupported Pi command".into()); }
    let s = get(&sessions, &id, &generation)?;
    let message = command["message"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "prompt" => crate::orchestration::native_input(&id, "pi", &s.generation, &message, &uuid::Uuid::new_v4().to_string(), None)?,
        "steer" | "follow_up" => { if message.trim().is_empty() { return Err("Message is empty".into()); } crate::orchestration::native_steer(&id, "pi", &s.generation, &message)?; }
        _ => {}
    }
    // A prompt answers once accepted; compaction runs a model request before answering.
    let timeout = Duration::from_secs(if kind == "compact" { 900 } else { 60 });
    tauri::async_runtime::spawn_blocking(move || s.request(command, timeout)).await.map_err(|e| e.to_string())?
}
/// Answers an extension dialog (`select`, `confirm`, `input`, `editor`).
#[tauri::command]
pub async fn pi_session_respond(sessions: State<'_, PiSessions>, id: String, generation: String, request_id: String, response: Value) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || s.respond(&request_id, &response)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pi_session_close(sessions: State<'_, PiSessions>, id: String, generation: String) -> Result<(), String> {
    let session = sessions.remove(&id, &generation);
    if let Some(s) = session {
        crate::orchestration::native_stop(&id, "pi", &generation);
        tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn shutdown(sessions: &PiSessions) {
    sessions.1.shutdown();
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for s in sessions { s.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_cancels_queued_start_without_cancelling_other_generations() {
        let sessions = PiSessions::default();
        let old = sessions.1.begin("tab", "old").unwrap();
        let new = sessions.1.begin("tab", "new").unwrap();
        let other = sessions.1.begin("other", "old").unwrap();
        assert!(sessions.remove("tab", "old").is_none());
        assert!(std::thread::spawn(move || old.check()).join().unwrap().is_err());
        assert!(new.check().is_ok());
        assert!(other.check().is_ok());
    }
    #[test]
    fn shutdown_cancels_queued_starts_and_rejects_new_work() {
        let sessions = PiSessions::default();
        let pending = sessions.1.begin("tab", "generation").unwrap();
        shutdown(&sessions);
        assert!(pending.check().is_err());
        assert!(sessions.1.begin("another", "generation").is_err());
        assert!(sessions.0.lock().unwrap().is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn stop_closes_launcher_descendants_and_pending_replies_with_busy_stdin() {
        use std::os::windows::process::CommandExt;
        use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
        struct OwnedFixture(HANDLE);
        impl Drop for OwnedFixture {
            fn drop(&mut self) { unsafe { let _ = TerminateProcess(self.0, 0); let _ = CloseHandle(self.0); } }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".Sinos-temp");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let script = directory.path().join("child.ps1");
        std::fs::write(&script, "[Console]::WriteLine($PID); [Console]::ReadLine() | Out-Null").unwrap();
        let launcher = directory.path().join("launcher.cmd");
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        std::fs::write(&launcher, format!("@echo off\r\n\"{}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"\r\n", powershell.display(), script.display())).unwrap();
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c"]).arg(&launcher).creation_flags(0x08000000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let (mut child, job) = crate::terminal::windows_job::spawn_session(&mut command).unwrap();
        let stdout = child.stdout.take().unwrap();
        let input = child.stdin.take().unwrap();
        let session = Arc::new(Session {
            generation: "fixture".into(), native_id: "fixture".into(), child: Mutex::new(child), input: Mutex::new(Some(input)),
            job: Mutex::new(Some(job)), closed: AtomicBool::new(false),
            pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::default(),
        });
        let reading = session.clone();
        let (pid_tx, pid_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            let _ = pid_tx.send(lines.next().unwrap().unwrap().trim().parse::<u32>().unwrap());
            for _line in lines {}
            drop(reading);
        });
        let pid = pid_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let descendant = OwnedFixture(unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid).unwrap() });
        let mut unrelated_command = Command::new("cmd.exe");
        unrelated_command.args(["/d", "/c", "pause"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        let (mut unrelated, unrelated_job) = crate::terminal::windows_job::spawn_session(&mut unrelated_command).unwrap();
        let (reply_tx, reply_rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("pending".into(), reply_tx);
        let writing = session.input.lock().unwrap();
        let stopping = session.clone();
        let (tx, rx) = mpsc::channel();
        let stopper = std::thread::spawn(move || { stopping.stop(); let _ = tx.send(()); });
        let prompt = rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let exited = unsafe { WaitForSingleObject(descendant.0, 3000) } == WAIT_OBJECT_0;
        let reply_closed = reply_rx.try_recv().is_ok_and(|reply| reply.is_err());
        let unrelated_running = unrelated.try_wait().unwrap().is_none();
        drop(unrelated_job);
        unrelated.wait().unwrap();
        drop(writing);
        session.stop();
        drop(descendant);
        stopper.join().unwrap();
        reader.join().unwrap();
        session.child.lock().unwrap().wait().unwrap();
        assert!(prompt, "close must not wait for a thread holding stdin");
        assert!(exited, "closing Pi must terminate the launcher's descendant");
        assert!(reply_closed, "closing Pi immediately settles pending RPC replies");
        assert!(unrelated_running, "another session's process stays alive");
        assert!(session.request(json!({"type":"get_state"}), Duration::ZERO).is_err());
        assert!(session.pending.lock().unwrap().is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn cancelled_registration_stops_a_late_process() {
        let sessions = PiSessions::default();
        let pending = sessions.1.begin("tab", "generation").unwrap();
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "pause"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        let (mut child, job) = crate::terminal::windows_job::spawn_session(&mut command).unwrap();
        let session = Arc::new(Session {
            generation: "generation".into(), native_id: "fixture".into(), input: Mutex::new(child.stdin.take()), child: Mutex::new(child),
            job: Mutex::new(Some(job)), closed: AtomicBool::new(false),
            pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::default(),
        });
        sessions.remove("tab", "generation");
        let registered = sessions.register("tab", &pending, &session);
        let released = session.job.lock().unwrap().is_none();
        session.stop();
        session.child.lock().unwrap().wait().unwrap();
        assert!(registered.is_err());
        assert!(sessions.0.lock().unwrap().is_empty());
        assert!(released, "a late process is stopped before registration returns");
    }
    #[test]
    fn terminal_session_flags_are_dropped_from_presets() {
        let args = |list: &[&str]| rpc_args(list.iter().map(|s| s.to_string()).collect());
        assert_eq!(args(&["--continue", "--provider", "openai", "--session", "abc", "--model=gpt", "--mode", "json"]), ["--provider", "openai", "--model=gpt"]);
        assert_eq!(args(&["-r", "--session-id=x", "--no-session", "--fork", "f", "--thinking", "high"]), ["--thinking", "high"]);
    }
    #[test]
    fn session_ids_accept_only_pi_characters() {
        assert!(valid_id("01a1a55b-5840-722d-b93a-3172232f0e8b"));
        assert!(valid_id("my_session.2"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("a b"));
        assert!(!valid_id(""));
    }
    #[test]
    fn dialog_deadlines_refuse_late_responses_without_affecting_other_requests() {
        let mut dialogs = DialogRegistry::default();
        let now = std::time::Instant::now();
        dialogs.insert("timed", Some(50.0), now);
        dialogs.insert("untimed", None, now);
        assert!(!dialogs.take("timed", now + Duration::from_millis(50)));
        assert!(dialogs.take("untimed", now + Duration::from_secs(100)));
        assert!(!dialogs.take("untimed", now));
        dialogs.insert("zero", Some(0.0), now);
        assert!(dialogs.take("zero", now + Duration::from_secs(100)));
        dialogs.insert("negative", Some(-1.0), now);
        assert!(!dialogs.take("negative", now + Duration::from_millis(1)));
        dialogs.insert("one", None, now);
        dialogs.clear();
        assert!(!dialogs.take("one", now));
    }
    #[test]
    fn responses_settle_requests_and_dialogs_are_tracked() {
        let mut command = Command::new(if cfg!(windows) { "cmd" } else { "true" });
        #[cfg(windows)]
        command.args(["/d", "/c", "exit", "0"]);
        let session = Session { generation: "g".into(), native_id: "n".into(), child: Mutex::new(command.spawn().unwrap()), input: Mutex::new(None),
            #[cfg(windows)] job: Mutex::new(None),
            closed: AtomicBool::new(false), pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::default() };
        let (tx, rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("r1".into(), tx);
        assert!(session.receive(json!({"id":"r1","type":"response","command":"get_state","success":true,"data":{"ok":1}})).is_none());
        assert_eq!(rx.recv().unwrap().unwrap()["ok"], 1);
        let (tx, rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("r2".into(), tx);
        session.receive(json!({"id":"r2","type":"response","command":"set_model","success":false,"error":"Model not found"}));
        assert_eq!(rx.recv().unwrap().unwrap_err(), "Model not found");
        assert!(session.receive(json!({"type":"response","command":"parse","success":false,"error":"bad"})).is_none());
        let now = std::time::Instant::now();
        session.dialogs.lock().unwrap().insert("expired", Some(1.0), now - Duration::from_millis(2));
        assert_eq!(session.respond("expired", &json!({"confirmed": true})).unwrap_err(), "This Pi request has ended");
        assert!(session.receive(json!({"type":"extension_ui_request","id":"d1","method":"confirm"})).is_some());
        assert!(session.receive(json!({"type":"extension_ui_request","id":"n1","method":"notify"})).is_some());
        { let dialogs = session.dialogs.lock().unwrap(); assert!(dialogs.contains("d1") && !dialogs.contains("n1")); }
        assert!(session.receive(json!({"type":"agent_start"})).is_some());
        session.receive(json!({"type":"agent_settled"}));
        assert!(session.dialogs.lock().unwrap().is_empty(), "settling clears old requests");
        session.receive(json!({"type":"extension_ui_request","id":"abort","method":"input"}));
        assert!(session.request(json!({"type":"abort"}), Duration::ZERO).is_err());
        assert!(session.dialogs.lock().unwrap().is_empty(), "aborting clears old requests even when writing fails");
        let (tx, rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("closing".into(), tx);
        session.stop();
        session.child.lock().unwrap().wait().unwrap();
        assert!(rx.try_recv().unwrap().is_err(), "close settles pending RPC replies immediately");
        assert!(session.dialogs.lock().unwrap().is_empty());
        assert!(session.request(json!({"type":"get_state"}), Duration::ZERO).is_err());
        assert!(session.pending.lock().unwrap().is_empty());
    }
}
