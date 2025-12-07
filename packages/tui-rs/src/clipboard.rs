//! Clipboard integration
//!
//! Provides copy/paste functionality for the TUI.
//! Enabled via the "clipboard" feature flag.

#[cfg(feature = "clipboard")]
use arboard::Clipboard;

/// Result type for clipboard operations
pub type ClipboardResult<T> = Result<T, ClipboardError>;

/// Clipboard error types
#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    #[error("Clipboard not available: {0}")]
    NotAvailable(String),

    #[error("Failed to access clipboard: {0}")]
    AccessFailed(String),

    #[error("Clipboard feature not enabled")]
    FeatureDisabled,
}

/// Clipboard manager for copy/paste operations
pub struct ClipboardManager {
    #[cfg(feature = "clipboard")]
    clipboard: Option<Clipboard>,
}

impl Default for ClipboardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipboardManager {
    /// Create a new clipboard manager
    pub fn new() -> Self {
        #[cfg(feature = "clipboard")]
        {
            let clipboard = Clipboard::new().ok();
            Self { clipboard }
        }

        #[cfg(not(feature = "clipboard"))]
        {
            Self {}
        }
    }

    /// Check if clipboard is available
    pub fn is_available(&self) -> bool {
        #[cfg(feature = "clipboard")]
        {
            self.clipboard.is_some()
        }

        #[cfg(not(feature = "clipboard"))]
        {
            false
        }
    }

    /// Copy text to clipboard
    pub fn copy(&mut self, text: &str) -> ClipboardResult<()> {
        #[cfg(feature = "clipboard")]
        {
            let clipboard = self
                .clipboard
                .as_mut()
                .ok_or_else(|| ClipboardError::NotAvailable("Clipboard not initialized".into()))?;

            clipboard
                .set_text(text)
                .map_err(|e| ClipboardError::AccessFailed(e.to_string()))
        }

        #[cfg(not(feature = "clipboard"))]
        {
            let _ = text;
            Err(ClipboardError::FeatureDisabled)
        }
    }

    /// Paste text from clipboard
    pub fn paste(&mut self) -> ClipboardResult<String> {
        #[cfg(feature = "clipboard")]
        {
            let clipboard = self
                .clipboard
                .as_mut()
                .ok_or_else(|| ClipboardError::NotAvailable("Clipboard not initialized".into()))?;

            clipboard
                .get_text()
                .map_err(|e| ClipboardError::AccessFailed(e.to_string()))
        }

        #[cfg(not(feature = "clipboard"))]
        {
            Err(ClipboardError::FeatureDisabled)
        }
    }

    /// Copy code block content (strips leading/trailing whitespace)
    pub fn copy_code_block(&mut self, code: &str) -> ClipboardResult<()> {
        let trimmed = code.trim();
        self.copy(trimmed)
    }

    /// Copy message content
    pub fn copy_message(&mut self, content: &str) -> ClipboardResult<()> {
        self.copy(content)
    }
}

/// Check if clipboard feature is compiled in
pub const fn is_feature_enabled() -> bool {
    cfg!(feature = "clipboard")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clipboard_manager_creation() {
        let manager = ClipboardManager::new();
        // Just ensure no panic on creation
        let _ = manager.is_available();
    }

    #[test]
    fn test_feature_enabled_flag() {
        // This should compile regardless of feature flag
        let enabled = is_feature_enabled();
        #[cfg(feature = "clipboard")]
        assert!(enabled);
        #[cfg(not(feature = "clipboard"))]
        assert!(!enabled);
    }

    // Note: Clipboard tests that actually access the system clipboard are marked
    // as ignored by default because they can crash in headless environments (CI).
    // Run them manually with: cargo test --features clipboard -- --ignored

    #[cfg(feature = "clipboard")]
    #[test]
    #[ignore = "Requires display environment for clipboard access"]
    fn test_copy_paste_roundtrip() {
        let mut manager = ClipboardManager::new();
        if manager.is_available() {
            let test_text = "Hello, clipboard!";
            assert!(manager.copy(test_text).is_ok());
            let result = manager.paste();
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), test_text);
        }
    }

    #[cfg(feature = "clipboard")]
    #[test]
    #[ignore = "Requires display environment for clipboard access"]
    fn test_copy_code_block() {
        let mut manager = ClipboardManager::new();
        if manager.is_available() {
            let code = "\n  fn main() {}\n  ";
            assert!(manager.copy_code_block(code).is_ok());
            let result = manager.paste();
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "fn main() {}");
        }
    }
}
