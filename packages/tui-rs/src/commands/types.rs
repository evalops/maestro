//! Command types and definitions

use std::collections::HashMap;

/// Result of executing a command
pub type CommandResult = Result<CommandOutput, CommandError>;

/// Handler function for a command
pub type CommandHandler = Box<dyn Fn(&CommandContext) -> CommandResult + Send + Sync>;

/// Output from a command execution
#[derive(Debug, Clone)]
pub enum CommandOutput {
    /// Display a message to the user
    Message(String),
    /// Display help text
    Help(String),
    /// Display an error (but not a failure)
    Warning(String),
    /// Open a modal/selector
    OpenModal(ModalType),
    /// No visible output
    Silent,
    /// Multiple outputs
    Multi(Vec<CommandOutput>),
}

/// Types of modals that can be opened by commands
#[derive(Debug, Clone)]
pub enum ModalType {
    ThemeSelector,
    ModelSelector,
    SessionList,
    FileSearch,
    CommandPalette,
    Help,
}

/// Error from command execution
#[derive(Debug, Clone)]
pub struct CommandError {
    pub message: String,
    pub hint: Option<String>,
}

impl CommandError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(ref hint) = self.hint {
            write!(f, " ({})", hint)?;
        }
        Ok(())
    }
}

impl std::error::Error for CommandError {}

/// Context passed to command handlers
#[derive(Debug, Clone)]
pub struct CommandContext {
    /// The full input text (including slash)
    pub input: String,
    /// The command name that was matched
    pub command_name: String,
    /// Parsed arguments
    pub args: HashMap<String, ArgumentValue>,
    /// Raw argument string (everything after command name)
    pub raw_args: String,
    /// Current working directory
    pub cwd: String,
    /// Current session ID
    pub session_id: Option<String>,
    /// Current model
    pub model: Option<String>,
}

impl CommandContext {
    /// Get a string argument
    pub fn get_string(&self, name: &str) -> Option<&str> {
        match self.args.get(name)? {
            ArgumentValue::String(s) => Some(s),
            _ => None,
        }
    }

    /// Get a boolean argument
    pub fn get_bool(&self, name: &str) -> Option<bool> {
        match self.args.get(name)? {
            ArgumentValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Get an integer argument
    pub fn get_int(&self, name: &str) -> Option<i64> {
        match self.args.get(name)? {
            ArgumentValue::Int(i) => Some(*i),
            _ => None,
        }
    }

    /// Check if a flag is present
    pub fn has_flag(&self, name: &str) -> bool {
        self.get_bool(name).unwrap_or(false)
    }
}

/// A parsed argument value
#[derive(Debug, Clone)]
pub enum ArgumentValue {
    String(String),
    Bool(bool),
    Int(i64),
    List(Vec<String>),
}

/// Command category for organization
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandCategory {
    /// UI-related commands (theme, clean, etc.)
    Ui,
    /// Session management
    Session,
    /// Tool management
    Tools,
    /// Safety and approval settings
    Safety,
    /// Diagnostic commands
    Diagnostics,
    /// Configuration
    Config,
    /// Navigation
    Navigation,
    /// Context management
    Context,
}

impl CommandCategory {
    pub fn label(&self) -> &'static str {
        match self {
            CommandCategory::Ui => "UI",
            CommandCategory::Session => "Session",
            CommandCategory::Tools => "Tools",
            CommandCategory::Safety => "Safety",
            CommandCategory::Diagnostics => "Diagnostics",
            CommandCategory::Config => "Config",
            CommandCategory::Navigation => "Navigation",
            CommandCategory::Context => "Context",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            CommandCategory::Ui => "User interface settings",
            CommandCategory::Session => "Session management",
            CommandCategory::Tools => "Tool and MCP management",
            CommandCategory::Safety => "Safety and approval settings",
            CommandCategory::Diagnostics => "System diagnostics",
            CommandCategory::Config => "Configuration options",
            CommandCategory::Navigation => "Navigation and search",
            CommandCategory::Context => "Context management",
        }
    }
}

/// Type of command argument
#[derive(Debug, Clone)]
pub enum CommandArgumentType {
    /// Free-form string
    String,
    /// Boolean flag
    Bool,
    /// Integer
    Int,
    /// One of several options
    Choice(Vec<String>),
    /// File path (enables file completion)
    FilePath,
    /// Session ID
    SessionId,
}

/// Definition of a command argument
#[derive(Debug, Clone)]
pub struct CommandArgument {
    /// Argument name
    pub name: String,
    /// Short description
    pub description: String,
    /// Argument type
    pub arg_type: CommandArgumentType,
    /// Whether the argument is required
    pub required: bool,
    /// Default value if not provided
    pub default: Option<ArgumentValue>,
}

impl CommandArgument {
    pub fn string(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            arg_type: CommandArgumentType::String,
            required: false,
            default: None,
        }
    }

