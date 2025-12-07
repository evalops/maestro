//! Command registry
//!
//! Stores all available commands and provides lookup functionality.

use std::collections::HashMap;
use std::sync::Arc;

use super::types::{
    ArgumentValue, Command, CommandAction, CommandArgument, CommandCategory, CommandContext,
    CommandError, CommandOutput, CommandResult, ModalType,
};

/// Registry of all available commands
pub struct CommandRegistry {
    /// Commands indexed by name
    commands: HashMap<String, Arc<Command>>,
    /// Alias to command name mapping
    aliases: HashMap<String, String>,
}

impl CommandRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            commands: HashMap::new(),
            aliases: HashMap::new(),
        }
    }

    /// Register a command
    pub fn register(&mut self, command: Command) {
        let name = command.name.clone();
        let cmd = Arc::new(command);

        // Register aliases
        for alias in &cmd.aliases {
            self.aliases.insert(alias.clone(), name.clone());
        }

        self.commands.insert(name, cmd);
    }

    /// Get a command by name or alias
    pub fn get(&self, name: &str) -> Option<Arc<Command>> {
        // Try direct lookup first
        if let Some(cmd) = self.commands.get(name) {
            return Some(Arc::clone(cmd));
        }

        // Try alias lookup
        if let Some(real_name) = self.aliases.get(name) {
            return self.commands.get(real_name).map(Arc::clone);
        }

        None
    }

    /// Get all commands
    pub fn all(&self) -> Vec<Arc<Command>> {
        self.commands.values().cloned().collect()
    }

    /// Get all command names (including aliases)
    pub fn all_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.commands.keys().map(|s| s.as_str()).collect();
        names.extend(self.aliases.keys().map(|s| s.as_str()));
        names.sort();
        names
    }

    /// Get commands by category
    pub fn by_category(&self, category: CommandCategory) -> Vec<Arc<Command>> {
        self.commands
            .values()
            .filter(|cmd| cmd.category == category)
            .cloned()
            .collect()
    }

    /// Execute a command from input text
    pub fn execute(
        &self,
        input: &str,
        cwd: &str,
        session_id: Option<&str>,
        model: Option<&str>,
    ) -> CommandResult {
        let input = input.trim();

        // Must start with /
        if !input.starts_with('/') {
            return Err(CommandError::new("Commands must start with /"));
        }

        let input_without_slash = &input[1..];

        // Split into command and args
        let mut parts = input_without_slash.splitn(2, char::is_whitespace);
        let command_name = parts.next().unwrap_or("").to_lowercase();
        let raw_args = parts.next().unwrap_or("").trim().to_string();

        // Find the command
        let command = self.get(&command_name).ok_or_else(|| {
            CommandError::new(format!("Unknown command: /{}", command_name))
                .with_hint("Type /help to see available commands")
        })?;

        // Parse arguments
        let args = parse_arguments(&raw_args, &command.arguments)?;

        // Build context
        let ctx = CommandContext {
            input: input.to_string(),
            command_name: command.name.clone(),
            args,
            raw_args,
            cwd: cwd.to_string(),
            session_id: session_id.map(String::from),
            model: model.map(String::from),
        };

        // Execute
        command.execute(&ctx)
    }

    /// Get the number of commands
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse argument string into values
fn parse_arguments(
    raw: &str,
    definitions: &[CommandArgument],
) -> Result<HashMap<String, ArgumentValue>, CommandError> {
    let mut result = HashMap::new();
    let parts: Vec<&str> = raw.split_whitespace().collect();

    // Apply defaults first
    for def in definitions {
        if let Some(ref default) = def.default {
            result.insert(def.name.clone(), default.clone());
        }
    }

    // Simple positional argument parsing
    for (i, def) in definitions.iter().enumerate() {
        if let Some(value) = parts.get(i) {
            let parsed = match &def.arg_type {
                super::types::CommandArgumentType::String => {
                    ArgumentValue::String(value.to_string())
                }
                super::types::CommandArgumentType::Bool => {
                    let b = matches!(value.to_lowercase().as_str(), "true" | "yes" | "on" | "1");
                    ArgumentValue::Bool(b)
                }
                super::types::CommandArgumentType::Int => {
                    let i = value.parse::<i64>().map_err(|_| {
                        CommandError::new(format!("Expected integer for '{}'", def.name))
                    })?;
                    ArgumentValue::Int(i)
                }
                super::types::CommandArgumentType::Choice(choices) => {
                    if !choices.contains(&value.to_string()) {
                        return Err(CommandError::new(format!(
                            "Invalid value '{}' for '{}'. Expected one of: {}",
                            value,
                            def.name,
                            choices.join(", ")
                        )));
                    }
                    ArgumentValue::String(value.to_string())
                }
                super::types::CommandArgumentType::FilePath
                | super::types::CommandArgumentType::SessionId => {
                    ArgumentValue::String(value.to_string())
                }
            };
            result.insert(def.name.clone(), parsed);
        } else if def.required {
            return Err(CommandError::new(format!(
                "Missing required argument: {}",
                def.name
            )));
        }
    }

    Ok(result)
}

