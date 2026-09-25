//! Read-only CLI activity adapters and a desktop-owned mobile message queue.
//! No hooks or CLI configuration are installed. A queued prompt is delivered
//! only after an explicit native turn-completion record, never after silence.
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, time::{Duration, Instant}};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Activity { Unknown, Working, Waiting, Idle, Failed }

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ActivitySnapshot {
    pub state: Activity,
    pub source: &'static str,
    pub revision: u64,
    pub auto_send_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct QueuedPrompt {
    pub id: String,
    pub text: String,
    pub revision: u64,
    pub status: &'static str,
    pub attachments: Vec<crate::remote_images::ImageMeta>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QueueRequest {
    pub action: String,
    pub id: String,
    #[serde(default)] pub text: String,
    pub expected_revision: Option<u64>,
    #[serde(default)] pub attachments: Vec<String>,
}

pub(crate) struct Runtime {
    pub images: crate::remote_images::ImageStore,
    pub activity: ActivitySnapshot,
    pub queue: VecDeque<QueuedPrompt>,
    pub cursor: Option<u64>,
    pub source_id: Option<String>,
    pub log_revision: Option<String>,
    pub input_revision: u64,
    pub watching_until: Instant,
    osc: String,
    collecting: bool,
    escaped: bool,
    discard_osc: bool,
    receipts: VecDeque<String>,
    changed_at: Instant,
    held: bool,
    submitted_at: Option<Instant>,
    submitted_epoch: u64,
    log_remainder: String,
}

impl Runtime {
    pub fn new() -> Self {
        Self { images: crate::remote_images::ImageStore::default(), activity: ActivitySnapshot { state: Activity::Unknown, source: "unknown", revision: 0, auto_send_ready: false }, queue: VecDeque::new(), cursor: None, source_id: None, log_revision: None, input_revision: 0, watching_until: Instant::now(), osc: String::new(), collecting: false, escaped: false, discard_osc: false, receipts: VecDeque::new(), changed_at: Instant::now(), held: false, submitted_at: None, submitted_epoch: 0, log_remainder: String::new() }
    }
    fn set(&mut self, state: Activity, source: &'static str, ready: bool) {
        let ready = ready && !self.held;
        if self.activity.state != state || self.activity.source != source || self.activity.auto_send_ready != ready {
            self.activity = ActivitySnapshot { state, source, auto_send_ready: ready, revision: self.activity.revision + 1 };
            self.changed_at = Instant::now();
        }
    }
    pub fn submitted(&mut self) {
        self.input_revision += 1;
        self.held = false;
        self.submitted_at = Some(Instant::now());
        self.submitted_epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|v| v.as_millis() as u64).unwrap_or(u64::MAX);
        self.set(Activity::Working, "submission", false);
    }
    pub fn interrupted(&mut self) {
        self.input_revision += 1;
        // Explicit Stop also holds the queue, so the next idle signal cannot
        // silently start a different request behind the user's back.
        self.held = true;
        self.set(Activity::Unknown, "interrupted", false);
    }
    pub fn desktop_input(&mut self, data: &str) {
        if data.contains('\x03') { self.interrupted(); }
        else if data.contains('\r') { self.submitted(); }
        else if !data.is_empty() { self.held = true; self.activity.auto_send_ready = false; }
    }
    pub fn observe_output(&mut self, data: &str, tool: &str) {
        // Stateful OSC 0/2 decoding handles split UTF-8-safe PTY batches and
        // either BEL or ST terminators. Bound memory for malformed sequences.
        for ch in data.chars() {
            if self.collecting {
                if ch == '\u{7}' || (self.escaped && ch == '\\') {
                    if !self.discard_osc {
                        let value = std::mem::take(&mut self.osc);
                        if let Some(title) = value.strip_prefix("0;").or_else(|| value.strip_prefix("2;")) { self.observe_title(tool, title); }
                    }
                    self.osc.clear(); self.collecting = false; self.escaped = false; self.discard_osc = false;
                } else if ch == '\u{1b}' { self.escaped = true; }
                else {
                    if self.escaped { self.osc.push('\u{1b}'); self.escaped = false; }
                    if self.osc.len() < 4096 { self.osc.push(ch); } else { self.discard_osc = true; }
                }
            } else if self.escaped {
                self.collecting = ch == ']'; self.osc.clear(); self.escaped = ch == '\u{1b}';
            } else { self.escaped = ch == '\u{1b}'; }
        }
    }
    fn observe_title(&mut self, tool: &str, title: &str) {
        let title = title.trim();
        let first = title.split_whitespace().next().unwrap_or("");
        let state = match tool {
            "claude" if matches!(first, "⠂" | "⠐" | "◐" | "◑") => Activity::Working,
            // Claude's static prefix also covers permission prompts. It must
            // not overwrite a structured waiting state or unlock auto-send.
            "claude" if first == "✳" => if self.activity.state == Activity::Waiting { Activity::Waiting } else { Activity::Idle },
            "codex" if title.starts_with('[') && title.split(']').next().is_some_and(|v| matches!(v.trim_start_matches('[').trim(), "!" | ".")) => Activity::Waiting,
            "codex" if title.split_whitespace().any(|s| ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"].contains(&s)) => Activity::Working,
            "codex" if !title.is_empty() => Activity::Idle,
            "omp" if first == "π" => match title.split_whitespace().nth(1) {
                Some("!") => Activity::Waiting,
                Some(">") => Activity::Idle,
                Some(":" | "⠋" | "⠙" | "⠹" | "⠸" | "⠼" | "⠴" | "⠦" | "⠧" | "⠇" | "⠏") => Activity::Working,
                _ => return,
            },
            "grok" if title.contains("Action Required") => Activity::Waiting,
            "grok" if title.split(" - ").any(|s| ["Thinking","Responding","Compacting","Waiting","Running tool","⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧"].contains(&s) || s.starts_with("Running:") || s.ends_with('…')) => Activity::Working,
            // Grok hides its action-required title during the blink cycle.
            "grok" if self.activity.state == Activity::Waiting => Activity::Waiting,
            "grok" if !title.is_empty() => Activity::Idle,
            _ => return,
        };
        // A late idle title immediately after input is still the old frame.
        if state == Activity::Idle && self.submitted_at.is_some_and(|at| at.elapsed() < Duration::from_secs(2)) { return; }
        let ready = state == Activity::Idle && self.activity.state == Activity::Idle && self.activity.auto_send_ready;
        self.set(state, "native_title", ready);
    }
    pub fn observe_log(&mut self, data: &str, seed: bool) {
        // Disk appends can end in the middle of one JSONL record. Keep a
        // bounded tail, otherwise its completion signal would be lost forever.
        if seed { self.log_remainder.clear(); }
        let mut combined = std::mem::take(&mut self.log_remainder);
        combined.push_str(data);
        let mut latest = None;
        for line in combined.split_inclusive('\n') {
            let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
                if !line.ends_with('\n') && line.len() <= 1_048_576 { self.log_remainder = line.to_owned(); }
                continue;
            };
            // A fresh disk read can still contain records from before the
            // input. Require a later native timestamp, not polling timing.
            if self.submitted_epoch > 0 && record_epoch(&row["timestamp"]).is_none_or(|at| at <= self.submitted_epoch) { continue; }
            let payload = &row["payload"];
            let kind = payload["type"].as_str().unwrap_or("");
            if row["type"] == "event_msg" {
                latest = match kind {
                    "task_started" | "turn_started" | "user_message" => Some(Activity::Working),
                    "task_complete" | "task_completed" | "turn_complete" => Some(Activity::Idle),
                    "turn_aborted" => Some(Activity::Failed),
                    _ => latest,
                };
            }
            let message = &row["message"];
            if message["role"] == "assistant" {
                if message["stop_reason"] == "end_turn" { latest = Some(Activity::Idle); }
                else if message["stop_reason"] == "tool_use" { latest = Some(Activity::Working); }
                if let Some(blocks) = message["content"].as_array() {
                    if blocks.iter().any(|block| block["type"] == "tool_use" && matches!(block["name"].as_str(), Some("AskUserQuestion" | "ask_user" | "request_user_input"))) { latest = Some(Activity::Waiting); }
                }
            } else if message["role"] == "user" { latest = Some(Activity::Working); }
            if row["type"] == "system" && row["subtype"] == "turn_duration" { latest = Some(Activity::Idle); }
        }
        if let Some(state) = latest {
            // History already on disk is context, not a fresh completion of a
            // just-submitted prompt or of an actively running desktop turn.
            if seed && matches!(self.activity.state, Activity::Working | Activity::Waiting) { return; }
            self.set(state, "native_log", state == Activity::Idle && !seed);
        }
    }
    pub fn enqueue(&mut self, request: &QueueRequest) -> Result<(), &'static str> {
        if request.id.is_empty() || request.id.len() > 80 || !request.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("INVALID_MESSAGE"); }
        // Idempotent even after delivery: a timed-out client cannot duplicate
        // a queued request when reconnecting.
        if self.queue.iter().any(|item| item.id == request.id) || self.receipts.contains(&request.id) { return Ok(()); }
        if self.queue.len() >= 20 { return Err("QUEUE_FULL"); }
        let attachments = self.images.metadata(&request.attachments)?;
        let text = image_prompt_text(&request.text, !attachments.is_empty())?;
        if self.queue.iter().map(|item| item.text.len()).sum::<usize>() + text.len() > 262_144 { return Err("QUEUE_FULL"); }
        self.queue.push_back(QueuedPrompt { id: request.id.clone(), text, revision: 1, status: "queued", attachments });
        Ok(())
    }
    pub fn mutate(&mut self, request: &QueueRequest) -> Result<(), &'static str> {
        let index = self.queue.iter().position(|item| item.id == request.id).ok_or("MESSAGE_NOT_FOUND")?;
        if Some(self.queue[index].revision) != request.expected_revision { return Err("QUEUE_CONFLICT"); }
        match request.action.as_str() {
            "edit" => {
                if self.queue[index].status == "uncertain" { return Err("DELIVERY_UNCERTAIN"); }
                let text = image_prompt_text(&request.text, !self.queue[index].attachments.is_empty())?;
                if self.queue.iter().enumerate().filter(|(i, _)| *i != index).map(|(_, item)| item.text.len()).sum::<usize>() + text.len() > 262_144 { return Err("QUEUE_FULL"); }
                self.queue[index].text = text; self.queue[index].revision += 1; self.queue[index].status = "queued";
            }
            "hold" if self.queue[index].status != "uncertain" => { self.queue[index].status = "editing"; self.queue[index].revision += 1; }
            "release" if self.queue[index].status == "editing" => { self.queue[index].status = "queued"; self.queue[index].revision += 1; }
            "remove" => { let item = self.queue.remove(index).unwrap(); self.remember(item.id); }
            _ => return Err("INVALID_ACTION"),
        }
        Ok(())
    }
    fn remember(&mut self, id: String) { self.receipts.push_back(id); if self.receipts.len() > 256 { self.receipts.pop_front(); } }
    pub fn ready(&self) -> bool {
        !self.held && self.activity.auto_send_ready && self.activity.state == Activity::Idle && self.changed_at.elapsed() >= Duration::from_millis(750) && self.queue.front().is_some_and(|item| item.status == "queued")
    }
    pub fn held(&self) -> bool { self.held }
    pub fn changed_source(&mut self) { self.held = true; self.set(Activity::Unknown, "source_changed", false); }
    pub fn claim(&mut self, id: Option<&str>, expected: Option<u64>) -> Result<QueuedPrompt, &'static str> {
        let index = if let Some(id) = id { self.queue.iter().position(|item| item.id == id).ok_or("MESSAGE_NOT_FOUND")? } else { 0 };
        let item = self.queue.get(index).ok_or("MESSAGE_NOT_FOUND")?;
        if id.is_some() && expected != Some(item.revision) { return Err("QUEUE_CONFLICT"); }
        if item.status != "queued" { return Err("DELIVERY_UNCERTAIN"); }
        let item = self.queue.remove(index).unwrap(); self.remember(item.id.clone()); self.submitted(); Ok(item)
    }
    pub fn delivery_failed(&mut self, mut item: QueuedPrompt) {
        item.status = "uncertain"; item.revision += 1; self.queue.push_front(item); self.held = true; self.set(Activity::Unknown, "delivery_failed", false);
    }
}

