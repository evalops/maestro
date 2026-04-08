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
//! Two `HashMaps` provide O(1) lookup performance:
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
//! 4. **Build Context**: Package inputs (cwd, session, model, args) into `CommandContext`
//! 5. **Execute Handler**: Call the command's handler function with the context
//! 6. **Return Output**: Handler returns `CommandOutput` enum (Message, Action, Modal, etc.)
//!
//! # Example
//!
//! ```rust,ignore
//! use maestro_tui::commands::{CommandRegistry, Command, CommandCategory, CommandOutput};
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
use std::path::Path;
use std::sync::Arc;

use super::types::{
    ArgumentValue, Command, CommandAction, CommandArgument, CommandCategory, CommandContext,
    CommandError, CommandOutput, CommandResult, ExportAction, HistoryAction, HooksAction,
    McpAction, ModalType, QueueAction, QueueModeKind, SessionAction, SkillsAction,
    ToolHistoryAction, UsageAction,
};
use crate::git;
use crate::keybindings::{
    format_keybindings_config_report, initialize_keybindings_file, keybindings_config_path,
};
use crate::lsp::max_diagnostics_per_file;
use crate::state::QueueMode;
use crate::tool_output::tool_output_limits;

/// Registry of all available commands with efficient lookup and execution
///
/// The `CommandRegistry` is the central storage for slash commands in the TUI. It provides:
/// - Fast name-based and alias-based lookup using `HashMaps`
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
/// use maestro_tui::commands::{CommandRegistry, build_command_registry};
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
    #[must_use]
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
    /// All aliases in `command.aliases` are registered in the `aliases` `HashMap`,
    /// pointing to the primary command name. This allows lookup by either name or alias.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use maestro_tui::commands::{CommandRegistry, Command, CommandCategory, CommandOutput};
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
    /// 1. Direct lookup in the `commands` `HashMap`
    /// 2. If not found, lookup in the `aliases` `HashMap` to get the primary name,
    ///    then lookup the primary name in `commands`
    ///
    /// Returns `Arc<Command>` for cheap cloning. The Arc is cloned (incrementing
    /// the reference count) rather than the entire Command structure.
    ///
    /// # Time Complexity
    ///
    /// O(1) average case for both direct and alias lookup (two `HashMap` lookups max).
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use maestro_tui::commands::build_command_registry;
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
    #[must_use]
    pub fn all(&self) -> Vec<Arc<Command>> {
        self.commands.values().cloned().collect()
    }

    /// Get all command names (including aliases)
    #[must_use]
    pub fn all_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self
            .commands
            .keys()
            .map(std::string::String::as_str)
            .collect();
        names.extend(self.aliases.keys().map(std::string::String::as_str));
        names.sort_unstable();
        names
    }

    /// Get commands by category
    #[must_use]
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
    /// use maestro_tui::commands::build_command_registry;
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
            CommandError::new(format!("Unknown command: /{command_name}"))
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
    #[must_use]
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Check if empty
    #[must_use]
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
/// Converts a raw argument string (everything after the command name) into a `HashMap`
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
                    ArgumentValue::String((*value).to_string())
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
                    if !choices.contains(&(*value).to_string()) {
                        return Err(CommandError::new(format!(
                            "Invalid value '{}' for '{}'. Expected one of: {}",
                            value,
                            def.name,
                            choices.join(", ")
                        )));
                    }
                    ArgumentValue::String((*value).to_string())
                }
                super::types::CommandArgumentType::FilePath
                | super::types::CommandArgumentType::SessionId => {
                    ArgumentValue::String((*value).to_string())
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

fn tokenize_command_args(raw: &str) -> Vec<String> {
    shlex::split(raw).unwrap_or_else(|| raw.split_whitespace().map(str::to_string).collect())
}

fn parse_mcp_prompts_action(raw: &str) -> Result<McpAction, CommandError> {
    let tokens = tokenize_command_args(raw);
    let server = tokens.get(1).cloned();
    let name = tokens.get(2).cloned();

    let mut arguments = HashMap::new();
    if server.is_none() || name.is_none() {
        return Ok(McpAction::Prompts {
            server,
            name,
            arguments,
        });
    }

    for token in tokens.iter().skip(3) {
        let Some((key, value)) = token.split_once('=') else {
            return Err(CommandError::new(
                "Invalid MCP prompt argument. Use KEY=value after the prompt name.",
            ));
        };
        if key.trim().is_empty() {
            return Err(CommandError::new(
                "Invalid MCP prompt argument. Use KEY=value after the prompt name.",
            ));
        }
        arguments.insert(key.trim().to_string(), value.to_string());
    }

    Ok(McpAction::Prompts {
        server,
        name,
        arguments,
    })
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
/// use maestro_tui::commands::build_command_registry;
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
#[must_use]
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

    // Hotkeys command
    registry.register(
        Command::new(
            "hotkeys",
            "Show or manage keyboard shortcuts",
            CommandCategory::Config,
            Box::new(|ctx| {
                let args = ctx.raw_args.trim();
                let parts: Vec<&str> = args.split_whitespace().collect();
                let subcommand = parts
                    .first()
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_else(String::new);

                match subcommand.as_str() {
                    "" | "show" | "list" | "help" => {
                        Ok(CommandOutput::OpenModal(ModalType::ShortcutsHelp))
                    }
                    "path" | "where" | "file" => {
                        let path = keybindings_config_path();
                        Ok(CommandOutput::Message(format!(
                            "Keyboard shortcuts config:\n  Path: {}\n  Status: {}",
                            path.display(),
                            if path.exists() { "present" } else { "missing" }
                        )))
                    }
                    "init" | "create" | "setup" => {
                        let force = parts.iter().skip(1).any(|arg| *arg == "--force");
                        match initialize_keybindings_file(force) {
                            Ok(result) if result.created => Ok(CommandOutput::Message(format!(
                                "Created keyboard shortcuts config at {}\nRun /hotkeys validate to verify the file after editing.",
                                result.path.display()
                            ))),
                            Ok(result) => Err(
                                CommandError::new(format!(
                                    "Keybindings config already exists at {}.",
                                    result.path.display()
                                ))
                                .with_hint(
                                    "Re-run with /hotkeys init --force to overwrite it.",
                                ),
                            ),
                            Err(err) => Err(CommandError::new(format!(
                                "Failed to create keybindings config: {err}"
                            ))),
                        }
                    }
                    "validate" | "check" | "doctor" | "status" => {
                        Ok(CommandOutput::Message(format_keybindings_config_report()))
                    }
                    _ => Err(
                        CommandError::new(format!(
                            "Unknown hotkeys subcommand: {}",
                            subcommand
                        ))
                        .with_hint("Usage: /hotkeys [show|path|init|validate]"),
                    ),
                }
            }),
        )
        .alias("keys")
        .alias("shortcuts")
        .usage("/hotkeys [show|path|init|validate]"),
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

    // Tool output compact mode
    registry.register(
        Command::new(
            "compact-tools",
            "Toggle tool output folding",
            CommandCategory::Ui,
            Box::new(|ctx| {
                let arg = ctx.raw_args.trim().to_lowercase();
                let mode = if arg.is_empty() || arg == "toggle" {
                    None
                } else if arg == "on" || arg == "true" {
                    Some(true)
                } else if arg == "off" || arg == "false" {
                    Some(false)
                } else {
                    return Err(CommandError::new("Usage: /compact-tools [on|off|toggle]"));
                };
                Ok(CommandOutput::Action(CommandAction::SetCompactTools(mode)))
            }),
        )
        .usage("/compact-tools [on|off|toggle]"),
    );

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
                    Ok(CommandOutput::Action(CommandAction::SetTheme(
                        ctx.raw_args.clone(),
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
                    Ok(CommandOutput::Action(CommandAction::SetModel(
                        ctx.raw_args.clone(),
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
            Box::new(|ctx| {
                let sub = ctx
                    .raw_args
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
                match sub.as_str() {
                    "cleanup" | "prune" => Ok(CommandOutput::Action(CommandAction::Session(
                        SessionAction::Cleanup,
                    ))),
                    _ => Ok(CommandOutput::Message("Current session info".to_string())),
                }
            }),
        )
        .alias("ss")
        .usage("/session [info|new|clear|list|load|export|cleanup]")
        .group(vec![
            "info", "new", "clear", "list", "load", "export", "cleanup",
        ]),
    );

    registry.register(Command::new(
        "sessions",
        "List and manage sessions",
        CommandCategory::Session,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::SessionList))),
    ));

    registry.register(Command::new(
        "files",
        "Search workspace files",
        CommandCategory::Navigation,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::FileSearch))),
    ));

    registry.register(Command::new(
        "commands",
        "Open command palette",
        CommandCategory::Navigation,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::CommandPalette))),
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

    // About command
    registry.register(
        Command::new(
            "about",
            "Show build and environment info",
            CommandCategory::Diagnostics,
            Box::new(|ctx| Ok(CommandOutput::Message(build_diag_about(ctx)))),
        )
        .usage("/about"),
    );

    // Context command
    registry.register(
        Command::new(
            "context",
            "Show context summary",
            CommandCategory::Context,
            Box::new(|ctx| Ok(CommandOutput::Message(build_diag_context(ctx)))),
        )
        .usage("/context"),
    );

    // Limits command
    registry.register(
        Command::new(
            "limits",
            "Show configurable runtime limits",
            CommandCategory::Config,
            Box::new(|ctx| {
                let subcommand = ctx
                    .raw_args
                    .split_whitespace()
                    .next()
                    .unwrap_or("all")
                    .to_lowercase();
                if matches!(subcommand.as_str(), "help" | "?" | "-h" | "--help") {
                    return Ok(CommandOutput::Message(
                        "Usage: /limits [all|tool|lsp|help]".to_string(),
                    ));
                }

                let tool_limits = tool_output_limits();
                let lsp_limit = max_diagnostics_per_file();

                let mut sections: Vec<(&str, Vec<String>)> = Vec::new();
                sections.push((
                    "Tool output (TUI):",
                    vec![
                        format!(
                            "  TUI_TOOL_MAX_CHARS: {} (env: MAESTRO_TUI_TOOL_MAX_CHARS)",
                            tool_limits.max_chars
                        ),
                        format!(
                            "  TUI_TOOL_MAX_LINES: {} (env: MAESTRO_TUI_TOOL_MAX_LINES)",
                            tool_limits.max_lines
                        ),
                    ],
                ));
                sections.push((
                    "LSP diagnostics:",
                    vec![format!(
                        "  MAX_DIAGNOSTICS_PER_FILE: {} (env: MAESTRO_LSP_MAX_DIAGNOSTICS)",
                        lsp_limit
                    )],
                ));

                let selected: Vec<(&str, Vec<String>)> = match subcommand.as_str() {
                    "all" | "" => sections.clone(),
                    "tool" | "tui" => sections
                        .first()
                        .map(|(title, lines)| (*title, lines.clone()))
                        .into_iter()
                        .collect(),
                    "lsp" => sections
                        .get(1)
                        .map(|(title, lines)| (*title, lines.clone()))
                        .into_iter()
                        .collect(),
                    _ => {
                        return Err(CommandError::new("Usage: /limits [all|tool|lsp|help]"));
                    }
                };

                let mut lines = vec!["Limits (restart after changing env vars):".to_string()];
                for (title, entries) in selected {
                    lines.push(String::new());
                    lines.push(title.to_string());
                    lines.extend(entries);
                }

                Ok(CommandOutput::Message(lines.join("\n")))
            }),
        )
        .usage("/limits [all|tool|lsp|help]"),
    );

    // Git diff command
    registry.register(
        Command::new(
            "diff",
            "Show git diff for working tree or a path",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let path = ctx.raw_args.trim();
                Ok(CommandOutput::Message(build_git_diff_message(
                    &ctx.cwd,
                    if path.is_empty() { None } else { Some(path) },
                )))
            }),
        )
        .arg(CommandArgument::string("path", "Optional path to diff"))
        .usage("/diff [path]"),
    );

    // Git review command
    registry.register(
        Command::new(
            "review",
            "Summarize git status and diff stats",
            CommandCategory::Diagnostics,
            Box::new(|ctx| Ok(CommandOutput::Message(build_git_review_message(&ctx.cwd)))),
        )
        .usage("/review"),
    );

    // Git command (grouped)
    registry.register(
        Command::new(
            "git",
            "Git operations: status, diff, review",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let mut parts = ctx.raw_args.split_whitespace();
                let sub = parts.next().unwrap_or("").to_lowercase();
                let rest_joined = parts.collect::<Vec<_>>().join(" ");
                let rest = if rest_joined.trim().is_empty() {
                    None
                } else {
                    Some(rest_joined.trim())
                };

                let message = match sub.as_str() {
                    "" | "status" | "st" => build_git_status_message(&ctx.cwd),
                    "diff" | "d" => build_git_diff_message(&ctx.cwd, rest),
                    "review" | "summary" => build_git_review_message(&ctx.cwd),
                    "help" | "?" | "-h" | "--help" => git_help_message(),
                    _ => {
                        let mut msg = String::new();
                        msg.push_str("Unknown git subcommand.\n\n");
                        msg.push_str(&git_help_message());
                        msg
                    }
                };

                Ok(CommandOutput::Message(message))
            }),
        )
        .usage("/git [status|diff <path>|review]"),
    );

    // Status command
    registry.register(
        Command::new(
            "status",
            "Show system health overview",
            CommandCategory::Diagnostics,
            Box::new(|_| Ok(CommandOutput::Action(CommandAction::ShowDiagnostics))),
        )
        .alias("health"),
    );

    // Stats command
    registry.register(Command::new(
        "stats",
        "Show combined status and usage summary",
        CommandCategory::Diagnostics,
        Box::new(|_| {
            Ok(CommandOutput::Multi(vec![
                CommandOutput::Action(CommandAction::ShowDiagnostics),
                CommandOutput::Action(CommandAction::ShowUsage(UsageAction::Summary)),
            ]))
        }),
    ));

    // Diagnostics command
    registry.register(
        Command::new(
            "diag",
            "System diagnostics",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let subcommand = ctx
                    .raw_args
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
                match subcommand.as_str() {
                    "" | "status" | "health" => {
                        Ok(CommandOutput::Action(CommandAction::ShowDiagnostics))
                    }
                    "stats" | "overview" => Ok(CommandOutput::Multi(vec![
                        CommandOutput::Action(CommandAction::ShowDiagnostics),
                        CommandOutput::Action(CommandAction::ShowUsage(UsageAction::Summary)),
                    ])),
                    "mcp" => Ok(CommandOutput::Action(CommandAction::Mcp(McpAction::Status))),
                    "help" | "?" | "-h" | "--help" => Ok(CommandOutput::Message(
                        "Usage: /diag [status|stats|about|context|mcp|help]".to_string(),
                    )),
                    "about" => Ok(CommandOutput::Message(build_diag_about(ctx))),
                    "context" => Ok(CommandOutput::Message(build_diag_context(ctx))),
                    "lsp" => Ok(CommandOutput::Message(
                        "LSP diagnostics are not supported in the Rust TUI yet.".to_string(),
                    )),
                    _ => Ok(CommandOutput::Action(CommandAction::ShowDiagnostics)),
                }
            }),
        )
        .group(vec!["status", "stats", "about", "context", "mcp"]),
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
        Box::new(|ctx| {
            let raw = ctx.raw_args.trim();
            let tokens = tokenize_command_args(raw);
            let subcommand = tokens
                .first()
                .map(|token| token.to_lowercase())
                .unwrap_or_default();

            let action = match subcommand.as_str() {
                "" => McpAction::Status,
                "resources" => {
                    let server = tokens.get(1).cloned();
                    let uri = if server.is_some() {
                        let rest = tokens.iter().skip(2).cloned().collect::<Vec<_>>().join(" ");
                        if rest.is_empty() {
                            None
                        } else {
                            Some(rest)
                        }
                    } else {
                        None
                    };
                    McpAction::Resources { server, uri }
                }
                "prompts" => parse_mcp_prompts_action(raw)?,
                other => {
                    return Err(
                        CommandError::new(format!("Unknown mcp subcommand: {other}"))
                            .with_hint("Available: resources, prompts"),
                    );
                }
            };

            Ok(CommandOutput::Action(CommandAction::Mcp(action)))
        }),
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
                            "Unknown hooks subcommand: {other}"
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
                    "Maestro TUI v{}",
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
                Ok(CommandOutput::Message(format!("Footer style: {style}")))
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
                        return Err(
                            CommandError::new(format!("Unknown cost subcommand: {other}"))
                                .with_hint("Available: summary, detailed, reset"),
                        );
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
                let path = parts.get(1).map(|s| (*s).to_string());

                let action = match format.as_deref() {
                    None | Some("") => ExportAction::ShowOptions,
                    Some("md" | "markdown") => ExportAction::Markdown(path),
                    Some("html") => ExportAction::Html(path),
                    Some("json") => ExportAction::Json(path),
                    Some("txt" | "text") => ExportAction::PlainText(path),
                    Some(other) => {
                        return Err(CommandError::new(format!("Unknown export format: {other}"))
                            .with_hint("Available: markdown, html, json, text"));
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
                let args_lower = args.to_lowercase();

                let action = if args.is_empty() {
                    HistoryAction::Recent(20)
                } else if args_lower == "clear" {
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
                let raw_args = ctx.raw_args.trim();
                let raw_parts: Vec<&str> = raw_args.split_whitespace().collect();
                let raw_sub = raw_parts.first().copied().unwrap_or("");
                let sub = raw_sub.to_lowercase();
                let rest = raw_parts
                    .iter()
                    .skip(1)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" ");
                let rest_trimmed = rest.trim();

                let action = match sub.as_str() {
                    "" => ToolHistoryAction::Recent(10),
                    "stats" | "statistics" => ToolHistoryAction::Stats,
                    "clear" => ToolHistoryAction::Clear,
                    "tool" => {
                        let tool_name = rest_trimmed.to_string();
                        if tool_name.is_empty() {
                            return Err(CommandError::new("Tool name required")
                                .with_hint("Usage: /toolhistory tool <name>"));
                        }
                        ToolHistoryAction::ForTool(tool_name)
                    }
                    _ => {
                        if let Ok(n) = raw_sub.parse::<usize>() {
                            ToolHistoryAction::Recent(n)
                        } else {
                            // Assume it's a tool name
                            ToolHistoryAction::ForTool(raw_sub.to_string())
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
                let raw_args = ctx.raw_args.trim();
                let raw_parts: Vec<&str> = raw_args.split_whitespace().collect();
                let raw_sub = raw_parts.first().copied().unwrap_or("");
                let sub = raw_sub.to_lowercase();
                let rest = raw_parts
                    .iter()
                    .skip(1)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" ");
                let rest_trimmed = rest.trim();

                let action = match sub.as_str() {
                    "" | "list" => SkillsAction::List,
                    "reload" | "refresh" => SkillsAction::Reload,
                    "activate" | "enable" | "on" => {
                        let name = rest_trimmed.to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills activate <skill-name>"));
                        }
                        SkillsAction::Activate(name)
                    }
                    "deactivate" | "disable" | "off" => {
                        let name = rest_trimmed.to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills deactivate <skill-name>"));
                        }
                        SkillsAction::Deactivate(name)
                    }
                    "info" | "show" => {
                        let name = rest_trimmed.to_string();
                        if name.is_empty() {
                            return Err(CommandError::new("Skill name required")
                                .with_hint("Usage: /skills info <skill-name>"));
                        }
                        SkillsAction::Info(name)
                    }
                    _ => {
                        // Treat unknown as skill name for info
                        if raw_args.is_empty() {
                            SkillsAction::List
                        } else {
                            SkillsAction::Info(raw_sub.to_string())
                        }
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

fn build_diag_about(ctx: &CommandContext) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let cwd = ctx.cwd.clone();
    let branch =
        git::current_branch(Path::new(&ctx.cwd)).unwrap_or_else(|| "(not a repo)".to_string());
    let session = ctx
        .session_id
        .clone()
        .unwrap_or_else(|| "(ephemeral)".to_string());
    let model = ctx.model.clone().unwrap_or_else(|| "(unknown)".to_string());

    let mut lines = Vec::new();
    lines.push("## About".to_string());
    lines.push(String::new());
    lines.push(format!("**Version:** {version}"));
    lines.push(format!("**OS:** {os}/{arch}"));
    lines.push(format!("**CWD:** {cwd}"));
    lines.push(format!("**Session:** {session}"));
    lines.push(format!("**Model:** {model}"));
    lines.push(format!("**Git:** {branch}"));
    lines.join("\n")
}

fn build_diag_context(ctx: &CommandContext) -> String {
    let session = ctx
        .session_id
        .clone()
        .unwrap_or_else(|| "(ephemeral)".to_string());
    let model = ctx.model.clone().unwrap_or_else(|| "(unknown)".to_string());

    let mut lines = Vec::new();
    lines.push("## Context".to_string());
    lines.push(String::new());
    lines.push(format!("**Model:** {model}"));
    lines.push(format!("**Session:** {session}"));
    lines.push(format!("**CWD:** {}", ctx.cwd));
    lines.push(String::new());
    lines.push("Token usage details are not available in the Rust TUI yet.".to_string());
    lines.join("\n")
}

fn git_help_message() -> String {
    let mut msg = String::new();
    msg.push_str("Git Commands:\n");
    msg.push_str("  /git                 Show git status summary\n");
    msg.push_str("  /git status          Show git status\n");
    msg.push_str("  /git diff [path]     Show diff for file\n");
    msg.push_str("  /git review          Summarize status and diff stats\n\n");
    msg.push_str("Direct shortcuts still work: /diff, /review");
    msg
}

fn build_git_status_message(cwd: &str) -> String {
    let cwd_path = Path::new(cwd);
    if !git::is_git_repo(cwd_path) {
        return "Not a git repository.".to_string();
    }
    match git::status_short(cwd_path) {
        Ok(status) => {
            if status.is_empty() {
                return "Working tree clean.".to_string();
            }
            if is_clean_status(&status) {
                if let Some(branch_line) = status.lines().next() {
                    return format!(
                        "## Git Status\n\n```\n{branch_line}\n```\n\nWorking tree clean.",
                    );
                }
                return "Working tree clean.".to_string();
            }
            format!("## Git Status\n\n```\n{status}\n```")
        }
        Err(err) => format!("Git status failed: {err}"),
    }
}

fn build_git_review_message(cwd: &str) -> String {
    let cwd_path = Path::new(cwd);
    if !git::is_git_repo(cwd_path) {
        return "Not a git repository.".to_string();
    }

    let status =
        git::status_short(cwd_path).unwrap_or_else(|err| format!("git status failed: {err}"));
    let staged = git::diff_stat(cwd_path, true)
        .unwrap_or_else(|err| format!("git diff --cached --stat failed: {err}"));
    let worktree = git::diff_stat(cwd_path, false)
        .unwrap_or_else(|err| format!("git diff --stat failed: {err}"));

    let status_display = if status.is_empty() {
        "Working tree clean.".to_string()
    } else if is_clean_status(&status) {
        let mut display = String::new();
        if let Some(branch_line) = status.lines().next() {
            display.push_str(branch_line);
            display.push('\n');
        }
        display.push_str("Working tree clean.");
        display
    } else {
        status.clone()
    };

    let mut msg = String::from("## Git Review\n\n");
    msg.push_str("**Status:**\n```\n");
    msg.push_str(&status_display);
    msg.push_str("\n```\n\n");

    msg.push_str("**Staged diff stats:**\n");
    if staged.is_empty() {
        msg.push_str("No staged changes.\n\n");
    } else {
        msg.push_str("```\n");
        msg.push_str(&staged);
        msg.push_str("\n```\n\n");
    }

    msg.push_str("**Worktree diff stats:**\n");
    if worktree.is_empty() {
        msg.push_str("No unstaged changes.");
    } else {
        msg.push_str("```\n");
        msg.push_str(&worktree);
        msg.push_str("\n```");
    }

    msg
}

fn is_clean_status(status: &str) -> bool {
    let mut lines = status.lines();
    let _ = lines.next();
    lines.all(|line| line.trim().is_empty())
}

fn build_git_diff_message(cwd: &str, path: Option<&str>) -> String {
    let cwd_path = Path::new(cwd);
    if !git::is_git_repo(cwd_path) {
        return "Not a git repository.".to_string();
    }

    match git::diff(cwd_path, path) {
        Ok(diff) => {
            if diff.is_empty() {
                return "No unstaged changes.".to_string();
            }
            let (truncated, was_truncated) = truncate_text(&diff, 200, 20_000);
            let mut msg = String::from("## Git Diff\n\n```diff\n");
            msg.push_str(&truncated);
            msg.push_str("\n```");
            if was_truncated {
                msg.push_str("\n\n(Truncated. Run git diff in your shell for full output.)");
            }
            msg
        }
        Err(err) => format!("Git diff failed: {err}"),
    }
}

fn truncate_text(text: &str, max_lines: usize, max_chars: usize) -> (String, bool) {
    if text.is_empty() {
        return (String::new(), false);
    }

    let mut out = String::new();
    let mut total_chars = 0usize;
    let mut lines_used = 0usize;
    let mut truncated = false;

    for line in text.lines() {
        if lines_used >= max_lines {
            truncated = true;
            break;
        }

        if !out.is_empty() {
            out.push('\n');
            total_chars += 1;
        }

        let line_len = line.chars().count();
        if total_chars + line_len > max_chars {
            let remaining = max_chars.saturating_sub(total_chars);
            if remaining > 0 {
                out.push_str(&line.chars().take(remaining).collect::<String>());
            }
            truncated = true;
            break;
        }

        out.push_str(line);
        total_chars += line_len;
        lines_used += 1;
    }

    if !truncated {
        let total_lines = text.lines().count();
        let total_chars_all = text.chars().count();
        if total_lines > lines_used || total_chars_all > total_chars {
            truncated = true;
        }
    }

    (out, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    use tempfile::tempdir;

    fn keybindings_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_temp_keybindings_file<T>(body: impl FnOnce(&Path) -> T) -> T {
        let _guard = keybindings_env_lock()
            .lock()
            .expect("keybindings env lock poisoned");
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("keybindings.json");
        let previous = std::env::var_os("MAESTRO_KEYBINDINGS_FILE");
        std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &path);
        let result = body(&path);
        match previous {
            Some(value) => std::env::set_var("MAESTRO_KEYBINDINGS_FILE", value),
            None => std::env::remove_var("MAESTRO_KEYBINDINGS_FILE"),
        }
        result
    }

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
        match result.unwrap() {
            CommandOutput::Message(message) => {
                assert_eq!(
                    message,
                    format!("Maestro TUI v{}", env!("CARGO_PKG_VERSION"))
                );
            }
            other => panic!("expected version message, got {other:?}"),
        }
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
        assert!(registry.get("hotkeys").is_some());
        assert!(registry.get("keys").is_some());
        assert!(registry.get("shortcuts").is_some());
        assert!(registry.get("theme").is_some());
        assert!(registry.get("model").is_some());
        assert!(registry.get("quit").is_some());
        assert!(registry.get("limits").is_some());
        assert!(registry.get("status").is_some());
        assert!(registry.get("stats").is_some());
        assert!(registry.get("about").is_some());
        assert!(registry.get("context").is_some());
        assert!(registry.get("git").is_some());
        assert!(registry.get("diff").is_some());
        assert!(registry.get("review").is_some());
    }

    #[test]
    fn hotkeys_command_opens_shortcuts_help_modal() {
        let registry = build_command_registry();
        let result = registry.execute("/hotkeys", "/tmp", None, None);

        match result.expect("hotkeys command should succeed") {
            CommandOutput::OpenModal(ModalType::ShortcutsHelp) => {}
            other => panic!("expected shortcuts help modal, got {other:?}"),
        }
    }

    #[test]
    fn hotkeys_command_can_init_and_validate_keybindings_config() {
        with_temp_keybindings_file(|path| {
            let registry = build_command_registry();
            let init_result = registry
                .execute("/hotkeys init", "/tmp", None, None)
                .expect("hotkeys init should succeed");
            match init_result {
                CommandOutput::Message(message) => {
                    assert!(message.contains("Created keyboard shortcuts config at"));
                }
                other => panic!("expected init message, got {other:?}"),
            }
            assert!(path.exists(), "hotkeys init should create the config file");

            let validate_result = registry
                .execute("/hotkeys validate", "/tmp", None, None)
                .expect("hotkeys validate should succeed");
            match validate_result {
                CommandOutput::Message(message) => {
                    assert!(message.contains("Keyboard Shortcuts Config:"));
                    assert!(message.contains("Status: present"));
                    assert!(message.contains("Rust TUI overrides:"));
                }
                other => panic!("expected validation message, got {other:?}"),
            }
        });
    }

    #[test]
    fn hotkeys_command_requires_force_to_overwrite_existing_config() {
        with_temp_keybindings_file(|path| {
            std::fs::write(path, r#"{"version":1,"bindings":{}}"#)
                .expect("write keybindings config");
            let registry = build_command_registry();
            let err = registry
                .execute("/hotkeys init", "/tmp", None, None)
                .expect_err("init without force should fail when config exists");

            assert_eq!(
                err.message,
                format!("Keybindings config already exists at {}.", path.display())
            );
            assert_eq!(
                err.hint,
                Some("Re-run with /hotkeys init --force to overwrite it.".to_string())
            );
        });
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

    #[test]
    fn mcp_prompts_command_parses_prompt_arguments() {
        let registry = build_command_registry();
        let result = registry.execute(
            r#"/mcp prompts docs summarize topic="MCP auth flow" format=brief"#,
            "/tmp",
            None,
            None,
        );

        match result.expect("mcp prompt args should parse") {
            CommandOutput::Action(CommandAction::Mcp(McpAction::Prompts {
                server,
                name,
                arguments,
            })) => {
                assert_eq!(server.as_deref(), Some("docs"));
                assert_eq!(name.as_deref(), Some("summarize"));
                assert_eq!(
                    arguments.get("topic").map(std::string::String::as_str),
                    Some("MCP auth flow")
                );
                assert_eq!(
                    arguments.get("format").map(std::string::String::as_str),
                    Some("brief")
                );
            }
            other => panic!("expected MCP prompts action, got {other:?}"),
        }
    }

    #[test]
    fn mcp_prompts_command_rejects_invalid_prompt_arguments() {
        let registry = build_command_registry();
        let result = registry.execute(
            "/mcp prompts docs summarize invalid-arg",
            "/tmp",
            None,
            None,
        );

        let err = result.expect_err("invalid MCP prompt args should fail");
        assert_eq!(
            err.message,
            "Invalid MCP prompt argument. Use KEY=value after the prompt name."
        );
    }
}
