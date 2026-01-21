//! Shell environment policy for user-command execution.
//!
//! Filters the process environment before spawning shell commands to avoid
//! leaking credential-like variables into arbitrary commands.

use crate::config::{load_config, ShellEnvironmentPolicy, ShellInherit};
use glob::Pattern;
use std::collections::HashMap;
use std::path::Path;

const CORE_ENV_VARS: [&str; 9] = [
    "HOME", "LOGNAME", "PATH", "SHELL", "USER", "USERNAME", "TMPDIR", "TEMP", "TMP",
];

const DEFAULT_EXCLUDES: [&str; 3] = ["*KEY*", "*SECRET*", "*TOKEN*"];

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

/// Build a filtered shell environment from a base environment.
pub fn build_shell_environment<I>(
    base_env: I,
    policy: Option<&ShellEnvironmentPolicy>,
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
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
        .collect::<std::collections::HashSet<_>>();

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

    if let Some(patterns) = include_only {
        let keys: Vec<String> = env.keys().cloned().collect();
        for key in keys {
            if !matches_any(&key, patterns) {
                env.remove(&key);
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
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
        assert!(env.get("OPENAI_API_KEY").is_none());
        assert!(env.get("GITHUB_TOKEN").is_none());
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
        assert!(env.get("OPENAI_API_KEY").is_none());
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
        assert!(env.get("HOME").is_none());
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
        assert!(env.get("SECRET_TOKEN").is_none());
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
}