pub(crate) fn clean_prompt(text: &str) -> Result<String, &'static str> {
    if text.len() > 65_536 || text.trim().is_empty() { return Err("INVALID_MESSAGE"); }
    let value: String = text.chars().filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t')).collect();
    if value.trim().is_empty() { return Err("INVALID_MESSAGE"); } Ok(value)
}

pub(crate) fn image_prompt_text(text: &str, has_images: bool) -> Result<String, &'static str> {
    if text.trim().is_empty() && has_images && text.len() <= 65_536 { Ok(String::new()) } else { clean_prompt(text) }
}

fn record_epoch(value: &serde_json::Value) -> Option<u64> {
    if let Some(value) = value.as_u64() { return Some(value); }
    let value = value.as_str()?;
    // The native JSONL adapters use UTC RFC3339. Unknown formats cannot
    // authorize delivery. Gregorian civil-date conversion, no locale I/O.
    let (date, time) = value.strip_suffix('Z')?.split_once('T')?;
    let date: Vec<i64> = date.split('-').map(str::parse).collect::<Result<_, _>>().ok()?;
    let time: Vec<&str> = time.split(':').collect();
    if date.len() != 3 || time.len() != 3 { return None; }
    let (year, month, day) = (date[0], date[1], date[2]);
    let hour: i64 = time[0].parse().ok()?; let minute: i64 = time[1].parse().ok()?;
    let (seconds, fraction) = time[2].split_once('.').unwrap_or((time[2], ""));
    let second: i64 = seconds.parse().ok()?;
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(0..24).contains(&hour) || !(0..60).contains(&minute) || !(0..60).contains(&second) || !fraction.chars().all(|c| c.is_ascii_digit()) { return None; }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max = [31, if leap {29} else {28},31,30,31,30,31,31,30,31,30,31][month as usize - 1];
    if day < 1 || day > max { return None; }
    let y = year - i64::from(month <= 2); let era = y / 400; let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 {-3} else {9}) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let ms: u64 = format!("{fraction:0<3}").chars().take(3).collect::<String>().parse().ok()?;
    Some(((days * 86400 + hour * 3600 + minute * 60 + second) * 1000) as u64 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omp_titles_and_current_claude_frames_do_not_authorize_auto_send() {
        let mut runtime = Runtime::new();
        for frame in ["◐", "◑", "⠂", "⠐"] {
            runtime.observe_output(&format!("\x1b]0;{frame} Test\x07"), "claude");
            assert_eq!(runtime.activity.state, Activity::Working);
        }
        for (prefix, state) in [(":", Activity::Working), ("!", Activity::Waiting), (">", Activity::Idle)] {
            runtime.observe_output(&format!("\x1b]0;π {prefix} Test\x07"), "omp");
            assert_eq!(runtime.activity.state, state);
            assert!(!runtime.activity.auto_send_ready);
        }
    }
    fn request(id: &str, text: &str) -> QueueRequest { QueueRequest { action: "enqueue".into(), id: id.into(), text: text.into(), expected_revision: None, attachments: Vec::new() } }
    #[test] fn native_titles_are_split_safe_and_never_authorize_auto_send() {
        let mut runtime = Runtime::new();
        runtime.observe_output("\x1b]0;⠋ project", "codex");
        assert_eq!(runtime.activity.state, Activity::Unknown);
        runtime.observe_output("\x1b\\", "codex"); assert_eq!(runtime.activity.state, Activity::Working);
        runtime.observe_output("\x1b]2;[ ! ] Action Required\x07", "codex"); assert_eq!(runtime.activity.state, Activity::Waiting);
        runtime.observe_output("\x1b]0;✳ workspace\x07", "claude"); assert_eq!(runtime.activity.state, Activity::Waiting);
        assert!(!runtime.activity.auto_send_ready);
    }
    #[test] fn queue_requires_native_completion_and_stop_holds_it() {
        let mut runtime = Runtime::new(); runtime.enqueue(&request("first", "First\nSecond")).unwrap();
        runtime.observe_output("\x1b]0;project\x07", "codex"); assert!(!runtime.ready());
        runtime.observe_log(r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#, false);
        runtime.changed_at = Instant::now() - Duration::from_secs(1); assert!(runtime.ready());
        runtime.interrupted();
        runtime.observe_log(r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#, false); assert!(!runtime.ready());
    }
    #[test] fn duplicate_requests_edits_and_uncertain_delivery_are_not_replayed() {
        let mut runtime = Runtime::new(); let item = request("id", "one");
        runtime.enqueue(&item).unwrap(); runtime.enqueue(&item).unwrap(); assert_eq!(runtime.queue.len(), 1);
        let mut edit = request("id", "two"); edit.action = "edit".into(); edit.expected_revision = Some(0);
        assert_eq!(runtime.mutate(&edit), Err("QUEUE_CONFLICT")); edit.expected_revision = Some(1); runtime.mutate(&edit).unwrap();
        let item = runtime.claim(Some("id"), Some(2)).unwrap(); runtime.enqueue(&request("id", "one")).unwrap(); assert!(runtime.queue.is_empty());
        runtime.delivery_failed(item); assert_eq!(runtime.queue[0].status, "uncertain");
        assert!(matches!(runtime.claim(Some("id"), Some(3)), Err("DELIVERY_UNCERTAIN")));
    }
    #[test] fn old_history_does_not_finish_a_new_submission() {
        let mut runtime = Runtime::new(); runtime.submitted();
        runtime.observe_log(r#"{"message":{"role":"assistant","stop_reason":"end_turn"}}"#, true);
        assert_eq!(runtime.activity.state, Activity::Working);
        let complete = serde_json::json!({"timestamp":runtime.submitted_epoch + 1,"message":{"role":"assistant","stop_reason":"end_turn"}}).to_string();
        runtime.observe_log(&complete, false);
        assert_eq!(runtime.activity.state, Activity::Idle);
    }
    #[test] fn native_timestamps_reject_old_completions_and_unknown_formats() {
        assert_eq!(record_epoch(&"1970-01-01T00:00:01.12Z".into()), Some(1120));
        assert_eq!(record_epoch(&"2026-02-30T00:00:00Z".into()), None);
        assert_eq!(record_epoch(&"2026-09-24T00:00:00+08:00".into()), None);
        let mut runtime = Runtime::new(); runtime.submitted();
        let old = serde_json::json!({"timestamp":runtime.submitted_epoch - 1,"type":"event_msg","payload":{"type":"task_complete"}});
        runtime.observe_log(&old.to_string(), false); assert_eq!(runtime.activity.state, Activity::Working);
    }
    #[test] fn initial_history_and_editing_never_trigger_automatic_delivery() {
        let mut runtime = Runtime::new(); runtime.enqueue(&request("id", "one")).unwrap();
        let complete = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        runtime.observe_log(complete, true); runtime.changed_at = Instant::now() - Duration::from_secs(1); assert!(!runtime.ready());
        runtime.observe_log(complete, false); runtime.changed_at = Instant::now() - Duration::from_secs(1); assert!(runtime.ready());
        let hold = QueueRequest { action: "hold".into(), id: "id".into(), text: String::new(), expected_revision: Some(1), attachments: Vec::new() };
        runtime.mutate(&hold).unwrap(); assert!(!runtime.ready());
    }
    #[test] fn incomplete_native_records_wait_for_their_next_disk_append() {
        let mut runtime = Runtime::new(); runtime.submitted();
        let first = format!("{{\"timestamp\":{},\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_", runtime.submitted_epoch + 1);
        runtime.observe_log(&first, false); assert_eq!(runtime.activity.state, Activity::Working);
        runtime.observe_log("complete\"}}\n", false); assert_eq!(runtime.activity.state, Activity::Idle);
        assert!(runtime.activity.auto_send_ready);
        runtime.observe_log("{\"incomplete\":", false);
        runtime.observe_log("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}", true);
        assert!(runtime.log_remainder.is_empty());
    }
}
