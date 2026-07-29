//! Bash Command Analyzer
//!
//! Analyzes shell commands with a bounded tree-sitter Bash parse and determines risk.

use std::collections::HashSet;
use tree_sitter::{Node, Parser};

const MAX_BASH_SOURCE_BYTES: usize = 1_048_576;
const MAX_BASH_NODES: usize = 50_000;

/// Risk level for a bash command
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRisk {
    /// Safe - read-only operations
    Safe,
    /// Requires approval - potentially destructive
    RequiresApproval,
    /// Dangerous - high risk operation
    Dangerous,
}

/// Analysis result for a bash command
#[derive(Debug, Clone)]
pub struct BashAnalysis {
    /// Overall risk level
    pub risk: CommandRisk,
    /// Reason for the risk assessment
    pub reason: String,
    /// Commands found in the input
    pub commands: Vec<ParsedCommand>,
    /// Whether the command has pipes
    pub has_pipes: bool,
    /// Whether the command has redirects
    pub has_redirects: bool,
    /// Whether the command has subshells
    pub has_subshell: bool,
    /// Whether the command has background jobs
    pub has_background: bool,
    /// Whether the command has command substitution
    pub has_command_substitution: bool,
}

/// A parsed command with program and arguments
#[derive(Debug, Clone)]
pub struct ParsedCommand {
    /// The program name
    pub program: String,
    /// Arguments to the program
    pub args: Vec<String>,
    /// Raw command string
    pub raw: String,
}

/// Safe read-only commands that don't require approval
static SAFE_COMMANDS: std::sync::LazyLock<HashSet<&'static str>> = std::sync::LazyLock::new(|| {
    [
        // File reading
        "cat", "head", "tail", "less", "more", "bat", // Search
        "grep", "rg", "ag", "find", "fd", "locate", // Directory
        "ls", "pwd", "tree", "exa", // Output
        "echo", "printf", // Text processing (read-only)
        "wc", "sort", "uniq", "diff", "cut", "tr", "awk", "sed", // Metadata
        "file", "stat", "du", "df", // Lookup
        "which", "whereis", "type", "command", // Docs
        "man", "help", "info", // System info
        "date", "cal", "whoami", "id", "groups", "hostname", "uname", "env", "printenv",
        // Modern tools
        "jq", "yq", "fzf", // Pipeline
        "tee", "xargs", // Testing
        "test", "[", "true", "false",
    ]
    .into_iter()
    .collect()
});

/// Safe git subcommands that don't modify the repository
static SAFE_GIT_SUBCOMMANDS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        [
            "status",
            "log",
            "diff",
            "show",
            "branch",
            "tag",
            "remote",
            "config",
            "describe",
            "rev-parse",
            "ls-files",
            "ls-tree",
            "blame",
            "shortlog",
            "reflog",
            "stash",
        ]
        .into_iter()
        .collect()
    });

/// Check whether arguments to a nominally read-only git subcommand actually
/// mutate repository state (e.g. `git branch -D`, `git remote set-url`,
/// `git tag -d`, `git stash drop`, `git config name value`).
pub(crate) fn git_args_are_mutating(subcommand: &str, args: &[String]) -> bool {
    // Tokens that turn a nominally read-only subcommand into a mutation.
    const MUTATING_TOKENS: &[&str] = &[
        "-d", "-D", "--delete", "add", "remove", "rm", "set-url", "prune", "drop", "clear",
    ];
    if args
        .iter()
        .any(|arg| MUTATING_TOKENS.contains(&arg.as_str()))
    {
        return true;
    }

    match subcommand {
        // `git branch foo` creates a branch; `git tag v1` creates a tag.
        // List mode (`-l`/`--list`) takes a pattern argument and stays read-only.
        "branch" | "tag" => {
            if args.iter().any(|arg| arg == "-l" || arg == "--list") {
                return false;
            }
            args.iter().any(|arg| !arg.starts_with('-'))
        }
        "config" => {
            const MUTATING_CONFIG_FLAGS: &[&str] = &[
                "--add",
                "--unset",
                "--unset-all",
                "--remove-section",
                "--rename-section",
                "--edit",
                "-e",
            ];
            if args
                .iter()
                .any(|arg| MUTATING_CONFIG_FLAGS.contains(&arg.as_str()))
            {
                return true;
            }
            // `git config <name>` reads; `git config <name> <value>` writes.
            args.iter().filter(|arg| !arg.starts_with('-')).count() > 1
        }
        _ => false,
    }
}

