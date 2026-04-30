use std::env;
use std::path::PathBuf;

use crate::safety::expand_tilde;

pub(crate) fn env_path(name: &str) -> Option<PathBuf> {
    env::var(name).ok().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            resolve_env_path(trimmed)
        }
    })
}

pub(crate) fn resolve_env_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let raw = PathBuf::from(trimmed);
    let expanded = expand_tilde(&raw).unwrap_or(raw);
    Some(if expanded.is_absolute() {
        expanded
    } else if let Ok(cwd) = env::current_dir() {
        cwd.join(expanded)
    } else {
        expanded
    })
}

pub(crate) fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in paths {
        if !result.iter().any(|candidate| candidate == &path) {
            result.push(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restore_env_var(name: &str, value: Option<String>) {
        match value {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
    }

    #[test]
    fn env_path_expands_tilde() {
        let previous = env::var("MAESTRO_TEST_ENV_PATH").ok();
        let home = dirs::home_dir().expect("home dir");

        env::set_var("MAESTRO_TEST_ENV_PATH", "~/custom-config.json");

        assert_eq!(
            env_path("MAESTRO_TEST_ENV_PATH"),
            Some(home.join("custom-config.json"))
        );

        restore_env_var("MAESTRO_TEST_ENV_PATH", previous);
    }
}
