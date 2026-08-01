//! Global Process Registry for Background Process Tracking
//!
//! This module provides a centralized registry for tracking background processes
//! spawned by the bash tool. It enables cleanup of all tracked processes on
//! application exit (SIGINT/SIGTERM).
//!
//! # Usage
//!
//! ```rust,ignore
//! use maestro_tui::tools::process_registry;
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

use std::sync::RwLock;

use super::process_utils::kill_process_tree;

/// Global registry of tracked background process IDs
static PROCESS_REGISTRY: std::sync::LazyLock<RwLock<ProcessRegistry>> =
    std::sync::LazyLock::new(|| RwLock::new(ProcessRegistry::new()));

/// Process registry for tracking background processes.
///
/// The tracked set is a dedup-on-insert `Vec` rather than a `HashSet`: the
/// registry holds a handful of per-session background processes, so linear
/// scans are cheap, iteration order is deterministic (insertion order),
/// initialization needs no OS entropy (std `HashSet`'s random seed reaches a
/// foreign call Kani cannot model), and the flat loops keep the registry's
/// lifecycle machine cheap to verify with Kani (`BTreeSet`'s tree navigation
/// loops do not unwind cleanly either).
#[derive(Debug)]
pub struct ProcessRegistry {
    /// Set of tracked process IDs (deduplicated on insert)
    pids: Vec<u32>,
}

impl ProcessRegistry {
    /// Create a new empty registry
    #[must_use]
    pub fn new() -> Self {
        Self { pids: Vec::new() }
    }

    /// Register a process ID for tracking
    pub fn register(&mut self, pid: u32) {
        if !self.pids.contains(&pid) {
            self.pids.push(pid);
        }
    }

    /// Unregister a process ID (e.g., when it completes)
    pub fn unregister(&mut self, pid: u32) -> bool {
        let Some(index) = self.pids.iter().position(|tracked| *tracked == pid) else {
            return false;
        };
        self.pids.remove(index);
        true
    }

    /// Get all tracked PIDs
    #[must_use]
    pub fn pids(&self) -> Vec<u32> {
        self.pids.clone()
    }

    /// Get count of tracked processes
    #[must_use]
    pub fn count(&self) -> usize {
        self.pids.len()
    }

    /// Clear all tracked PIDs
    pub fn clear(&mut self) {
        self.pids.clear();
    }

    /// Atomically take every tracked PID and leave the registry empty.
    ///
    /// This is the pure state transition behind [`cleanup_all`]'s shutdown
    /// drain: the returned set is exactly what was registered, and no live
    /// registrations remain afterwards. The registry stays usable, so a
    /// background launch that linearizes after the drain is tracked fresh
    /// (and is the next drain's responsibility, not this one's).
    pub fn drain(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pids)
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
        eprintln!("[process_registry] Registered background process: {pid}");
    }
}

/// Unregister a process (e.g., when it completes naturally)
///
/// Call this when a tracked process exits normally to avoid killing it on shutdown.
pub fn unregister(pid: u32) {
    if let Ok(mut registry) = PROCESS_REGISTRY.write() {
        if registry.unregister(pid) {
            eprintln!("[process_registry] Unregistered process: {pid}");
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
    // SAFETY: signal 0 delivers no signal; `kill` only validates that a
    // process with this pid exists, so there is no memory-safety precondition
    // beyond the FFI call itself. Note the inherent PID-reuse race: if `pid`
    // already exited, the OS may have recycled it to an unrelated process,
    // producing a false "running" result. Callers only use this as a
    // liveness hint for registry bookkeeping, not as a security check.
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
        Ok(mut registry) => registry.drain(),
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
            eprintln!("[process_registry] Killing process tree: {pid}");
            kill_process_tree(pid);
            killed += 1;
        } else {
            eprintln!("[process_registry] Process {pid} already exited");
        }
    }

    if killed > 0 {
        eprintln!("[process_registry] Cleaned up {killed} background process(es)");
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
        eprintln!("[process_registry] Killing process tree: {pid}");
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
        assert_eq!(registry.count(), 1); // deduplicated on insert
    }

    #[test]
    fn test_registry_drain() {
        let mut registry = ProcessRegistry::new();
        registry.register(1);
        registry.register(2);
        let drained = registry.drain();
        assert_eq!(drained.len(), 2);
        assert!(drained.contains(&1) && drained.contains(&2));
        assert_eq!(registry.count(), 0);
        // Registry stays usable after a drain.
        registry.register(3);
        assert_eq!(registry.count(), 1);
    }
}

