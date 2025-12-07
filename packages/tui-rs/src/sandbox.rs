//! Native Sandboxing for Command Execution
//!
//! Ported from OpenAI Codex (MIT License) sandbox implementation.
//! Provides OS-native sandboxing for tool execution with platform-specific mechanisms:
//!
//! - **macOS**: Seatbelt (sandbox-exec) with SBPL policies
//! - **Linux**: Landlock LSM + seccomp BPF filters
//! - **Other platforms**: Returns UnsupportedPlatform error
//!
//! -------------------------------------------------------------------------
//! Architecture Overview
//! -------------------------------------------------------------------------
//!
//! This module uses Rust's conditional compilation feature (#[cfg(...)]) to
//! provide platform-specific sandboxing implementations while maintaining a
//! unified public API. The architecture consists of three layers:
//!
//! 1. **Policy Layer**: Platform-agnostic SandboxPolicy enum that describes
//!    security constraints (read-only, workspace write, full access).
//!
//! 2. **Platform Modules**: Separate implementation modules for macOS and Linux,
//!    each implementing the policy in their native sandbox technology.
//!
//! 3. **Public API**: Cross-platform functions (spawn_sandboxed_command, etc.)
//!    that dispatch to the appropriate platform module at compile time.
//!
//! -------------------------------------------------------------------------
//! Conditional Compilation (#[cfg(...)])
//! -------------------------------------------------------------------------
//!
//! Rust's #[cfg] attribute enables compile-time feature gating. This module
//! uses it extensively to include platform-specific code only when building
//! for that target OS:
//!
//! - `#[cfg(target_os = "macos")]` - Only compiled on macOS
//! - `#[cfg(target_os = "linux")]` - Only compiled on Linux
//! - `#[cfg(not(any(...)))]` - Compiled when neither macOS nor Linux
//!
//! The conditional compilation ensures:
//! - No runtime overhead from unused platform code
//! - Dependencies are only included for relevant platforms (landlock on Linux,
//!   seccompiler on Linux, libc::confstr on macOS)
//! - Type-safe compile-time guarantees that platform-specific code won't
//!   accidentally run on the wrong OS
//!
//! Example:
//! ```rust,ignore
//! #[cfg(target_os = "macos")]
//! mod macos {
//!     // This entire module is only compiled on macOS builds
//!     // Other platforms won't see this code at all
//! }
//! ```
//!
//! -------------------------------------------------------------------------
//! macOS: Seatbelt Sandbox
//! -------------------------------------------------------------------------
//!
//! Seatbelt is macOS's application sandboxing mechanism based on the TrustedBSD
//! Mandatory Access Control (MAC) framework. It uses Scheme-like policy files
//! (SBPL - Sandbox Profile Language) to define allowed operations.
//!
//! Process spawning flow:
//! 1. Generate SBPL policy from SandboxPolicy struct
//! 2. Invoke /usr/bin/sandbox-exec with -p <policy>
//! 3. sandbox-exec applies MAC rules and then executes the target command
//!
//! The SBPL policy starts with "deny default" and selectively allows:
//! - Process operations (fork, exec, signal)
//! - Filesystem read/write based on policy
//! - Network access if policy permits
//! - System calls via sysctl whitelist
//!
//! Key implementation details:
//! - Uses Command::new(SEATBELT_EXECUTABLE) to spawn sandbox-exec
//! - Policy parameters are passed as -D<key>=<value> arguments
//! - Canonicalize paths to prevent symlink escapes
//!
//! -------------------------------------------------------------------------
//! Linux: Landlock + seccomp
//! -------------------------------------------------------------------------
//!
//! Linux sandboxing combines two kernel security modules:
//!
//! **Landlock LSM (Linux Security Module)**
//! - Kernel 5.13+ filesystem access control
//! - Unprivileged process self-restriction (no root required)
//! - Path-based access control (read/write permissions per directory)
//!
//! Landlock works by creating a "ruleset" with allowed filesystem access:
//! 1. Create ruleset with access rights (read-only or read-write)
//! 2. Add path rules for allowed directories
//! 3. Call restrict_self() to apply rules to current thread
//! 4. All future operations are restricted by these rules
//!
//! **seccomp BPF (Berkeley Packet Filter)**
//! - System call filtering at kernel level
//! - Used here to block network-related syscalls (connect, bind, listen, etc.)
//! - Allows AF_UNIX sockets but blocks AF_INET/AF_INET6
//! - Returns EPERM for blocked syscalls
//!
//! Process spawning flow:
//! 1. Clone SandboxPolicy and cwd for the pre_exec closure
//! 2. Use Command::pre_exec() to apply sandbox before exec()
//! 3. In pre_exec hook (child process, after fork, before exec):
//!    a. Apply seccomp filter if network is disabled
//!    b. Apply Landlock rules for filesystem restrictions
//! 4. exec() the target command (now sandboxed)
//!
//! SAFETY: pre_exec runs in a forked child process before exec. It must only
//! use async-signal-safe operations. Both Landlock and seccomp syscalls are
//! async-signal-safe, making this pattern safe.
//!
//! -------------------------------------------------------------------------
//! Error Handling
//! -------------------------------------------------------------------------
//!
//! This module uses Rust's Result type with a custom SandboxError enum.
//! The thiserror crate generates Display implementations automatically:
//!
//! - SandboxError::UnsupportedPlatform - Returned on Windows, BSD, etc.
//! - SandboxError::SpawnFailed(io::Error) - Process creation failure
//! - SandboxError::LandlockRestrict - Landlock restriction failed
//! - SandboxError::SeccompFailed(String) - seccomp filter application failed
//! - SandboxError::SeatbeltFailed(String) - Seatbelt execution failed
//!
//! The #[from] attribute on SpawnFailed enables automatic conversion from
//! io::Error using the ? operator:
//! ```rust,ignore
//! let child = Command::new(...).spawn()?; // io::Error -> SandboxError
//! ```
//!
//! -------------------------------------------------------------------------
//! Usage Example
//! -------------------------------------------------------------------------
//!
//! ```rust,ignore
//! use composer_tui::sandbox::{SandboxPolicy, spawn_sandboxed_command};
//!
//! // Define security policy
//! let policy = SandboxPolicy::WorkspaceWrite {
//!     writable_roots: vec!["/tmp".into()],
//!     network_access: false,
//!     exclude_tmpdir_env_var: false,
//!     exclude_slash_tmp: false,
//! };
//!
//! // Spawn sandboxed command (automatically uses Seatbelt or Landlock)
//! let child = spawn_sandboxed_command(
//!     vec!["ls".into(), "-la".into()],
//!     std::env::current_dir().unwrap(),
//!     &policy,
//!     HashMap::new(),
//! ).await?;
//!
//! // Wait for completion
//! let status = child.wait().await?;
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

// ─────────────────────────────────────────────────────────────
// Sandbox Policy Types
// ─────────────────────────────────────────────────────────────

