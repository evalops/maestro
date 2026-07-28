use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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

pub(crate) fn maestro_home_dir() -> Option<PathBuf> {
    env_path("MAESTRO_HOME").or_else(|| dirs::home_dir().map(|home| home.join(".maestro")))
}

pub(crate) fn legacy_composer_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".composer"))
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

/// Atomically replace a configuration file with private permissions.
pub(crate) fn atomic_private_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("configuration path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("maestro"),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    if let Err(error) = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()
    })() {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{LazyLock, Mutex};

    static ENV_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn restore_env_var(name: &str, value: Option<String>) {
        match value {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
    }

    #[test]
    fn env_path_expands_tilde() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous = env::var("MAESTRO_TEST_ENV_PATH").ok();
        let home = dirs::home_dir().expect("home dir");

        env::set_var("MAESTRO_TEST_ENV_PATH", "~/custom-config.json");

        assert_eq!(
            env_path("MAESTRO_TEST_ENV_PATH"),
            Some(home.join("custom-config.json"))
        );

        restore_env_var("MAESTRO_TEST_ENV_PATH", previous);
    }

    #[test]
    fn maestro_home_dir_uses_env_override() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous = env::var("MAESTRO_HOME").ok();

        env::set_var("MAESTRO_HOME", "/tmp/custom-maestro-home");

        assert_eq!(
            maestro_home_dir(),
            Some(PathBuf::from("/tmp/custom-maestro-home"))
        );

        restore_env_var("MAESTRO_HOME", previous);
    }

    #[test]
    fn maestro_home_dir_falls_back_to_default_home() {
        let _lock = ENV_MUTEX.lock().expect("lock env");
        let previous = env::var("MAESTRO_HOME").ok();
        let home = dirs::home_dir().expect("home dir");

        env::remove_var("MAESTRO_HOME");

        assert_eq!(maestro_home_dir(), Some(home.join(".maestro")));

        restore_env_var("MAESTRO_HOME", previous);
    }
}
