//! Shell environment policy for user-command execution.
//!
//! Filters the process environment before spawning shell commands to avoid
//! leaking credential-like or loader-injection variables into arbitrary
//! commands.

use crate::config::{ShellEnvironmentPolicy, ShellInherit, load_config};
use glob::Pattern;
use std::collections::{HashMap, HashSet};
use std::path::Path;

const CORE_ENV_VARS: [&str; 9] = [
    "HOME", "LOGNAME", "PATH", "SHELL", "USER", "USERNAME", "TMPDIR", "TEMP", "TMP",
];

const DEFAULT_EXCLUDES: [&str; 10] = [
    "*KEY*",
    "*SECRET*",
    "*TOKEN*",
    "*PASS*",
    "*PWD*",
    "*CREDENTIAL*",
    "*PAT",
    "*AUTH*",
    // Loader-injection variables; pre-main process hardening strips the same
    // names from maestro's own environment (see `crate::process_hardening`).
    "LD_*",
    "DYLD_*",
];
const PLATFORM_WORKER_SURFACE: &str = "platform-agent-runtime";
const PLATFORM_TRUSTED_TOOL_ENV_FLAG: &str = "MAESTRO_PLATFORM_TRUSTED_TOOL_ENV";
const PLATFORM_TRUSTED_TOOL_ENV_ALLOWLIST: [&str; 13] = [
    "CODEX_WORKER_GIT_USERNAME",
    "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT",
    "MAESTRO_PLATFORM_A2A_ENABLED",
    "MAESTRO_AGENT_RUNTIME_A2A_ENABLED",
    "MAESTRO_PLATFORM_A2A_EXTENSIONS",
    "MAESTRO_AGENT_RUNTIME_SERVICE_URL",
    "MAESTRO_PLATFORM_A2A_URL",
    "MAESTRO_AGENT_REGISTRY_SERVICE_URL",
    "MAESTRO_AGENT_RUNTIME_ORG_ID",
    "MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
    "MAESTRO_OBJECTIVE_ID",
    "MAESTRO_EVALOPS_OBJECTIVE_ID",
];

fn matches_any(name: &str, patterns: &[String]) -> bool {
    let name = name.to_lowercase();
    patterns.iter().any(|pattern| {
        let pat = pattern.to_lowercase();
        Pattern::new(&pat)
            .map(|p| p.matches(&name))
            .unwrap_or(false)
    })
}

fn matches_any_static(name: &str, patterns: &[&str]) -> bool {
    let name = name.to_lowercase();
    patterns.iter().any(|pattern| {
        let pat = pattern.to_lowercase();
        Pattern::new(&pat)
            .map(|p| p.matches(&name))
            .unwrap_or(false)
    })
}