/// Defines the sandbox restrictions for command execution
///
/// This enum uses Rust's powerful enum variant syntax to represent different
/// security policies. Each variant can carry associated data (like WorkspaceWrite's
/// configuration fields).
///
/// # Serde Serialization
///
/// The `#[serde(rename_all = "kebab-case")]` attribute transforms variant names
/// from PascalCase to kebab-case for JSON serialization:
/// - `DangerFullAccess` -> `"danger-full-access"`
/// - `WorkspaceWrite` -> `"workspace-write"`
///
/// # Variants
///
/// - **DangerFullAccess**: Unrestricted access to filesystem, network, and all
///   system resources. Should only be used for trusted commands or when the
///   sandbox causes compatibility issues.
///
/// - **ReadOnly**: Filesystem is read-only everywhere. No writes permitted,
///   no network access. Useful for static analysis tools or read-only queries.
///
/// - **WorkspaceWrite**: The recommended default. Allows reads everywhere but
///   restricts writes to:
///   - The current working directory (cwd)
///   - Explicitly listed writable_roots
///   - /tmp (unless excluded)
///   - $TMPDIR (unless excluded or same as /tmp)
///
///   The .git directory within cwd is automatically marked read-only to prevent
///   accidental repository corruption.
///
/// # Platform Translation
///
/// This platform-agnostic policy is translated to:
/// - **macOS**: Seatbelt SBPL rules (allow/deny filesystem operations)
/// - **Linux**: Landlock path_beneath rules (read/write access per directory)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxPolicy {
    /// No restrictions whatsoever. Use with extreme caution.
    DangerFullAccess,

    /// Read-only access to the entire filesystem. No writes allowed.
    ReadOnly,

    /// Read-only by default, but allows writes to specific directories.
    ///
    /// This variant demonstrates Rust's struct-like enum variants, where each
    /// variant can have named fields. The #[serde(default)] attribute means
    /// these fields are optional in JSON and will use their type's Default
    /// implementation if omitted.
    WorkspaceWrite {
        /// Directories that should be writable (in addition to cwd)
        ///
        /// Paths will be canonicalized to absolute paths to prevent symlink
        /// escapes. If a path cannot be canonicalized (doesn't exist yet),
        /// the original path is used.
        #[serde(default)]
        writable_roots: Vec<PathBuf>,

        /// Whether outbound network access is allowed
        ///
        /// When false:
        /// - macOS: Omits network policy from Seatbelt SBPL
        /// - Linux: Applies seccomp filter blocking socket syscalls
        #[serde(default)]
        network_access: bool,

        /// Exclude TMPDIR environment variable from writable roots
        ///
        /// By default, $TMPDIR is added to writable roots (unless it equals /tmp).
        /// Set this to true to deny writes to $TMPDIR.
        #[serde(default)]
        exclude_tmpdir_env_var: bool,

        /// Exclude /tmp from writable roots
        ///
        /// By default, /tmp is writable for temporary files. Set this to true
        /// to deny writes to /tmp.
        #[serde(default)]
        exclude_slash_tmp: bool,
    },
}

