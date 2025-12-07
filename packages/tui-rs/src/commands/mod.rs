//! Slash command system
//!
//! Provides a flexible command system with fuzzy matching, tab completion,
//! and organized command categories.

mod matcher;
mod registry;
mod types;

pub use matcher::{CommandMatch, SlashCommandMatcher, SlashCycleState};
pub use registry::{build_command_registry, CommandRegistry};
pub use types::{
    Command, CommandArgument, CommandArgumentType, CommandCategory, CommandContext, CommandHandler,
    CommandResult,
};
