//! TUI Components
//!
//! Ratatui widgets that render our component tree.

mod approval;
mod command_palette;
mod file_search;
mod input;
mod layout;
mod message;
mod scroll;
mod session_switcher;
mod text;
mod textarea;

pub use approval::{ApprovalController, ApprovalDecision, ApprovalModal, ApprovalRequest};
pub use command_palette::CommandPalette;
pub use file_search::FileSearchModal;
pub use input::{EditorWidget, InputWidget};
pub use layout::{column_layout, row_layout, BoxWidget};
pub use message::{ChatInputWidget, ChatView, MessageWidget, StatusBarWidget, ToolCallWidget};
pub use scroll::render_scrollbar;
pub use session_switcher::SessionSwitcher;
pub use text::{StyledTextWidget, TextWidget};