impl Default for SandboxPolicy {
    /// Returns the recommended default: WorkspaceWrite with no network access
    ///
    /// This implementation of the Default trait provides a sensible default
    /// policy that balances security and functionality:
    /// - Allows writes to cwd, /tmp, and $TMPDIR
    /// - No network access
    /// - Read access to entire filesystem
    fn default() -> Self {
        Self::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

/// Represents a writable directory with optional read-only subdirectories
///
/// This struct is used internally when translating SandboxPolicy to platform-specific
/// sandbox rules. It enables fine-grained control like "allow writes to /workspace
/// but deny writes to /workspace/.git".
///
/// # Platform Usage
///
/// - **macOS**: Converted to Seatbelt (require-all (subpath root) (require-not (subpath ro)))
/// - **Linux**: Landlock doesn't support exclusions natively, so read_only_subpaths
///   are not enforced on Linux (limitation of Landlock LSM)
#[derive(Debug, Clone)]
pub struct WritableRoot {
    /// The root directory that should be writable
    pub root: PathBuf,

    /// Subdirectories within root that should remain read-only
    ///
    /// Example: root=/workspace, read_only_subpaths=[/workspace/.git]
    /// Result: Can write to /workspace/src but not /workspace/.git/
    pub read_only_subpaths: Vec<PathBuf>,
}

impl SandboxPolicy {
    /// Check if policy allows full disk write access
    ///
    /// Returns true only for DangerFullAccess variant.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let policy = SandboxPolicy::DangerFullAccess;
    /// assert!(policy.has_full_disk_write_access());
    ///
    /// let policy = SandboxPolicy::default();
    /// assert!(!policy.has_full_disk_write_access());
    /// ```
    pub fn has_full_disk_write_access(&self) -> bool {
        matches!(self, Self::DangerFullAccess)
    }

    /// Check if policy allows full disk read access
    ///
    /// Returns true for DangerFullAccess and WorkspaceWrite (which allows
    /// reads everywhere). Only ReadOnly variant restricts reads.
    ///
    /// Note: The name is slightly misleading - ReadOnly doesn't restrict
    /// reads, it just denies writes.
    pub fn has_full_disk_read_access(&self) -> bool {
        !matches!(self, Self::ReadOnly)
    }

    /// Check if policy allows network access
    ///
    /// # Pattern Matching
    ///
    /// This method demonstrates Rust's match expression for extracting data
    /// from enum variants:
    /// - Use `..` to ignore other fields in WorkspaceWrite variant
    /// - Dereference network_access with * to get bool value
    pub fn has_full_network_access(&self) -> bool {
        match self {
            Self::DangerFullAccess => true,
            Self::ReadOnly => false,
            Self::WorkspaceWrite { network_access, .. } => *network_access,
        }
    }

    /// Get writable roots including cwd and optionally TMPDIR/tmp
    ///
    /// This method computes the complete list of writable directories based on
    /// the policy configuration and current working directory.
    ///
    /// # Behavior by Policy Type
    ///
    /// - **DangerFullAccess**: Returns empty vec (everything writable)
    /// - **ReadOnly**: Returns empty vec (nothing writable)
    /// - **WorkspaceWrite**: Returns vec containing:
    ///   1. User-specified writable_roots
    ///   2. /tmp (unless exclude_slash_tmp is true)
    ///   3. $TMPDIR (unless exclude_tmpdir_env_var is true or equals /tmp)
    ///   4. Current working directory with .git as read-only subpath
    ///
    /// # .git Protection
    ///
    /// The .git directory is automatically marked read-only to prevent:
    /// - Accidental corruption of git metadata
    /// - Sandbox escape via git hooks
    /// - Loss of version control data
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let policy = SandboxPolicy::WorkspaceWrite {
    ///     writable_roots: vec![PathBuf::from("/custom")],
    ///     network_access: false,
    ///     exclude_tmpdir_env_var: false,
    ///     exclude_slash_tmp: false,
    /// };
    ///
    /// let roots = policy.get_writable_roots_with_cwd(Path::new("/workspace"));
    /// // Returns: [/custom, /tmp, $TMPDIR, /workspace (with .git read-only)]
    /// ```
    pub fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot> {
        let mut roots = Vec::new();

        match self {
            Self::DangerFullAccess => {
                // Everything is writable
            }
            Self::ReadOnly => {
                // Nothing is writable
            }
            Self::WorkspaceWrite {
                writable_roots,
                exclude_tmpdir_env_var,
                exclude_slash_tmp,
                ..
            } => {
                // Add user-specified roots
                for root in writable_roots {
                    roots.push(WritableRoot {
                        root: root.clone(),
                        read_only_subpaths: Vec::new(),
                    });
                }

                // Add /tmp unless excluded
                if !exclude_slash_tmp {
                    roots.push(WritableRoot {
                        root: PathBuf::from("/tmp"),
                        read_only_subpaths: Vec::new(),
                    });
                }

                // Add TMPDIR unless excluded
                if !exclude_tmpdir_env_var {
                    if let Ok(tmpdir) = std::env::var("TMPDIR") {
                        let tmpdir_path = PathBuf::from(tmpdir);
                        if tmpdir_path.as_path() != Path::new("/tmp") {
                            roots.push(WritableRoot {
                                root: tmpdir_path,
                                read_only_subpaths: Vec::new(),
                            });
                        }
                    }
                }

                // Add cwd with .git as read-only subpath if present
                let git_dir = cwd.join(".git");
                let read_only_subpaths = if git_dir.exists() {
                    vec![git_dir]
                } else {
                    Vec::new()
                };

                roots.push(WritableRoot {
                    root: cwd.to_path_buf(),
                    read_only_subpaths,
                });
            }
        }

        roots
    }
}

// ─────────────────────────────────────────────────────────────
// Sandbox Errors
// ─────────────────────────────────────────────────────────────

/// Error types for sandbox operations
///
/// This enum uses the thiserror crate to automatically derive the Error trait
/// and Display implementation. The #[error("...")] attribute defines the
/// display message for each variant.
///
/// # Error Conversion with #[from]
///
/// The #[from] attribute on SpawnFailed creates an automatic From<io::Error>
/// implementation, enabling the ? operator to convert io::Error into SandboxError:
///
/// ```rust,ignore
/// let child = Command::new(...).spawn()?; // io::Error auto-converts
/// ```
///
/// Without #[from], you would need to manually map errors:
/// ```rust,ignore
/// let child = Command::new(...).spawn()
///     .map_err(SandboxError::SpawnFailed)?;
/// ```
#[derive(Debug, Error)]
pub enum SandboxError {
    /// Sandbox not supported on this platform (Windows, BSD, etc.)
    #[error("Sandbox not supported on this platform")]
    UnsupportedPlatform,

    /// Process spawning failed (command not found, permission denied, etc.)
    ///
    /// The #[from] attribute enables automatic conversion from std::io::Error
    #[error("Failed to spawn sandboxed process: {0}")]
    SpawnFailed(#[from] std::io::Error),

    /// Landlock restriction failed (Linux only)
    ///
    /// This can occur if:
    /// - Landlock is not supported by the kernel (< 5.13)
    /// - Path rules cannot be created
    /// - restrict_self() syscall fails
    #[error("Landlock restriction failed")]
    LandlockRestrict,

    /// seccomp filter application failed (Linux only)
    ///
    /// Possible causes:
    /// - Unsupported architecture (not x86_64 or aarch64)
    /// - Invalid BPF program
    /// - seccomp syscall failed
    #[error("Seccomp filter failed: {0}")]
    SeccompFailed(String),

    /// Seatbelt execution failed (macOS only)
    ///
    /// Usually indicates:
    /// - sandbox-exec binary not found
    /// - Invalid SBPL policy syntax
    /// - Permission denied
    #[error("Seatbelt execution failed: {0}")]
    SeatbeltFailed(String),
}

/// Type alias for Result with SandboxError
///
/// This pattern is common in Rust to reduce boilerplate. Instead of writing
/// Result<Child, SandboxError> everywhere, we can write SandboxResult<Child>.
pub type SandboxResult<T> = Result<T, SandboxError>;

// ─────────────────────────────────────────────────────────────
// Seatbelt Policy (macOS)
// ─────────────────────────────────────────────────────────────

/// Base Seatbelt policy - starts with deny-all and allows basic operations
///
/// This constant contains the Seatbelt Profile Language (SBPL) baseline policy.
/// SBPL is a Scheme-like language for defining security policies on macOS.
///
/// # Policy Structure
///
/// The policy follows a deny-by-default approach:
/// 1. `(deny default)` - Block everything by default
/// 2. `(allow ...)` - Selectively permit operations
///
/// # Allowed Operations
///
/// - **Process management**: fork, exec, signal within same sandbox
/// - **Basic I/O**: Read user preferences, write to /dev/null
/// - **System info**: Read hardware info via sysctl (CPU, memory, etc.)
/// - **IOKit**: Access RootDomainUserClient for power management
/// - **Mach services**: Directory services, power management
/// - **Pseudo-terminals**: openpty() for interactive commands
///
/// # The #[allow(dead_code)] Attribute
///
/// This attribute suppresses compiler warnings about unused code. It's needed
/// because this constant is only referenced in the `#[cfg(target_os = "macos")]`
/// module. On Linux builds, the constant exists but is never used, triggering
/// a warning without this attribute.
///
/// # Raw String Literals (r#"..."#)
///
/// The r#"..."# syntax is a raw string literal that:
/// - Doesn't require escaping backslashes or quotes
/// - Preserves formatting exactly as written
/// - Useful for embedding other languages (here: Scheme/SBPL)
#[allow(dead_code)] // Only used on macOS
const SEATBELT_BASE_POLICY: &str = r#"(version 1)

; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; Allow cf prefs to work.
(allow user-preference-read)

; process-info
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; sysctls permitted.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable.")
)

; Allow Java to read some CPU info.
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

; IOKit
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient")
)

; needed to look up user info
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
)

; Needed for python multiprocessing on MacOS for the SemLock
(allow ipc-posix-sem)

(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
)

; allow openpty()
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
"#;

/// Network policy for Seatbelt
///
/// This SBPL policy fragment is appended to the base policy when
/// `network_access: true` in WorkspaceWrite or when using DangerFullAccess.
///
/// # Allowed Operations
///
/// - **network-outbound**: Create outbound network connections
/// - **network-inbound**: Accept inbound network connections
/// - **system-socket**: Create system-level sockets
/// - **mach-lookup**: Access network-related system services:
///   - DNS configuration
///   - Network daemon (networkd)
///   - Certificate validation (ocspd, trustd)
///   - Security framework
///
/// # File Operations
///
/// Allows writes to Darwin user cache directory for storing network-related
/// data (DNS cache, certificate cache, etc.). The cache directory path is
/// obtained via confstr(_CS_DARWIN_USER_CACHE_DIR).
#[allow(dead_code)] // Only used on macOS
const SEATBELT_NETWORK_POLICY: &str = r#"
; Network access policies
(allow network-outbound)
(allow network-inbound)
(allow system-socket)

(allow mach-lookup
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.system.opendirectoryd.membership")
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.networkd")
    (global-name "com.apple.ocspd")
    (global-name "com.apple.trustd.agent")
    (global-name "com.apple.SystemConfiguration.DNSConfiguration")
    (global-name "com.apple.SystemConfiguration.configd")
)

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable")
)

(allow file-write*
  (subpath (param "DARWIN_USER_CACHE_DIR"))
)
"#;

