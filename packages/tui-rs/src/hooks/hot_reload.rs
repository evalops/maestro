//! Hot reload support for the hook system
//!
//! Watches hook configuration files and scripts for changes,
//! automatically reloading them when modified.

use super::integration::IntegratedHookSystem;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[cfg(feature = "hot-reload")]
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

#[cfg(feature = "hot-reload")]
use std::sync::mpsc::{channel, Receiver};

/// Event indicating hooks should be reloaded
#[derive(Debug, Clone)]
pub enum HotReloadEvent {
    /// A hook file was modified
    FileModified(PathBuf),
    /// A hook file was created
    FileCreated(PathBuf),
    /// A hook file was deleted
    FileDeleted(PathBuf),
    /// Configuration file changed
    ConfigChanged,
}

/// Hot reload watcher for hook files
#[cfg(feature = "hot-reload")]
pub struct HotReloader {
    /// The file watcher
    _watcher: RecommendedWatcher,
    /// Channel receiver for events
    rx: Receiver<Result<Event, notify::Error>>,
    /// Paths being watched
    watched_paths: Vec<PathBuf>,
}

#[cfg(feature = "hot-reload")]
impl HotReloader {
    /// Create a new hot reloader watching the given paths
    pub fn new(paths: &[PathBuf]) -> Result<Self> {
        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        )?;

        let mut watched_paths = Vec::new();

        for path in paths {
            if path.exists() {
                watcher.watch(path, RecursiveMode::Recursive)?;
                watched_paths.push(path.clone());
            }
        }

        Ok(Self {
            _watcher: watcher,
            rx,
            watched_paths,
        })
    }

    /// Create a hot reloader for the default hook directories
    pub fn for_cwd(cwd: &Path) -> Result<Self> {
        let mut paths = Vec::new();

        // Project-local hooks
        let local_hooks = cwd.join(".composer").join("hooks");
        if local_hooks.exists() {
            paths.push(local_hooks);
        }

        // Project-local config
        let local_config = cwd.join(".composer").join("hooks.toml");
        if local_config.exists() {
            paths.push(local_config);
        }

        // Global hooks
        if let Some(home) = dirs::home_dir() {
            let global_hooks = home.join(".composer").join("hooks");
            if global_hooks.exists() {
                paths.push(global_hooks);
            }

            let global_config = home.join(".composer").join("hooks.toml");
            if global_config.exists() {
                paths.push(global_config);
            }
        }

        Self::new(&paths)
    }

    /// Check for pending events (non-blocking)
    pub fn poll(&self) -> Vec<HotReloadEvent> {
        let mut events = Vec::new();

        while let Ok(result) = self.rx.try_recv() {
            if let Ok(event) = result {
                for path in event.paths {
                    let reload_event = match event.kind {
                        notify::EventKind::Modify(_) => {
                            if path.ends_with("hooks.toml") {
                                HotReloadEvent::ConfigChanged
                            } else {
                                HotReloadEvent::FileModified(path)
                            }
                        }
                        notify::EventKind::Create(_) => HotReloadEvent::FileCreated(path),
                        notify::EventKind::Remove(_) => HotReloadEvent::FileDeleted(path),
                        _ => continue,
                    };
                    events.push(reload_event);
                }
            }
        }

        events
    }

    /// Get the paths being watched
    pub fn watched_paths(&self) -> &[PathBuf] {
        &self.watched_paths
    }
}

// Stub implementation when hot-reload feature is not enabled
#[cfg(not(feature = "hot-reload"))]
pub struct HotReloader {
    watched_paths: Vec<PathBuf>,
}

#[cfg(not(feature = "hot-reload"))]
impl HotReloader {
    pub fn new(_paths: &[PathBuf]) -> Result<Self> {
        Ok(Self {
            watched_paths: Vec::new(),
        })
    }

    pub fn for_cwd(_cwd: &Path) -> Result<Self> {
        Ok(Self {
            watched_paths: Vec::new(),
        })
    }

    pub fn poll(&self) -> Vec<HotReloadEvent> {
        Vec::new()
    }

    pub fn watched_paths(&self) -> &[PathBuf] {
        &self.watched_paths
    }
}

/// Async task that watches for hook file changes and triggers reloads
pub async fn watch_and_reload(
    hooks: Arc<Mutex<IntegratedHookSystem>>,
    cwd: PathBuf,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) -> Result<()> {
    let reloader = HotReloader::for_cwd(&cwd)?;

    if reloader.watched_paths().is_empty() {
        eprintln!("[hot-reload] No hook directories found to watch");
        return Ok(());
    }

    eprintln!(
        "[hot-reload] Watching {} paths for changes",
        reloader.watched_paths().len()
    );

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                eprintln!("[hot-reload] Shutting down");
                break;
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                let events = reloader.poll();
                if !events.is_empty() {
                    eprintln!("[hot-reload] Detected {} file changes, reloading hooks", events.len());
                    let mut hooks = hooks.lock().await;
                    match hooks.reload() {
                        Ok(result) => {
                            eprintln!(
                                "[hot-reload] Reloaded {} Lua scripts, {} WASM plugins",
                                result.lua_scripts, result.wasm_plugins
                            );
                        }
                        Err(e) => {
                            eprintln!("[hot-reload] Error reloading hooks: {}", e);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hot_reloader_creation() {
        let reloader = HotReloader::new(&[]);
        assert!(reloader.is_ok());
    }

    #[test]
    fn test_poll_returns_empty() {
        let reloader = HotReloader::new(&[]).unwrap();
        let events = reloader.poll();
        assert!(events.is_empty());
    }
}