/// Dangerous git subcommands that require approval
static DANGEROUS_GIT_SUBCOMMANDS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        [
            "reset",
            "clean",
            "rm",
            "push",
            "rebase",
            "merge",
            "cherry-pick",
            "checkout",
            "restore",
            "switch",
        ]
        .into_iter()
        .collect()
    });

/// Commands that are always dangerous
static DANGEROUS_COMMANDS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        [
            // Destructive
            "rm",
            "rmdir",
            "shred",
            // Disk - including common mkfs variants
            "mkfs",
            "mkfs.ext2",
            "mkfs.ext3",
            "mkfs.ext4",
            "mkfs.xfs",
            "mkfs.btrfs",
            "mkfs.vfat",
            "mkfs.ntfs",
            "mkfs.fat",
            "dd",
            "fdisk",
            "parted",
            "format",
            // Permissions
            "chmod",
            "chown",
            "chgrp",
            // Process
            "kill",
            "killall",
            "pkill",
            // System
            "reboot",
            "shutdown",
            "halt",
            "poweroff",
            "init",
            "systemctl",
            "service",
            // Privilege
            "sudo",
            "su",
            "doas",
        ]
        .into_iter()
        .collect()
    });

/// Check if a command matches a dangerous command (including prefix matches)
fn is_dangerous_command(program: &str) -> bool {
    // Exact match
    if DANGEROUS_COMMANDS.contains(program) {
        return true;
    }
    // Prefix match for commands like mkfs.* (mkfs.ext4, mkfs.xfs, etc.)
    if program.starts_with("mkfs.") {
        return true;
    }
    false
}

/// Commands that can be dangerous with certain flags
static CONDITIONALLY_DANGEROUS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        [
            "mv", "cp", "tar", "zip", "unzip", "gzip", "gunzip", "curl", "wget", "scp", "rsync",
        ]
        .into_iter()
        .collect()
    });

/// Analyze a bash command for safety
#[must_use]
pub fn analyze_bash_command(command: &str) -> BashAnalysis {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return BashAnalysis {
            risk: CommandRisk::Safe,
            reason: "Empty command".to_string(),
            commands: Vec::new(),
            has_pipes: false,
            has_redirects: false,
            has_subshell: false,
            has_background: false,
            has_command_substitution: false,
        };
    }

    let Ok(parsed) = parse_commands(trimmed) else {
        return BashAnalysis {
            risk: CommandRisk::RequiresApproval,
            reason: "Bash command could not be parsed safely".to_string(),
            commands: Vec::new(),
            has_pipes: false,
            has_redirects: false,
            has_subshell: false,
            has_background: false,
            has_command_substitution: false,
        };
    };

    // Determine overall risk
    let (risk, reason) = determine_risk(
        &parsed.commands,
        parsed.has_pipes,
        parsed.has_redirects,
        parsed.has_command_substitution,
    );

    BashAnalysis {
        risk,
        reason,
        commands: parsed.commands,
        has_pipes: parsed.has_pipes,
        has_redirects: parsed.has_redirects,
        has_subshell: parsed.has_subshell,
        has_background: parsed.has_background,
        has_command_substitution: parsed.has_command_substitution,
    }
}

struct ParsedShell {
    commands: Vec<ParsedCommand>,
    has_pipes: bool,
    has_redirects: bool,
    has_subshell: bool,
    has_background: bool,
    has_command_substitution: bool,
}

/// Parse a command string into individual commands.
fn parse_commands(input: &str) -> Result<ParsedShell, ()> {
    if input.len() > MAX_BASH_SOURCE_BYTES {
        return Err(());
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|_| ())?;
    #[allow(deprecated)]
    parser.set_timeout_micros(50_000);
    let tree = parser.parse(input, None).ok_or(())?;
    if tree.root_node().has_error() {
        return Err(());
    }

    let mut parsed = ParsedShell {
        commands: Vec::new(),
        has_pipes: false,
        has_redirects: false,
        has_subshell: false,
        has_background: false,
        has_command_substitution: false,
    };
    let mut stack = vec![tree.root_node()];
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        visited += 1;
        if visited > MAX_BASH_NODES {
            return Err(());
        }
        classify_syntax_node(node, input, &mut parsed);
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }
    Ok(parsed)
}

