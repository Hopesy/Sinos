//! Antigravity CLI (Google): current SQLite conversation index and legacy
//! Gemini-compatible JSONL sessions are both supported. Resume uses agy --conversation.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "antigravity",
    display_name: "Antigravity CLI",
    binary_name: "agy",
    has_legacy_hook_artifacts: false,
    // agy writes session JSONL to `~/.gemini/tmp/<project>/chats/
    // session-*.jsonl` using the format inherited from the retired
    // Gemini CLI (verified on populated session files dated 2026-05-20).
    // The protobuf at `~/.gemini/antigravity-cli/conversations/*.pb`
    // is the model-side state, but the JSONL has enough to render
    // titles and message counts in the history list. Same schema as
    // older Gemini sessions in the same dir, which now also surface
    // as Antigravity — Gemini CLI as a separate product is retiring
    // anyway, so a unified label is the cleaner UX.
    history_shape: Some(HistoryShape::AntigravityTmp {
        root_under_home: ".gemini/tmp",
        depth: 3,
    }),
    default_args: &[],
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_keeps_legacy_jsonl_alongside_its_index() {
        assert!(matches!(DESCRIPTOR.history_shape, Some(HistoryShape::AntigravityTmp { root_under_home: ".gemini/tmp", depth: 3 })));
        assert!(!DESCRIPTOR.has_legacy_hook_artifacts);
    }
}
