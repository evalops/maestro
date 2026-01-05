//! Command registry and execution engine
//!
//! This module implements the central command storage and dispatch system. The `CommandRegistry`
//! maintains a collection of all available slash commands and provides efficient lookup by name
//! or alias, argument parsing, and command execution.
//!
//! # Key Concepts
//!
//! ## Arc-based Shared Ownership
//!
//! Commands are stored as `Arc<Command>` to enable safe sharing across threads without copying:
//! - Multiple components can hold references to the same command
//! - Commands are immutable after registration (internal mutability via handler closures)
//! - Cheap cloning via reference counting instead of deep copies
//!
//! ## HashMap-based Lookup
//!
//! Two HashMaps provide O(1) lookup performance:
//! - `commands`: Primary name to Command mapping
//! - `aliases`: Alias to primary name mapping (double indirection)
//!
//! ## Command Execution Pipeline
//!
//! When `execute()` is called with input like `/help theme`:
//!
//! 1. **Parse**: Strip `/`, split command name from arguments
//! 2. **Lookup**: Find command by name or alias in registry
//! 3. **Parse Arguments**: Convert raw string into typed arguments based on command definition
//! 4. **Build Context**: Package inputs (cwd, session, model, args) into CommandContext
//! 5. **Execute Handler**: Call the command's handler function with the context
//! 6. **Return Output**: Handler returns CommandOutput enum (Message, Action, Modal, etc.)
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::commands::{CommandRegistry, Command, CommandCategory, CommandOutput};
//!
//! let mut registry = CommandRegistry::new();
//!
//! // Register a simple command
//! registry.register(
//!     Command::new(
//!         "greet",
//!         "Greet the user",
//!         CommandCategory::Ui,
//!         Box::new(|ctx| {
//!             let name = ctx.get_string("name").unwrap_or("stranger");
//!             Ok(CommandOutput::Message(format!("Hello, {}!", name)))
//!         }),
//!     )
//!     .alias("hi")
//!     .arg(CommandArgument::string("name", "Your name")),
//! );
//!
//! // Execute by primary name
//! let result = registry.execute("/greet Alice", "/home", None, None);
//!
//! // Execute by alias
//! let result = registry.execute("/hi Bob", "/home", None, None);
//! ```
//!
//! # Argument Parsing
//!
//! The `parse_arguments()` function converts raw input strings into typed values:
//! - Positional parsing: Arguments are matched to definitions in order
//! - Type validation: Strings, integers, booleans, and choices are validated
//! - Required vs. optional: Missing required arguments return an error
//! - Default values: Applied before positional parsing
//!
//! See `CommandArgument` in `types.rs` for argument definition details.

use std::collections::HashMap;
use std::sync::Arc;

use super::types::{
    ArgumentValue, Command, CommandAction, CommandArgument, CommandCategory, CommandContext,
    CommandError, CommandOutput, CommandResult, ExportAction, HistoryAction, HooksAction,
    ModalType, QueueAction, QueueModeKind, SkillsAction, ToolHistoryAction, UsageAction,
};
use crate::state::QueueMode;

/// Registry of all available commands with efficient lookup and execution
///
/// The `CommandRegistry` is the central storage for slash commands in the TUI. It provides:
/// - Fast name-based and alias-based lookup using HashMaps
/// - Thread-safe command sharing via Arc (atomic reference counting)
/// - Argument parsing and validation
/// - Command execution with runtime context
///
/// # Thread Safety
///
/// While the registry itself requires `&mut self` for registration (expected to happen
/// at initialization), command lookup and execution only require `&self`. Commands are
/// stored as `Arc<Command>`, allowing cheap cloning for concurrent access.
///
/// # Examples
///
/// ```rust,ignore
/// use composer_tui::commands::{CommandRegistry, build_command_registry};
/// use std::sync::Arc;
///
/// // Build the default registry
/// let registry = build_command_registry();
///
/// // Get a command by name
/// let help_cmd = registry.get("help");
///
/// // Get a command by alias
/// let help_by_alias = registry.get("h");  // Same as "help"
///
/// // Execute a command
/// let result = registry.execute("/help theme", "/home/user", None, None);
/// ```
pub struct CommandRegistry {
    /// Commands indexed by primary name for O(1) lookup
    commands: HashMap<String, Arc<Command>>,
    /// Alias to primary command name mapping (double indirection for lookup)
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