fn classify_syntax_node(node: Node<'_>, source: &str, parsed: &mut ParsedShell) {
    match node.kind() {
        "command" => {
            if let Ok(raw) = node.utf8_text(source.as_bytes()) {
                if let Some(command) = parse_single_command(raw) {
                    parsed.commands.push(command);
                }
            }
        }
        "pipeline" => parsed.has_pipes = true,
        "redirected_statement" | "file_redirect" | "heredoc_redirect" => {
            parsed.has_redirects = true;
        }
        "subshell" => parsed.has_subshell = true,
        "command_substitution" | "process_substitution" => {
            parsed.has_command_substitution = true;
        }
        _ => {
            if !node.is_named() {
                if let Ok(text) = node.utf8_text(source.as_bytes()) {
                    if text == "&" {
                        parsed.has_background = true;
                    }
                }
            }
        }
    }
}

/// Parse a single command into program and arguments
fn parse_single_command(input: &str) -> Option<ParsedCommand> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Tokenize respecting quotes
    let tokens = tokenize(trimmed);
    if tokens.is_empty() {
        return None;
    }

    // Skip common wrappers
    let (program, args) = skip_wrappers(&tokens);

    Some(ParsedCommand {
        program: program.to_string(),
        args: args.iter().map(std::string::ToString::to_string).collect(),
        raw: trimmed.to_string(),
    })
}

