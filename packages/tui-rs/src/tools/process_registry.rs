//! Global Process Registry for Background Process Tracking
//!
//! This module provides a centralized registry for tracking background processes
//! spawned by the bash tool. It enables cleanup of all tracked processes on
//! application exit (SIGINT/SIGTERM).
//!
//! # Usage
//!
//! ```rust,ignore
//! use composer_tui::tools::process_registry;
//!
//! // Register a background process
//! process_registry::register(12345);
//!
//! // Unregister when it completes
//! process_registry::unregister(12345);
//!
//! // Kill all tracked processes on shutdown
//! process_registry::cleanup_all();
//! ```
//!
//! # Thread Safety
//!
//! The registry uses `RwLock` for thread-safe access across the async runtime.
//! It's safe to register and unregister from multiple tasks concurrently.

use std::collections::HashSet;
use std::sync::RwLock;

use once_cell::sync::Lazy;

use super::process_utils::kill_process_tree;

/// Global registry of tracked background process IDs
static PROCESS_REGISTRY: Lazy<RwLock<ProcessRegistry>> =
    Lazy::new(|| RwLock::new(ProcessRegistry::new()));

/// Process registry for tracking background processes
#[derive(Debug)]
pub struct ProcessRegistry {
    /// Set of tracked process IDs
    pids: HashSet<u32>,
}

impl ProcessRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            pids: HashSet::new(),
        }
    }

    /// Register a process ID for tracking
    pub fn register(&mut self, pid: u32) {
        self.pids.insert(pid);
    }

    /// Unregister a process ID (e.g., when it completes)
    pub fn unregister(&mut self, pid: u32) -> bool {
        self.pids.remove(&pid)
    }

    /// Get all tracked PIDs
    pub fn pids(&self) -> Vec<u32> {
        self.pids.iter().copied().collect()
    }

    /// Get count of tracked processes
    pub fn count(&self) -> usize {
        self.pids.len()
    }

    /// Clear all tracked PIDs
    pub fn clear(&mut self) {
        self.pids.clear();
    }
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global API Functions
// ─────────────────────────────────────────────────────────────────────────────

/// Register a process for tracking
///
/// Call this when spawning a background process so it can be cleaned up on exit.
pub fn register(pid: u32) {
    if let Ok(mut registry) = PROCESS_REGISTRY.write() {
        registry.register(pid);
        eprintln!("[process_registry] Registered background process: {}", pid);
    }
}

/// Unregister a process (e.g., when it completes naturally)
///
/// Call this when a tracked process exits normally to avoid killing it on shutdown.
pub fn unregister(pid: u32) {
    if let Ok(mut registry) = PROCESS_REGISTRY.write() {
        if registry.unregister(pid) {
            eprintln!("[process_registry] Unregistered process: {}", pid);
        }
    }
}

/// Get the number of tracked processes
pub fn count() -> usize {
    PROCESS_REGISTRY.read().map(|r| r.count()).unwrap_or(0)
}

/// Get list of all tracked PIDs
pub fn tracked_pids() -> Vec<u32> {
    PROCESS_REGISTRY
        .read()
        .map(|r| r.pids())
        .unwrap_or_default()
}

/// Check if a process is still running
#[cfg(unix)]
fn is_process_running(pid: u32) -> bool {
    // kill(pid, 0) checks if process exists without sending a signal
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn is_process_running(_pid: u32) -> bool {
    // On non-Unix, assume it's running to be safe
    true
}

/// Cleanup all tracked processes
///
/// This should be called on application shutdown (SIGINT, SIGTERM, or normal exit)
/// to ensure no orphan processes are left running.
///
/// # Returns
///
/// The number of processes that were killed.
pub fn cleanup_all() -> usize {
    let pids = match PROCESS_REGISTRY.write() {
        Ok(mut registry) => {
            let pids = registry.pids();
            registry.clear();
            pids
        }
        Err(_) => return 0,
    };

    if pids.is_empty() {
        return 0;
    }

    eprintln!(
        "[process_registry] Cleaning up {} background process(es)...",
        pids.len()
    );

    let mut killed = 0;
    for pid in pids {
        if is_process_running(pid) {
            eprintln!("[process_registry] Killing process tree: {}", pid);
            kill_process_tree(pid);
            killed += 1;
        } else {
            eprintln!("[process_registry] Process {} already exited", pid);
        }
    }

    if killed > 0 {
        eprintln!(
            "[process_registry] Cleaned up {} background process(es)",
            killed
        );
    }

    killed
}

/// Cleanup a specific process and unregister it
///
/// Useful for stopping a specific background process.
pub fn cleanup_one(pid: u32) -> bool {
    // Unregister first
    if let Ok(mut registry) = PROCESS_REGISTRY.write() {
        if !registry.unregister(pid) {
            return false; // Not tracked
        }
    }

    // Then kill
    if is_process_running(pid) {
        eprintln!("[process_registry] Killing process tree: {}", pid);
        kill_process_tree(pid);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_new() {
        let registry = ProcessRegistry::new();
        assert_eq!(registry.count(), 0);
    }

    #[test]
    fn test_registry_register_unregister() {
        let mut registry = ProcessRegistry::new();

        registry.register(1234);
        assert_eq!(registry.count(), 1);
        assert!(registry.pids().contains(&1234));

        registry.register(5678);
        assert_eq!(registry.count(), 2);

        assert!(registry.unregister(1234));
        assert_eq!(registry.count(), 1);
        assert!(!registry.pids().contains(&1234));

        // Unregistering non-existent returns false
        assert!(!registry.unregister(1234));
    }

    #[test]
    fn test_registry_clear() {
        let mut registry = ProcessRegistry::new();
        registry.register(1);
        registry.register(2);
        registry.register(3);
        assert_eq!(registry.count(), 3);

        registry.clear();
        assert_eq!(registry.count(), 0);
    }

    #[test]
    fn test_registry_duplicate() {
        let mut registry = ProcessRegistry::new();
        registry.register(1234);
        registry.register(1234); // Duplicate
        assert_eq!(registry.count(), 1); // HashSet deduplicates
    }
}
