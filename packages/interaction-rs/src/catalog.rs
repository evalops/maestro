//! Validated action metadata shared by lookup, help, and keyboard adapters.
use crate::Action;

/// Terminal-independent keys used by native picker controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shortcut {
    Up,
    Down,
    Enter,
    Escape,
    Left,
    Right,
    Backspace,
}
impl Shortcut {
    /// Compact user-facing label for this exact binding.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Up => "↑",
            Self::Down => "↓",
            Self::Enter => "Enter",
            Self::Escape => "Esc",
            Self::Left => "←",
            Self::Right => "→",
            Self::Backspace => "Backspace",
        }
    }
}

/// Ambiguous metadata is rejected before a catalog can be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogError {
    DuplicateId(&'static str),
    DuplicateShortcut(Shortcut),
}
impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateId(id) => write!(f, "duplicate action ID: {id}"),
            Self::DuplicateShortcut(key) => write!(f, "duplicate shortcut: {}", key.label()),
        }
    }
}
impl std::error::Error for CatalogError {}

/// Borrowed catalog with unique IDs and bindings. Empty IDs may name a default action.
#[derive(Debug)]
pub struct ActionCatalog<'a, T> {
    actions: &'a [Action<T>],
}
impl<'a, T> ActionCatalog<'a, T> {
    /// Validate once when constructing an owned host's catalog.
    pub fn new(actions: &'a [Action<T>]) -> Result<Self, CatalogError> {
        for (index, action) in actions.iter().enumerate() {
            for previous in &actions[..index] {
                if previous.id == action.id {
                    return Err(CatalogError::DuplicateId(action.id));
                }
                if let Some(key) = action.shortcut {
                    if previous.shortcut == Some(key) {
                        return Err(CatalogError::DuplicateShortcut(key));
                    }
                }
            }
        }
        Ok(Self { actions })
    }
    /// Original declaration order, suitable for menus and command completion.
    pub fn actions(&self) -> &'a [Action<T>] {
        self.actions
    }
    /// Find a typed intent by its stable ID, never by display prose.
    pub fn find(&self, id: &str) -> Option<&'a Action<T>> {
        self.actions.iter().find(|a| a.id == id)
    }
    /// Resolve a binding through the same declaration used by help.
    pub fn binding(&self, key: Shortcut) -> Option<&'a Action<T>> {
        self.actions.iter().find(|a| a.shortcut == Some(key))
    }
    /// Generate human-readable command help from the validated declarations.
    pub fn help(&self) -> String {
        self.actions
            .iter()
            .map(|a| {
                let name = if a.id.is_empty() { a.label } else { a.id };
                let binding = a
                    .shortcut
                    .map(|key| format!(" ({})", key.label()))
                    .unwrap_or_default();
                format!("{name}: {}{binding}", a.description)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
