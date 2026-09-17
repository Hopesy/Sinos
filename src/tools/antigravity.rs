//! Antigravity CLI (Google) — third-class (T3) integration.
//!
//! Antigravity is closed-source and its private session formats have changed
//! across releases. Coffee CLI therefore treats `agy` as launch-only: brand
//! icon, PATH detection, and one-click terminal startup, with no history,
//! resume, heatmap, hook, or protocol integration.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "antigravity",
    display_name: "Antigravity CLI",
    binary_name: "agy",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_is_launch_only() {
        assert!(DESCRIPTOR.history_shape.is_none());
        assert!(!DESCRIPTOR.has_legacy_hook_artifacts);
    }
}