/// Build the default command registry with all built-in commands
pub fn build_command_registry() -> CommandRegistry {
    let mut registry = CommandRegistry::new();

    // Help command
    registry.register(
        Command::new(
            "help",
            "Show available commands",
            CommandCategory::Navigation,
            Box::new(|ctx| {
                if ctx.raw_args.is_empty() {
                    Ok(CommandOutput::OpenModal(ModalType::Help))
                } else {
                    Ok(CommandOutput::Message(format!(
                        "Help for command: {}",
                        ctx.raw_args
                    )))
                }
            }),
        )
        .alias("h")
        .alias("?")
        .arg(CommandArgument::string(
            "command",
            "Command to get help for",
        ))
        .usage("/help [command]"),
    );

    // Clear command
    registry.register(
        Command::new(
            "clear",
            "Clear the screen",
            CommandCategory::Ui,
            Box::new(|_| Ok(CommandOutput::Action(CommandAction::ClearMessages))),
        )
        .alias("cls"),
    );

    // Quit command
    registry.register(
        Command::new(
            "quit",
            "Quit the application",
            CommandCategory::Navigation,
            Box::new(|_| Ok(CommandOutput::Action(CommandAction::Quit))),
        )
        .alias("exit")
        .alias("q"),
    );

    // Zen mode command
    registry.register(Command::new(
        "zen",
        "Toggle zen mode (minimal UI)",
        CommandCategory::Ui,
        Box::new(|_| Ok(CommandOutput::Action(CommandAction::ToggleZenMode))),
    ));

    // Refresh command
    registry.register(Command::new(
        "refresh",
        "Refresh workspace files",
        CommandCategory::Navigation,
        Box::new(|_| Ok(CommandOutput::Action(CommandAction::RefreshWorkspace))),
    ));

    // Copy command
    registry.register(Command::new(
        "copy",
        "Copy last message to clipboard",
        CommandCategory::Ui,
        Box::new(|_| Ok(CommandOutput::Action(CommandAction::CopyLastMessage))),
    ));

    // Theme command
    registry.register(
        Command::new(
            "theme",
            "Change color theme",
            CommandCategory::Ui,
            Box::new(|ctx| {
                if ctx.raw_args.is_empty() {
                    Ok(CommandOutput::OpenModal(ModalType::ThemeSelector))
                } else {
                    Ok(CommandOutput::Message(format!(
                        "Setting theme to: {}",
                        ctx.raw_args
                    )))
                }
            }),
        )
        .arg(CommandArgument::string("name", "Theme name"))
        .usage("/theme [name]"),
    );

    // Model command
    registry.register(
        Command::new(
            "model",
            "Change AI model",
            CommandCategory::Config,
            Box::new(|ctx| {
                if ctx.raw_args.is_empty() {
                    Ok(CommandOutput::OpenModal(ModalType::ModelSelector))
                } else {
                    Ok(CommandOutput::Message(format!(
                        "Setting model to: {}",
                        ctx.raw_args
                    )))
                }
            }),
        )
        .alias("m")
        .arg(CommandArgument::string("name", "Model name"))
        .usage("/model [name]"),
    );

    // Session commands
    registry.register(
        Command::new(
            "session",
            "Session information",
            CommandCategory::Session,
            Box::new(|_| Ok(CommandOutput::Message("Current session info".to_string()))),
        )
        .alias("ss")
        .group(vec!["info", "new", "clear", "list", "load", "export"]),
    );

    registry.register(Command::new(
        "sessions",
        "List and manage sessions",
        CommandCategory::Session,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::SessionList))),
    ));

    // Compact command
    registry.register(
        Command::new(
            "compact",
            "Compact conversation history to reduce context size",
            CommandCategory::Context,
            Box::new(|ctx| {
                let instructions = if ctx.raw_args.is_empty() {
                    None
                } else {
                    Some(ctx.raw_args.clone())
                };
                Ok(CommandOutput::Action(CommandAction::CompactConversation(
                    instructions,
                )))
            }),
        )
        .arg(CommandArgument::string(
            "instructions",
            "Custom compaction instructions",
        ))
        .usage("/compact [instructions]"),
    );

    // Approval mode command
    registry.register(
        Command::new(
            "approvals",
            "Set approval mode",
            CommandCategory::Safety,
            Box::new(|ctx| {
                let mode = ctx.raw_args.trim().to_string();
                if mode.is_empty() {
                    // Toggle to next mode
                    Ok(CommandOutput::Action(CommandAction::SetApprovalMode(
                        "next".to_string(),
                    )))
                } else {
                    Ok(CommandOutput::Action(CommandAction::SetApprovalMode(mode)))
                }
            }),
        )
        .arg(CommandArgument::choice(
            "mode",
            "Approval mode",
            vec!["yolo", "selective", "safe"],
        ))
        .usage("/approvals [yolo|selective|safe]"),
    );

    // Thinking level command
    registry.register(
        Command::new(
            "thinking",
            "Set extended thinking level",
            CommandCategory::Config,
            Box::new(|ctx| {
                let level = ctx.raw_args.trim().to_string();
                if level.is_empty() {
                    Ok(CommandOutput::Message(
                        "Usage: /thinking <level>\nLevels: off, minimal, low, medium, high, max"
                            .to_string(),
                    ))
                } else {
                    Ok(CommandOutput::Action(CommandAction::SetThinkingLevel(
                        level,
                    )))
                }
            }),
        )
        .arg(CommandArgument::choice(
            "level",
            "Thinking level",
            vec!["off", "minimal", "low", "medium", "high", "max"],
        ))
        .usage("/thinking <level>"),
    );

    // Status command
    registry.register(Command::new(
        "status",
        "Show current status",
        CommandCategory::Diagnostics,
        Box::new(|ctx| {
            let mut info = String::new();
            info.push_str(&format!("Working directory: {}\n", ctx.cwd));
            if let Some(ref session) = ctx.session_id {
                info.push_str(&format!("Session: {}\n", session));
            }
            if let Some(ref model) = ctx.model {
                info.push_str(&format!("Model: {}\n", model));
            }
            Ok(CommandOutput::Message(info))
        }),
    ));

    // Diagnostics command
    registry.register(
        Command::new(
            "diag",
            "System diagnostics",
            CommandCategory::Diagnostics,
            Box::new(|_| Ok(CommandOutput::Message("Running diagnostics...".to_string()))),
        )
        .group(vec!["status", "about", "context", "stats", "lsp", "mcp"]),
    );

    // Tools command
    registry.register(
        Command::new(
            "tools",
            "Tool management",
            CommandCategory::Tools,
            Box::new(|_| Ok(CommandOutput::Message("Available tools...".to_string()))),
        )
        .group(vec!["list", "mcp", "lsp"]),
    );

    // MCP command
    registry.register(Command::new(
        "mcp",
        "Show MCP server status and configuration",
        CommandCategory::Tools,
        Box::new(|_| Ok(CommandOutput::Action(CommandAction::ShowMcpStatus))),
    ));

    // Version command
    registry.register(
        Command::new(
            "version",
            "Show version information",
            CommandCategory::Diagnostics,
            Box::new(|_| {
                Ok(CommandOutput::Message(format!(
                    "Composer TUI v{}",
                    env!("CARGO_PKG_VERSION")
                )))
            }),
        )
        .alias("v"),
    );

    // Zen mode
    registry.register(Command::new(
        "zen",
        "Toggle zen mode (minimal UI)",
        CommandCategory::Ui,
        Box::new(|_| Ok(CommandOutput::Message("Toggling zen mode".to_string()))),
    ));

    // Footer command
    registry.register(
        Command::new(
            "footer",
            "Change footer style",
            CommandCategory::Ui,
            Box::new(|ctx| {
                let style = ctx.get_string("style").unwrap_or("ensemble");
                Ok(CommandOutput::Message(format!("Footer style: {}", style)))
            }),
        )
        .arg(CommandArgument::choice(
            "style",
            "Footer style",
            vec!["ensemble", "solo", "history", "clear"],
        ))
        .usage("/footer [ensemble|solo|history|clear]"),
    );

    // Memory commands
    registry.register(
        Command::new(
            "memory",
            "Cross-session memory",
            CommandCategory::Context,
            Box::new(|_| Ok(CommandOutput::Message("Memory management...".to_string()))),
        )
        .group(vec!["save", "search", "list", "delete", "stats"]),
    );

    // Plan command
    registry.register(Command::new(
        "plan",
        "View saved plans",
        CommandCategory::Context,
        Box::new(|_| Ok(CommandOutput::Message("Saved plans...".to_string()))),
    ));

    // Thinking command
    registry.register(
        Command::new(
            "thinking",
            "Set thinking level",
            CommandCategory::Config,
            Box::new(|ctx| {
                let level = ctx.get_string("level").unwrap_or("medium");
                Ok(CommandOutput::Message(format!("Thinking level: {}", level)))
            }),
        )
        .arg(CommandArgument::choice(
            "level",
            "Thinking level",
            vec!["off", "low", "medium", "high"],
        ))
        .usage("/thinking [off|low|medium|high]"),
    );

    // Continue command
    registry.register(
        Command::new(
            "continue",
            "Continue previous session",
            CommandCategory::Session,
            Box::new(|_| {
                Ok(CommandOutput::Message(
                    "Continuing previous session...".to_string(),
                ))
            }),
        )
        .alias("c"),
    );

    // Resume command
    registry.register(
        Command::new(
            "resume",
            "Resume a specific session",
            CommandCategory::Session,
            Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::SessionList))),
        )
        .alias("r"),
    );

    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_register_and_get() {
        let mut registry = CommandRegistry::new();
        registry.register(Command::new(
            "test",
            "A test command",
            CommandCategory::Diagnostics,
            Box::new(|_| Ok(CommandOutput::Silent)),
        ));

        assert!(registry.get("test").is_some());
        assert!(registry.get("unknown").is_none());
    }

    #[test]
    fn registry_alias_lookup() {
        let mut registry = CommandRegistry::new();
        registry.register(
            Command::new(
                "help",
                "Help command",
                CommandCategory::Navigation,
                Box::new(|_| Ok(CommandOutput::Silent)),
            )
            .alias("h"),
        );

        assert!(registry.get("help").is_some());
        assert!(registry.get("h").is_some());
        assert_eq!(
            registry.get("h").unwrap().name,
            registry.get("help").unwrap().name
        );
    }

    #[test]
    fn registry_execute() {
        let registry = build_command_registry();
        let result = registry.execute("/version", "/tmp", None, None);
        assert!(result.is_ok());
    }

    #[test]
    fn registry_execute_unknown() {
        let registry = build_command_registry();
        let result = registry.execute("/unknowncommand", "/tmp", None, None);
        assert!(result.is_err());
    }

    #[test]
    fn built_in_commands_exist() {
        let registry = build_command_registry();
        assert!(registry.get("help").is_some());
        assert!(registry.get("theme").is_some());
        assert!(registry.get("model").is_some());
        assert!(registry.get("quit").is_some());
    }
}