    pub fn bool(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            arg_type: CommandArgumentType::Bool,
            required: false,
            default: Some(ArgumentValue::Bool(false)),
        }
    }

    pub fn choice(
        name: impl Into<String>,
        description: impl Into<String>,
        choices: Vec<&str>,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            arg_type: CommandArgumentType::Choice(choices.into_iter().map(String::from).collect()),
            required: false,
            default: None,
        }
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn with_default(mut self, value: ArgumentValue) -> Self {
        self.default = Some(value);
        self
    }
}

/// A command definition
pub struct Command {
    /// Primary command name (without slash)
    pub name: String,
    /// Short description for help
    pub description: String,
    /// Usage example
    pub usage: String,
    /// Command category
    pub category: CommandCategory,
    /// Alternative names (aliases)
    pub aliases: Vec<String>,
    /// Command arguments
    pub arguments: Vec<CommandArgument>,
    /// The command handler
    pub handler: CommandHandler,
    /// Whether this is a grouped command (has subcommands)
    pub is_group: bool,
    /// Subcommands (if is_group)
    pub subcommands: Vec<String>,
}

impl Command {
    /// Create a new command
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        category: CommandCategory,
        handler: CommandHandler,
    ) -> Self {
        let name = name.into();
        Self {
            usage: format!("/{}", name),
            name,
            description: description.into(),
            category,
            aliases: Vec::new(),
            arguments: Vec::new(),
            handler,
            is_group: false,
            subcommands: Vec::new(),
        }
    }

    /// Add an alias
    pub fn alias(mut self, alias: impl Into<String>) -> Self {
        self.aliases.push(alias.into());
        self
    }

    /// Add an argument
    pub fn arg(mut self, arg: CommandArgument) -> Self {
        self.arguments.push(arg);
        self
    }

    /// Set usage string
    pub fn usage(mut self, usage: impl Into<String>) -> Self {
        self.usage = usage.into();
        self
    }

    /// Make this a command group
    pub fn group(mut self, subcommands: Vec<&str>) -> Self {
        self.is_group = true;
        self.subcommands = subcommands.into_iter().map(String::from).collect();
        self
    }

    /// Execute the command
    pub fn execute(&self, ctx: &CommandContext) -> CommandResult {
        (self.handler)(ctx)
    }
}

impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Command")
            .field("name", &self.name)
            .field("description", &self.description)
            .field("category", &self.category)
            .field("aliases", &self.aliases)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_context_get_string() {
        let mut args = HashMap::new();
        args.insert("name".to_string(), ArgumentValue::String("test".to_string()));

        let ctx = CommandContext {
            input: "/test name".to_string(),
            command_name: "test".to_string(),
            args,
            raw_args: "name".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            model: None,
        };

        assert_eq!(ctx.get_string("name"), Some("test"));
        assert_eq!(ctx.get_string("missing"), None);
    }

    #[test]
    fn command_builder() {
        let cmd = Command::new("test", "A test command", CommandCategory::Diagnostics, Box::new(|_| Ok(CommandOutput::Silent)))
            .alias("t")
            .arg(CommandArgument::string("name", "The name"))
            .usage("/test [name]");

        assert_eq!(cmd.name, "test");
        assert_eq!(cmd.aliases, vec!["t"]);
        assert_eq!(cmd.arguments.len(), 1);
    }
}
