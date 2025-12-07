//! Native Sandboxing for Command Execution
//!
//! Ported from OpenAI Codex (MIT License) sandbox implementation.
//! Provides OS-native sandboxing for tool execution:
//!
//! - **macOS**: Seatbelt (sandbox-exec) with SBPL policies
//! - **Linux**: Landlock LSM + seccomp BPF filters
//!
//! ## Usage
//!
//! ```rust,ignore
//! use composer_tui::sandbox::{SandboxPolicy, spawn_sandboxed_command};
//!
//! let policy = SandboxPolicy::WorkspaceWrite {
//!     writable_roots: vec!["/tmp".into()],
//!     network_access: false,
//! };
//!
//! let child = spawn_sandboxed_command(
//!     vec!["ls".into(), "-la".into()],
//!     std::env::current_dir().unwrap(),
//!     &policy,
//!     HashMap::new(),
//! ).await?;
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

// ─────────────────────────────────────────────────────────────
// Sandbox Policy Types
// ─────────────────────────────────────────────────────────────

/// Defines the sandbox restrictions for command execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxPolicy {
    /// No restrictions whatsoever. Use with extreme caution.
    DangerFullAccess,

    /// Read-only access to the entire filesystem. No writes allowed.
    ReadOnly,

    /// Read-only by default, but allows writes to specific directories.
    WorkspaceWrite {
        /// Directories that should be writable (in addition to cwd)
        #[serde(default)]
        writable_roots: Vec<PathBuf>,

        /// Whether outbound network access is allowed
        #[serde(default)]
        network_access: bool,

        /// Exclude TMPDIR environment variable from writable roots
        #[serde(default)]
        exclude_tmpdir_env_var: bool,

        /// Exclude /tmp from writable roots
        #[serde(default)]
        exclude_slash_tmp: bool,
    },
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        Self::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

/// Writable root with optional read-only subpaths
#[derive(Debug, Clone)]
pub struct WritableRoot {
    pub root: PathBuf,
    pub read_only_subpaths: Vec<PathBuf>,
}

impl SandboxPolicy {
    /// Check if policy allows full disk write access
    pub fn has_full_disk_write_access(&self) -> bool {
        matches!(self, Self::DangerFullAccess)
    }

    /// Check if policy allows full disk read access
    pub fn has_full_disk_read_access(&self) -> bool {
        !matches!(self, Self::ReadOnly)
    }

    /// Check if policy allows network access
    pub fn has_full_network_access(&self) -> bool {
        match self {
            Self::DangerFullAccess => true,
            Self::ReadOnly => false,
            Self::WorkspaceWrite { network_access, .. } => *network_access,
        }
    }

    /// Get writable roots including cwd and optionally TMPDIR/tmp
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
                        if tmpdir_path != PathBuf::from("/tmp") {
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

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("Sandbox not supported on this platform")]
    UnsupportedPlatform,

    #[error("Failed to spawn sandboxed process: {0}")]
    SpawnFailed(#[from] std::io::Error),

    #[error("Landlock restriction failed")]
    LandlockRestrict,

    #[error("Seccomp filter failed: {0}")]
    SeccompFailed(String),

    #[error("Seatbelt execution failed: {0}")]
    SeatbeltFailed(String),
}

pub type SandboxResult<T> = Result<T, SandboxError>;

// ─────────────────────────────────────────────────────────────
// Seatbelt Policy (macOS)
// ─────────────────────────────────────────────────────────────

/// Base Seatbelt policy - starts with deny-all and allows basic operations
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
#[cfg(target_os = "macos")]
pub const SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

/// Environment variable set when running inside sandbox
pub const SANDBOX_ENV_VAR: &str = "COMPOSER_SANDBOX";

// ─────────────────────────────────────────────────────────────
// macOS Seatbelt Implementation
// ─────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::CStr;
    use tokio::process::{Child, Command};

    /// Get Darwin user cache directory via confstr.
    ///
    /// # Safety
    /// This function uses FFI to call the C library `confstr` function.
    /// The unsafe blocks are safe because:
    /// 1. The buffer is sized to PATH_MAX+1, which is sufficient for any path
    /// 2. confstr writes a null-terminated string to the buffer
    /// 3. We check the return value before using the buffer
    /// 4. CStr::from_ptr is given a valid null-terminated buffer
    fn get_darwin_user_cache_dir() -> Option<PathBuf> {
        let mut buf = vec![0_i8; (libc::PATH_MAX as usize) + 1];
        // SAFETY: buf is properly sized and mutable. confstr returns 0 on error.
        let len = unsafe { libc::confstr(libc::_CS_DARWIN_USER_CACHE_DIR, buf.as_mut_ptr(), buf.len()) };
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
    pub fn create_seatbelt_args(
        command: Vec<String>,
        policy: &SandboxPolicy,
        cwd: &Path,
    ) -> Vec<String> {
        let (file_write_policy, mut params) = if policy.has_full_disk_write_access() {
            // Full write access
            (r#"(allow file-write* (regex #"^/"))"#.to_string(), Vec::new())
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
                        require_parts.push(format!(r#"(require-not (subpath (param "{ro_param}")))"#));
                        params.push((ro_param, canonical_ro));
                    }
                    policies.push(format!("(require-all {} )", require_parts.join(" ")));
                }
            }

            if policies.is_empty() {
                (String::new(), params)
            } else {
                let file_write_policy = format!(
                    "(allow file-write*\n{}\n)",
                    policies.join(" ")
                );
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

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use landlock::{
        ABI, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetCreatedAttr,
    };
    use seccompiler::{
        apply_filter, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp,
        SeccompCondition, SeccompFilter, SeccompRule, TargetArch,
    };
    use std::collections::BTreeMap;
    use tokio::process::{Child, Command};

    /// Apply Landlock filesystem restrictions to the current thread
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
            .map_err(|e: seccompiler::Error| SandboxError::SeccompFailed(e.to_string()))?;

        apply_filter(&prog).map_err(|e| SandboxError::SeccompFailed(e.to_string()))?;

        Ok(())
    }

    /// Apply sandbox policy to the current thread (for use in child process)
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
    /// Note: The sandbox is applied in a pre_exec hook, so it only affects
    /// the child process, not the parent.
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
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
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
/// Uses the appropriate sandbox mechanism for the current platform:
/// - macOS: Seatbelt (sandbox-exec)
/// - Linux: Landlock + seccomp
///
/// Returns an error on unsupported platforms.
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
        assert!(roots.iter().any(|r| r.root == PathBuf::from("/custom")));
        assert!(roots.iter().any(|r| r.root == PathBuf::from("/workspace")));
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
        let args = create_seatbelt_args(vec!["echo".to_string(), "hello".to_string()], &policy, &cwd);

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
