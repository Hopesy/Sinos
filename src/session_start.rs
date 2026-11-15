//! Cancellation reservations created before a native launch enters the blocking pool.
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

type Key = (String, String);
#[derive(Default)]
struct Starts { closing: bool, pending: HashMap<Key, Arc<AtomicBool>> }
#[derive(Default)]
pub(crate) struct SessionStarts(Arc<Mutex<Starts>>);
pub(crate) struct PendingStart { key: Key, cancelled: Arc<AtomicBool>, starts: Arc<Mutex<Starts>> }

impl SessionStarts {
    pub fn begin(&self, id: &str, generation: &str) -> Result<PendingStart, String> {
        let key = (id.to_owned(), generation.to_owned());
        let mut starts = self.0.lock().unwrap();
        if starts.closing { return Err("Native sessions are shutting down".into()); }
        if starts.pending.contains_key(&key) { return Err("This session is already starting".into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        starts.pending.insert(key.clone(), cancelled.clone());
        Ok(PendingStart { key, cancelled, starts: self.0.clone() })
    }
    pub fn cancel(&self, id: &str, generation: &str) {
        if let Some(cancelled) = self.0.lock().unwrap().pending.get(&(id.to_owned(), generation.to_owned())) {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
    pub fn shutdown(&self) {
        let mut starts = self.0.lock().unwrap();
        starts.closing = true;
        for cancelled in starts.pending.values() { cancelled.store(true, Ordering::SeqCst); }
    }
}
impl PendingStart {
    /// Check before spawning and while holding the session map lock before insertion.
    /// Close marks cancellation before locking that map, covering either lock order.
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) { Err("Native session launch cancelled".into()) } else { Ok(()) }
    }
}
impl Drop for PendingStart {
    fn drop(&mut self) { self.starts.lock().unwrap().pending.remove(&self.key); }
}

#[cfg(all(test, windows))]
pub(crate) mod process_fixture {
    use std::{io::Write, os::windows::process::CommandExt, path::Path, process::{Command, Stdio}};

    /// Use the already-built test executable as the .cmd launcher's descendant.
    /// This exercises real Job Objects without three concurrent PowerShell cold starts.
    pub fn launcher(directory: &Path) -> Command {
        let launcher = directory.join("launcher.cmd");
        std::fs::write(&launcher, format!(
            "@echo off\r\n\"{}\" --exact session_start::process_fixture::child_process --ignored --nocapture\r\n",
            std::env::current_exe().unwrap().display(),
        )).unwrap();
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c"]).arg(launcher).env("SINOS_PROCESS_FIXTURE", "1")
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        command
    }

    pub fn ready_pid(lines: &mut impl Iterator<Item = std::io::Result<String>>) -> u32 {
        for line in lines {
            let line = line.unwrap();
            if let Some(pid) = line.trim().strip_prefix("SINOS_FIXTURE_PID=") { return pid.parse().unwrap(); }
        }
        panic!("Native child fixture exited before readiness");
    }

    #[test]
    #[ignore = "internal child-process fixture, invoked only by Job Object regressions"]
    fn child_process() {
        if std::env::var("SINOS_PROCESS_FIXTURE").as_deref() != Ok("1") { return; }
        println!("\nSINOS_FIXTURE_PID={}", std::process::id());
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_line(&mut String::new()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_survives_queued_launch_and_preserves_other_generations() {
        let starts = SessionStarts::default();
        let old = starts.begin("tab", "old").unwrap();
        let new = starts.begin("tab", "new").unwrap();
        let other = starts.begin("other", "old").unwrap();
        starts.cancel("tab", "old");
        assert!(std::thread::spawn(move || old.check()).join().unwrap().is_err());
        assert!(new.check().is_ok()); assert!(other.check().is_ok());
        drop(new); drop(other);
        assert!(starts.0.lock().unwrap().pending.is_empty());
    }
    #[test]
    fn shutdown_cancels_pending_work_and_rejects_new_launches() {
        let starts = SessionStarts::default();
        let pending = starts.begin("tab", "generation").unwrap();
        assert!(starts.begin("tab", "generation").is_err());
        starts.shutdown();
        assert!(pending.check().is_err());
        assert!(starts.begin("new", "generation").is_err());
    }
}
