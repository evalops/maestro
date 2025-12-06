//! TUI Components
//!
//! Ratatui widgets that render our component tree.

mod text;
mod layout;
mod input;
mod scroll;
mod message;

pub use text::{TextWidget, StyledTextWidget};
pub use layout::{BoxWidget, column_layout, row_layout};
pub use input::{InputWidget, EditorWidget};
pub use scroll::render_scrollbar;
pub use message::{ChatView, MessageWidget, ToolCallWidget, ChatInputWidget, StatusBarWidget};
