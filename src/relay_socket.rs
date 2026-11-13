//! Keep relay control frames readable while RPC work or writes are pending.
#[cfg(test)]
#[path = "relay_socket_tests.rs"]
mod tests;
use super::*;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use std::future::Future;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Error, Message};

pub(super) async fn run<S, H, F>(socket: S, device: Arc<Device>, handle: H) -> Result<(), String>
where
    S: Stream<Item = Result<Message, Error>> + Sink<Message, Error = Error> + Unpin,
    H: Fn(Value) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Value> + Send + 'static,
{
    let key = crypto::decode(&device.credential.content_key)?;
    let (mut sink, mut source) = socket.split();
    let (frames, mut writes) = mpsc::channel::<Vec<Message>>(16);
    let (replies, mut outgoing) = mpsc::channel::<(Value, bool)>(16);
    let (ordered, mut requests) = mpsc::channel::<Value>(16);
    let channel = Arc::new(RwLock::new(uuid::Uuid::new_v4().to_string()));
    let limit = Arc::new(tokio::sync::Semaphore::new(8));
    // These futures belong to the socket and are dropped with it. Neither an
    // ordered RPC nor a blocked writer may suspend the control-frame reader.
    let writer = async {
        while let Some(batch) = writes.recv().await {
            for frame in batch {
                if !device.active() { return Ok::<(), String>(()); }
                sink.send(frame).await.map_err(|_| "SEND_FAILED")?;
            }
        }
        Ok(())
    };
    let ordered_worker = async {
        while let Some(request) = requests.recv().await {
            if !device.active() { return; }
            if request["channel"] != *channel.read().unwrap() { continue; }
            let chunks = request["acceptChunks"].as_bool().unwrap_or(false);
            let response = handle(request).await;
            if replies.send((response, chunks)).await.is_err() { return; }
        }
    };
    tokio::pin!(writer, ordered_worker);
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    let mut last_seen = Instant::now();
    let mut received_seq = 0u64;
    *device.state.write().unwrap() = "connected".into();
    loop {
        tokio::select! {
            // When close, write failure and heartbeat are ready together, the
            // server's terminal ownership decision must win over local retry.
            biased;
            message = source.next() => {
                let Some(Ok(message)) = message else { return Err("DISCONNECTED".into()); };
                last_seen = Instant::now();
                match message {
                    Message::Close(frame) => {
                        let action = frame.as_ref().map(|frame| close_action(Some(u16::from(frame.code)), Some(frame.reason.as_ref())))
                            .unwrap_or(CloseAction::Retry);
                        device.handle_close(action);
                        return Ok(());
                    }
                    Message::Text(text) => {
                        if text == "pong" { continue; }
                        let Ok(control) = serde_json::from_str::<Value>(&text) else { continue; };
                        match control["type"].as_str() {
                            Some("peer-joined") => {
                                device.online.store(true, Ordering::SeqCst);
                                let next = uuid::Uuid::new_v4().to_string();
                                *channel.write().unwrap() = next.clone(); received_seq = 0;
                                let hello = crypto::seal(&key, &json!({"type":"hello", "protocol":"coffee-v1", "channel":next}))?;
                                frames.try_send(vec![Message::Binary(hello.into())]).map_err(|_| "SEND_BACKPRESSURE")?;
                            }
                            Some("peer-left") => { device.online.store(false, Ordering::SeqCst); }
                            Some("revoked") => { device.handle_close(CloseAction::Revoked); return Ok(()); }
                            _ => {}
                        }
                    }
                    Message::Binary(frame) => {
                        let Ok(request) = crypto::open(&key, &frame) else { continue; };
                        if !device.active() { return Ok(()); }
                        let current = channel.read().unwrap().clone();
                        let seq = request["seq"].as_u64().unwrap_or(0);
                        if request["channel"] != current || seq <= received_seq { continue; }
                        received_seq = seq;
                        if request["type"] != "request" { continue; }
                        let id = request["id"].as_str().unwrap_or("");
                        if id.is_empty() || id.len() > 64 { continue; }
                        // A single consumer preserves write order without holding
                        // up the socket reader. All queues and concurrency are bounded.
                        if matches!(request["action"].as_str(), Some("session.input" | "session.prompt" | "session.answer" | "session.queue_action" | "session.images" | "session.pause" | "session.kill" | "session.launch" | "workspace.save" | "terminal.resize")) {
                            if let Err(error) = ordered.try_send(request) {
                                let request = error.into_inner();
                                let _ = replies.try_send((json!({"type":"response", "channel":current, "id":request["id"], "status":429, "error":"TOO_MANY_REQUESTS"}), false));
                            }
                            continue;
                        }
                        let Ok(permit) = limit.clone().try_acquire_owned() else {
                            let _ = replies.try_send((json!({"type":"response", "channel":current, "id":id, "status":429, "error":"TOO_MANY_REQUESTS"}), false)); continue;
                        };
                        let handle = handle.clone(); let tx = replies.clone(); let active = device.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            if !active.active() { return; }
                            let chunks = request["acceptChunks"].as_bool().unwrap_or(false);
                            let response = handle(request).await;
                            let _ = tx.send((response, chunks)).await;
                        });
                    }
                    Message::Ping(bytes) => {
                        frames.try_send(vec![Message::Pong(bytes)]).map_err(|_| "SEND_BACKPRESSURE")?;
                    }
                    _ => {}
                }
            }
            result = &mut writer => { return result; }
            _ = &mut ordered_worker => { return Ok(()); }
            _ = interval.tick() => {
                if !device.active() { return Ok(()); }
                if last_seen.elapsed() > Duration::from_secs(25) { return Err("HEARTBEAT_TIMEOUT".into()); }
                frames.try_send(vec![Message::Text("ping".into())]).map_err(|_| "SEND_BACKPRESSURE")?;
            }
            Some((reply, chunks)) = outgoing.recv(), if frames.capacity() > 0 => {
                if !device.active() { return Ok(()); }
                if reply["channel"] != *channel.read().unwrap() { continue; }
                let batch = crypto::seal_reply(&key, &reply, chunks)?.into_iter().map(|frame| Message::Binary(frame.into())).collect();
                frames.try_send(batch).map_err(|_| "SEND_BACKPRESSURE")?;
            }
        }
    }
}
