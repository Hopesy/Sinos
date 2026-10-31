use std::collections::VecDeque;

pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_CHUNKS: usize = 2000;

/// Recent raw UTF-8 output for mobile replay. Every entry represents one
/// emitted batch, so evicting the oldest entries preserves sequence offsets.
#[derive(Default)]
pub struct OutputBuffer {
    chunks: VecDeque<Box<str>>,
    bytes: usize,
}

impl OutputBuffer {
    pub fn push(&mut self, data: String) {
        // A lossy UTF-8 conversion can expand a large PTY batch. Retain its
        // newest valid suffix without splitting a code point or sequence entry.
        let data = if data.len() > MAX_OUTPUT_BYTES {
            let mut start = data.len() - MAX_OUTPUT_BYTES;
            while !data.is_char_boundary(start) { start += 1; }
            data[start..].to_owned()
        } else { data };
        self.bytes += data.len();
        self.chunks.push_back(data.into_boxed_str());
        while self.bytes > MAX_OUTPUT_BYTES || self.chunks.len() > MAX_OUTPUT_CHUNKS {
            self.bytes -= self.chunks.pop_front().unwrap().len();
        }
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn since(&self, sequence: u64, offset: &mut u64) -> Vec<String> {
        let delta = usize::try_from(sequence.saturating_sub(*offset)).unwrap_or(usize::MAX);
        let start = self.len().saturating_sub(delta);
        *offset = sequence;
        self.chunks.iter().skip(start).map(|chunk| chunk.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sustained_output_has_a_byte_budget_per_session() {
        let mut buffer = OutputBuffer::default();
        for _ in 0..2200 {
            buffer.push("x".repeat(16 * 1024));
            assert!(buffer.bytes <= MAX_OUTPUT_BYTES);
        }
        assert_eq!(buffer.bytes, MAX_OUTPUT_BYTES);
        assert_eq!(buffer.len(), 128);
    }

    #[test]
    fn tiny_batches_keep_the_existing_entry_limit() {
        let mut buffer = OutputBuffer::default();
        for index in 0..2100 { buffer.push(index.to_string()); }
        assert_eq!(buffer.len(), MAX_OUTPUT_CHUNKS);
        let mut offset = 0;
        let chunks = buffer.since(2100, &mut offset);
        assert_eq!(chunks.first().unwrap(), "100");
        assert_eq!(chunks.last().unwrap(), "2099");
        assert_eq!(offset, 2100);
        assert!(buffer.since(2100, &mut offset).is_empty());
    }

    #[test]
    fn byte_eviction_keeps_recent_sequence_offsets() {
        let mut buffer = OutputBuffer::default();
        for index in 0..6 { buffer.push(index.to_string().repeat(MAX_OUTPUT_BYTES / 2)); }
        let mut lagging = 1;
        assert!(buffer.since(6, &mut lagging) == vec!["4".repeat(MAX_OUTPUT_BYTES / 2), "5".repeat(MAX_OUTPUT_BYTES / 2)]);
        let mut current = 5;
        assert!(buffer.since(6, &mut current) == vec!["5".repeat(MAX_OUTPUT_BYTES / 2)]);
        assert!(buffer.since(6, &mut current).is_empty());
        buffer.push("next".into());
        assert_eq!(buffer.since(7, &mut current), vec!["next"]);
    }

    #[test]
    fn oversized_batch_keeps_a_valid_utf8_tail_and_one_sequence_entry() {
        let mut buffer = OutputBuffer::default();
        buffer.push("old".into());
        let text = "中🙂".repeat(MAX_OUTPUT_BYTES / 7 + 10);
        buffer.push(text.clone());
        assert!(buffer.bytes <= MAX_OUTPUT_BYTES);
        assert_eq!(buffer.len(), 1);
        let chunks = buffer.since(2, &mut 0);
        assert!(text.ends_with(&chunks[0]));
        assert!(chunks[0].len() >= MAX_OUTPUT_BYTES - 3);
    }

    /// Manual deterministic retention profile; excludes CLI/WebView memory.
    #[test]
    #[ignore]
    fn retained_output_memory_profile() {
        for sessions in [1, 4, 8] {
            let mut previous = vec![Vec::<String>::new(); sessions];
            for buffer in &mut previous {
                for _ in 0..2200 {
                    buffer.push("x".repeat(16 * 1024));
                    if buffer.len() > 2000 { buffer.drain(..buffer.len() - 2000); }
                }
            }
            let before: usize = previous.iter().flatten().map(String::capacity).sum();
            drop(previous);
            let mut current: Vec<_> = (0..sessions).map(|_| OutputBuffer::default()).collect();
            for buffer in &mut current {
                for _ in 0..2200 { buffer.push("x".repeat(16 * 1024)); }
            }
            let after: usize = current.iter().map(|buffer| buffer.bytes).sum();
            println!("sessions={sessions} before_bytes={before} after_bytes={after}");
            assert_eq!(after, sessions * MAX_OUTPUT_BYTES);
        }
    }
}