    /// Register a command in the registry
    ///
    /// Adds a command to the registry, making it available for lookup and execution.
    /// Also registers all aliases defined in the command.
    ///
    /// # Arc Wrapping
    ///
    /// The command is wrapped in an `Arc` (atomic reference counted pointer) to enable:
    /// - Cheap cloning for concurrent access (only increments a counter)
    /// - Shared ownership across multiple matcher and UI components
    /// - Thread-safe distribution without locks
    ///
    /// # Alias Registration
    ///
    /// All aliases in `command.aliases` are registered in the `aliases` HashMap,
    /// pointing to the primary command name. This allows lookup by either name or alias.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use composer_tui::commands::{CommandRegistry, Command, CommandCategory, CommandOutput};
    ///
    /// let mut registry = CommandRegistry::new();
    ///
    /// registry.register(
    ///     Command::new(
    ///         "help",
    ///         "Show help",
    ///         CommandCategory::Navigation,
    ///         Box::new(|_| Ok(CommandOutput::Silent)),
    ///     )
    ///     .alias("h")
    ///     .alias("?"),
    /// );
    ///
    /// assert!(registry.get("help").is_some());
    /// assert!(registry.get("h").is_some());
    /// assert!(registry.get("?").is_some());
    /// ```
    pub fn register(&mut self, command: Command) {
        let name = command.name.clone();
        let cmd = Arc::new(command);

        // Register aliases pointing to primary name
        for alias in &cmd.aliases {
            self.aliases.insert(alias.clone(), name.clone());
        }

        self.commands.insert(name, cmd);
    }