fn truthy(value: Option<&String>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn platform_trusted_tool_env_enabled(base: &HashMap<String, String>) -> bool {
    truthy(base.get(PLATFORM_TRUSTED_TOOL_ENV_FLAG))
        && base
            .get("MAESTRO_SURFACE")
            .map(|value| value.trim() == PLATFORM_WORKER_SURFACE)
            .unwrap_or(false)
}

fn restore_platform_trusted_tool_env(
    base: &HashMap<String, String>,
    env: &mut HashMap<String, String>,
    policy: Option<&ShellEnvironmentPolicy>,
    inherit: ShellInherit,
    core_set: &HashSet<String>,
) {
    if !platform_trusted_tool_env_enabled(base) {
        return;
    }
    for key in PLATFORM_TRUSTED_TOOL_ENV_ALLOWLIST {
        if !platform_trusted_tool_env_policy_allows_key(key, policy, inherit, core_set) {
            continue;
        }
        if let Some(value) = base.get(key) {
            env.insert(key.to_string(), value.clone());
        }
    }
}

fn platform_trusted_tool_env_policy_allows_key(
    key: &str,
    policy: Option<&ShellEnvironmentPolicy>,
    inherit: ShellInherit,
    core_set: &HashSet<String>,
) -> bool {
    match inherit {
        ShellInherit::All => {}
        ShellInherit::Core => {
            if !core_set.contains(&key.to_uppercase()) {
                return false;
            }
        }
        ShellInherit::None => return false,
    }

    if let Some(policy) = policy {
        if let Some(patterns) = policy.exclude.as_ref() {
            if matches_any(key, patterns) {
                return false;
            }
        }
        if let Some(patterns) = policy
            .include_only
            .as_ref()
            .filter(|patterns| !patterns.is_empty())
        {
            if !matches_any(key, patterns) {
                return false;
            }
        }
        if policy
            .set
            .as_ref()
            .map(|set| set.contains_key(key))
            .unwrap_or(false)
        {
            return false;
        }
    }

    true
}

/// Build a filtered shell environment from a base environment.
pub fn build_shell_environment<I>(
    base_env: I,
    policy: Option<&ShellEnvironmentPolicy>,
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let base_env: Vec<(String, String)> = base_env.into_iter().collect();
    let base_lookup: HashMap<String, String> = base_env.iter().cloned().collect();
    let inherit = policy.and_then(|p| p.inherit).unwrap_or(ShellInherit::All);
    let ignore_default_excludes = policy
        .and_then(|p| p.ignore_default_excludes)
        .unwrap_or(false);
    let exclude = policy.and_then(|p| p.exclude.as_ref());
    let include_only = policy.and_then(|p| p.include_only.as_ref());
    let set_vars = policy.and_then(|p| p.set.as_ref());

    let mut env: HashMap<String, String> = HashMap::new();
    let core_set = CORE_ENV_VARS
        .iter()
        .map(|name| name.to_uppercase())
        .collect::<HashSet<_>>();

    match inherit {
        ShellInherit::All => {
            for (key, value) in base_env {
                env.insert(key, value);
            }
        }
        ShellInherit::Core => {
            for (key, value) in base_env {
                if core_set.contains(&key.to_uppercase()) {
                    env.insert(key, value);
                }
            }
        }
        ShellInherit::None => {}
    }

    if !ignore_default_excludes {
        let keys: Vec<String> = env.keys().cloned().collect();
        for key in keys {
            if matches_any_static(&key, &DEFAULT_EXCLUDES) {
                env.remove(&key);
            }
        }
    }

    if let Some(patterns) = exclude {
        let keys: Vec<String> = env.keys().cloned().collect();
        for key in keys {
            if matches_any(&key, patterns) {
                env.remove(&key);
            }
        }
    }

    if let Some(set) = set_vars {
        for (key, value) in set {
            env.insert(key.clone(), value.clone());
        }
    }

    if let Some(patterns) = include_only.filter(|patterns| !patterns.is_empty()) {
        let keys: Vec<String> = env.keys().cloned().collect();
        for key in keys {
            if !matches_any(&key, patterns) {
                env.remove(&key);
            }
        }
    }

    restore_platform_trusted_tool_env(&base_lookup, &mut env, policy, inherit, &core_set);

    if let Some(overrides) = overrides {
        for (key, value) in overrides {
            env.insert(key.clone(), value.clone());
        }
    }

    env
}

/// Resolve the shell environment using workspace config and process env.
pub fn resolve_shell_environment(
    workspace_dir: &Path,
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String> {
    let config = load_config(workspace_dir, None);
    let policy = config.shell_environment_policy.as_ref();
    build_shell_environment(std::env::vars(), policy, overrides)
}

/// Resolve the environment values an approver must see before an inline shell
/// command can safely execute.
///
/// This returns the exact filtered child environment passed to
/// `Command::envs`, including inherited executable selectors such as
/// `LD_PRELOAD` and `GIT_ASKPASS`. Approval rendering is responsible for
/// redacting credential-shaped values before display.
pub fn resolve_shell_environment_approval_context(
    workspace_dir: &Path,
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String> {
    let config = load_config(workspace_dir, None);
    let policy = config.shell_environment_policy.as_ref();
    build_shell_environment_approval_context(std::env::vars(), policy, overrides)
}

fn build_shell_environment_approval_context<I>(
    base_env: I,
    policy: Option<&ShellEnvironmentPolicy>,
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    build_shell_environment(base_env, policy, overrides)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn test_default_excludes_strip_loader_injection_vars() {
        let base = env(&[
            ("PATH", "/bin"),
            ("LD_PRELOAD", "/tmp/evil.so"),
            ("LD_PRELOAD_32", "/tmp/evil32.so"),
            ("LD_PRELOAD_64", "/tmp/evil64.so"),
            ("LD_AUDIT", "/tmp/audit.so"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
            ("DYLD_PRINT_LIBRARIES", "1"),
            ("LD_LIBRARY_PATH", "/opt/custom/lib"),
        ]);
        let env = build_shell_environment(base, None, None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("LD_PRELOAD"));
        assert!(!env.contains_key("LD_PRELOAD_32"));
        assert!(!env.contains_key("LD_PRELOAD_64"));
        assert!(!env.contains_key("LD_AUDIT"));
        assert!(!env.contains_key("DYLD_INSERT_LIBRARIES"));
        assert!(!env.contains_key("DYLD_PRINT_LIBRARIES"));
        assert!(!env.contains_key("LD_LIBRARY_PATH"));
    }

    #[test]
    fn test_default_excludes() {
        let base = env(&[
            ("PATH", "/bin"),
            ("OPENAI_API_KEY", "sk-test"),
            ("GITHUB_TOKEN", "ghp-test"),
        ]);
        let env = build_shell_environment(base, None, None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
    }

    #[test]
    fn test_default_excludes_cover_common_secrets() {
        let base = env(&[
            ("PATH", "/bin"),
            ("PGPASSWORD", "postgres-secret"),
            ("DOCKER_PASSWORD", "docker-secret"),
            ("GH_PAT", "github-pat"),
            ("MYSQL_PWD", "mysql-secret"),
            ("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/creds.json"),
            ("AWS_SESSION_TOKEN", "aws-session"),
            ("OAUTH_CLIENT_SECRET", "oauth-secret"),
        ]);
        let env = build_shell_environment(base, None, None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("PGPASSWORD"));
        assert!(!env.contains_key("DOCKER_PASSWORD"));
        assert!(!env.contains_key("GH_PAT"));
        assert!(!env.contains_key("MYSQL_PWD"));
        assert!(!env.contains_key("GOOGLE_APPLICATION_CREDENTIALS"));
        assert!(!env.contains_key("AWS_SESSION_TOKEN"));
        assert!(!env.contains_key("OAUTH_CLIENT_SECRET"));
    }

    #[test]
    fn test_ignore_default_excludes() {
        let base = env(&[("OPENAI_API_KEY", "sk-test"), ("NORMAL", "ok")]);
        let policy = ShellEnvironmentPolicy {
            ignore_default_excludes: Some(true),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"sk-test".to_string()));
        assert_eq!(env.get("NORMAL"), Some(&"ok".to_string()));
    }

    #[test]
    fn test_inherit_core() {
        let base = env(&[
            ("PATH", "/bin"),
            ("HOME", "/home/test"),
            ("OPENAI_API_KEY", "sk-test"),
        ]);
        let policy = ShellEnvironmentPolicy {
            inherit: Some(ShellInherit::Core),
            ignore_default_excludes: Some(true),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert_eq!(env.get("HOME"), Some(&"/home/test".to_string()));
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn test_include_only() {
        let base = env(&[("PATH", "/bin"), ("HOME", "/home/test")]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string()]),
            ignore_default_excludes: Some(true),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("HOME"));
    }

    #[test]
    fn test_set_filtered_by_include_only() {
        let base = env(&[("PATH", "/bin")]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string()]),
            ignore_default_excludes: Some(true),
            set: Some(HashMap::from([(
                "SECRET_TOKEN".to_string(),
                "override".to_string(),
            )])),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("SECRET_TOKEN"));
    }

    #[test]
    fn test_set_kept_when_included() {
        let base = env(&[("PATH", "/bin")]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string(), "SECRET_*".to_string()]),
            ignore_default_excludes: Some(true),
            set: Some(HashMap::from([(
                "SECRET_TOKEN".to_string(),
                "override".to_string(),
            )])),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert_eq!(env.get("SECRET_TOKEN"), Some(&"override".to_string()));
    }

    #[test]
    fn test_overrides_apply_after_policy() {
        let base = env(&[("OPENAI_API_KEY", "sk-test")]);
        let mut overrides = HashMap::new();
        overrides.insert("OPENAI_API_KEY".to_string(), "override".to_string());
        let env = build_shell_environment(base, None, Some(&overrides));
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"override".to_string()));
    }

    #[test]
    fn test_approval_context_matches_filtered_execution_environment() {
        let base = env(&[
            ("HOME", "/home/test"),
            ("BASH_ENV", "/tmp/prelude.sh"),
            ("LD_PRELOAD", "/tmp/inject.so"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GIT_ASKPASS", "/tmp/git-askpass"),
            ("OPENAI_API_KEY", "sk-hidden"),
        ]);
        let overrides = HashMap::from([("MODE".to_string(), "inline".to_string())]);

        let context = build_shell_environment_approval_context(base, None, Some(&overrides));

        assert_eq!(context.get("HOME"), Some(&"/home/test".to_string()));
        assert_eq!(
            context.get("BASH_ENV"),
            Some(&"/tmp/prelude.sh".to_string())
        );
        assert!(
            !context.contains_key("LD_PRELOAD"),
            "loader-injection variables must remain excluded from trusted worker contexts"
        );
        assert_eq!(
            context.get("GIT_ASKPASS"),
            Some(&"/tmp/git-askpass".to_string())
        );
        assert_eq!(context.get("MODE"), Some(&"inline".to_string()));
        assert!(!context.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn test_platform_trusted_tool_env_restores_non_secret_worker_env() {
        let base = env(&[
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("CODEX_WORKER_GIT_USERNAME", "x-access-token"),
            ("GIT_ASKPASS", "/tmp/git-askpass"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GH_TOKEN", "worker-git-credential"),
            ("GITHUB_TOKEN", "worker-git-credential"),
            ("CODEX_WORKER_RUNTIME_TOKEN", "runtime-token"),
            (
                "MAESTRO_PLATFORM_A2A_TOKEN",
                "platform-runtime-token-1234567890",
            ),
            ("MAESTRO_PLATFORM_A2A_ENABLED", "true"),
            ("OPENAI_API_KEY", "sk-should-stay-filtered-1234567890"),
        ]);
        let env = build_shell_environment(base, None, None);
        assert_eq!(
            env.get("CODEX_WORKER_GIT_USERNAME"),
            Some(&"x-access-token".to_string())
        );
        assert_eq!(
            env.get("GIT_ASKPASS"),
            Some(&"/tmp/git-askpass".to_string())
        );
        assert_eq!(env.get("GIT_TERMINAL_PROMPT"), Some(&"0".to_string()));
        assert!(!env.contains_key("GH_TOKEN"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
        assert!(!env.contains_key("CODEX_WORKER_RUNTIME_TOKEN"));
        assert!(!env.contains_key("MAESTRO_PLATFORM_A2A_TOKEN"));
        assert_eq!(
            env.get("MAESTRO_PLATFORM_A2A_ENABLED"),
            Some(&"true".to_string())
        );
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn test_platform_trusted_tool_env_honors_include_only() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GH_TOKEN", "worker-git-credential"),
            ("GITHUB_TOKEN", "worker-git-credential"),
        ]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string()]),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("GH_TOKEN"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
    }

    #[test]
    fn test_platform_trusted_tool_env_does_not_restore_token_include_only_matches() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GH_TOKEN", "worker-git-credential"),
            ("GITHUB_TOKEN", "worker-git-credential"),
        ]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string(), "GH_TOKEN".to_string()]),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("GH_TOKEN"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
    }

    #[test]
    fn test_platform_trusted_tool_env_ignores_empty_include_only() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GIT_ASKPASS", "/tmp/git-askpass"),
        ]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec![]),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert_eq!(
            env.get("GIT_ASKPASS"),
            Some(&"/tmp/git-askpass".to_string())
        );
    }

    #[test]
    fn test_platform_trusted_tool_env_honors_explicit_exclude() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GIT_ASKPASS", "/tmp/git-askpass"),
            ("MAESTRO_PLATFORM_A2A_ENABLED", "true"),
        ]);
        let policy = ShellEnvironmentPolicy {
            exclude: Some(vec!["GIT_ASKPASS".to_string()]),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert!(!env.contains_key("GIT_ASKPASS"));
        assert_eq!(
            env.get("MAESTRO_PLATFORM_A2A_ENABLED"),
            Some(&"true".to_string())
        );
    }

    #[test]
    fn test_platform_trusted_tool_env_honors_explicit_set() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GIT_ASKPASS", "/tmp/git-askpass"),
        ]);
        let policy = ShellEnvironmentPolicy {
            include_only: Some(vec!["PATH".to_string(), "GIT_ASKPASS".to_string()]),
            set: Some(HashMap::from([(
                "GIT_ASKPASS".to_string(),
                "/policy/git-askpass".to_string(),
            )])),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert_eq!(
            env.get("GIT_ASKPASS"),
            Some(&"/policy/git-askpass".to_string())
        );
    }

    #[test]
    fn test_platform_trusted_tool_env_honors_inherit_none() {
        let base = env(&[
            ("PATH", "/bin"),
            ("MAESTRO_SURFACE", PLATFORM_WORKER_SURFACE),
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GH_TOKEN", "worker-git-credential"),
        ]);
        let policy = ShellEnvironmentPolicy {
            inherit: Some(ShellInherit::None),
            ..Default::default()
        };
        let env = build_shell_environment(base, Some(&policy), None);
        assert!(!env.contains_key("PATH"));
        assert!(!env.contains_key("GH_TOKEN"));
    }

    #[test]
    fn test_platform_trusted_tool_env_requires_platform_surface() {
        let base = env(&[
            (PLATFORM_TRUSTED_TOOL_ENV_FLAG, "true"),
            ("GH_TOKEN", "worker-git-credential"),
        ]);
        let env = build_shell_environment(base, None, None);
        assert!(!env.contains_key("GH_TOKEN"));
    }
}