/// Tokenize a command string, respecting quotes
pub(crate) fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escape_next = false;

    for ch in input.chars() {
        if escape_next {
            current.push(ch);
            escape_next = false;
            continue;
        }

        match ch {
            '\\' if !in_single_quote => {
                escape_next = true;
            }
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
            }
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
            }
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            _ => {
                current.push(ch);
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// Skip common command wrappers (env, nice, sudo, etc.)
fn skip_wrappers(tokens: &[String]) -> (&str, &[String]) {
    let mut idx = 0;

    while idx < tokens.len() {
        let token = &tokens[idx];

        // Skip env with VAR=value patterns
        if token == "env" {
            idx += 1;
            // Skip env's VAR=value patterns and flags
            while idx < tokens.len() && (tokens[idx].contains('=') || tokens[idx].starts_with('-'))
            {
                idx += 1;
            }
            continue;
        }

        // Skip nice with optional -n flag and priority
        if token == "nice" {
            idx += 1;
            // Skip -n and its numeric argument
            if idx < tokens.len() && tokens[idx] == "-n" {
                idx += 1;
                // Skip the numeric priority if present
                if idx < tokens.len() && tokens[idx].parse::<i32>().is_ok() {
                    idx += 1;
                }
            }
            continue;
        }

        // Skip simple wrappers that take no arguments before the command
        if token == "nohup" || token == "command" {
            idx += 1;
            continue;
        }

        // Skip time with optional flags
        if token == "time" {
            idx += 1;
            // Skip time flags
            while idx < tokens.len() && tokens[idx].starts_with('-') {
                idx += 1;
            }
            continue;
        }

        // Skip timeout with duration argument
        if token == "timeout" {
            idx += 1;
            // Skip duration argument (e.g., "5s", "30")
            if idx < tokens.len() && !tokens[idx].starts_with('-') {
                idx += 1;
            }
            continue;
        }

        // NOTE: We do NOT skip sudo/doas here because they represent
        // privilege escalation, which should be detected as dangerous.
        // The determine_risk function checks for these explicitly.

        break;
    }

    if idx < tokens.len() {
        (&tokens[idx], &tokens[idx + 1..])
    } else {
        ("", &[])
    }
}

/// Determine the risk level of parsed commands
fn determine_risk(
    commands: &[ParsedCommand],
    has_pipes: bool,
    has_redirects: bool,
    has_command_substitution: bool,
) -> (CommandRisk, String) {
    // Command substitution is always risky
    if has_command_substitution {
        return (
            CommandRisk::RequiresApproval,
            "Command contains command substitution".to_string(),
        );
    }

    let mut highest_risk = CommandRisk::Safe;
    let mut reason = "Read-only command".to_string();

    for cmd in commands {
        let program = cmd.program.to_lowercase();
        let program = program.as_str();

        // Check for always-dangerous commands (including prefix matches)
        if is_dangerous_command(program) {
            return (
                CommandRisk::Dangerous,
                format!("Dangerous command: {program}"),
            );
        }

        // Check for sudo/doas
        if program == "sudo" || program == "doas" || program == "su" {
            return (
                CommandRisk::Dangerous,
                "Command uses privilege escalation".to_string(),
            );
        }

        // Check git subcommands
        if program == "git" && !cmd.args.is_empty() {
            let subcommand = cmd.args[0].to_lowercase();
            if DANGEROUS_GIT_SUBCOMMANDS.contains(subcommand.as_str()) {
                highest_risk = CommandRisk::RequiresApproval;
                reason = format!("Git {subcommand} can modify repository");
            } else if SAFE_GIT_SUBCOMMANDS.contains(subcommand.as_str()) {
                if git_args_are_mutating(&subcommand, &cmd.args[1..])
                    && highest_risk == CommandRisk::Safe
                {
                    highest_risk = CommandRisk::RequiresApproval;
                    reason = format!("Git {subcommand} arguments can modify repository");
                }
            } else if highest_risk == CommandRisk::Safe {
                highest_risk = CommandRisk::RequiresApproval;
                reason = format!("Unknown git subcommand: {subcommand}");
            }
            continue;
        }

        // Check for conditionally dangerous commands
        if CONDITIONALLY_DANGEROUS.contains(program) {
            if highest_risk == CommandRisk::Safe {
                highest_risk = CommandRisk::RequiresApproval;
                reason = format!("{program} may modify files");
            }
            continue;
        }

        // Check if command is safe
        if !SAFE_COMMANDS.contains(program) && highest_risk == CommandRisk::Safe {
            highest_risk = CommandRisk::RequiresApproval;
            reason = format!("Unknown command: {program}");
        }
    }

    // Pipes with non-safe commands need approval
    if has_pipes && highest_risk == CommandRisk::Safe {
        // Check if ALL commands in pipe are safe
        let all_safe = commands.iter().all(|cmd| {
            let program = cmd.program.to_lowercase();
            SAFE_COMMANDS.contains(program.as_str())
                || (program == "git"
                    && !cmd.args.is_empty()
                    && SAFE_GIT_SUBCOMMANDS.contains(cmd.args[0].to_lowercase().as_str())
                    && !git_args_are_mutating(&cmd.args[0].to_lowercase(), &cmd.args[1..]))
        });

        if !all_safe {
            highest_risk = CommandRisk::RequiresApproval;
            reason = "Pipeline contains potentially unsafe commands".to_string();
        }
    }

    // Redirects to files need approval (could overwrite)
    if has_redirects && highest_risk == CommandRisk::Safe {
        highest_risk = CommandRisk::RequiresApproval;
        reason = "Command uses file redirection".to_string();
    }

    (highest_risk, reason)
}

/// Quick check if a command is likely safe
#[must_use]
pub fn is_likely_safe(command: &str) -> bool {
    let analysis = analyze_bash_command(command);
    analysis.risk == CommandRisk::Safe
}

/// Quick check if a command is dangerous
#[must_use]
pub fn is_dangerous(command: &str) -> bool {
    let analysis = analyze_bash_command(command);
    analysis.risk == CommandRisk::Dangerous
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_commands() {
        assert!(is_likely_safe("ls -la"));
        assert!(is_likely_safe("cat file.txt"));
        assert!(is_likely_safe("grep pattern file"));
        assert!(is_likely_safe("git status"));
        assert!(is_likely_safe("git log"));
        assert!(is_likely_safe("pwd"));
        assert!(is_likely_safe("echo hello"));
    }

    #[test]
    fn test_dangerous_commands() {
        assert!(is_dangerous("rm -rf /"));
        // sudo gets detected via the determine_risk function
        let analysis = analyze_bash_command("sudo anything");
        assert_eq!(analysis.risk, CommandRisk::Dangerous);
        assert!(is_dangerous("shutdown now"));
        assert!(is_dangerous("mkfs.ext4 /dev/sda"));
    }

    #[test]
    fn test_git_subcommands() {
        // Safe git commands
        assert!(is_likely_safe("git status"));
        assert!(is_likely_safe("git log"));
        assert!(is_likely_safe("git diff"));
        assert!(is_likely_safe("git branch"));
        assert!(is_likely_safe("git branch -a"));
        assert!(is_likely_safe("git tag"));
        assert!(is_likely_safe("git tag -l 'v*'"));
        assert!(is_likely_safe("git stash list"));
        assert!(is_likely_safe("git config user.name"));
        assert!(is_likely_safe("git config --get user.name"));

        // Dangerous git commands
        let analysis = analyze_bash_command("git reset --hard");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);

        let analysis = analyze_bash_command("git push --force");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
    }

    #[test]
    fn test_git_mutating_args_require_approval() {
        for cmd in [
            "git branch -D feature",
            "git branch -d feature",
            "git branch --delete feature",
            "git branch new-branch",
            "git tag -d v1.0",
            "git tag v1.0",
            "git remote add origin https://example.com/repo.git",
            "git remote set-url origin https://evil.example/repo.git",
            "git remote remove origin",
            "git remote prune origin",
            "git stash drop",
            "git stash clear",
            "git config user.name evil",
            "git config --unset user.name",
        ] {
            let analysis = analyze_bash_command(cmd);
            assert_eq!(
                analysis.risk,
                CommandRisk::RequiresApproval,
                "expected approval for: {cmd}"
            );
        }
    }

    #[test]
    fn test_pipes() {
        // Safe pipe
        assert!(is_likely_safe("cat file | grep pattern"));
        assert!(is_likely_safe("ls -la | head"));

        // Unsafe pipe (unknown command)
        let analysis = analyze_bash_command("cat file | custom_cmd");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
    }

    #[test]
    fn quoted_shell_operators_are_not_parsed_as_commands() {
        let analysis = analyze_bash_command("printf '%s|%s;still-one-command' left right");
        assert_eq!(analysis.commands.len(), 1);
        assert_eq!(analysis.commands[0].program, "printf");
        assert!(!analysis.has_pipes);
    }

    #[test]
    fn malformed_bash_requires_approval() {
        let analysis = analyze_bash_command("echo $(unterminated");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
        assert!(analysis.reason.contains("could not be parsed"));
    }

    #[test]
    fn test_redirects() {
        let analysis = analyze_bash_command("echo hello > file.txt");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
    }

    #[test]
    fn test_command_substitution() {
        let analysis = analyze_bash_command("echo $(whoami)");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);

        let analysis = analyze_bash_command("echo `date`");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
    }

    #[test]
    fn test_tokenize() {
        let tokens = tokenize("echo 'hello world' \"foo bar\"");
        assert_eq!(tokens, vec!["echo", "hello world", "foo bar"]);
    }

    #[test]
    fn test_skip_wrappers() {
        let tokens = tokenize("env VAR=value nice -n 10 myprogram arg1");
        let (program, args) = skip_wrappers(&tokens);
        assert_eq!(program, "myprogram");
        assert_eq!(args, &["arg1"]);
    }

    #[test]
    fn test_sudo_wrapper() {
        // sudo is NOT skipped because it's a privilege escalation indicator
        let tokens = tokenize("sudo -u root rm -rf /tmp/test");
        let (program, _) = skip_wrappers(&tokens);
        assert_eq!(program, "sudo");

        // But env and nice ARE skipped
        let tokens = tokenize("env VAR=value sudo rm -rf /tmp");
        let (program, _) = skip_wrappers(&tokens);
        assert_eq!(program, "sudo");
    }

    #[test]
    fn test_complex_command() {
        let analysis = analyze_bash_command("cd /tmp && git clone repo && npm install");
        assert!(analysis.commands.len() >= 2);
    }

    #[test]
    fn test_empty_command() {
        let analysis = analyze_bash_command("");
        assert_eq!(analysis.risk, CommandRisk::Safe);
        assert!(analysis.commands.is_empty());
    }
}
