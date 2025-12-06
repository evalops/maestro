//! TUI Components
//!
//! Ratatui widgets that render our component tree.

mod approval;
mod input;
mod layout;
mod message;
mod scroll;
mod text;

pub use approval::{ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest};
pub use input::{EditorWidget, InputWidget};
pub use layout::{column_layout, row_layout, BoxWidget};
pub use message::{ChatInputWidget, ChatView, MessageWidget, StatusBarWidget, ToolCallWidget};
pub use scroll::render_scrollbar;
pub use text::{StyledTextWidget, TextWidget};
