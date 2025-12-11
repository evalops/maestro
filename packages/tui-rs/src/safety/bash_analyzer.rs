//! Bash Command Analyzer
//!
//! Analyzes shell commands for safety without tree-sitter dependency.
//! Uses regex-based parsing to extract command structure and determine risk.

use std::collections::HashSet;

use once_cell::sync::Lazy;

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
static SAFE_COMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
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
static SAFE_GIT_SUBCOMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
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

/// Dangerous git subcommands that require approval
static DANGEROUS_GIT_SUBCOMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
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
static DANGEROUS_COMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
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
static CONDITIONALLY_DANGEROUS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "mv", "cp", "tar", "zip", "unzip", "gzip", "gunzip", "curl", "wget", "scp", "rsync",
    ]
    .into_iter()
    .collect()
});

/// Analyze a bash command for safety
pub fn analyze_bash_command(command: &str) -> BashAnalysis {
    let trimmed = command.trim();

    // Check for shell features
    let has_pipes = trimmed.contains('|');
    let has_redirects = trimmed.contains('>') || trimmed.contains('<');
    let has_subshell = trimmed.contains('(') && trimmed.contains(')');
    let has_background = trimmed.contains('&') && !trimmed.contains("&&");
    let has_command_substitution = trimmed.contains("$(") || trimmed.contains('`');

    // Try to parse commands
    let commands = parse_commands(trimmed);

    // Determine overall risk
    let (risk, reason) = determine_risk(
        &commands,
        has_pipes,
        has_redirects,
        has_command_substitution,
    );

    BashAnalysis {
        risk,
        reason,
        commands,
        has_pipes,
        has_redirects,
        has_subshell,
        has_background,
        has_command_substitution,
    }
}

/// Parse a command string into individual commands
fn parse_commands(input: &str) -> Vec<ParsedCommand> {
    let mut commands = Vec::new();

    // Split by common separators (simplified parsing)
    // Note: This is a simplified parser - a full parser would use tree-sitter
    let parts: Vec<&str> = input
        .split(['|', ';', '\n'].as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    for part in parts {
        // Handle && and ||
        let subparts: Vec<&str> = part
            .split("&&")
            .flat_map(|s| s.split("||"))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        for subpart in subparts {
            if let Some(cmd) = parse_single_command(subpart) {
                commands.push(cmd);
            }
        }
    }

    commands
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
        args: args.iter().map(|s| s.to_string()).collect(),
        raw: trimmed.to_string(),
    })
}

/// Tokenize a command string, respecting quotes
fn tokenize(input: &str) -> Vec<String> {
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
                format!("Dangerous command: {}", program),
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
                reason = format!("Git {} can modify repository", subcommand);
            } else if !SAFE_GIT_SUBCOMMANDS.contains(subcommand.as_str())
                && highest_risk == CommandRisk::Safe
            {
                highest_risk = CommandRisk::RequiresApproval;
                reason = format!("Unknown git subcommand: {}", subcommand);
            }
            continue;
        }

        // Check for conditionally dangerous commands
        if CONDITIONALLY_DANGEROUS.contains(program) {
            if highest_risk == CommandRisk::Safe {
                highest_risk = CommandRisk::RequiresApproval;
                reason = format!("{} may modify files", program);
            }
            continue;
        }

        // Check if command is safe
        if !SAFE_COMMANDS.contains(program) && highest_risk == CommandRisk::Safe {
            highest_risk = CommandRisk::RequiresApproval;
            reason = format!("Unknown command: {}", program);
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
                    && SAFE_GIT_SUBCOMMANDS.contains(cmd.args[0].to_lowercase().as_str()))
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
pub fn is_likely_safe(command: &str) -> bool {
    let analysis = analyze_bash_command(command);
    analysis.risk == CommandRisk::Safe
}

/// Quick check if a command is dangerous
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

        // Dangerous git commands
        let analysis = analyze_bash_command("git reset --hard");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);

        let analysis = analyze_bash_command("git push --force");
        assert_eq!(analysis.risk, CommandRisk::RequiresApproval);
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
