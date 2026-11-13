use super::*;
use std::{pin::Pin, task::{Context, Poll}};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};

// Only the transport and RPC boundary are controlled. The production socket
// loop, encryption, sequencing, close handling and owner state run unchanged.
struct Socket {
    incoming: mpsc::Receiver<Result<Message, Error>>,
    outgoing: mpsc::UnboundedSender<Message>,
    blocked: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    blocked_write: Arc<Notify>,
}
impl Stream for Socket {
    type Item = Result<Message, Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.incoming.poll_recv(cx)
    }
}
impl Sink<Message> for Socket {
    type Error = Error;
    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        if self.failed.load(Ordering::SeqCst) { return Poll::Ready(Err(Error::ConnectionClosed)); }
        if self.blocked.load(Ordering::SeqCst) {
            self.blocked_write.notify_one(); return Poll::Pending;
        }
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, frame: Message) -> Result<(), Error> {
        self.outgoing.send(frame).map_err(|_| Error::ConnectionClosed)
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Error>> { Poll::Ready(Ok(())) }
    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Error>> { Poll::Ready(Ok(())) }
}
fn fixture() -> (Arc<Device>, Socket, mpsc::Sender<Result<Message, Error>>, mpsc::UnboundedReceiver<Message>) {
    let (tx, incoming) = mpsc::channel(32);
    let (outgoing, rx) = mpsc::unbounded_channel();
    let device = Arc::new(Device::new(Credential {
        pair_id: "test".into(), relay_url: "http://127.0.0.1".into(), token: "disposable".into(),
        content_key: crypto::encode(&[7; 32]), device_name: "test".into(), paired_at: 1, revoked: false,
    }, None));
    (device, Socket { incoming, outgoing, blocked: Arc::new(AtomicBool::new(false)), failed: Arc::new(AtomicBool::new(false)), blocked_write: Arc::new(Notify::new()) }, tx, rx)
}
fn replaced() -> Result<Message, Error> {
    Ok(Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "replaced".into() })))
}
async fn hello(tx: &mpsc::Sender<Result<Message, Error>>, rx: &mut mpsc::UnboundedReceiver<Message>) -> String {
    tx.send(Ok(Message::Text(r#"{"type":"peer-joined"}"#.into()))).await.unwrap();
    loop {
        let message = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        if let Message::Binary(frame) = message {
            return crypto::open(&[7; 32], &frame).unwrap()["channel"].as_str().unwrap().to_string();
        }
    }
}
fn request(channel: &str, seq: u64) -> Result<Message, Error> {
    Ok(Message::Binary(crypto::seal(&[7; 32], &json!({
        "type":"request", "channel":channel, "seq":seq, "id":seq.to_string(), "action":"workspace.save",
    })).unwrap().into()))
}

#[tokio::test]
async fn replacement_interrupts_a_stalled_ordered_rpc_without_reconnecting() {
    let (device, socket, tx, mut rx) = fixture();
    let started = Arc::new(Notify::new());
    let signal = started.clone();
    let owner = device.clone();
    let task = tokio::spawn(run(socket, owner, move |_| {
        let signal = signal.clone();
        async move { signal.notify_one(); std::future::pending::<Value>().await }
    }));
    let channel = hello(&tx, &mut rx).await;
    tx.send(request(&channel, 1)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), started.notified()).await.unwrap();
    tx.send(replaced()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().unwrap();
    assert!(!device.active(), "run_device must not enter another connection attempt");
    assert_eq!(&*device.state.read().unwrap(), "replaced");
    assert!(!device.saved_credential().revoked);
}

#[tokio::test]
async fn replacement_remains_readable_during_blocked_or_failing_writes() {
    for fail_write in [false, true] {
        let (device, socket, tx, _rx) = fixture();
        socket.blocked.store(true, Ordering::SeqCst);
        let failed = socket.failed.clone();
        let entered = socket.blocked_write.clone();
        let task = tokio::spawn(run(socket, device.clone(), |request| async move { request }));
        tx.send(Ok(Message::Text(r#"{"type":"peer-joined"}"#.into()))).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), entered.notified()).await.unwrap();
        // Both the queued terminal close and the writer failure are now ready.
        failed.store(fail_write, Ordering::SeqCst);
        tx.send(replaced()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().unwrap();
        assert!(!device.active());
        assert_eq!(&*device.state.read().unwrap(), "replaced");
    }
}

#[tokio::test]
async fn a_new_guest_channel_discards_queued_old_writes() {
    let (device, socket, tx, mut rx) = fixture();
    let (started, mut order) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let task = tokio::spawn(run(socket, device, move |request| {
        let started = started.clone(); let gate = gate.clone();
        async move {
            let id = request["id"].as_str().unwrap().to_string();
            started.send(id.clone()).unwrap();
            if id == "1" { gate.notified().await; }
            json!({"type":"response", "channel":request["channel"], "id":id, "status":200})
        }
    }));
    let old_channel = hello(&tx, &mut rx).await;
    tx.send(request(&old_channel, 1)).await.unwrap();
    tx.send(request(&old_channel, 2)).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), order.recv()).await.unwrap().unwrap(), "1");
    let new_channel = hello(&tx, &mut rx).await;
    assert_ne!(old_channel, new_channel);
    release.notify_one();
    tx.send(request(&new_channel, 3)).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), order.recv()).await.unwrap().unwrap(), "3");
    tx.send(replaced()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn ordered_requests_stay_serial_while_the_reader_stays_available() {
    let (device, socket, tx, mut rx) = fixture();
    let (started, mut order) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let task = tokio::spawn(run(socket, device, move |request| {
        let started = started.clone(); let gate = gate.clone();
        async move {
            let id = request["id"].as_str().unwrap().to_string();
            started.send(id.clone()).unwrap();
            if id == "1" { gate.notified().await; }
            json!({"type":"response", "channel":request["channel"], "id":id, "status":200})
        }
    }));
    let channel = hello(&tx, &mut rx).await;
    tx.send(request(&channel, 1)).await.unwrap();
    tx.send(request(&channel, 2)).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), order.recv()).await.unwrap().unwrap(), "1");
    assert!(order.try_recv().is_err(), "second write must wait for the first RPC");
    release.notify_one();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), order.recv()).await.unwrap().unwrap(), "2");
    tx.send(replaced()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap().unwrap();
}