/// Kani proofs for the process-registry lifecycle state machine.
///
/// These harnesses verify the pure invariants that the shutdown/cleanup
/// paths rely on (fork/exec, signal delivery, and the async watcher loop are
/// OS side effects Kani cannot model; those are covered by the integration
/// tests in `tools::bash::tests`):
///
/// 1. register/unregister round-trips (with dedup) preserve the tracked set.
/// 2. `drain` -- the state transition behind shutdown cleanup -- returns
///    exactly the registered set and leaves no live registrations behind.
/// 3. The registry remains usable after a drain: registrations that
///    linearize after a shutdown drain are tracked, never silently lost.
///
/// Run with: `cargo kani -p maestro-tui` (requires the Kani toolchain, see
/// https://model-checking.github.io/kani/install-guide.html).
#[cfg(kani)]
mod kani_proofs {
    use super::*;

    /// Any single registration is tracked, unregisters exactly once, and
    /// leaves the registry empty.
    #[kani::proof]
    #[kani::unwind(4)]
    fn register_unregister_roundtrip() {
        let mut registry = ProcessRegistry::new();
        let pid: u32 = kani::any();
        registry.register(pid);
        assert!(registry.pids().contains(&pid));
        assert_eq!(registry.count(), 1);
        assert!(registry.unregister(pid));
        assert_eq!(registry.count(), 0);
        assert!(!registry.unregister(pid));
    }

    /// Registering the same pid twice is idempotent; unregistering a pid
    /// that was never registered fails and disturbs nothing else.
    #[kani::proof]
    #[kani::unwind(4)]
    fn duplicate_register_is_idempotent_and_unknown_unregister_is_safe() {
        let mut registry = ProcessRegistry::new();
        let pid: u32 = kani::any();
        let other: u32 = kani::any();
        registry.register(pid);
        registry.register(pid);
        assert_eq!(registry.count(), 1);
        assert_eq!(registry.unregister(other), other == pid);
        if other != pid {
            assert!(registry.pids().contains(&pid));
        }
    }

    /// After a drain, no live registrations remain, and the drained output
    /// is exactly the registered set with no duplicates.
    #[kani::proof]
    #[kani::unwind(4)]
    fn drain_returns_exactly_the_registered_set() {
        let mut registry = ProcessRegistry::new();
        let a: u32 = kani::any();
        let b: u32 = kani::any();
        registry.register(a);
        registry.register(b);
        let expected_len = if a == b { 1 } else { 2 };
        let drained = registry.drain();
        assert_eq!(registry.count(), 0, "drain must leave no registrations");
        assert_eq!(drained.len(), expected_len);
        assert!(drained.contains(&a));
        assert!(drained.contains(&b));
    }

    /// A registration that linearizes after a shutdown drain is tracked
    /// fresh: post-drain registrations are never silently dropped, so a
    /// later cleanup still sees them.
    #[kani::proof]
    #[kani::unwind(4)]
    fn registration_after_drain_is_tracked() {
        let mut registry = ProcessRegistry::new();
        let first: u32 = kani::any();
        registry.register(first);
        let _ = registry.drain();
        let second: u32 = kani::any();
        registry.register(second);
        assert_eq!(registry.count(), 1);
        assert!(registry.pids().contains(&second));
        let drained_again = registry.drain();
        assert_eq!(drained_again.len(), 1);
        assert!(drained_again.contains(&second));
        assert_eq!(registry.count(), 0);
    }
}