/// Path to macOS sandbox-exec binary
///
/// The #[cfg(target_os = "macos")] attribute means this constant only exists
/// in macOS builds. Attempting to use this constant on Linux would result in
/// a compile error.
#[cfg(target_os = "macos")]
pub const SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

/// Environment variable set when running inside sandbox
///
/// This variable is set to "seatbelt" on macOS or "landlock" on Linux when
/// a command is executed in the sandbox. Commands can check this variable
/// to detect sandbox execution and adjust their behavior accordingly.
pub const SANDBOX_ENV_VAR: &str = "COMPOSER_SANDBOX";

// ─────────────────────────────────────────────────────────────
// macOS Seatbelt Implementation
// ─────────────────────────────────────────────────────────────

/// Platform-specific implementation for macOS Seatbelt sandbox
///
/// This module is only compiled when building for macOS (target_os = "macos").
/// It contains all Seatbelt-specific logic for policy generation and process
/// spawning.
///
/// # Module Organization
///
/// Using a module (mod macos) rather than inline #[cfg] blocks provides:
/// - Better code organization and namespace separation
/// - IDE support (autocomplete, navigation) on macOS
/// - Clear separation of platform-specific dependencies
///
/// # Key Functions
///
/// - `get_darwin_user_cache_dir()`: FFI call to get macOS cache directory
/// - `create_seatbelt_args()`: Generate sandbox-exec command arguments
/// - `spawn_under_seatbelt()`: Spawn a process under Seatbelt sandbox
#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::CStr;
    use tokio::process::{Child, Command};

    /// Get Darwin user cache directory via confstr.
    ///
    /// This function uses FFI (Foreign Function Interface) to call the C
    /// standard library function confstr() to retrieve the macOS user cache
    /// directory path. This directory is used for network-related caching.
    ///
    /// # FFI and Unsafe Rust
    ///
    /// Rust's FFI allows calling C functions, but requires `unsafe` blocks
    /// because the compiler cannot verify memory safety across the language
    /// boundary. This function demonstrates proper unsafe usage:
    ///
    /// 1. Create a buffer sized to PATH_MAX + 1 (max path length on Unix)
    /// 2. Call confstr() to write the path to the buffer
    /// 3. Check the return value (0 indicates error)
    /// 4. Convert the C string (null-terminated) to Rust String
    /// 5. Canonicalize the path to resolve symlinks
    ///
    /// # Safety Justification
    ///
    /// The unsafe blocks are safe because:
    /// 1. The buffer is sized to PATH_MAX+1, which is sufficient for any path
    /// 2. confstr writes a null-terminated string to the buffer
    /// 3. We check the return value before using the buffer
    /// 4. CStr::from_ptr is given a valid null-terminated buffer that lives
    ///    for the duration of the call
    ///
    /// # Return Value
    ///
    /// Returns Some(PathBuf) if the cache directory is found, None otherwise.
    /// This follows Rust's Option pattern for optional values instead of
    /// returning null pointers like C would.
    fn get_darwin_user_cache_dir() -> Option<PathBuf> {
        let mut buf = vec![0_i8; (libc::PATH_MAX as usize) + 1];
        // SAFETY: buf is properly sized and mutable. confstr returns 0 on error.
        let len =
            unsafe { libc::confstr(libc::_CS_DARWIN_USER_CACHE_DIR, buf.as_mut_ptr(), buf.len()) };
        if len == 0 {
            return None;
        }
        // SAFETY: confstr writes a null-terminated C string to buf.
        // buf lives for the duration of this call.
        let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
        cstr.to_str()
            .ok()
            .map(PathBuf::from)
            .and_then(|p| p.canonicalize().ok())
    }

    /// Build Seatbelt command arguments
    ///
    /// This function generates the complete argument list for sandbox-exec based
    /// on the provided SandboxPolicy. The result is a Vec<String> that can be
    /// passed to Command::args().
    ///
    /// # Arguments
    ///
    /// - `command`: The command and arguments to execute (e.g., ["ls", "-la"])
    /// - `policy`: The security policy to enforce
    /// - `cwd`: Current working directory (needed for writable roots calculation)
    ///
    /// # Return Value
    ///
    /// Returns a Vec<String> structured as:
    /// ```text
    /// ["-p", "<SBPL_POLICY>", "-DPARAM1=value1", "-DPARAM2=value2", "--", "command", "arg1", "arg2"]
    /// ```
    ///
    /// # SBPL Policy Generation
    ///
    /// The function constructs the SBPL policy by concatenating:
    /// 1. SEATBELT_BASE_POLICY (always included)
    /// 2. File read policy (if policy allows disk reads)
    /// 3. File write policy (generated from writable_roots)
    /// 4. SEATBELT_NETWORK_POLICY (if network_access is true)
    ///
    /// # Parameter Substitution
    ///
    /// Seatbelt supports parameterized policies via -D flags:
    /// - `-DWRITABLE_ROOT_0=/workspace` defines a parameter named WRITABLE_ROOT_0
    /// - In SBPL: `(subpath (param "WRITABLE_ROOT_0"))` references the parameter
    ///
    /// This approach:
    /// - Avoids string injection vulnerabilities
    /// - Allows sandbox-exec to canonicalize paths
    /// - Keeps the policy generation logic separate from path values
    ///
    /// # Path Canonicalization
    ///
    /// All paths are canonicalized (resolved to absolute paths without symlinks)
    /// before being passed as parameters. This prevents sandbox escapes via
    /// symlinks that point outside the allowed directories.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let policy = SandboxPolicy::WorkspaceWrite {
    ///     writable_roots: vec!["/tmp".into()],
    ///     network_access: false,
    ///     exclude_tmpdir_env_var: true,
    ///     exclude_slash_tmp: true,
    /// };
    ///
    /// let args = create_seatbelt_args(
    ///     vec!["ls".into(), "-la".into()],
    ///     &policy,
    ///     Path::new("/workspace"),
    /// );
    ///
    /// // Result:
    /// // ["-p", "<policy>", "-DWRITABLE_ROOT_0=/tmp",
    /// //  "-DWRITABLE_ROOT_1=/workspace", "--", "ls", "-la"]
    /// ```
    pub fn create_seatbelt_args(
        command: Vec<String>,
        policy: &SandboxPolicy,
        cwd: &Path,
    ) -> Vec<String> {
        let (file_write_policy, mut params) = if policy.has_full_disk_write_access() {
            // Full write access
            (
                r#"(allow file-write* (regex #"^/"))"#.to_string(),
                Vec::new(),
            )
        } else {
            let writable_roots = policy.get_writable_roots_with_cwd(cwd);
            let mut policies = Vec::new();
            let mut params = Vec::new();

            for (index, wr) in writable_roots.iter().enumerate() {
                let canonical_root = wr.root.canonicalize().unwrap_or_else(|_| wr.root.clone());
                let root_param = format!("WRITABLE_ROOT_{index}");
                params.push((root_param.clone(), canonical_root));

                if wr.read_only_subpaths.is_empty() {
                    policies.push(format!(r#"(subpath (param "{root_param}"))"#));
                } else {
                    // Build require-not clauses for read-only subpaths
                    let mut require_parts = vec![format!(r#"(subpath (param "{root_param}"))"#)];
                    for (subpath_index, ro) in wr.read_only_subpaths.iter().enumerate() {
                        let canonical_ro = ro.canonicalize().unwrap_or_else(|_| ro.clone());
                        let ro_param = format!("WRITABLE_ROOT_{index}_RO_{subpath_index}");
                        require_parts
                            .push(format!(r#"(require-not (subpath (param "{ro_param}")))"#));
                        params.push((ro_param, canonical_ro));
                    }
                    policies.push(format!("(require-all {} )", require_parts.join(" ")));
                }
            }

            if policies.is_empty() {
                (String::new(), params)
            } else {
                let file_write_policy = format!("(allow file-write*\n{}\n)", policies.join(" "));
                (file_write_policy, params)
            }
        };

        let file_read_policy = if policy.has_full_disk_read_access() {
            "; allow read-only file operations\n(allow file-read*)"
        } else {
            ""
        };

        let network_policy = if policy.has_full_network_access() {
            SEATBELT_NETWORK_POLICY
        } else {
            ""
        };

        // Add Darwin cache dir if available
        if let Some(cache_dir) = get_darwin_user_cache_dir() {
            params.push(("DARWIN_USER_CACHE_DIR".to_string(), cache_dir));
        }

        let full_policy = format!(
            "{SEATBELT_BASE_POLICY}\n{file_read_policy}\n{file_write_policy}\n{network_policy}"
        );

        let mut args = vec!["-p".to_string(), full_policy];

        // Add parameter definitions
        for (key, value) in params {
            args.push(format!("-D{key}={}", value.to_string_lossy()));
        }

        args.push("--".to_string());
        args.extend(command);

        args
    }

    /// Spawn a command under Seatbelt sandbox
    ///
    /// This function is the entry point for spawning sandboxed commands on macOS.
    /// It uses Tokio's async process spawning for non-blocking operation.
    ///
    /// # Arguments
    ///
    /// - `command`: Command and arguments (e.g., vec!["ls", "-la"])
    /// - `cwd`: Working directory for the sandboxed process
    /// - `policy`: Security policy to enforce
    /// - `env`: Environment variables to pass to the process
    ///
    /// # Process Spawning
    ///
    /// The function:
    /// 1. Generates Seatbelt arguments via create_seatbelt_args()
    /// 2. Adds SANDBOX_ENV_VAR=seatbelt to environment
    /// 3. Spawns sandbox-exec with:
    ///    - stdin/stdout/stderr as pipes (for parent communication)
    ///    - Current directory set to cwd
    ///    - Custom environment variables
    ///
    /// # Tokio Process
    ///
    /// Uses `tokio::process::Command` instead of `std::process::Command` to
    /// enable async I/O operations. This allows the caller to await the process
    /// without blocking the async runtime.
    ///
    /// # Return Value
    ///
    /// Returns SandboxResult<Child> where Child is a tokio::process::Child handle.
    /// The caller can use this handle to:
    /// - Read stdout/stderr via child.stdout.take()
    /// - Write to stdin via child.stdin.take()
    /// - Wait for completion via child.wait().await
    /// - Kill the process via child.kill().await
    ///
    /// # Error Handling
    ///
    /// Returns SandboxError::SpawnFailed if Command::spawn() fails. This can
    /// happen if:
    /// - sandbox-exec binary doesn't exist
    /// - Invalid SBPL policy syntax
    /// - Permission denied
    /// - Command in the command vec doesn't exist
    pub async fn spawn_under_seatbelt(
        command: Vec<String>,
        cwd: PathBuf,
        policy: &SandboxPolicy,
        mut env: HashMap<String, String>,
    ) -> SandboxResult<Child> {
        let args = create_seatbelt_args(command, policy, &cwd);
        env.insert(SANDBOX_ENV_VAR.to_string(), "seatbelt".to_string());

        let child = Command::new(SEATBELT_EXECUTABLE)
            .args(&args)
            .current_dir(cwd)
            .envs(env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        Ok(child)
    }
}

// ─────────────────────────────────────────────────────────────
// Linux Landlock + seccomp Implementation
// ─────────────────────────────────────────────────────────────

/// Platform-specific implementation for Linux Landlock + seccomp sandbox
///
/// This module is only compiled when building for Linux (target_os = "linux").
/// It uses two complementary kernel security features:
///
/// 1. **Landlock LSM**: Filesystem access control
/// 2. **seccomp BPF**: System call filtering
///
/// # Why Two Mechanisms?
///
/// - Landlock handles filesystem restrictions (read/write permissions)
/// - seccomp handles network restrictions (blocking socket syscalls)
///
/// Neither alone provides complete sandboxing, but together they offer
/// defense-in-depth similar to macOS Seatbelt.
///
/// # Key Functions
///
/// - `install_landlock_rules()`: Apply filesystem restrictions
/// - `install_network_seccomp_filter()`: Block network syscalls
/// - `apply_sandbox_policy()`: Combine both mechanisms
/// - `spawn_sandboxed()`: Spawn process with pre_exec sandbox application
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use landlock::{
        Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
    };
    use seccompiler::{
        apply_filter, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition,
        SeccompFilter, SeccompRule, TargetArch,
    };
    use std::collections::BTreeMap;
    use tokio::process::{Child, Command};

    /// Apply Landlock filesystem restrictions to the current thread
    ///
    /// Landlock is a Linux Security Module (LSM) introduced in kernel 5.13 that
    /// allows unprivileged processes to restrict their own filesystem access.
    ///
    /// # How Landlock Works
    ///
    /// 1. **Create Ruleset**: Define what access rights exist (read, write, exec, etc.)
    /// 2. **Add Path Rules**: Specify which directories have which access rights
    /// 3. **Restrict Self**: Apply the ruleset to the current thread
    ///
    /// After restriction, any filesystem operation not explicitly allowed is denied.
    ///
    /// # Access Control Model
    ///
    /// This implementation uses a "default deny" model:
    /// - Create ruleset with all access rights (read-write)
    /// - Grant read-only access to "/" (entire filesystem)
    /// - Grant read-write access to /dev/null (needed for stdio)
    /// - Grant read-write access to each path in writable_roots
    ///
    /// # ABI Versioning
    ///
    /// Landlock uses an ABI version system (V1 through V5 as of kernel 6.7).
    /// We use ABI::V5 to get the latest features, but set compatibility to
    /// BestEffort so the code works on older kernels with reduced functionality.
    ///
    /// # Thread Safety
    ///
    /// Landlock restrictions apply to the current thread and all children.
    /// This is why we must call this function in the pre_exec hook (child
    /// process) rather than in the parent.
    ///
    /// # Return Value
    ///
    /// Returns Ok(()) if restrictions were successfully applied and enforced.
    /// Returns Err(SandboxError::LandlockRestrict) if:
    /// - Landlock is not supported by the kernel
    /// - Path rules cannot be created
    /// - Ruleset application fails
    /// - Ruleset status indicates NotEnforced
    fn install_landlock_rules(writable_roots: Vec<PathBuf>) -> SandboxResult<()> {
        let abi = ABI::V5;
        let access_rw = AccessFs::from_all(abi);
        let access_ro = AccessFs::from_read(abi);

        let mut ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(access_rw)
            .map_err(|_| SandboxError::LandlockRestrict)?
            .create()
            .map_err(|_| SandboxError::LandlockRestrict)?
            .add_rules(landlock::path_beneath_rules(&["/"], access_ro))
            .map_err(|_| SandboxError::LandlockRestrict)?
            .add_rules(landlock::path_beneath_rules(&["/dev/null"], access_rw))
            .map_err(|_| SandboxError::LandlockRestrict)?
            .set_no_new_privs(true);

        if !writable_roots.is_empty() {
            ruleset = ruleset
                .add_rules(landlock::path_beneath_rules(&writable_roots, access_rw))
                .map_err(|_| SandboxError::LandlockRestrict)?;
        }

        let status = ruleset
            .restrict_self()
            .map_err(|_| SandboxError::LandlockRestrict)?;

        if status.ruleset == landlock::RulesetStatus::NotEnforced {
            return Err(SandboxError::LandlockRestrict);
        }

        Ok(())
    }

    /// Apply seccomp filter to block network syscalls
    ///
    /// seccomp (secure computing mode) is a Linux kernel feature that restricts
    /// which system calls a process can make. This function uses seccomp-bpf
    /// (Berkeley Packet Filter) to create a programmable syscall filter.
    ///
    /// # BPF Programs
    ///
    /// BPF was originally designed for packet filtering (tcpdump, wireshark) but
    /// has been extended for syscall filtering. A BPF program is a small bytecode
    /// program that runs in the kernel for each syscall attempt.
    ///
    /// # Filter Logic
    ///
    /// This filter uses a default-allow policy:
    /// 1. Most syscalls are allowed (SeccompAction::Allow)
    /// 2. Network syscalls are denied with EPERM error
    /// 3. socket() and socketpair() are conditionally allowed:
    ///    - Allowed if domain == AF_UNIX (Unix domain sockets)
    ///    - Denied if domain != AF_UNIX (network sockets)
    ///
    /// # Blocked Syscalls
    ///
    /// The following syscalls are unconditionally blocked:
    /// - **Connection**: connect, accept, accept4, bind, listen
    /// - **Socket info**: getpeername, getsockname
    /// - **Control**: shutdown, getsockopt, setsockopt
    /// - **I/O**: sendto, sendmsg, sendmmsg, recvmsg, recvmmsg
    /// - **Process tracing**: ptrace (security hardening)
    ///
    /// # Unix Domain Sockets
    ///
    /// AF_UNIX sockets are allowed because they enable local IPC without network
    /// access. Many programs use Unix sockets for:
    /// - Communication with system services (D-Bus, systemd)
    /// - Inter-process communication within the same machine
    /// - X11 display connections
    ///
    /// # BTreeMap Usage
    ///
    /// The seccompiler crate expects syscall rules in a BTreeMap<i64, Vec<SeccompRule>>.
    /// BTreeMap is used instead of HashMap because:
    /// - Deterministic ordering (important for reproducible builds)
    /// - Efficient range queries (not used here, but syscalls are numeric)
    ///
    /// # Architecture Detection
    ///
    /// The filter must match the target architecture (x86_64 or aarch64). This
    /// is detected at compile time using cfg! macro. Other architectures return
    /// UnsupportedPlatform error.
    ///
    /// # Error Propagation
    ///
    /// The function uses .map_err() to convert library-specific errors into
    /// SandboxError::SeccompFailed. This demonstrates Rust's error handling
    /// pattern of converting between error types.
    ///
    /// # Safety
    ///
    /// seccomp filters are irreversible - once applied, they cannot be removed
    /// (only made more restrictive). This is a kernel security guarantee.
    fn install_network_seccomp_filter() -> SandboxResult<()> {
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

        // Block network-related syscalls
        let deny_syscalls = [
            libc::SYS_connect,
            libc::SYS_accept,
            libc::SYS_accept4,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_getpeername,
            libc::SYS_getsockname,
            libc::SYS_shutdown,
            libc::SYS_sendto,
            libc::SYS_sendmsg,
            libc::SYS_sendmmsg,
            libc::SYS_recvmsg,
            libc::SYS_recvmmsg,
            libc::SYS_getsockopt,
            libc::SYS_setsockopt,
            libc::SYS_ptrace,
        ];

        for syscall in deny_syscalls {
            rules.insert(syscall, vec![]); // Empty rule = unconditional match
        }

        // Allow AF_UNIX sockets only
        let unix_only_rule = SeccompRule::new(vec![SeccompCondition::new(
            0, // first argument (domain)
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Ne,
            libc::AF_UNIX as u64,
        )
        .map_err(|e| SandboxError::SeccompFailed(e.to_string()))?])
        .map_err(|e| SandboxError::SeccompFailed(e.to_string()))?;

        rules.insert(libc::SYS_socket, vec![unix_only_rule.clone()]);
        rules.insert(libc::SYS_socketpair, vec![unix_only_rule]);

        let arch = if cfg!(target_arch = "x86_64") {
            TargetArch::x86_64
        } else if cfg!(target_arch = "aarch64") {
            TargetArch::aarch64
        } else {
            return Err(SandboxError::UnsupportedPlatform);
        };

        let filter = SeccompFilter::new(
            rules,
            SeccompAction::Allow,
            SeccompAction::Errno(libc::EPERM as u32),
            arch,
        )
        .map_err(|e| SandboxError::SeccompFailed(e.to_string()))?;

        let prog: BpfProgram = filter
            .try_into()
            .map_err(|e: seccompiler::BackendError| SandboxError::SeccompFailed(e.to_string()))?;

        apply_filter(&prog).map_err(|e| SandboxError::SeccompFailed(e.to_string()))?;

        Ok(())
    }

    /// Apply sandbox policy to the current thread (for use in child process)
    ///
    /// This function combines Landlock and seccomp to enforce the SandboxPolicy.
    /// It is designed to be called from Command::pre_exec() in the child process.
    ///
    /// # Execution Order
    ///
    /// 1. **Apply seccomp first** (if network is disabled)
    ///    - Must come before Landlock because seccomp is irreversible
    ///    - Once applied, even Landlock setup syscalls could be blocked
    /// 2. **Apply Landlock second** (if write restrictions exist)
    ///    - Landlock is also irreversible but less restrictive
    ///
    /// # Policy Translation
    ///
    /// - **DangerFullAccess**: No restrictions applied, function returns immediately
    /// - **ReadOnly**: Only Landlock applied (empty writable_roots)
    /// - **WorkspaceWrite**: Both seccomp and Landlock applied as configured
    ///
    /// # Thread Context
    ///
    /// This function must run in the child process context (after fork, before exec).
    /// Both Landlock and seccomp apply to the current thread and all future children.
    ///
    /// # Error Handling
    ///
    /// Returns the first error encountered. If seccomp fails, Landlock is not
    /// attempted. This fail-fast approach ensures partial sandboxing doesn't
    /// create a false sense of security.
    pub fn apply_sandbox_policy(policy: &SandboxPolicy, cwd: &Path) -> SandboxResult<()> {
        if !policy.has_full_network_access() {
            install_network_seccomp_filter()?;
        }

        if !policy.has_full_disk_write_access() {
            let writable_roots: Vec<PathBuf> = policy
                .get_writable_roots_with_cwd(cwd)
                .into_iter()
                .map(|wr| wr.root)
                .collect();
            install_landlock_rules(writable_roots)?;
        }

        Ok(())
    }

    /// Spawn a sandboxed command on Linux
    ///
    /// This function spawns a command with Landlock + seccomp sandboxing applied
    /// in the child process. It uses Command::pre_exec() to inject the sandbox
    /// restrictions after fork() but before exec().
    ///
    /// # Process Lifecycle
    ///
    /// 1. Parent process calls spawn_sandboxed()
    /// 2. Clone policy and cwd for the pre_exec closure
    /// 3. Configure Command with args, env, stdio
    /// 4. Set pre_exec hook (closure that will run in child)
    /// 5. Call Command::spawn() which forks:
    ///    - Parent: Returns immediately with Child handle
    ///    - Child: Runs pre_exec closure, then execs command
    /// 6. In pre_exec (child process):
    ///    a. Apply seccomp filter (if needed)
    ///    b. Apply Landlock restrictions (if needed)
    ///    c. Return Ok(()) to proceed with exec
    /// 7. Child process execs the target command (now sandboxed)
    ///
    /// # The pre_exec Hook
    ///
    /// Command::pre_exec() accepts a closure that runs in the forked child
    /// between fork() and exec(). This is the ONLY way to apply Landlock on
    /// Linux because:
    /// - Landlock must be applied in the same process that will run the command
    /// - We can't apply it before fork (would sandbox the parent)
    /// - We can't apply it after exec (the new program image is already running)
    ///
    /// # Safety Considerations
    ///
    /// The pre_exec closure is marked `unsafe` because it runs in a forked
    /// child process where:
    /// - Memory is shared with parent (copy-on-write)
    /// - Multi-threaded programs have only the calling thread
    /// - Only async-signal-safe functions are allowed
    ///
    /// Our usage is SAFE because:
    /// 1. The closure uses only owned data (policy_clone, cwd_clone)
    /// 2. No shared mutable state is accessed
    /// 3. apply_sandbox_policy only calls async-signal-safe syscalls:
    ///    - landlock_create_ruleset, landlock_add_rule, landlock_restrict_self
    ///    - seccomp (technically prctl with PR_SET_SECCOMP)
    /// 4. Error handling uses Result, not panicking
    ///
    /// # Move Semantics
    ///
    /// The `move` keyword in the closure captures policy_clone and cwd_clone
    /// by value (transferring ownership into the closure). This is required
    /// because the closure runs in a different process and needs its own copy
    /// of the data.
    ///
    /// # Error Handling
    ///
    /// Errors can occur at two stages:
    /// 1. **Spawn failure**: Returns SandboxError::SpawnFailed immediately
    /// 2. **Sandbox failure**: The pre_exec hook converts SandboxError to
    ///    io::Error via io::Error::other(), causing spawn() to fail
    ///
    /// # Async Process
    ///
    /// Uses tokio::process::Command for async I/O. The caller can await
    /// process completion, read stdout/stderr, or send stdin data without
    /// blocking the async runtime.
    pub async fn spawn_sandboxed(
        command: Vec<String>,
        cwd: PathBuf,
        policy: &SandboxPolicy,
        mut env: HashMap<String, String>,
    ) -> SandboxResult<Child> {
        if command.is_empty() {
            return Err(SandboxError::SpawnFailed(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Empty command",
            )));
        }

        env.insert(SANDBOX_ENV_VAR.to_string(), "landlock".to_string());

        // Clone values needed in pre_exec (moved into the closure)
        let policy_clone = policy.clone();
        let cwd_clone = cwd.clone();

        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..])
            .current_dir(&cwd)
            .envs(env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // SAFETY: The pre_exec hook runs after fork() but before exec() in the child
        // process. This is the only way to apply Landlock sandboxing because:
        // 1. Landlock must be applied in the same process that will exec
        // 2. The closure captures cloned data by value (no shared state)
        // 3. apply_sandbox_policy only uses async-signal-safe syscalls
        //    (landlock_create_ruleset, landlock_add_rule, landlock_restrict_self)
        // 4. The closure does not access any shared mutable state
        //
        // The closure is Send because policy_clone and cwd_clone are owned.
        unsafe {
            cmd.pre_exec(move || {
                apply_sandbox_policy(&policy_clone, &cwd_clone)
                    .map_err(|e| std::io::Error::other(e.to_string()))
            });
        }

        let child = cmd.spawn()?;
        Ok(child)
    }
}

// ─────────────────────────────────────────────────────────────
// Cross-Platform API
// ─────────────────────────────────────────────────────────────

/// Check if sandboxing is available on this platform
///
/// This function performs runtime checks to determine if the native sandbox
/// mechanism is available. The implementation is platform-specific via
/// conditional compilation.
///
/// # Platform Implementations
///
/// **macOS**: Checks if /usr/bin/sandbox-exec exists
/// - Seatbelt is built into macOS, so this file should always exist
/// - If missing, the system may be damaged or extremely old
///
/// **Linux**: Checks if Landlock is enabled in the kernel
/// - Reads /sys/kernel/security/lsm to get active LSM list
/// - Returns true if the string contains "landlock"
/// - Landlock requires kernel 5.13+ and CONFIG_SECURITY_LANDLOCK=y
///
/// **Other platforms**: Always returns false
/// - Windows, BSD, etc. are not supported
///
/// # Usage
///
/// This function should be called before attempting to spawn sandboxed
/// commands to provide graceful degradation:
///
/// ```rust,ignore
/// if is_sandbox_available() {
///     spawn_sandboxed_command(...).await?;
/// } else {
///     // Fall back to unsandboxed execution or warn the user
///     spawn_unsandboxed_command(...).await?;
/// }
/// ```
///
/// # Return Value
///
/// Returns true if sandboxing is available, false otherwise.
pub fn is_sandbox_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new(SEATBELT_EXECUTABLE).exists()
    }
    #[cfg(target_os = "linux")]
    {
        // Check if Landlock is supported
        use std::fs;
        fs::read_to_string("/sys/kernel/security/lsm")
            .map(|s| s.contains("landlock"))
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

/// Get the sandbox type name for the current platform
///
/// Returns a string identifying the sandbox technology used on this platform.
/// This is useful for logging, diagnostics, and user-facing messages.
///
/// # Return Values
///
/// - **macOS**: "seatbelt"
/// - **Linux**: "landlock"
/// - **Other platforms**: "none"
///
/// # Compile-Time Selection
///
/// The return value is determined at compile time via #[cfg] attributes.
/// There is no runtime overhead - the compiler includes only the branch
/// for the target platform.
///
/// # Static Lifetime
///
/// The return type is &'static str, meaning the string slice lives for
/// the entire program duration. This is possible because string literals
/// are stored in the program's read-only data section.
pub fn sandbox_type() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "seatbelt"
    }
    #[cfg(target_os = "linux")]
    {
        "landlock"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "none"
    }
}

/// Spawn a sandboxed command
///
/// This is the main public API for spawning sandboxed commands. It automatically
/// dispatches to the appropriate platform-specific implementation.
///
/// # Platform Dispatch
///
/// The function body contains multiple #[cfg] blocks that are resolved at compile
/// time. Only one implementation is included in the final binary:
///
/// - **macOS builds**: Calls macos::spawn_under_seatbelt()
/// - **Linux builds**: Calls linux::spawn_sandboxed()
/// - **Other platforms**: Returns Err(SandboxError::UnsupportedPlatform)
///
/// # Arguments
///
/// - `command`: Command and arguments as Vec<String> (e.g., vec!["ls", "-la"])
/// - `cwd`: Working directory for the command (must exist)
/// - `policy`: Security policy to enforce (see SandboxPolicy enum)
/// - `env`: Environment variables as HashMap<String, String>
///
/// # Return Value
///
/// Returns SandboxResult<Child> where Child is a tokio::process::Child.
/// The child process is already running when this function returns.
///
/// # Error Handling
///
/// Possible errors:
/// - **UnsupportedPlatform**: Called on Windows, BSD, etc.
/// - **SpawnFailed**: Command doesn't exist, permission denied, sandbox binary missing
/// - **LandlockRestrict**: Landlock not supported or failed to apply (Linux only)
/// - **SeccompFailed**: seccomp filter application failed (Linux only)
/// - **SeatbeltFailed**: Invalid SBPL policy or sandbox-exec failed (macOS only)
///
/// # Usage Example
///
/// ```rust,ignore
/// use composer_tui::sandbox::{SandboxPolicy, spawn_sandboxed_command};
/// use std::collections::HashMap;
///
/// let policy = SandboxPolicy::default();
/// let cwd = std::env::current_dir()?;
/// let env = HashMap::new();
///
/// let mut child = spawn_sandboxed_command(
///     vec!["echo".to_string(), "Hello, sandboxed world!".to_string()],
///     cwd,
///     &policy,
///     env,
/// ).await?;
///
/// let status = child.wait().await?;
/// println!("Exit status: {}", status);
/// ```
///
/// # The #[allow(unused_variables)] Attribute
///
/// This attribute suppresses warnings about unused parameters. It's needed because:
/// - On unsupported platforms, all parameters are unused (only returns error)
/// - The compiler would warn about unused `command`, `cwd`, `policy`, `env`
/// - The attribute tells the compiler this is intentional, not a mistake
#[allow(unused_variables)]
pub async fn spawn_sandboxed_command(
    command: Vec<String>,
    cwd: PathBuf,
    policy: &SandboxPolicy,
    env: HashMap<String, String>,
) -> SandboxResult<tokio::process::Child> {
    #[cfg(target_os = "macos")]
    {
        macos::spawn_under_seatbelt(command, cwd, policy, env).await
    }

    #[cfg(target_os = "linux")]
    {
        linux::spawn_sandboxed(command, cwd, policy, env).await
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(SandboxError::UnsupportedPlatform)
    }
}

/// Spawn a command without sandboxing (for comparison/fallback)
///
/// This function spawns a command without any sandbox restrictions. It's
/// provided as a fallback for situations where sandboxing is unavailable
/// or causes compatibility issues.
///
/// # Use Cases
///
/// - **Unsupported platforms**: Windows, BSD, etc. where native sandboxing unavailable
/// - **Fallback**: When is_sandbox_available() returns false
/// - **Testing**: Compare behavior between sandboxed and unsandboxed execution
/// - **Compatibility**: Some programs don't work properly in sandboxes
///
/// # Security Warning
///
/// This function provides NO security isolation. The command has:
/// - Full filesystem access (read and write)
/// - Full network access
/// - Access to all environment variables
/// - Ability to spawn child processes
///
/// Only use this for trusted commands or when sandboxing is impossible.
///
/// # Arguments
///
/// - `command`: Command and arguments (e.g., vec!["ls", "-la"])
/// - `cwd`: Working directory
/// - `env`: Environment variables
///
/// # Return Value
///
/// Returns SandboxResult<Child> for consistency with spawn_sandboxed_command.
/// The only error is SpawnFailed (e.g., command not found).
///
/// # Implementation
///
/// Directly uses tokio::process::Command with no wrapper or restrictions.
/// This is essentially the same as calling Command::new() directly, but
/// provides a consistent API with spawn_sandboxed_command.
pub async fn spawn_unsandboxed_command(
    command: Vec<String>,
    cwd: PathBuf,
    env: HashMap<String, String>,
) -> SandboxResult<tokio::process::Child> {
    if command.is_empty() {
        return Err(SandboxError::SpawnFailed(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Empty command",
        )));
    }

    let child = tokio::process::Command::new(&command[0])
        .args(&command[1..])
        .current_dir(cwd)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    Ok(child)
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_policy_defaults() {
        let policy = SandboxPolicy::default();
        assert!(!policy.has_full_disk_write_access());
        assert!(policy.has_full_disk_read_access());
        assert!(!policy.has_full_network_access());
    }

    #[test]
    fn test_danger_full_access() {
        let policy = SandboxPolicy::DangerFullAccess;
        assert!(policy.has_full_disk_write_access());
        assert!(policy.has_full_disk_read_access());
        assert!(policy.has_full_network_access());
    }

    #[test]
    fn test_read_only() {
        let policy = SandboxPolicy::ReadOnly;
        assert!(!policy.has_full_disk_write_access());
        assert!(!policy.has_full_disk_read_access());
        assert!(!policy.has_full_network_access());
    }

    #[test]
    fn test_workspace_write_with_network() {
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/custom")],
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        };
        assert!(!policy.has_full_disk_write_access());
        assert!(policy.has_full_disk_read_access());
        assert!(policy.has_full_network_access());
    }

    #[test]
    fn test_get_writable_roots() {
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/custom")],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let cwd = PathBuf::from("/workspace");
        let roots = policy.get_writable_roots_with_cwd(&cwd);

        // Should include /custom and cwd
        assert!(roots
            .iter()
            .any(|r| r.root.as_path() == Path::new("/custom")));
        assert!(roots
            .iter()
            .any(|r| r.root.as_path() == Path::new("/workspace")));
    }

    #[test]
    fn test_sandbox_type() {
        let t = sandbox_type();
        #[cfg(target_os = "macos")]
        assert_eq!(t, "seatbelt");
        #[cfg(target_os = "linux")]
        assert_eq!(t, "landlock");
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert_eq!(t, "none");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_args_basic() {
        use super::macos::create_seatbelt_args;

        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let cwd = std::env::temp_dir();
        let args =
            create_seatbelt_args(vec!["echo".to_string(), "hello".to_string()], &policy, &cwd);

        // Should start with -p (policy)
        assert_eq!(args[0], "-p");
        // Should end with -- echo hello
        assert!(args.contains(&"--".to_string()));
        assert!(args.contains(&"echo".to_string()));
        assert!(args.contains(&"hello".to_string()));
    }

    #[test]
    fn test_policy_serialization() {
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/tmp")],
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        };

        let json = serde_json::to_string(&policy).unwrap();
        let parsed: SandboxPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(policy, parsed);
    }
}
