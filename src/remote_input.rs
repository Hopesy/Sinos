//! Submit terminal text as a paste followed by a distinct Enter keystroke.
use std::io::{self, Write};
use std::time::Duration;

/// Windows ConPTY can deliver a paste as a burst of character key events.
/// Codex deliberately turns Enter inside its 120 ms paste window into a
/// newline. Flush the paste first, then let the CLI finish that window before
/// sending Enter. Callers keep the per-terminal writer locked across both
/// writes, and run this on a blocking worker, so other input cannot interleave.
/// A partial write is never retried: it may already have reached the CLI.
pub(crate) fn paste_and_submit(writer: &mut dyn Write, text: &str) -> io::Result<()> {
    writer.write_all(format!("\x1b[200~{text}\x1b[201~").as_bytes())?;
    writer.flush()?;
    std::thread::sleep(Duration::from_millis(250));
    writer.write_all(b"\r")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_sends_enter_after_a_failed_paste() {
        struct FailedPaste {
            bytes: Vec<u8>,
        }
        impl Write for FailedPaste {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::other("disconnected"))
            }
        }
        let mut writer = FailedPaste { bytes: vec![] };
        assert!(paste_and_submit(&mut writer, "first\nsecond").is_err());
        assert_eq!(writer.bytes, b"\x1b[200~first\nsecond\x1b[201~");
    }
}
