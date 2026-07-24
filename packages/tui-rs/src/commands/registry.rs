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
    A2aAction, ArgumentValue, BackgroundMonitorAction, Command, CommandAction, CommandArgument,
    CommandCategory, CommandContext, CommandError, CommandOutput, CommandResult, ExportAction,
    HistoryAction, HooksAction, McpAction, ModalType, PlanReviewAction, PluginsAction, QueueAction,
    QueueModeKind, SessionAction, SkillsAction, ToolHistoryAction, UsageAction,
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

    /// Register a command only if its primary name and aliases are free.
    /// Built-ins always win when this is used after `build_command_registry`.
    pub fn register_if_absent(&mut self, command: Command) -> bool {
        if self.get(&command.name).is_some() {
            return false;
        }
        for alias in &command.aliases {
            if self.get(alias).is_some() {
                return false;
            }
        }
        self.register(command);
        true
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

    /// Resolve a mistyped command name when it is within edit distance 1 of
    /// exactly one command name or alias (e.g. `quti` -> `quit`).
    ///
    /// This is the last-resort rescue before an unknown slash command falls
    /// through to the agent as a prompt: a single-character typo should not
    /// turn into a paid LLM call.
    ///
    /// Inputs shorter than 3 characters never match — at that length a
    /// distance-1 match is more likely to be a different intent than a typo.
    ///
    /// # Returns
    ///
    /// Same contract as [`Self::resolve_unique_prefix`]: `Ok(Some(cmd))` for a
    /// unique rescue, `Ok(None)` when nothing is close enough, and
    /// `Err(candidates)` when more than one command is within edit distance 1.
    pub fn resolve_typo(&self, typed: &str) -> Result<Option<Arc<Command>>, Vec<String>> {
        let typed = typed.to_lowercase();
        if typed.chars().count() < 3 {
            return Ok(None);
        }

        let mut matches: Vec<Arc<Command>> = Vec::new();
        for cmd in self.commands.values() {
            let name_hit = edit_distance(&typed, &cmd.name.to_lowercase()) <= 1;
            let alias_hit = cmd
                .aliases
                .iter()
                .any(|alias| edit_distance(&typed, &alias.to_lowercase()) <= 1);
            if name_hit || alias_hit {
                matches.push(Arc::clone(cmd));
            }
        }

        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.pop()),
            _ => {
                let mut names: Vec<String> = matches.iter().map(|cmd| cmd.name.clone()).collect();
                names.sort_unstable();
                Err(names)
            }
        }
    }

    /// Get all commands
    #[must_use]
    pub fn all(&self) -> Vec<Arc<Command>> {
        self.commands.values().cloned().collect()
    }

    /// Resolve a partial command name when it is an unambiguous prefix of
    /// exactly one command name or alias (e.g. `qui` -> `quit`).
    ///
    /// Used to make bare `Enter` on a partial slash command do what the user
    /// means instead of erroring (or leaking the partial command to the agent
    /// as a prompt).
    ///
    /// # Returns
    ///
    /// - `Ok(Some(cmd))`: exactly one command matches the prefix
    /// - `Ok(None)`: no command name or alias starts with `partial`
    /// - `Err(candidates)`: the prefix is ambiguous; `candidates` is the
    ///   sorted list of matching canonical command names for display
    ///
    /// Exact matches should be resolved via [`Self::get`] first; this method
    /// only considers proper prefixes and is case-insensitive.
    pub fn resolve_unique_prefix(
        &self,
        partial: &str,
    ) -> Result<Option<Arc<Command>>, Vec<String>> {
        let partial = partial.to_lowercase();
        if partial.is_empty() {
            return Ok(None);
        }

        let mut matches: Vec<Arc<Command>> = Vec::new();
        for cmd in self.commands.values() {
            let name_hit = cmd.name.to_lowercase().starts_with(&partial);
            let alias_hit = cmd
                .aliases
                .iter()
                .any(|alias| alias.to_lowercase().starts_with(&partial));
            if name_hit || alias_hit {
                matches.push(Arc::clone(cmd));
            }
        }

        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.pop()),
            _ => {
                let mut names: Vec<String> = matches.iter().map(|cmd| cmd.name.clone()).collect();
                names.sort_unstable();
                Err(names)
            }
        }
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

        // Tolerate accidental double-slash from completion bugs (`//help`) or paste.
        let input_without_slash = input.trim_start_matches('/');

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