    /// Get a command by name or alias
    ///
    /// Performs a two-stage lookup:
    /// 1. Direct lookup in the `commands` HashMap
    /// 2. If not found, lookup in the `aliases` HashMap to get the primary name,
    ///    then lookup the primary name in `commands`
    ///
    /// Returns `Arc<Command>` for cheap cloning. The Arc is cloned (incrementing
    /// the reference count) rather than the entire Command structure.
    ///
    /// # Time Complexity
    ///
    /// O(1) average case for both direct and alias lookup (two HashMap lookups max).
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use composer_tui::commands::build_command_registry;
    ///
    /// let registry = build_command_registry();
    ///
    /// // Get by primary name
    /// let help = registry.get("help");
    /// assert!(help.is_some());
    ///
    /// // Get by alias
    /// let help_alias = registry.get("h");
    /// assert!(help_alias.is_some());
    ///
    /// // Both return the same command
    /// assert_eq!(help.unwrap().name, help_alias.unwrap().name);
    /// ```
    pub fn get(&self, name: &str) -> Option<Arc<Command>> {
        // Try direct lookup first (primary name)
        if let Some(cmd) = self.commands.get(name) {
            return Some(Arc::clone(cmd));
        }

        // Try alias lookup (double indirection: alias -> name -> command)
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
    ///
    /// Parses the input string, looks up the command, validates arguments,
    /// builds a context, and executes the command handler.
    ///
    /// # Arguments
    ///
    /// * `input` - The full command string (must start with `/`)
    /// * `cwd` - Current working directory (passed to handler context)
    /// * `session_id` - Optional current session ID (passed to handler context)
    /// * `model` - Optional current AI model (passed to handler context)
    ///
    /// # Execution Pipeline
    ///
    /// 1. **Validation**: Ensure input starts with `/`
    /// 2. **Parsing**: Split input into command name and raw arguments
    /// 3. **Lookup**: Find the command by name or alias
    /// 4. **Argument Parsing**: Convert raw args to typed values using `parse_arguments()`
    /// 5. **Context Building**: Create `CommandContext` with all inputs
    /// 6. **Execution**: Call the command's handler function
    ///
    /// # Returns
    ///
    /// Returns `CommandResult` which is `Result<CommandOutput, CommandError>`:
    /// - `Ok(CommandOutput)`: Handler executed successfully (Message, Action, Modal, etc.)
    /// - `Err(CommandError)`: Parsing failed, unknown command, or handler returned error
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use composer_tui::commands::build_command_registry;
    ///
    /// let registry = build_command_registry();
    ///
    /// // Execute a simple command
    /// let result = registry.execute("/help", "/home/user", None, None);
    /// assert!(result.is_ok());
    ///
    /// // Execute with arguments
    /// let result = registry.execute("/theme dark", "/home/user", None, None);
    ///
    /// // Invalid command returns error
    /// let result = registry.execute("/notacommand", "/home/user", None, None);
    /// assert!(result.is_err());
    /// ```
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

/// Parse argument string into typed values
///
/// Converts a raw argument string (everything after the command name) into a HashMap
/// of typed argument values based on the command's argument definitions.
///
/// # Parsing Strategy
///
/// 1. **Apply Defaults**: Start with default values for all arguments that have them
/// 2. **Positional Parsing**: Match space-separated tokens to argument definitions in order
/// 3. **Type Conversion**: Convert string tokens to the appropriate type (String, Bool, Int, Choice)
/// 4. **Validation**: Ensure required arguments are present and choices are valid
///
/// # Type Conversion Rules
///
/// - **String**: No conversion, stored as-is
/// - **Bool**: "true", "yes", "on", "1" (case-insensitive) -> true; everything else -> false
/// - **Int**: Parsed as i64; returns error if parsing fails
/// - **Choice**: Must match one of the allowed values; returns error if not
/// - **FilePath/SessionId**: Stored as strings (type hints for UI completion)
///
/// # Example
///
/// ```rust,ignore
/// // Command definition
/// let args = vec![
///     CommandArgument::string("name", "Name").required(),
///     CommandArgument::choice("mode", "Mode", vec!["fast", "slow"]),
/// ];
///
/// // Parse "/cmd Alice fast"
/// let parsed = parse_arguments("Alice fast", &args)?;
/// assert_eq!(parsed.get("name"), Some(&ArgumentValue::String("Alice".into())));
/// assert_eq!(parsed.get("mode"), Some(&ArgumentValue::String("fast".into())));
/// ```
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
///
/// Constructs and returns a fully populated `CommandRegistry` containing all
/// standard slash commands for the TUI application.
///
/// # Command Categories
///
/// The registry includes commands across multiple categories:
///
/// - **Navigation**: help, quit, refresh
/// - **UI**: clear, theme, zen, copy, footer
/// - **Session**: session, sessions, continue, resume
/// - **Config**: model, thinking, approvals
/// - **Context**: compact, memory, plan
/// - **Tools**: tools, mcp
/// - **Diagnostics**: status, diag, version
/// - **Safety**: approvals
///
/// # Function Pointers and Closures
///
/// Each command handler is a boxed closure with the signature:
/// ```rust,ignore
/// Box<dyn Fn(&CommandContext) -> CommandResult + Send + Sync>
/// ```
///
/// This allows:
/// - **Fn trait**: Handler can be called multiple times without consuming itself
/// - **Send + Sync**: Handler can be safely shared across threads
/// - **Box**: Dynamic dispatch - handlers can have different implementations
/// - **Closure**: Handlers can capture environment if needed (though most don't)
///
/// # Example
///
/// ```rust,ignore
/// use composer_tui::commands::build_command_registry;
///
/// let registry = build_command_registry();
///
/// // Registry includes all standard commands
/// assert!(registry.get("help").is_some());
/// assert!(registry.get("quit").is_some());
/// assert!(registry.get("theme").is_some());
///
/// // Aliases are also registered
/// assert!(registry.get("h").is_some());  // alias for help
/// assert!(registry.get("q").is_some());  // alias for quit
/// ```
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

    // Queue command
    registry.register(
        Command::new(
            "queue",
            "Manage queued prompts",
            CommandCategory::Ui,
            Box::new(|ctx| {
                let args = ctx.raw_args.trim();
                if args.is_empty() || args.eq_ignore_ascii_case("list") {
                    return Ok(CommandOutput::Action(CommandAction::Queue(
                        QueueAction::Show,
                    )));
                }

                let mut parts = args.split_whitespace();
                let action = parts.next().unwrap_or("");
                if action.eq_ignore_ascii_case("cancel") {
                    let raw_id = parts
                        .next()
                        .ok_or_else(|| CommandError::new("Usage: /queue cancel <id>"))?;
                    let trimmed = raw_id.trim_start_matches('#');
                    let id = trimmed.parse::<u64>().map_err(|_| {
                        CommandError::new("Queue id must be a number (e.g. /queue cancel 12)")
                    })?;
                    return Ok(CommandOutput::Action(CommandAction::Queue(
                        QueueAction::Cancel { id },
                    )));
                }

                if action != "mode" {
                    return Err(CommandError::new(
                        "Usage: /queue [list|cancel <id>|mode [steer|followup] <one|all>]",
                    ));
                }

                let scope = parts.next();
                let value = parts.next();
                let (kind, mode) = match (scope, value) {
                    (None, _) => {
                        return Err(CommandError::new(
                            "Usage: /queue mode [steer|followup] <one|all>",
                        ));
                    }
                    (Some(scope), None) => {
                        if let Some(mode) = QueueMode::parse(scope) {
                            (QueueModeKind::FollowUp, mode)
                        } else {
                            return Err(CommandError::new(
                                "Usage: /queue mode [steer|followup] <one|all>",
                            ));
                        }
                    }
                    (Some(scope), Some(value)) => {
                        let kind = match scope.to_lowercase().as_str() {
                            "steer" | "steering" => QueueModeKind::Steering,
                            "followup" | "follow-up" => QueueModeKind::FollowUp,
                            _ => {
                                return Err(CommandError::new(
                                    "Usage: /queue mode [steer|followup] <one|all>",
                                ));
                            }
                        };
                        let Some(mode) = QueueMode::parse(value) else {
                            return Err(CommandError::new("Mode must be \"one\" or \"all\"."));
                        };
                        (kind, mode)
                    }
                };

                Ok(CommandOutput::Action(CommandAction::Queue(
                    QueueAction::Mode { kind, mode },
                )))
            }),
        )
        .usage("/queue [list|cancel <id>|mode [steer|followup] <one|all>]"),
    );

    // Steer command
    registry.register(
        Command::new(
            "steer",
            "Send a steering message",
            CommandCategory::Ui,
            Box::new(|ctx| {
                let text = ctx.raw_args.trim();
                if text.is_empty() {
                    return Err(CommandError::new("Usage: /steer <message>"));
                }
                Ok(CommandOutput::Action(CommandAction::Steer(
                    text.to_string(),
                )))
            }),
        )
        .usage("/steer <message>"),
    );

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

    // Hooks command
    registry.register(
        Command::new(
            "hooks",
            "Manage the hook system (list, toggle, reload, metrics)",
            CommandCategory::Tools,
            Box::new(|ctx| {
                let subcommand = ctx.raw_args.trim().to_lowercase();
                let action = match subcommand.as_str() {
                    "" | "list" => HooksAction::List,
                    "toggle" => HooksAction::Toggle,
                    "reload" => HooksAction::Reload,
                    "metrics" | "stats" => HooksAction::Metrics,
                    "enable" | "on" => HooksAction::Enable,
                    "disable" | "off" => HooksAction::Disable,
                    other => {
                        return Err(CommandError::new(format!(
                            "Unknown hooks subcommand: {}",
                            other
                        ))
                        .with_hint("Available: list, toggle, reload, metrics, enable, disable"));
                    }
                };
                Ok(CommandOutput::Action(CommandAction::HooksManage(action)))
            }),
        )
        .alias("hook")
        .arg(CommandArgument::choice(
            "action",
            "Hook management action",
            vec!["list", "toggle", "reload", "metrics", "enable", "disable"],
        ))
        .usage("/hooks [list|toggle|reload|metrics|enable|disable]")
        .group(vec![
            "list", "toggle", "reload", "metrics", "enable", "disable",
        ]),
    );

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

    // Cost/usage command
    registry.register(
        Command::new(
            "cost",
            "Show token usage and cost statistics",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let subcommand = ctx.raw_args.trim().to_lowercase();
                let action = match subcommand.as_str() {
                    "" | "summary" => UsageAction::Summary,
                    "detailed" | "detail" | "full" => UsageAction::Detailed,
                    "reset" | "clear" => UsageAction::Reset,
                    other => {
                        return Err(CommandError::new(format!(
                            "Unknown cost subcommand: {}",
                            other
                        ))
                        .with_hint("Available: summary, detailed, reset"));
                    }
                };
                Ok(CommandOutput::Action(CommandAction::ShowUsage(action)))
            }),
        )
        .alias("usage")
        .alias("tokens")
        .arg(CommandArgument::choice(
            "action",
            "What to show",
            vec!["summary", "detailed", "reset"],
        ))
        .usage("/cost [summary|detailed|reset]"),
    );

    // Export command
    registry.register(
        Command::new(
            "export",
            "Export current session to file",
            CommandCategory::Session,
            Box::new(|ctx| {
                let parts: Vec<&str> = ctx.raw_args.split_whitespace().collect();
                let format = parts.first().map(|s| s.to_lowercase());
                let path = parts.get(1).map(|s| s.to_string());

                let action = match format.as_deref() {
                    None | Some("") => ExportAction::ShowOptions,
                    Some("md") | Some("markdown") => ExportAction::Markdown(path),
                    Some("html") => ExportAction::Html(path),
                    Some("json") => ExportAction::Json(path),
                    Some("txt") | Some("text") => ExportAction::PlainText(path),
                    Some(other) => {
                        return Err(
                            CommandError::new(format!("Unknown export format: {}", other))
                                .with_hint("Available: markdown, html, json, text"),
                        );
                    }
                };
                Ok(CommandOutput::Action(CommandAction::ExportSession(action)))
            }),
        )
        .arg(CommandArgument::choice(
            "format",
            "Export format",
            vec!["markdown", "html", "json", "text"],
        ))
        .arg(CommandArgument::string("path", "Output file path"))
        .usage("/export [format] [path]"),
    );

    // History command
    registry.register(
        Command::new(
            "history",
            "Show or search prompt history",
            CommandCategory::Session,
            Box::new(|ctx| {
                let args = ctx.raw_args.trim();

                let action = if args.is_empty() {
                    HistoryAction::Recent(20)
                } else if args == "clear" {
                    HistoryAction::Clear
                } else if let Ok(n) = args.parse::<usize>() {
                    HistoryAction::Recent(n)
                } else {
                    HistoryAction::Search(args.to_string())
                };

                Ok(CommandOutput::Action(CommandAction::ShowHistory(action)))
            }),
        )
        .alias("hist")
        .arg(CommandArgument::string(
            "query",
            "Number of entries or search query",
        ))
        .usage("/history [count|search query|clear]"),
    );

    // Tool history command
    registry.register(
        Command::new(
            "toolhistory",
            "Show tool execution history and statistics",
            CommandCategory::Tools,
            Box::new(|ctx| {
                let args = ctx.raw_args.trim().to_lowercase();
                let parts: Vec<&str> = args.split_whitespace().collect();

                let action = match parts.first().copied() {
                    None | Some("") => ToolHistoryAction::Recent(10),
                    Some("stats") | Some("statistics") => ToolHistoryAction::Stats,
                    Some("clear") => ToolHistoryAction::Clear,
                    Some("tool") => {
                        let tool_name = parts.get(1).unwrap_or(&"").to_string();
                        if tool_name.is_empty() {
                            return Err(CommandError::new("Tool name required")
                                .with_hint("Usage: /toolhistory tool <name>"));
                        }
                        ToolHistoryAction::ForTool(tool_name)
                    }
                    Some(other) => {
                        if let Ok(n) = other.parse::<usize>() {
                            ToolHistoryAction::Recent(n)
                        } else {
                            // Assume it's a tool name
                            ToolHistoryAction::ForTool(other.to_string())
                        }
                    }
                };

                Ok(CommandOutput::Action(CommandAction::ShowToolHistory(
                    action,
                )))
            }),
        )
        .alias("th")
        .arg(CommandArgument::string("action", "Action or tool name"))
        .usage("/toolhistory [count|stats|clear|tool <name>]"),
    );

    // Skills command
    registry.register(
        Command::new(
            "skills",
            "Manage skills (specialized behaviors from SKILL.md files)",
            CommandCategory::Tools,
            Box::new(|ctx| {
                let args = ctx.raw_args.trim().to_lowercase();
                let parts: Vec<&str> = args.split_whitespace().collect();

                let action = match parts.first().copied() {
                    None | Some("") | Some("list") => SkillsAction::List,
                    Some("reload") | Some("refresh") => SkillsAction::Reload,
                    Some("activate") | Some("enable") | Some("on") => {
                        let name = parts.get(1).unwrap_or(&"").to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills activate <skill-name>"));
                        }
                        SkillsAction::Activate(name)
                    }
                    Some("deactivate") | Some("disable") | Some("off") => {
                        let name = parts.get(1).unwrap_or(&"").to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills deactivate <skill-name>"));
                        }
                        SkillsAction::Deactivate(name)
                    }
                    Some("info") | Some("show") => {
                        let name = parts.get(1).unwrap_or(&"").to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills info <skill-name>"));
                        }
                        SkillsAction::Info(name)
                    }
                    Some(other) => {
                        // Treat unknown as skill name for info
                        SkillsAction::Info(other.to_string())
                    }
                };

                Ok(CommandOutput::Action(CommandAction::Skills(action)))
            }),
        )
        .alias("skill")
        .arg(CommandArgument::string(
            "action",
            "list|activate|deactivate|reload|info",
        ))
        .arg(CommandArgument::string("name", "Skill name"))
        .usage("/skills [list|activate|deactivate|reload|info] [skill-name]"),
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

    #[test]
    fn cost_command_exists() {
        let registry = build_command_registry();
        assert!(registry.get("cost").is_some());
        assert!(registry.get("usage").is_some()); // alias
        assert!(registry.get("tokens").is_some()); // alias
    }

    #[test]
    fn cost_command_actions() {
        let registry = build_command_registry();

        // Summary (default)
        let result = registry.execute("/cost", "/tmp", None, None);
        assert!(result.is_ok());

        // Detailed
        let result = registry.execute("/cost detailed", "/tmp", None, None);
        assert!(result.is_ok());

        // Reset
        let result = registry.execute("/cost reset", "/tmp", None, None);
        assert!(result.is_ok());

        // Invalid
        let result = registry.execute("/cost invalid", "/tmp", None, None);
        assert!(result.is_err());
    }

    #[test]
    fn export_command_exists() {
        let registry = build_command_registry();
        assert!(registry.get("export").is_some());
    }

    #[test]
    fn export_command_formats() {
        let registry = build_command_registry();

        // No args (show options)
        let result = registry.execute("/export", "/tmp", None, None);
        assert!(result.is_ok());

        // Markdown
        let result = registry.execute("/export markdown", "/tmp", None, None);
        assert!(result.is_ok());

        // HTML with path
        let result = registry.execute("/export html output.html", "/tmp", None, None);
        assert!(result.is_ok());

        // Invalid format
        let result = registry.execute("/export invalid", "/tmp", None, None);
        assert!(result.is_err());
    }

    #[test]
    fn history_command_exists() {
        let registry = build_command_registry();
        assert!(registry.get("history").is_some());
        assert!(registry.get("hist").is_some()); // alias
    }

    #[test]
    fn history_command_actions() {
        let registry = build_command_registry();

        // Default (recent 20)
        let result = registry.execute("/history", "/tmp", None, None);
        assert!(result.is_ok());

        // With count
        let result = registry.execute("/history 10", "/tmp", None, None);
        assert!(result.is_ok());

        // Search
        let result = registry.execute("/history git status", "/tmp", None, None);
        assert!(result.is_ok());

        // Clear
        let result = registry.execute("/history clear", "/tmp", None, None);
        assert!(result.is_ok());
    }

    #[test]
    fn toolhistory_command_exists() {
        let registry = build_command_registry();
        assert!(registry.get("toolhistory").is_some());
        assert!(registry.get("th").is_some()); // alias
    }

    #[test]
    fn toolhistory_command_actions() {
        let registry = build_command_registry();

        // Default
        let result = registry.execute("/toolhistory", "/tmp", None, None);
        assert!(result.is_ok());

        // Stats
        let result = registry.execute("/toolhistory stats", "/tmp", None, None);
        assert!(result.is_ok());

        // For specific tool
        let result = registry.execute("/toolhistory read", "/tmp", None, None);
        assert!(result.is_ok());

        // Clear
        let result = registry.execute("/toolhistory clear", "/tmp", None, None);
        assert!(result.is_ok());
    }
}