/// Edit distance between two strings, counted in characters.
///
/// Optimal string alignment distance: Levenshtein plus adjacent-character
/// transpositions at cost 1, since swapped neighbors ("quti") are the most
/// common typo on a keyboard. Used for typo rescue of slash commands; inputs
/// are command names, so strings stay short and the O(n*m) cost is negligible.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());

    let mut d = vec![vec![usize::MAX; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }

    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }

    d[n][m]
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

fn parse_a2a_action(raw: &str) -> Result<A2aAction, CommandError> {
    let tokens = tokenize_command_args(raw);
    let subcommand = tokens
        .first()
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    match subcommand.as_str() {
        "" | "help" => Ok(A2aAction::Help),
        "fleet" => Ok(A2aAction::Fleet),
        "peers" | "list" => Ok(A2aAction::Peers),
        "tasks" => Ok(A2aAction::Tasks {
            peer: first_a2a_positional(&tokens, 1),
            include_work_graph: has_a2a_flag(&tokens, "--work-graph"),
        }),
        "coordinate" => {
            let reply_index = tokens.iter().position(|value| value == "--reply");
            let peer = first_a2a_positional(
                reply_index
                    .map(|index| &tokens[..index])
                    .unwrap_or_else(|| tokens.as_slice()),
                1,
            );
            let include_work_graph = has_a2a_flag(&tokens, "--work-graph");
            let reply = reply_index.map(|index| {
                tokens
                    .get(index + 1..)
                    .unwrap_or(&[])
                    .iter()
                    .take_while(|value| !value.starts_with("--"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            let reply = reply.and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });
            Ok(A2aAction::Coordinate {
                peer,
                reply,
                include_work_graph,
            })
        }
        "accept" => {
            let code = tokens
                .get(1)
                .ok_or_else(|| CommandError::new("Usage: /a2a accept <pairing-code>"))?;
            Ok(A2aAction::Accept { code: code.clone() })
        }
        "register" | "publish" => Ok(A2aAction::Register {
            agent_id: a2a_flag_value(&tokens, "--agent-id"),
            public_url: a2a_flag_value(&tokens, "--url")
                .or_else(|| a2a_flag_value(&tokens, "--public-url")),
            heartbeat_only: has_a2a_flag(&tokens, "--heartbeat-only"),
        }),
        "delegate" => {
            let peer = tokens
                .get(1)
                .ok_or_else(|| CommandError::new("Usage: /a2a delegate <peer> <text>"))?;
            let text = tokens.get(2..).unwrap_or(&[]).join(" ");
            if text.trim().is_empty() {
                return Err(CommandError::new("Usage: /a2a delegate <peer> <text>"));
            }
            Ok(A2aAction::Delegate {
                peer: peer.clone(),
                text,
            })
        }
        "reply" | "continue" => {
            let peer = tokens
                .get(1)
                .ok_or_else(|| CommandError::new("Usage: /a2a reply <peer> <task-id> <text>"))?;
            let task_id = tokens
                .get(2)
                .ok_or_else(|| CommandError::new("Usage: /a2a reply <peer> <task-id> <text>"))?;
            let text = tokens.get(3..).unwrap_or(&[]).join(" ");
            if text.trim().is_empty() {
                return Err(CommandError::new("Usage: /a2a reply <peer> <task-id> <text>"));
            }
            Ok(A2aAction::Reply {
                peer: peer.clone(),
                task_id: task_id.clone(),
                text,
            })
        }
        "send" => {
            let peer = tokens
                .get(1)
                .ok_or_else(|| CommandError::new("Usage: /a2a send <peer> <text>"))?;
            let text = tokens.get(2..).unwrap_or(&[]).join(" ");
            if text.trim().is_empty() {
                return Err(CommandError::new("Usage: /a2a send <peer> <text>"));
            }
            Ok(A2aAction::Send {
                peer: peer.clone(),
                text,
            })
        }
        _ => Err(CommandError::new(format!("Unknown A2A subcommand: {subcommand}")).with_hint(
            "Usage: /a2a [fleet|peers|tasks [--work-graph]|coordinate [--work-graph]|accept <code>|register --url <base-url>|delegate <peer> <text>|reply <peer> <task-id> <text>|send <peer> <text>]",
        )),
    }
}

fn has_a2a_flag(tokens: &[String], flag: &str) -> bool {
    tokens.iter().any(|value| value == flag)
}

fn first_a2a_positional(tokens: &[String], start: usize) -> Option<String> {
    let mut index = start;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.starts_with("--") {
            if a2a_value_flag(token) && !token.contains('=') {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        return Some(token.clone());
    }
    None
}

fn a2a_flag_value(tokens: &[String], flag: &str) -> Option<String> {
    for (index, token) in tokens.iter().enumerate() {
        if let Some((token_flag, value)) = token.split_once('=') {
            if token_flag == flag {
                let value = value.trim();
                return (!value.is_empty()).then(|| value.to_string());
            }
        }
        if token == flag {
            let value = tokens.get(index + 1)?.trim();
            return (!value.is_empty() && !value.starts_with("--")).then(|| value.to_string());
        }
    }
    None
}

fn a2a_value_flag(token: &str) -> bool {
    matches!(
        token,
        "--registry"
            | "--tasks"
            | "--timeout-ms"
            | "--interval-ms"
            | "--max-wait-ms"
            | "--role"
            | "--cwd"
            | "--agent-card-url"
            | "--agent-id"
            | "--capabilities"
            | "--description"
            | "--internal-url"
            | "--name"
            | "--owner-id"
            | "--protocol-version"
            | "--public-url"
            | "--security-schemes"
            | "--status"
            | "--surface"
            | "--surface-types"
            | "--type"
            | "--url"
            | "--workspace-id"
    )
}

fn parse_rewind_args(raw: &str, usage: &str) -> Result<SessionAction, CommandError> {
    let mut turns = None;
    let mut dry_run = false;
    for arg in raw.split_whitespace() {
        match arg {
            "--dry-run" => dry_run = true,
            _ if turns.is_none() => {
                turns = Some(arg.parse::<usize>().map_err(|_| CommandError::new(usage))?);
            }
            _ => return Err(CommandError::new(usage)),
        }
    }
    let turns = turns.unwrap_or(1);
    if turns == 0 {
        return Err(CommandError::new("Rewind count must be >= 1"));
    }
    Ok(SessionAction::Rewind { turns, dry_run })
}

fn parse_plan_range(raw: &str) -> Result<(usize, usize), CommandError> {
    let (start, end) = raw
        .split_once('-')
        .or_else(|| raw.split_once(':'))
        .unwrap_or((raw, raw));
    let start = start
        .parse::<usize>()
        .map_err(|_| CommandError::new("Plan comment range must be LINE or START-END"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| CommandError::new("Plan comment range must be LINE or START-END"))?;
    if start == 0 || end < start {
        return Err(CommandError::new(
            "Plan comment range must be positive and ordered",
        ));
    }
    Ok((start, end))
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
                    .unwrap_or_default();

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

    // Clear / new session (Grok-style: /new and /clear start fresh)
    registry.register(
        Command::new(
            "clear",
            "Start a new session (clear transcript)",
            CommandCategory::Session,
            Box::new(|_| {
                Ok(CommandOutput::Action(CommandAction::Session(
                    SessionAction::New,
                )))
            }),
        )
        .alias("cls")
        .alias("new"),
    );

    // Fork session
    registry.register(
        Command::new(
            "fork",
            "Fork the conversation into a new session branch",
            CommandCategory::Session,
            Box::new(|_| {
                Ok(CommandOutput::Action(CommandAction::Session(
                    SessionAction::Fork,
                )))
            }),
        )
        .usage("/fork"),
    );

    // Rewind turns
    registry.register(
        Command::new(
            "rewind",
            "Remove the last N user turns from in-memory history",
            CommandCategory::Session,
            Box::new(|ctx| {
                Ok(CommandOutput::Action(CommandAction::Session(
                    parse_rewind_args(&ctx.raw_args, "Usage: /rewind [n] [--dry-run]")?,
                )))
            }),
        )
        .alias("undo")
        .usage("/rewind [n] [--dry-run]"),
    );

    registry.register(
        Command::new(
            "btw",
            "Ask a tool-free side question outside main history",
            CommandCategory::Context,
            Box::new(|ctx| {
                let question = ctx.raw_args.trim();
                if question.is_empty() {
                    return Err(CommandError::new("Usage: /btw <question>"));
                }
                Ok(CommandOutput::Action(CommandAction::SideQuestion(
                    question.to_string(),
                )))
            }),
        )
        .usage("/btw <question>"),
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

    // A2A peer pairing command
    registry.register(
        Command::new(
            "a2a",
            "Pair, inspect, and delegate to A2A peer agents",
            CommandCategory::Tools,
            Box::new(|ctx| {
                Ok(CommandOutput::Action(CommandAction::A2a(parse_a2a_action(
                    &ctx.raw_args,
                )?)))
            }),
        )
        .usage("/a2a [fleet|peers|tasks [--work-graph]|coordinate [--work-graph]|accept <code>|register --url <base-url>|delegate <peer> <text>|reply <peer> <task-id> <text>|send <peer> <text>]"),
    );

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
                    "new" | "clear" => Ok(CommandOutput::Action(CommandAction::Session(
                        SessionAction::New,
                    ))),
                    "fork" => Ok(CommandOutput::Action(CommandAction::Session(
                        SessionAction::Fork,
                    ))),
                    "rewind" | "undo" => Ok(CommandOutput::Action(CommandAction::Session(
                        parse_rewind_args(
                            ctx.raw_args
                                .strip_prefix(ctx.raw_args.split_whitespace().next().unwrap_or(""))
                                .unwrap_or("")
                                .trim(),
                            "Usage: /session rewind [n] [--dry-run]",
                        )?,
                    ))),
                    "info" | "" => Ok(CommandOutput::Action(CommandAction::ShowDiagnostics)),
                    _ => Ok(CommandOutput::Message(
                        "Usage: /session [info|new|clear|fork|rewind|cleanup]".to_string(),
                    )),
                }
            }),
        )
        .alias("ss")
        .usage("/session [info|new|clear|list|load|export|cleanup|fork|rewind]")
        .group(vec![
            "info", "new", "clear", "list", "load", "export", "cleanup", "fork", "rewind",
        ]),
    );

    registry.register(Command::new(
        "sessions",
        "List and manage sessions",
        CommandCategory::Session,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::SessionList))),
    ));

    registry.register(Command::new(
        "operations",
        "Inspect recent persisted tool executions",
        CommandCategory::Diagnostics,
        Box::new(|_| Ok(CommandOutput::OpenModal(ModalType::Operations))),
    ));

    registry.register(
        Command::new(
            "monitor",
            "Monitor output from an existing background task",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let raw = ctx.raw_args.trim();
                let (action, rest) = raw
                    .split_once(char::is_whitespace)
                    .map_or((raw, ""), |(action, rest)| (action, rest.trim_start()));
                match action {
                    "" | "list" => Ok(CommandOutput::Action(CommandAction::BackgroundMonitor(
                        BackgroundMonitorAction::List,
                    ))),
                    "add" => {
                        let (task_id, pattern) =
                            rest.split_once(char::is_whitespace).ok_or_else(|| {
                                CommandError::new("Usage: /monitor add <task-id> <regex>")
                            })?;
                        Ok(CommandOutput::Action(CommandAction::BackgroundMonitor(
                            BackgroundMonitorAction::Add {
                                task_id: task_id.to_string(),
                                pattern: pattern.trim_start().to_string(),
                            },
                        )))
                    }
                    "remove" | "rm" => {
                        if rest.is_empty() {
                            return Err(CommandError::new("Usage: /monitor remove <monitor-id>"));
                        }
                        Ok(CommandOutput::Action(CommandAction::BackgroundMonitor(
                            BackgroundMonitorAction::Remove {
                                monitor_id: rest.to_string(),
                            },
                        )))
                    }
                    _ => Err(CommandError::new(
                        "Usage: /monitor [list|add <task-id> <regex>|remove <monitor-id>]",
                    )),
                }
            }),
        )
        .usage("/monitor [list|add <task-id> <regex>|remove <monitor-id>]")
        .group(vec!["list", "add", "remove"]),
    );

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

    // Jane Street magic-trace (Linux/Intel PT) — https://github.com/janestreet/magic-trace
    registry.register(
        Command::new(
            "magic-trace",
            "Fire magic-trace stop indicator or toggle slow-frame snapshots",
            CommandCategory::Diagnostics,
            Box::new(|ctx| {
                let sub = ctx
                    .raw_args
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
                let action = match sub.as_str() {
                    "" | "stop" | "snap" | "snapshot" => crate::commands::MagicTraceAction::Stop,
                    "on" | "enable" | "slow" => crate::commands::MagicTraceAction::EnableSlowFrame,
                    "off" | "disable" => crate::commands::MagicTraceAction::DisableSlowFrame,
                    "status" | "help" | "?" => crate::commands::MagicTraceAction::Status,
                    _ => {
                        return Err(CommandError::new(
                            "Usage: /magic-trace [stop|on|off|status]",
                        ));
                    }
                };
                Ok(CommandOutput::Action(CommandAction::MagicTrace(action)))
            }),
        )
        .alias("mt")
        .usage("/magic-trace [stop|on|off|status]"),
    );

    // Tools command
    registry.register(
        Command::new(
            "tools",
            "List built-in tools (and MCP via /mcp)",
            CommandCategory::Tools,
            Box::new(|ctx| {
                let sub = ctx
                    .raw_args
                    .split_whitespace()
                    .next()
                    .unwrap_or("list")
                    .to_lowercase();
                match sub.as_str() {
                    "list" | "" => Ok(CommandOutput::Action(CommandAction::ShowTools)),
                    "mcp" => Ok(CommandOutput::Action(CommandAction::Mcp(McpAction::Status))),
                    "lsp" => Ok(CommandOutput::Message(
                        "LSP: set lsp.enabled in config; diagnostics can surface on write tools."
                            .to_string(),
                    )),
                    _ => Err(CommandError::new("Usage: /tools [list|mcp|lsp]")),
                }
            }),
        )
        .group(vec!["list", "mcp", "lsp"])
        .usage("/tools [list|mcp|lsp]"),
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
                let style = ctx.get_string("style").unwrap_or("rich");
                Ok(CommandOutput::Message(format!("Footer style: {style}")))
            }),
        )
        .arg(CommandArgument::choice(
            "style",
            "Footer style",
            vec!["rich", "solo", "history", "clear"],
        ))
        .usage("/footer [rich|solo|history|clear]"),
    );

    // Memory commands
    registry.register(
        Command::new(
            "memory",
            "Local / shared memory status",
            CommandCategory::Context,
            Box::new(|_| Ok(CommandOutput::Action(CommandAction::ShowMemory))),
        )
        .group(vec!["save", "search", "list", "delete", "stats"])
        .usage("/memory"),
    );

    // Plan mode (Grok-style: plan.md + approve)
    registry.register(
        Command::new(
            "plan",
            "Plan mode: explore + write plan.md only until approved",
            CommandCategory::Context,
            Box::new(|ctx| {
                let raw = ctx.raw_args.trim();
                let mut parts = raw.split_whitespace();
                let subcommand = parts.next().unwrap_or("").to_lowercase();
                match subcommand.as_str() {
                    "" | "on" | "true" | "1" => {
                        Ok(CommandOutput::Action(CommandAction::SetPlanMode(true)))
                    }
                    "off" | "false" | "0" => {
                        Ok(CommandOutput::Action(CommandAction::SetPlanMode(false)))
                    }
                    "approve" | "accept" | "done" => {
                        Ok(CommandOutput::Action(CommandAction::ApprovePlan))
                    }
                    "view" | "show" => Ok(CommandOutput::Action(CommandAction::ViewPlan)),
                    "comments" | "list" => Ok(CommandOutput::Action(CommandAction::PlanReview(
                        PlanReviewAction::List,
                    ))),
                    "comment" => {
                        let range = parts.next().ok_or_else(|| {
                            CommandError::new("Usage: /plan comment <line|start-end> <text>")
                        })?;
                        let (start_line, end_line) = parse_plan_range(range)?;
                        let text = parts.collect::<Vec<_>>().join(" ");
                        if text.is_empty() {
                            return Err(CommandError::new(
                                "Usage: /plan comment <line|start-end> <text>",
                            ));
                        }
                        Ok(CommandOutput::Action(CommandAction::PlanReview(
                            PlanReviewAction::Comment {
                                start_line,
                                end_line,
                                text,
                            },
                        )))
                    }
                    "resolve" | "reopen" => {
                        let id = parts
                            .next()
                            .ok_or_else(|| CommandError::new("Usage: /plan resolve|reopen <id>"))?
                            .trim_start_matches('#')
                            .parse::<u64>()
                            .map_err(|_| CommandError::new("Plan comment id must be a number"))?;
                        let action = if subcommand == "resolve" {
                            PlanReviewAction::Resolve { id }
                        } else {
                            PlanReviewAction::Reopen { id }
                        };
                        Ok(CommandOutput::Action(CommandAction::PlanReview(action)))
                    }
                    _ => Err(CommandError::new("Usage: /plan [on|off|approve|view|comments|comment <range> <text>|resolve <id>|reopen <id>]")),
                }
            }),
        )
        .usage("/plan [on|off|approve|view|comments|comment <range> <text>|resolve <id>|reopen <id>]"),
    );

    registry.register(
        Command::new(
            "view-plan",
            "Show the current session plan.md",
            CommandCategory::Context,
            Box::new(|_| Ok(CommandOutput::Action(CommandAction::ViewPlan))),
        )
        .alias("show-plan")
        .alias("plan-view")
        .usage("/view-plan"),
    );

    // Grok-style permission shortcuts
    registry.register(
        Command::new(
            "always-approve",
            "Auto-approve all tool executions (YOLO)",
            CommandCategory::Safety,
            Box::new(|_| {
                Ok(CommandOutput::Action(CommandAction::SetApprovalMode(
                    "yolo".to_string(),
                )))
            }),
        )
        .alias("yolo"),
    );
    registry.register(Command::new(
        "auto",
        "Selective approvals (safe tools free, risky prompt)",
        CommandCategory::Safety,
        Box::new(|_| {
            Ok(CommandOutput::Action(CommandAction::SetApprovalMode(
                "selective".to_string(),
            )))
        }),
    ));
    registry.register(Command::new(
        "ask",
        "Require approval for all tools",
        CommandCategory::Safety,
        Box::new(|_| {
            Ok(CommandOutput::Action(CommandAction::SetApprovalMode(
                "safe".to_string(),
            )))
        }),
    ));

    // Continue command
    registry.register(
        Command::new(
            "continue",
            "Continue the most recent session for this workspace",
            CommandCategory::Session,
            Box::new(|_| {
                Ok(CommandOutput::Action(CommandAction::Session(
                    SessionAction::Continue,
                )))
            }),
        )
        .alias("c")
        .usage("/continue"),
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

    // Plugins command
    registry.register(
        Command::new(
            "plugins",
            "List discovered plugins (skills, commands, hooks, MCP packages)",
            CommandCategory::Tools,
            Box::new(|ctx| {
                let raw_args = ctx.raw_args.trim();
                let raw_parts: Vec<&str> = raw_args.split_whitespace().collect();
                let raw_sub = raw_parts.first().copied().unwrap_or("");
                let sub = raw_sub.to_lowercase();

                let action = match sub.as_str() {
                    "" | "list" => PluginsAction::List,
                    "reload" | "refresh" => PluginsAction::Reload,
                    "info" | "show" => {
                        let name = raw_parts
                            .iter()
                            .skip(1)
                            .copied()
                            .collect::<Vec<_>>()
                            .join(" ");
                        let name = name.trim();
                        if name.is_empty() {
                            return Err(CommandError::new("Plugin name required")
                                .with_hint("Usage: /plugins info <plugin-name>"));
                        }
                        PluginsAction::Info(name.to_string())
                    }
                    _ => {
                        // Treat bare name as info lookup: `/plugins team-tools`
                        PluginsAction::Info(raw_sub.to_string())
                    }
                };

                Ok(CommandOutput::Action(CommandAction::Plugins(action)))
            }),
        )
        .alias("plugin")
        .arg(CommandArgument::string(
            "action",
            "list|info|reload or plugin name",
        ))
        .usage("/plugins [list|info|reload] [plugin-name]"),
    );

    registry
}

/// Built-ins + Grok-style skill/prompt slash extensions. Built-ins always win.
#[must_use]
pub fn build_command_registry_with_extensions(
    skills: &[crate::skills::LoadedSkill],
    prompts: &[crate::prompts::PromptDefinition],
) -> CommandRegistry {
    let mut registry = build_command_registry();

    for prompt in prompts {
        let name = prompt.name.clone();
        let desc = prompt
            .description
            .clone()
            .unwrap_or_else(|| format!("Prompt template ({})", prompt.source_type.as_str()));
        let usage = crate::prompts::get_usage_hint(prompt).replace("/prompts:", "/");
        let name_for_handler = name.clone();
        registry.register_if_absent(
            Command::new(
                name.clone(),
                desc,
                CommandCategory::Tools,
                Box::new(move |ctx| {
                    Ok(CommandOutput::Action(CommandAction::InvokePromptTemplate {
                        name: name_for_handler.clone(),
                        args: ctx.raw_args.clone(),
                    }))
                }),
            )
            .usage(usage),
        );
    }

    for skill in skills {
        if !skill.definition.enabled || !skill.definition.user_invocable {
            continue;
        }
        let name = skill.definition.name.clone();
        let desc = if skill.definition.description.is_empty() {
            format!("Skill: {name}")
        } else {
            skill.definition.description.clone()
        };
        let hint = skill
            .definition
            .metadata
            .get("argument-hint")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let usage = match hint {
            Some(h) if !h.is_empty() => format!("/{name} {h}"),
            _ => format!("/{name} [args...]"),
        };
        let name_for_handler = name.clone();
        registry.register_if_absent(
            Command::new(
                name.clone(),
                desc,
                CommandCategory::Tools,
                Box::new(move |ctx| {
                    Ok(CommandOutput::Action(CommandAction::InvokeSkill {
                        name: name_for_handler.clone(),
                        args: ctx.raw_args.clone(),
                    }))
                }),
            )
            .usage(usage),
        );
    }

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
mod tests;
