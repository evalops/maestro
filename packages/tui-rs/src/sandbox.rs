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
//! use maestro_tui::sandbox::{SandboxPolicy, spawn_sandboxed_command};
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
/// security policies. Each variant can carry associated data (like `WorkspaceWrite`'s
/// configuration fields).
///
/// # Serde Serialization
///
/// The `#[serde(rename_all = "kebab-case")]` attribute transforms variant names
/// from `PascalCase` to kebab-case for JSON serialization:
/// - `DangerFullAccess` -> `"danger-full-access"`
/// - `WorkspaceWrite` -> `"workspace-write"`
///
/// # Variants
///
/// - **`DangerFullAccess`**: Unrestricted access to filesystem, network, and all
///   system resources. Should only be used for trusted commands or when the
///   sandbox causes compatibility issues.
///
/// - **`ReadOnly`**: Filesystem is read-only everywhere. No writes permitted,
///   no network access. Useful for static analysis tools or read-only queries.
///
/// - **`WorkspaceWrite`**: The recommended default. Allows reads everywhere but
///   restricts writes to:
///   - The current working directory (cwd)
///   - Explicitly listed `writable_roots`
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
/// - **Linux**: Landlock `path_beneath` rules (read/write access per directory)
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
    /// Returns the recommended default: `WorkspaceWrite` with no network access
    ///
    /// This implementation of the Default trait provides a sensible default
    /// policy that balances security and functionality:
    /// - Allows writes to cwd, /tmp, and $TMPDIR
    /// - No network access
    /// - Read access to entire filesystem
    ///
    /// This is the conservative library default used by callers that don't
    /// have a specific product surface in mind. Interactive and exec sessions
    /// should use [`SandboxPolicy::workspace_write_default`] instead, which
    /// additionally allows network access and a curated set of package-manager
    /// cache directories — see that function's docs for the measurement
    /// behind the difference.
    fn default() -> Self {
        Self::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

impl SandboxPolicy {
    /// Writable roots that toolchains need in order to build inside the
    /// sandbox: a single per-session cache directory under the system temp
    /// dir, created on demand.
    ///
    /// [`sandbox_cache_env`] points every toolchain cache variable at
    /// subdirectories of this root, so `cargo`, `npm`, `pip`, `go`, and the
    /// rest write their caches here instead of into the user's real caches.
    /// The root is per-session, so a session's builds stay warm.
    ///
    /// # Why the real caches are no longer granted
    ///
    /// This function used to return `$CARGO_HOME/registry`, `$CARGO_HOME/git`,
    /// `$CARGO_HOME/.package-cache`, `$CARGO_HOME/.global-cache`,
    /// `$XDG_CACHE_HOME/pip`, `$XDG_CACHE_HOME/uv`, `~/.npm/_cacache`, and
    /// `~/.npm/_logs`, and pre-create the missing ones. Those are the caches a
    /// *later, unsandboxed* build reads. A build script (`build.rs`, an npm
    /// install script, `setup.py`) running inside the sandbox could write a
    /// poisoned artifact into one of them and have it executed outside the
    /// sandbox on the next build. Redirecting the caches removes that path.
    ///
    /// The real caches stay *readable*: every policy allows reads everywhere
    /// and restricts only writes, so a toolchain can still read a populated
    /// `~/.cargo/registry`. It cannot write to it, so the first fetch in a
    /// sandboxed session repopulates the redirected cache instead — see the
    /// cold-cache cost noted on [`sandbox_cache_env`].
    #[must_use]
    pub fn dev_cache_writable_roots() -> Vec<PathBuf> {
        prepare_sandbox_cache_root(sandbox_cache_session_id())
            .map(|root| vec![root])
            .unwrap_or_default()
    }

    /// The default sandbox policy for interactive and exec sessions that do
    /// not explicitly opt out.
    ///
    /// This differs from [`SandboxPolicy::default`] (the conservative library
    /// default) in two measured ways:
    ///
    /// - **`network_access: true`.** Agentic coding sessions routinely need
    ///   outbound network access: `cargo`/`npm` fetching dependencies from a
    ///   registry, `git push`/`git fetch` against a remote, and calling the
    ///   model provider API itself. A `network_access: false` default was
    ///   measured to break all three immediately, which is exactly the
    ///   "users disable it globally on day one" failure mode a sandbox
    ///   default must avoid. This does mean network exfiltration is not
    ///   contained by the default policy — that is a deliberate, documented
    ///   trade-off, not an oversight. Structured allowlists are conservatively
    ///   mapped to no network access until the native policy supports them.
    /// - **`writable_roots: dev_cache_writable_roots()`.** Without these,
    ///   `cargo build` fails to fetch new dependencies (see that function's
    ///   docs).
    ///
    /// Filesystem *writes* outside the workspace/tmp/cache roots remain
    /// contained, which is what actually stops the two demonstrated
    /// allowlist bypasses (`find -fprintf ~/.ssh/authorized_keys`-style
    /// writes and `LD_PRELOAD`-injected writes to `~/.bashrc`-style targets):
    /// both are filesystem-write attacks, not network-exfiltration attacks.
    #[must_use]
    pub fn workspace_write_default() -> Self {
        Self::WorkspaceWrite {
            writable_roots: Self::dev_cache_writable_roots(),
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

/// Directory name under the system temp dir holding redirected sandbox caches.
const SANDBOX_CACHE_DIR: &str = "maestro-sandbox-cache";

/// Stale process caches are reclaimed whenever a Maestro process prepares its
/// own cache. A live process is never removed, even when it runs longer than
/// this interval; the age is the fallback for incomplete directories which
/// never acquired a process marker.
const SANDBOX_CACHE_STALE_AFTER: std::time::Duration = std::time::Duration::from_hours(24);

/// Bound the number of exited-process caches retained for warm diagnostics.
const SANDBOX_CACHE_RETAINED_INACTIVE: usize = 2;

const SANDBOX_CACHE_PROCESS_MARKER: &str = ".maestro-process";

/// The cache session id for this process, generated once on first use.
///
/// One id per process keeps a session's toolchain caches warm across every
/// command it runs, and keeps them separate from any other Maestro process on
/// the same host.
pub fn sandbox_cache_session_id() -> &'static str {
    static SESSION_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SESSION_ID.get_or_init(|| {
        use rand::Rng;
        use std::fmt::Write as _;
        let bytes: [u8; 16] = rand::rng().random();
        bytes
            .iter()
            .fold(String::with_capacity(32), |mut id, byte| {
                let _ = write!(id, "{byte:02x}");
                id
            })
    })
}

/// The directory that [`sandbox_cache_env`] points toolchain caches at.
#[must_use]
pub fn sandbox_cache_root(session_id: &str) -> PathBuf {
    let temp_dir = std::env::temp_dir();
    dunce::canonicalize(&temp_dir)
        .unwrap_or(temp_dir)
        .join(SANDBOX_CACHE_DIR)
        .join(session_id)
}

fn prepare_sandbox_cache_root(session_id: &str) -> std::io::Result<PathBuf> {
    prepare_sandbox_cache_root_in(&std::env::temp_dir(), session_id)
}

fn prepare_sandbox_cache_root_in(temp_dir: &Path, session_id: &str) -> std::io::Result<PathBuf> {
    if Path::new(session_id).components().count() != 1
        || !matches!(
            Path::new(session_id).components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sandbox cache session id must be one path component",
        ));
    }

    let temp_dir = dunce::canonicalize(temp_dir)?;
    ensure_trusted_temp_directory(&temp_dir)?;
    let parent = temp_dir.join(SANDBOX_CACHE_DIR);
    ensure_private_directory(&parent)?;
    reclaim_inactive_sandbox_caches(&parent, session_id)?;

    let root = parent.join(session_id);
    ensure_private_directory(&root)?;
    write_process_marker(&root)?;
    Ok(root)
}

fn ensure_trusted_temp_directory(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "sandbox temp path is not a trusted directory: {}",
                path.display()
            ),
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let mode = metadata.mode();
        let private_to_owner = metadata.uid() == unsafe { libc::geteuid() } && mode & 0o022 == 0;
        let sticky_directory = mode & 0o1000 != 0;
        if !private_to_owner && !sticky_directory {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "sandbox temp directory must be private or sticky: {}",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                let mut builder = std::fs::DirBuilder::new();
                builder.mode(0o700);
                match builder.create(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            #[cfg(not(unix))]
            {
                match std::fs::create_dir(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Err(error) => return Err(error),
    }

    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "sandbox cache path is not a trusted directory: {}",
                path.display()
            ),
        ));
    }

    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd as _;
        use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};

        // Pin and inspect the directory without following a last-component
        // symlink. The fd also makes the permission migration race-free.
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let metadata = directory.metadata()?;
        let mode = metadata.mode() & 0o777;
        if metadata.uid() != unsafe { libc::geteuid() } || mode & 0o022 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "sandbox cache directory must be owned by the current user and private: {}",
                    path.display()
                ),
            ));
        }
        // Older Maestro releases created these directories with 0755. Such a
        // directory was never writable by another user, so it can be safely
        // migrated before any credentials are copied into it. Group/world
        // writable directories were rejected above and are never repaired.
        if mode != 0o700 && unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }

    Ok(())
}

fn write_process_marker(root: &Path) -> std::io::Result<()> {
    use std::io::Write as _;
    let marker = root.join(SANDBOX_CACHE_PROCESS_MARKER);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(marker)?;
    writeln!(file, "{}", std::process::id())
}

fn reclaim_inactive_sandbox_caches(parent: &Path, current_session: &str) -> std::io::Result<()> {
    let mut inactive = Vec::new();
    let now = std::time::SystemTime::now();

    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        if entry.file_name() == current_session {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        // Multiple Maestro/test processes reclaim this shared parent in
        // parallel. Another process may remove an inactive entry after our
        // `read_dir` snapshot but before this metadata lookup; that is already
        // the desired outcome, not a cache-preparation failure.
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or_default();
        let pid = std::fs::read_to_string(entry.path().join(SANDBOX_CACHE_PROCESS_MARKER))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        // Another process may be between creating its directory and writing
        // the marker. Give incomplete directories the full stale interval so
        // concurrent startup can never reclaim an active cache.
        if pid.is_none() && age < SANDBOX_CACHE_STALE_AFTER {
            continue;
        }
        #[cfg(unix)]
        if pid.is_some_and(process_is_alive) {
            continue;
        }
        #[cfg(not(unix))]
        if age < SANDBOX_CACHE_STALE_AFTER {
            // There is no dependency-free cross-platform process probe. Keep
            // recent marked directories and reclaim them by age instead.
            continue;
        }
        inactive.push((entry.path(), modified, age));
    }

    inactive.sort_by_key(|(_, modified, _)| *modified);
    let excess = inactive
        .len()
        .saturating_sub(SANDBOX_CACHE_RETAINED_INACTIVE);
    for (index, (path, _, age)) in inactive.into_iter().enumerate() {
        if index < excess || age >= SANDBOX_CACHE_STALE_AFTER {
            if let Err(error) = std::fs::remove_dir_all(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error);
                }
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Environment variables that redirect toolchain caches into the sandbox's own
/// cache directory.
///
/// # Why this exists
///
/// The alternative is granting the sandbox write access to the user's real
/// caches (`~/.cargo/registry`, `~/.npm/_cacache`, `~/.cache/pip`, ...), which
/// is what [`SandboxPolicy::dev_cache_writable_roots`] used to do. A build
/// script running inside the sandbox could then write a poisoned artifact into
/// a cache that a later *unsandboxed* build reads and executes. Pointing each
/// toolchain at a sandbox-private directory removes that path while leaving
/// the real caches readable.
///
/// # What is deliberately absent
///
/// `RUSTUP_HOME`, `GEM_HOME`, `VOLTA_HOME`, `PIPX_HOME`, and `DENO_DIR` are
/// not redirected because they hold installed executables. `CARGO_HOME` is
/// redirected because Cargo stores registry and Git downloads there; the
/// command's existing PATH and RUSTUP_HOME still select the installed Cargo
/// and Rust toolchain, while [`seed_toolchain_user_config`] preserves Cargo
/// configuration and credentials in the isolated home.
///
/// # Cost
///
/// The first build in a session runs against a cold cache and re-downloads
/// dependencies. Subsequent commands in the same session hit the warm
/// redirected download cache. Cargo build artifacts remain in the caller's
/// workspace-visible target directory.
#[must_use]
pub fn sandbox_cache_env(session_id: &str) -> Vec<(String, String)> {
    let root = sandbox_cache_root(session_id);
    let entry = |name: &str, subdir: &str| {
        (
            name.to_string(),
            root.join(subdir).to_string_lossy().into_owned(),
        )
    };
    vec![
        // npm
        entry("NPM_CONFIG_CACHE", "npm"),
        // pnpm
        entry("npm_config_store_dir", "pnpm-store"),
        // Go
        entry("GOCACHE", "go-build"),
        entry("GOMODCACHE", "go-mod"),
        // Cargo downloads. Build artifacts remain workspace-visible.
        entry("CARGO_HOME", "cargo-home"),
        // Python
        entry("PIP_CACHE_DIR", "pip"),
        entry("UV_CACHE_DIR", "uv"),
        entry("POETRY_CACHE_DIR", "poetry"),
        entry("CONDA_PKGS_DIRS", "conda"),
        // Bun
        entry("BUN_INSTALL_CACHE_DIR", "bun"),
        // Yarn
        entry("YARN_CACHE_FOLDER", "yarn"),
        entry("YARN_GLOBAL_FOLDER", "yarn-global"),
        // node-gyp
        entry("npm_config_devdir", "node-gyp"),
        // Browser automation downloads
        entry("PLAYWRIGHT_BROWSERS_PATH", "playwright"),
        entry("PUPPETEER_CACHE_DIR", "puppeteer"),
        entry("CYPRESS_CACHE_FOLDER", "cypress"),
        // JS monorepo build caches
        entry("TURBO_CACHE_DIR", "turbo"),
        entry("NX_CACHE_DIRECTORY", "nx"),
        // JVM
        entry("GRADLE_USER_HOME", "gradle"),
        // Ruby: spec cache and bundle path only; GEM_HOME holds executables.
        entry("GEM_SPEC_CACHE", "gem-specs"),
        entry("BUNDLE_PATH", "bundle"),
        // PHP
        entry("COMPOSER_CACHE_DIR", "composer"),
        // macOS package manager
        entry("HOMEBREW_CACHE", "homebrew"),
        // .NET
        entry("NUGET_PACKAGES", "nuget"),
        // C/C++
        entry("CCACHE_DIR", "ccache"),
        // iOS
        entry("CP_HOME_DIR", "cocoapods"),
    ]
}

/// Overlay [`sandbox_cache_env`] onto a command environment.
///
/// The redirected download-cache values win over anything the caller inherited.
/// `CARGO_TARGET_DIR` is removed so Cargo uses its normal workspace-local
/// target directory rather than a host path the sandbox cannot safely write.
/// Maven has no dedicated cache environment variable, so its local repository
/// override is appended to `MAVEN_OPTS` instead.
pub fn apply_sandbox_cache_env(
    mut env: HashMap<String, String>,
    session_id: &str,
) -> std::io::Result<HashMap<String, String>> {
    let root = prepare_sandbox_cache_root(session_id)?;
    seed_toolchain_user_config(&env, &root)?;
    for (name, value) in sandbox_cache_env(session_id) {
        env.insert(name, value);
    }
    env.remove("CARGO_TARGET_DIR");
    let maven_repository = root.join("maven").to_string_lossy().into_owned();
    let maven_override = format!("-Dmaven.repo.local={maven_repository}");
    env.entry("MAVEN_OPTS".to_string())
        .and_modify(|value| {
            if !value.is_empty() {
                value.push(' ');
            }
            value.push_str(&maven_override);
        })
        .or_insert(maven_override);
    Ok(env)
}

fn seed_toolchain_user_config(env: &HashMap<String, String>, root: &Path) -> std::io::Result<()> {
    let home = env
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(dirs::home_dir);

    let cargo_source = env
        .get("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_HOME").map(PathBuf::from))
        .or_else(|| home.as_ref().map(|home| home.join(".cargo")));
    if let Some(source) = cargo_source {
        let destination = root.join("cargo-home");
        ensure_private_directory(&destination)?;
        copy_named_config_files(
            &source,
            &destination,
            &["config", "config.toml", "credentials", "credentials.toml"],
        )?;
    }

    let gradle_source = env
        .get("GRADLE_USER_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from))
        .or_else(|| home.map(|home| home.join(".gradle")));
    if let Some(source) = gradle_source {
        let destination = root.join("gradle");
        ensure_private_directory(&destination)?;
        copy_named_config_files(
            &source,
            &destination,
            &["gradle.properties", "init.gradle", "init.gradle.kts"],
        )?;
        copy_config_directory(&source.join("init.d"), &destination.join("init.d"))?;
    }
    Ok(())
}

fn copy_named_config_files(
    source: &Path,
    destination: &Path,
    names: &[&str],
) -> std::io::Result<()> {
    for name in names {
        let source_file = source.join(name);
        let destination_file = destination.join(name);
        match std::fs::symlink_metadata(&source_file) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                remove_path_if_present(&destination_file)?;
                std::fs::copy(&source_file, destination_file)?;
            }
            Ok(_) => remove_path_if_present(&destination_file)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                remove_path_if_present(&destination_file)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn copy_config_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_path_if_present(destination)?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        remove_path_if_present(destination)?;
        return Ok(());
    }
    ensure_private_directory(destination)?;
    let mut copied = std::collections::HashSet::new();
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        copied.insert(entry.file_name());
        let destination_file = destination.join(entry.file_name());
        remove_path_if_present(&destination_file)?;
        std::fs::copy(entry.path(), destination_file)?;
    }
    for entry in std::fs::read_dir(destination)? {
        let entry = entry?;
        if !copied.contains(&entry.file_name()) {
            remove_path_if_present(&entry.path())?;
        }
    }
    Ok(())
}

fn remove_path_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(path)
        }
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Represents a writable directory with optional read-only subdirectories
///
/// This struct is used internally when translating `SandboxPolicy` to platform-specific
/// sandbox rules. It enables fine-grained control like "allow writes to /workspace
/// but deny writes to /workspace/.git".
///
/// # Platform Usage
///
/// - **macOS**: Converted to Seatbelt (require-all (subpath root) (require-not (subpath ro)))
/// - **Linux (stage-1)**: roots with exclusions expand to existing non-excluded
///   children for full RW, plus Make*/Remove* on the root itself. Landlock
///   grants are OR'd within a layer (there is no "most specific wins" /
///   deny-rule), so a RW grant on the root necessarily covers `.git`. Stage-1
///   never grants WriteFile on the root, which keeps `.git` unwritable at the
///   cost of new root children staying empty on content write (MakeReg may
///   still create the name). True stage-2 (create+write new root children
///   without `.git` write) needs bind-mount or a non-`path_beneath` design.
#[derive(Debug, Clone)]
pub struct WritableRoot {
    /// The root directory that should be writable
    pub root: PathBuf,

    /// Subdirectories within root that should remain read-only
    ///
    /// Example: root=/workspace, `read_only_subpaths`=[/workspace/.git]
    /// Result: Can write to /workspace/src but not /workspace/.git/
    pub read_only_subpaths: Vec<PathBuf>,
}

impl SandboxPolicy {
    /// Kebab-case label for this policy's variant, matching the
    /// `MAESTRO_SANDBOX_MODE`/`sandbox_mode` config grammar
    /// (`"danger-full-access"` / `"read-only"` / `"workspace-write"`; see
    /// `parse_sandbox_mode_env_override` in `config.rs`).
    ///
    /// Intended for user-facing messages that need to name the *actual*
    /// active policy rather than assuming one -- e.g. a sandboxed command's
    /// failure guidance. Hard-coding a mode name in that kind of message is
    /// a trap: `MAESTRO_SANDBOX_MODE=read-only` is a real, documented
    /// escape hatch, and a message that always says "workspace-write"
    /// regardless of the actual policy misleads a `ReadOnly` session's user
    /// into thinking in-workspace writes should have worked.
    #[must_use]
    pub fn mode_label(&self) -> &'static str {
        match self {
            Self::DangerFullAccess => "danger-full-access",
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite { .. } => "workspace-write",
        }
    }

    /// Check if policy allows full disk write access
    ///
    /// Returns true only for `DangerFullAccess` variant.
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
    #[must_use]
    pub fn has_full_disk_write_access(&self) -> bool {
        matches!(self, Self::DangerFullAccess)
    }

    /// Check if policy allows full disk read access
    ///
    /// Returns true for `DangerFullAccess` and `WorkspaceWrite` (which allows
    /// reads everywhere). Only `ReadOnly` variant restricts reads.
    ///
    /// Note: The name is slightly misleading - `ReadOnly` doesn't restrict
    /// reads, it just denies writes.
    #[must_use]
    pub fn has_full_disk_read_access(&self) -> bool {
        !matches!(self, Self::ReadOnly)
    }

    /// Check if policy allows network access
    ///
    /// # Pattern Matching
    ///
    /// This method demonstrates Rust's match expression for extracting data
    /// from enum variants:
    /// - Use `..` to ignore other fields in `WorkspaceWrite` variant
    /// - Dereference `network_access` with * to get bool value
    #[must_use]
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
    /// - **`DangerFullAccess`**: Returns empty vec (everything writable)
    /// - **`ReadOnly`**: Returns empty vec (nothing writable)
    /// - **`WorkspaceWrite`**: Returns vec containing:
    ///   1. User-specified `writable_roots`
    ///   2. /tmp (unless `exclude_slash_tmp` is true)
    ///   3. $TMPDIR (unless `exclude_tmpdir_env_var` is true or equals /tmp)
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
    #[must_use]
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

    /// Check whether `path` may be written under this policy, evaluated
    /// against `cwd`.
    ///
    /// # Why this exists
    ///
    /// The OS-level sandbox (Seatbelt on macOS, Landlock on Linux) only
    /// contains processes spawned through [`spawn_sandboxed_command`]. Tools
    /// that mutate files *in the Maestro process itself* — `write`, `edit`,
    /// `notebook_edit` — never go through that spawn path, so the kernel
    /// sandbox provides them no containment at all. Those tools check this
    /// method explicitly (via [`preflight_native_write`]) before any side
    /// effects and then perform the mutation through
    /// [`commit_native_write`], which revalidates this check against the
    /// directory descriptor it writes through so a path swap between check
    /// and write cannot redirect the mutation.
    ///
    /// # Behavior by policy
    ///
    /// - `DangerFullAccess`: always allowed.
    /// - `ReadOnly`: never allowed.
    /// - `WorkspaceWrite`: allowed only if `path` resolves under one of
    ///   [`Self::get_writable_roots_with_cwd`]'s roots and not under one of
    ///   that root's `read_only_subpaths` (e.g. `cwd/.git`).
    ///
    /// Paths are canonicalized with `dunce::canonicalize` (falling back to
    /// the original path when the target does not exist yet, e.g. a new
    /// file being created) so that symlinks and `..` segments cannot be
    /// used to escape a writable root.
    #[must_use]
    pub fn allows_write_to(&self, cwd: &Path, path: &Path) -> bool {
        match self {
            Self::DangerFullAccess => true,
            Self::ReadOnly => false,
            Self::WorkspaceWrite { .. } => {
                if contains_dangling_symlink(path) {
                    return false;
                }
                let candidate = canonicalize_best_effort(path);
                self.get_writable_roots_with_cwd(cwd).iter().any(|wr| {
                    let root = canonicalize_best_effort(&wr.root);
                    if !candidate.starts_with(&root) {
                        return false;
                    }
                    !wr.read_only_subpaths.iter().any(|ro| {
                        let ro = canonicalize_best_effort(ro);
                        candidate.starts_with(&ro)
                    })
                })
            }
        }
    }
}

fn contains_dangling_symlink(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if std::fs::symlink_metadata(candidate).is_ok_and(|meta| meta.file_type().is_symlink())
            && std::fs::metadata(candidate).is_err()
        {
            return true;
        }
        current = candidate.parent();
    }
    false
}

/// Canonicalize `path`, falling back to canonicalizing the longest existing
/// ancestor and rejoining the remaining (not-yet-created) components when
/// `path` itself does not exist.
///
/// [`allows_write_to`](SandboxPolicy::allows_write_to) is most often asked
/// about a file the caller is about to *create* (e.g. `write` on a new
/// file), so a plain `dunce::canonicalize(path)` — which requires every
/// component to exist — would fail for the overwhelming common case. Falling
/// back to the raw, uncanonicalized path in that case is unsound on systems
/// where an *existing* ancestor is itself reached through a symlink (for
/// example macOS's `/tmp` -> `/private/tmp` and `$TMPDIR` under
/// `/var/folders` -> `/private/var/folders`): the writable root would
/// canonicalize to the `/private/...` form while the candidate path would
/// not, so `starts_with` would always fail even for legitimate in-root
/// writes. Canonicalizing the nearest existing ancestor keeps the symlink
/// resolution while still tolerating a path that doesn't exist yet.
fn canonicalize_best_effort(path: &Path) -> PathBuf {
    if let Ok(canonical) = dunce::canonicalize(path) {
        return canonical;
    }

    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent().map(Path::to_path_buf) {
        if parent.as_os_str().is_empty() {
            break;
        }
        if let Some(name) = current.file_name() {
            suffix.push(name.to_os_string());
        }
        if let Ok(canonical_parent) = dunce::canonicalize(&parent) {
            let mut resolved = canonical_parent;
            for part in suffix.iter().rev() {
                resolved.push(part);
            }
            return resolved;
        }
        current = parent;
    }

    path.to_path_buf()
}

// ─────────────────────────────────────────────────────────────
// Atomic native (in-process) file writes
// ─────────────────────────────────────────────────────────────

/// Preflight check for a native (in-process) file mutation under `policy`.
///
/// Returns `Err` with a user-facing message when `policy` denies a write to
/// `path`; `Ok(())` when there is no policy or the write is allowed. This is
/// the early, good-error-message check — callers must still route the actual
/// mutation through [`commit_native_write`], which re-validates against the
/// directory it actually writes into (see its docs for why the preflight
/// alone is not sufficient).
pub(crate) fn preflight_native_write(
    policy: Option<&SandboxPolicy>,
    cwd: &Path,
    path: &Path,
) -> Result<(), String> {
    let Some(policy) = policy else {
        return Ok(());
    };
    if policy.allows_write_to(cwd, path) {
        return Ok(());
    }
    Err(format!(
        "Tool blocked by sandbox policy: {} is outside the sandbox's writable roots",
        path.display()
    ))
}

/// Atomically check-and-write `contents` to `path` under `policy`.
///
/// # Why this exists (TOCTOU)
///
/// [`preflight_native_write`] validates a *path*; the write that follows it
/// is a separate filesystem operation. A background process can swap an
/// in-workspace directory for a symlink pointing outside the writable roots
/// between the two, and a plain `fs::write` would then follow the symlink
/// and write outside the sandbox. To make check-and-write atomic, this
/// function pins the parent directory with an `O_DIRECTORY | O_NOFOLLOW`
/// descriptor, reads the descriptor's *actual* path back from the kernel,
/// runs the policy check against that, and then performs the whole mutation
/// (temp file + rename) relative to the pinned descriptor via
/// `openat`/`renameat`. Swapping the path after the descriptor is opened
/// cannot redirect the write: the directory the bytes land in is the exact
/// directory that was validated.
///
/// With `policy: None` the descriptor-relative write still happens (it is
/// also what gives the write its temp-file-plus-rename atomicity), but no
/// containment check is applied.
///
/// On non-Unix platforms this falls back to a preflight check followed by a
/// path-based temp-file write; the kernel sandbox is unsupported there
/// anyway.
pub(crate) fn commit_native_write(
    policy: Option<&SandboxPolicy>,
    cwd: &Path,
    path: &Path,
    contents: &[u8],
) -> Result<(), String> {
    commit_native_write_impl(policy, cwd, path, contents)
}

#[cfg(unix)]
fn commit_native_write_impl(
    policy: Option<&SandboxPolicy>,
    cwd: &Path,
    path: &Path,
    contents: &[u8],
) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::fd::{AsRawFd as _, FromRawFd as _};
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("path has no parent directory: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("path has no file name: {}", path.display()))?;

    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;

    // Pin the parent directory. O_NOFOLLOW rejects a symlink in the final
    // component; ancestor symlinks are resolved at open time and then
    // validated below via the descriptor's real path.
    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|error| format!("Failed to open directory {}: {error}", parent.display()))?;
    let real_parent = fd_resolved_path(dir.as_raw_fd())
        .map_err(|error| format!("Failed to resolve directory {}: {error}", parent.display()))?;

    // The containment check runs against the directory we actually hold
    // open, so a path swap racing the earlier preflight is caught here
    // before any byte is written.
    preflight_native_write(policy, cwd, &real_parent.join(file_name))?;

    let dir_fd = dir.as_raw_fd();
    let tmp_name = format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    );
    let tmp_c = std::ffi::CString::new(tmp_name.as_str())
        .map_err(|_| "file name contains NUL byte".to_string())?;
    let final_c = std::ffi::CString::new(file_name.as_bytes())
        .map_err(|_| "file name contains NUL byte".to_string())?;

    let write_result = (|| -> std::io::Result<()> {
        // O_EXCL + O_NOFOLLOW: never follow or clobber anything that
        // already exists at the temp name.
        let raw = unsafe {
            libc::openat(
                dir_fd,
                tmp_c.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o644,
            )
        };
        if raw == -1 {
            return Err(std::io::Error::last_os_error());
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(raw) };
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        if unsafe { libc::renameat(dir_fd, tmp_c.as_ptr(), dir_fd, final_c.as_ptr()) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();

    if let Err(error) = write_result {
        unsafe { libc::unlinkat(dir_fd, tmp_c.as_ptr(), 0) };
        return Err(format!("Failed to write file {}: {error}", path.display()));
    }
    Ok(())
}

/// Read the real, kernel-resolved path of an open descriptor back from the
/// OS. Used by [`commit_native_write`] to validate the directory it pinned
/// rather than the (raceable) path string it was opened from.
#[cfg(target_os = "linux")]
fn fd_resolved_path(fd: std::os::fd::RawFd) -> std::io::Result<PathBuf> {
    std::fs::read_link(format!("/proc/self/fd/{fd}"))
}

#[cfg(target_os = "macos")]
fn fd_resolved_path(fd: std::os::fd::RawFd) -> std::io::Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt as _;

    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let len = buf.iter().position(|&byte| byte == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..len])))
}

// Neither Seatbelt nor Landlock exists on other Unix targets; fall back to
// canonicalizing the pinned descriptor's open path via /proc-less means.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn fd_resolved_path(_fd: std::os::fd::RawFd) -> std::io::Result<PathBuf> {
    Err(std::io::Error::other(
        "fd path resolution unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn commit_native_write_impl(
    policy: Option<&SandboxPolicy>,
    cwd: &Path,
    path: &Path,
    contents: &[u8],
) -> Result<(), String> {
    preflight_native_write(policy, cwd, path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp, contents)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            format!("Failed to write file {}: {error}", path.display())
        })
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
/// The #[from] attribute on `SpawnFailed` creates an automatic From<io::Error>
/// implementation, enabling the ? operator to convert `io::Error` into `SandboxError`:
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
    /// The #[from] attribute enables automatic conversion from `std::io::Error`
    #[error("Failed to spawn sandboxed process: {0}")]
    SpawnFailed(#[from] std::io::Error),

    /// Landlock restriction failed (Linux only)
    ///
    /// This can occur if:
    /// - Landlock is not supported by the kernel (< 5.13)
    /// - Path rules cannot be created
    /// - `restrict_self()` syscall fails
    #[error("Landlock restriction failed")]
    LandlockRestrict,

    /// seccomp filter application failed (Linux only)
    ///
    /// Possible causes:
    /// - Unsupported architecture (not `x86_64` or aarch64)
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

/// Type alias for Result with `SandboxError`
///
/// This pattern is common in Rust to reduce boilerplate. Instead of writing
/// Result<Child, `SandboxError`> everywhere, we can write `SandboxResult`<Child>.
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
/// - **`IOKit`**: Access `RootDomainUserClient` for power management
/// - **Mach services**: Directory services, power management
/// - **Pseudo-terminals**: `openpty()` for interactive commands
///
/// # The #[`allow(dead_code)`] Attribute
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
/// `network_access: true` in `WorkspaceWrite` or when using `DangerFullAccess`.
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
/// Network-only Seatbelt rules for policies with `network_access: true`.
///
/// Intentionally does **not** grant `file-write*` on the whole
/// `DARWIN_USER_CACHE_DIR`: that root is shared with other apps on the Mac,
/// so a recursive write grant would let a sandboxed command poison another
/// process's cache outside every configured writable root (review finding
/// on #3144). Network sockets and the mach/sysctl lookups below are enough
/// for HTTPS; any process that needs a private cache must write under a
/// workspace/tmp/curated writable root instead.
///
/// The cache directory path is still passed as `DARWIN_USER_CACHE_DIR` by
/// the caller for any future scoped subpath grants; it is not used for a
/// blanket write rule.
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
"#;

/// Path to macOS sandbox-exec binary
///
/// The #[`cfg(target_os` = "macos")] attribute means this constant only exists
/// in macOS builds. Attempting to use this constant on Linux would result in
/// a compile error.
#[cfg(target_os = "macos")]
pub const SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

/// Environment variable set when running inside sandbox
///
/// This variable is set to "seatbelt" on macOS or "landlock" on Linux when
/// a command is executed in the sandbox. Commands can check this variable
/// to detect sandbox execution and adjust their behavior accordingly.
pub const SANDBOX_ENV_VAR: &str = "MAESTRO_SANDBOX";

// ─────────────────────────────────────────────────────────────
// macOS Seatbelt Implementation
// ─────────────────────────────────────────────────────────────

/// Platform-specific implementation for macOS Seatbelt sandbox
///
/// This module is only compiled when building for macOS (`target_os` = "macos").
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
    use super::{
        HashMap, Path, PathBuf, SANDBOX_ENV_VAR, SEATBELT_BASE_POLICY, SEATBELT_EXECUTABLE,
        SEATBELT_NETWORK_POLICY, SandboxPolicy, SandboxResult,
    };
    use std::ffi::CStr;
    use tokio::process::{Child, Command};

    /// Get Darwin user cache directory via confstr.
    ///
    /// This function uses FFI (Foreign Function Interface) to call the C
    /// standard library function `confstr()` to retrieve the macOS user cache
    /// directory path. This directory is used for network-related caching.
    ///
    /// # FFI and Unsafe Rust
    ///
    /// Rust's FFI allows calling C functions, but requires `unsafe` blocks
    /// because the compiler cannot verify memory safety across the language
    /// boundary. This function demonstrates proper unsafe usage:
    ///
    /// 1. Create a buffer sized to `PATH_MAX` + 1 (max path length on Unix)
    /// 2. Call `confstr()` to write the path to the buffer
    /// 3. Check the return value (0 indicates error)
    /// 4. Convert the C string (null-terminated) to Rust String
    /// 5. Canonicalize the path to resolve symlinks
    ///
    /// # Safety Justification
    ///
    /// The unsafe blocks are safe because:
    /// 1. The buffer is sized to `PATH_MAX+1`, which is sufficient for any path
    /// 2. confstr writes a null-terminated string to the buffer
    /// 3. We check the return value before using the buffer
    /// 4. `CStr::from_ptr` is given a valid null-terminated buffer that lives
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
            .and_then(|p| dunce::canonicalize(&p).ok())
    }

    /// Build Seatbelt command arguments
    ///
    /// This function generates the complete argument list for sandbox-exec based
    /// on the provided `SandboxPolicy`. The result is a Vec<String> that can be
    /// passed to `Command::args()`.
    ///
    /// # Arguments
    ///
    /// - `command`: The command and arguments to execute (e.g., `["ls", "-la"]`)
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
    /// 1. `SEATBELT_BASE_POLICY` (always included)
    /// 2. File read policy (if policy allows disk reads)
    /// 3. File write policy (generated from `writable_roots`)
    /// 4. `SEATBELT_NETWORK_POLICY` (if `network_access` is true)
    ///
    /// # Parameter Substitution
    ///
    /// Seatbelt supports parameterized policies via -D flags:
    /// - `-DWRITABLE_ROOT_0=/workspace` defines a parameter named `WRITABLE_ROOT_0`
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
                let canonical_root =
                    dunce::canonicalize(&wr.root).unwrap_or_else(|_| wr.root.clone());
                let root_param = format!("WRITABLE_ROOT_{index}");
                params.push((root_param.clone(), canonical_root));

                if wr.read_only_subpaths.is_empty() {
                    policies.push(format!(r#"(subpath (param "{root_param}"))"#));
                } else {
                    // Build require-not clauses for read-only subpaths
                    let mut require_parts = vec![format!(r#"(subpath (param "{root_param}"))"#)];
                    for (subpath_index, ro) in wr.read_only_subpaths.iter().enumerate() {
                        let canonical_ro = dunce::canonicalize(ro).unwrap_or_else(|_| ro.clone());
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

        // Every `SandboxPolicy` variant allows reads everywhere; only writes
        // are scoped by policy (see the enum's own docs: `ReadOnly` means
        // "no writes allowed", not "no filesystem access"). This must not
        // key off `has_full_disk_read_access()` -- despite its name, that
        // method returns `false` specifically for `ReadOnly` (see its own
        // "the name is slightly misleading" doc comment), which previously
        // made this Seatbelt translation omit `(allow file-read*)` for
        // `ReadOnly` and turn it into no-access-at-all on macOS: an
        // ordinary `cat Cargo.toml` would fail under a policy documented,
        // and correctly implemented on Linux (Landlock grants read access
        // to `/` unconditionally), as read-only rather than no-access.
        let file_read_policy = "; allow read-only file operations\n(allow file-read*)";

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
    /// 1. Generates Seatbelt arguments via `create_seatbelt_args()`
    /// 2. Adds `SANDBOX_ENV_VAR=seatbelt` to environment
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
    /// Returns `SandboxResult`<Child> where Child is a `tokio::process::Child` handle.
    /// The caller can use this handle to:
    /// - Read stdout/stderr via `child.stdout.take()`
    /// - Write to stdin via `child.stdin.take()`
    /// - Wait for completion via child.wait().await
    /// - Kill the process via child.kill().await
    ///
    /// # Error Handling
    ///
    /// Returns `SandboxError::SpawnFailed` if `Command::spawn()` fails. This can
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
            // `Command` inherits the parent's full environment by default;
            // without `env_clear()` here, `env` (the caller's filtered map,
            // e.g. `resolve_shell_environment`'s output with secrets like
            // `OPENAI_API_KEY`/`GITHUB_TOKEN` stripped) would only be
            // overlaid on top of -- not replace -- every variable Maestro
            // itself inherited, silently undoing that filtering for every
            // "sandboxed" command. The unsandboxed bash path already does
            // this (see `tools/bash/mod.rs`); sandboxed spawns must match.
            .env_clear()
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
        ABI, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetCreatedAttr,
    };
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule, TargetArch, apply_filter,
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
    fn install_landlock_rules(writable: LandlockWritablePaths) -> SandboxResult<()> {
        let abi = ABI::V5;
        let access_rw = AccessFs::from_all(abi);
        let access_ro = AccessFs::from_read(abi);
        // Creation/removal rights only: permits making and deleting new
        // entries in a directory but not opening or truncating any existing
        // file for writing. Used for roots whose pre-existing entries are
        // granted individually (see `writable_paths_without_exclusions`).
        //
        // Landlock grants within a layer are OR'd (kernel docs): there is no
        // "most specific wins" deny. WriteFile on the workspace root would
        // therefore also grant WriteFile on `.git`. Stage-1 therefore never
        // puts WriteFile on excluded roots.
        let access_make_remove = AccessFs::MakeReg
            | AccessFs::MakeDir
            | AccessFs::MakeSym
            | AccessFs::MakeSock
            | AccessFs::MakeFifo
            | AccessFs::MakeChar
            | AccessFs::MakeBlock
            | AccessFs::RemoveFile
            | AccessFs::RemoveDir
            | AccessFs::Refer;

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
            .no_new_privs(true);

        if !writable.full.is_empty() {
            ruleset = ruleset
                .add_rules(landlock::path_beneath_rules(&writable.full, access_rw))
                .map_err(|_| SandboxError::LandlockRestrict)?;
        }

        if !writable.make_remove_only.is_empty() {
            ruleset = ruleset
                .add_rules(landlock::path_beneath_rules(
                    &writable.make_remove_only,
                    access_make_remove,
                ))
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

    /// The filesystem paths a Landlock sandbox must grant, split by right
    /// set.
    ///
    /// - `full`: paths granted the full read-write right set.
    /// - `make_remove_only`: directory roots granted only creation/removal
    ///   rights (`Make*`/`Remove*`/`Refer`) so sandboxed commands can create
    ///   and delete *new* direct children of the root (e.g. `cargo build`
    ///   creating a missing `Cargo.lock` name) without gaining WriteFile on
    ///   any pre-existing file beneath it — including excluded trees such as
    ///   `.git`.
    pub(super) struct LandlockWritablePaths {
        pub(super) full: Vec<PathBuf>,
        pub(super) make_remove_only: Vec<PathBuf>,
    }

    pub(super) fn writable_paths_without_exclusions(
        roots: Vec<WritableRoot>,
    ) -> LandlockWritablePaths {
        let mut paths = LandlockWritablePaths {
            full: Vec::new(),
            make_remove_only: Vec::new(),
        };
        for root in roots {
            if root.read_only_subpaths.is_empty() {
                paths.full.push(root.root);
                continue;
            }

            let exclusions: Vec<PathBuf> = root
                .read_only_subpaths
                .iter()
                .map(|path| canonicalize_best_effort(path))
                .collect();
            let Ok(entries) = std::fs::read_dir(&root.root) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
                    continue;
                }
                let candidate = canonicalize_best_effort(&entry.path());
                if exclusions.iter().any(|excluded| {
                    candidate.starts_with(excluded) || excluded.starts_with(&candidate)
                }) {
                    continue;
                }
                paths.full.push(candidate);
            }

            // Stage-1: Make*/Remove* on the root lets processes create/unlink
            // names there without WriteFile/Truncate. Shell redirection such
            // as `printf x > Cargo.lock` may leave an empty file (MakeReg
            // succeeded) while the write itself is denied. Existing non-
            // excluded children get full RW above.
            //
            // Stage-2 (create+write new root children without reopening
            // `.git` write) is not expressible with path_beneath grants
            // alone: WriteFile on the root ORs across the whole subtree,
            // including exclusions. Follow-ups: bind-mount `.git` read-only
            // before enforce, or drop the `.git` RO guarantee explicitly.
            paths.make_remove_only.push(root.root);
        }
        paths
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
        let unix_only_rule = SeccompRule::new(vec![
            SeccompCondition::new(
                0, // first argument (domain)
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                libc::AF_UNIX as u64,
            )
            .map_err(|e| SandboxError::SeccompFailed(e.to_string()))?,
        ])
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
            let writable =
                writable_paths_without_exclusions(policy.get_writable_roots_with_cwd(cwd));
            install_landlock_rules(writable)?;
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
            // See the matching comment in `macos::spawn_under_seatbelt`:
            // without `env_clear()`, the child inherits every variable in
            // Maestro's own environment and `env` only adds to that set, so
            // secrets filtered out of `env` leak into the "sandboxed" child
            // anyway.
            .env_clear()
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
/// - Landlock requires kernel 5.13+ and `CONFIG_SECURITY_LANDLOCK=y`
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
#[must_use]
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

/// Human-readable reason the native sandbox is unavailable, or `None` when
/// [`is_sandbox_available`] returns `true`.
///
/// Callers that need to *enforce* sandboxing (rather than just report a
/// status) should treat unavailability as requiring an explicit, visible
/// decision from the user rather than a silent fallback — see the
/// interactive-TUI sandbox default for how this is used to gate a fail-closed
/// startup message instead of quietly running every command unsandboxed.
#[must_use]
pub fn sandbox_unavailable_reason() -> Option<String> {
    if is_sandbox_available() {
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        Some(format!(
            "{SEATBELT_EXECUTABLE} is missing. This is unexpected on macOS; \
             check whether System Integrity Protection or an MDM profile \
             removed it."
        ))
    }
    #[cfg(target_os = "linux")]
    {
        Some(
            "Landlock is not present in this kernel's active LSM list \
             (/sys/kernel/security/lsm). This is common inside containers \
             (Docker, LXC/Proxmox) and on hardened kernels that boot with a \
             `security=`/`lsm=` parameter that excludes it."
                .to_string(),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Some("This platform has no native sandbox implementation (Windows/BSD).".to_string())
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
#[must_use]
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
/// - **macOS builds**: Calls `macos::spawn_under_seatbelt()`
/// - **Linux builds**: Calls `linux::spawn_sandboxed()`
/// - **Other platforms**: Returns `Err(SandboxError::UnsupportedPlatform)`
///
/// # Arguments
///
/// - `command`: Command and arguments as Vec<String> (e.g., vec!["ls", "-la"])
/// - `cwd`: Working directory for the command (must exist)
/// - `policy`: Security policy to enforce (see `SandboxPolicy` enum)
/// - `env`: Environment variables as `HashMap`<String, String>
///
/// # Return Value
///
/// Returns `SandboxResult`<Child> where Child is a `tokio::process::Child`.
/// The child process is already running when this function returns.
///
/// # Error Handling
///
/// Possible errors:
/// - **`UnsupportedPlatform`**: Called on Windows, BSD, etc.
/// - **`SpawnFailed`**: Command doesn't exist, permission denied, sandbox binary missing
/// - **`LandlockRestrict`**: Landlock not supported or failed to apply (Linux only)
/// - **`SeccompFailed`**: seccomp filter application failed (Linux only)
/// - **`SeatbeltFailed`**: Invalid SBPL policy or sandbox-exec failed (macOS only)
///
/// # Usage Example
///
/// ```rust,ignore
/// use maestro_tui::sandbox::{SandboxPolicy, spawn_sandboxed_command};
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
/// # The #[`allow(unused_variables)`] Attribute
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
    // Point toolchain caches at the sandbox's own cache directory rather than
    // the user's real ones. `DangerFullAccess` is not sandboxed in any
    // meaningful sense, so it keeps the caller's environment untouched.
    let env = if matches!(policy, SandboxPolicy::DangerFullAccess) {
        env
    } else {
        apply_sandbox_cache_env(env, sandbox_cache_session_id())?
    };

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
/// - **Fallback**: When `is_sandbox_available()` returns false
/// - **Testing**: Compare behavior between sandboxed and unsandboxed execution
/// - **Compatibility**: Some programs don't work properly in sandboxes
///
/// # Security Warning
///
/// This function provides NO security isolation. The command has:
/// - Full filesystem access (read and write)
/// - Full network access
/// - Whatever environment variables the caller passes in `env` (the process
///   environment is cleared first, matching the plain unsandboxed `bash`
///   path -- callers are responsible for passing an already-filtered map)
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
/// Returns `SandboxResult`<Child> for consistency with `spawn_sandboxed_command`.
/// The only error is `SpawnFailed` (e.g., command not found).
///
/// # Implementation
///
/// Directly uses `tokio::process::Command` with no wrapper or restrictions.
/// This is essentially the same as calling `Command::new()` directly, but
/// provides a consistent API with `spawn_sandboxed_command`.
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
        // The only caller (`bash`'s `bypass_sandbox` path) passes the same
        // filtered `resolve_shell_environment` map the plain unsandboxed
        // branch uses, and expects the same "exactly this env, nothing
        // inherited" semantics. Without `env_clear()`, the child would
        // additionally inherit Maestro's full environment underneath that
        // map, defeating the shell-environment-policy trust gate the caller
        // already applied.
        .env_clear()
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

// ─────────────────────────────────────────────────────────────
// Kernel sandbox denial capture
// ─────────────────────────────────────────────────────────────

/// How a denial event's process relates to the command that was run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyRelationship {
    /// The event's pid is the command's own root process.
    Related,
    /// The event's pid is neither the root process nor a known-unrelated one.
    /// Descendants of the command land here, and so do other sandboxed
    /// processes on the host that the kernel log does not let us separate.
    MaybeRelated,
    /// The event's pid is known not to belong to the command (currently the
    /// Maestro process itself).
    ProbablyUnrelated,
}

/// One kernel sandbox denial parsed out of the macOS unified log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DenyEvent {
    /// Log timestamp, as the unified log reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Name of the process the kernel denied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    /// Pid of the process the kernel denied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// The kernel's decision, lowercased (`deny`, `deny-file-write`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// The denied operation (`file-write-create`, `network-outbound`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// What the operation targeted (a path, an address, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// How many identical denials the kernel collapsed into this entry.
    pub duplicate_count: u32,
    /// The unparsed `eventMessage`, always present.
    pub raw: String,
    /// Whether this event belongs to the command that was run.
    pub relationship: DenyRelationship,
}

impl DenyEvent {
    /// A short `operation target` description for a one-line summary.
    #[must_use]
    pub fn short_description(&self) -> String {
        match (&self.operation, &self.target) {
            (Some(operation), Some(target)) => format!("{operation} {target}"),
            (Some(operation), None) => operation.clone(),
            _ => self.raw.clone(),
        }
    }
}

/// Unified-log predicate selecting kernel sandbox denial messages.
#[cfg(target_os = "macos")]
const DENY_PREDICATE: &str =
    r#"process=="kernel" AND eventMessage CONTAINS "Sandbox:" AND eventMessage contains "deny""#;

/// Upper bound on the `--last` window handed to `log show`, so a long-lived
/// command cannot ask the unified log for hours of history.
#[cfg(target_os = "macos")]
const MAX_DENY_LOOKBACK_SECS: u64 = 300;

/// Collect kernel sandbox denials recorded while a command ran.
///
/// # Why this exists
///
/// When Seatbelt or Landlock blocks a syscall, the program the agent ran sees
/// only its own errno — usually `Permission denied` — with nothing saying the
/// kernel sandbox caused it. The agent then debugs the wrong thing. The kernel
/// does log the denial with the operation and target, so reading it back turns
/// a bare errno into "the sandbox denied `file-write-create /etc/hosts`".
///
/// # Platform support
///
/// macOS reads the unified log (`/usr/bin/log show`). Linux returns an empty
/// list: Landlock denials are not recorded anywhere readable without an
/// auditd configuration Maestro does not control.
///
/// # Bounds
///
/// `budget` is a hard wall-clock cap on the `log show` subprocess. On timeout,
/// spawn failure, a non-zero exit, or unparseable output, this returns an
/// empty list — a missing diagnostic must never turn into a failed command.
/// The lookback window is `started.elapsed()` rounded up, capped at
/// `MAX_DENY_LOOKBACK_SECS`.
///
/// Uses the native Seatbelt log format and fails open for diagnostics only.
pub async fn capture_denies(
    pid: u32,
    started: std::time::Instant,
    budget: std::time::Duration,
) -> Vec<DenyEvent> {
    #[cfg(target_os = "macos")]
    {
        capture_denies_macos(pid, started, budget).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (pid, started, budget);
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
async fn capture_denies_macos(
    pid: u32,
    started: std::time::Instant,
    budget: std::time::Duration,
) -> Vec<DenyEvent> {
    let seconds = started
        .elapsed()
        .as_secs()
        .saturating_add(1)
        .min(MAX_DENY_LOOKBACK_SECS);

    let mut command = tokio::process::Command::new("/usr/bin/log");
    command
        .arg("show")
        .arg("--style")
        .arg("ndjson")
        .arg("--predicate")
        .arg(DENY_PREDICATE)
        .arg("--last")
        .arg(format!("{seconds}s"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let Ok(child) = command.spawn() else {
        return Vec::new();
    };
    let Ok(Ok(output)) = tokio::time::timeout(budget, child.wait_with_output()).await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_deny_events(&String::from_utf8_lossy(&output.stdout), pid)
}

/// Parse `log show --style ndjson` output into denial events.
///
/// Lines that are not JSON, carry no `eventMessage`, or do not match a
/// known Sandbox message shape are skipped or kept as raw text; nothing here
/// can fail.
#[must_use]
pub fn parse_deny_events(ndjson: &str, root_pid: u32) -> Vec<DenyEvent> {
    ndjson
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|entry| {
            let message = entry.get("eventMessage")?.as_str()?.to_string();
            let timestamp = entry
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .map(ToString::to_string);
            Some(parse_deny_message(&message, timestamp, root_pid))
        })
        .collect()
}

/// Classify a denial's pid against the command's root pid.
#[must_use]
fn deny_relationship(event_pid: u32, root_pid: u32) -> DenyRelationship {
    if event_pid == root_pid {
        DenyRelationship::Related
    } else if event_pid == std::process::id() {
        // Maestro itself is sandboxed by nothing we spawned; a denial from
        // this pid never belongs to the command.
        DenyRelationship::ProbablyUnrelated
    } else {
        DenyRelationship::MaybeRelated
    }
}

/// Parse one `eventMessage` into a [`DenyEvent`].
fn parse_deny_message(message: &str, timestamp: Option<String>, root_pid: u32) -> DenyEvent {
    static DENY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^Sandbox:\s+([^(]+)\((\d+)\)\s+([a-zA-Z-]+)\((\d+)\)\s+(\S+)\s+(.+)$")
            .expect("deny regex")
    });
    static DUPLICATE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(\d+) duplicate reports? for Sandbox: (.+)$").expect("duplicate regex")
    });
    static DUPLICATE_BODY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^([^(]+)\((\d+)\)\s+([a-zA-Z-]+)\((\d+)\)\s+(\S+)\s+(.+)$")
            .expect("duplicate body regex")
    });

    let unparsed = |timestamp: Option<String>, duplicate_count: u32| DenyEvent {
        timestamp,
        process_name: None,
        pid: None,
        decision: None,
        operation: None,
        target: None,
        duplicate_count,
        raw: message.to_string(),
        relationship: DenyRelationship::MaybeRelated,
    };

    let build = |captures: &regex::Captures<'_>, duplicate_count: u32| {
        let event_pid: u32 = captures[2].parse().unwrap_or(0);
        DenyEvent {
            timestamp: timestamp.clone(),
            process_name: Some(captures[1].trim().to_string()),
            pid: Some(event_pid),
            decision: Some(captures[3].to_lowercase()),
            operation: Some(captures[5].to_string()),
            target: Some(captures[6].to_string()),
            duplicate_count,
            raw: message.to_string(),
            relationship: deny_relationship(event_pid, root_pid),
        }
    };

    if let Some(captures) = DENY.captures(message) {
        return build(&captures, 1);
    }
    if let Some(captures) = DUPLICATE.captures(message) {
        let count: u32 = captures[1].parse().unwrap_or(1);
        if let Some(body) = DUPLICATE_BODY.captures(&captures[2]) {
            return build(&body, count);
        }
        return unparsed(timestamp, count);
    }
    unparsed(timestamp, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn private_tempdir() -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        temp
    }

    /// One `log show --style ndjson` line, as the unified log emits them.
    fn ndjson_line(message: &str) -> String {
        serde_json::json!({
            "timestamp": "2026-08-23 09:41:02.123456-0700",
            "processImagePath": "/kernel",
            "eventMessage": message,
        })
        .to_string()
    }

    #[test]
    fn parse_deny_events_extracts_process_operation_and_target() {
        let ndjson = ndjson_line(
            "Sandbox: bash(4242) deny(1) file-write-create /Users/dev/.cargo/registry/x",
        );

        let events = parse_deny_events(&ndjson, 4242);

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.process_name.as_deref(), Some("bash"));
        assert_eq!(event.pid, Some(4242));
        assert_eq!(event.decision.as_deref(), Some("deny"));
        assert_eq!(event.operation.as_deref(), Some("file-write-create"));
        assert_eq!(
            event.target.as_deref(),
            Some("/Users/dev/.cargo/registry/x")
        );
        assert_eq!(event.duplicate_count, 1);
        assert_eq!(event.relationship, DenyRelationship::Related);
        assert_eq!(
            event.timestamp.as_deref(),
            Some("2026-08-23 09:41:02.123456-0700")
        );
    }

    #[test]
    fn parse_deny_events_reads_duplicate_reports() {
        let ndjson = ndjson_line(
            "17 duplicate reports for Sandbox: cargo(4243) deny(1) network-outbound 1.2.3.4:443",
        );

        let events = parse_deny_events(&ndjson, 4242);

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.duplicate_count, 17);
        assert_eq!(event.pid, Some(4243));
        assert_eq!(event.operation.as_deref(), Some("network-outbound"));
        assert_eq!(event.target.as_deref(), Some("1.2.3.4:443"));
        assert_eq!(event.relationship, DenyRelationship::MaybeRelated);
    }

    #[test]
    fn parse_deny_events_tags_relationship_by_pid() {
        let ndjson = [
            ndjson_line("Sandbox: bash(4242) deny(1) file-write-create /etc/hosts"),
            ndjson_line("Sandbox: rustc(9999) deny(1) file-write-create /etc/hosts"),
            ndjson_line(&format!(
                "Sandbox: maestro({}) deny(1) file-write-create /etc/hosts",
                std::process::id()
            )),
        ]
        .join("\n");

        let events = parse_deny_events(&ndjson, 4242);

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].relationship, DenyRelationship::Related);
        assert_eq!(events[1].relationship, DenyRelationship::MaybeRelated);
        assert_eq!(events[2].relationship, DenyRelationship::ProbablyUnrelated);
    }

    #[test]
    fn parse_deny_events_keeps_unrecognized_messages_as_raw() {
        let ndjson = ndjson_line("Sandbox: something the regex does not model");

        let events = parse_deny_events(&ndjson, 4242);

        assert_eq!(events.len(), 1);
        assert!(events[0].operation.is_none());
        assert!(events[0].pid.is_none());
        assert_eq!(events[0].raw, "Sandbox: something the regex does not model");
        assert_eq!(events[0].duplicate_count, 1);
    }

    #[test]
    fn parse_deny_events_skips_lines_that_are_not_usable() {
        let ndjson = [
            "not json at all",
            "",
            "   ",
            &serde_json::json!({ "timestamp": "t" }).to_string(),
            &ndjson_line("Sandbox: bash(1) deny(1) file-write-create /x"),
        ]
        .join("\n");

        assert_eq!(parse_deny_events(&ndjson, 1).len(), 1);
    }

    #[test]
    fn deny_event_short_description_prefers_operation_and_target() {
        let mut event = parse_deny_events(
            &ndjson_line("Sandbox: bash(1) deny(1) file-write-create /x"),
            1,
        )
        .remove(0);
        assert_eq!(event.short_description(), "file-write-create /x");

        event.operation = None;
        event.target = None;
        assert_eq!(event.short_description(), event.raw);
    }

    #[tokio::test]
    async fn capture_denies_returns_empty_within_its_budget() {
        // No sandboxed command ran under this pid, so there is nothing to
        // find. The point of the assertion is the bound: the capture must
        // return promptly and must never fail the caller.
        let started = std::time::Instant::now();
        let events = capture_denies(
            std::process::id(),
            started,
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        for event in &events {
            assert!(!event.raw.is_empty());
        }
    }

    /// Integration probe: run a write the sandbox must deny and check that
    /// the kernel denial is visible. Ignored by default because CI runners
    /// commonly cannot read the unified log (`log show` needs a real macOS
    /// host with the log daemon, which sandboxed/virtualized runners lack).
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "needs a macOS host where `log show` can read kernel messages"]
    async fn capture_denies_sees_a_denied_write_under_read_only() {
        let started = std::time::Instant::now();
        let child = spawn_sandboxed_command(
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "touch /etc/maestro-probe".to_string(),
            ],
            std::env::temp_dir(),
            &SandboxPolicy::ReadOnly,
            HashMap::new(),
        )
        .await
        .expect("sandboxed spawn should succeed");
        let pid = child.id().expect("child pid");
        let output = child.wait_with_output().await.expect("child should exit");
        assert!(!output.status.success(), "the write must be denied");

        let events = capture_denies(pid, started, std::time::Duration::from_secs(10)).await;
        assert!(
            events.iter().any(|event| event
                .operation
                .as_deref()
                .is_some_and(|operation| operation.starts_with("file-write"))),
            "expected a file-write denial: {events:?}"
        );
    }

    /// `CARGO_HOME`/`XDG_CACHE_HOME` are process-global env vars read by
    /// `dev_cache_writable_roots()`; guard tests that set them so they don't
    /// race other tests reading the ambient values, matching the
    /// `env_lock()` pattern used for this class of test elsewhere in the
    /// crate (e.g. `config_cli.rs`).
    fn dev_cache_env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn dev_cache_writable_roots_never_grants_the_real_cargo_cache() {
        // The sandbox no longer writes into the user's Cargo cache at all:
        // `sandbox_cache_env` redirects dependency caches into a
        // session-private directory, while Cargo build artifacts stay under
        // the writable workspace, so a build script cannot leave a poisoned
        // artifact in the user's reusable Cargo cache.
        let _guard = dev_cache_env_lock();
        let cargo_home = tempfile::tempdir().unwrap();
        std::env::set_var("CARGO_HOME", cargo_home.path());
        std::fs::create_dir_all(cargo_home.path().join("registry")).unwrap();
        std::fs::create_dir_all(cargo_home.path().join("git")).unwrap();

        let roots = SandboxPolicy::dev_cache_writable_roots();

        std::env::remove_var("CARGO_HOME");

        assert!(
            roots
                .iter()
                .all(|root| !root.starts_with(cargo_home.path())),
            "no writable root may live under $CARGO_HOME: {roots:?}"
        );
        assert_eq!(
            roots,
            vec![sandbox_cache_root(sandbox_cache_session_id())],
            "the only writable cache root is the session-private one: {roots:?}"
        );
    }

    #[test]
    fn dev_cache_writable_roots_is_the_session_cache_root() {
        let roots = SandboxPolicy::dev_cache_writable_roots();
        assert_eq!(roots.len(), 1);
        assert!(
            roots[0].is_dir(),
            "the cache root must be created: {roots:?}"
        );
        let temp_dir = dunce::canonicalize(std::env::temp_dir()).unwrap();
        assert!(roots[0].starts_with(temp_dir));
    }

    #[test]
    fn sandbox_cache_env_never_names_toolchain_home_variables() {
        // These hold installed executables, not caches. Redirecting them
        // would point the toolchain at an empty directory and break the
        // command, and is why the reference implementation excludes them.
        let env = sandbox_cache_env("test-session");
        for forbidden in [
            "RUSTUP_HOME",
            "GEM_HOME",
            "VOLTA_HOME",
            "PIPX_HOME",
            "DENO_DIR",
        ] {
            assert!(
                !env.iter().any(|(name, _)| name == forbidden),
                "{forbidden} must not be redirected: {env:?}"
            );
        }
    }

    #[test]
    fn sandbox_cache_env_points_every_variable_inside_the_session_root() {
        let root = sandbox_cache_root("test-session");
        let env = sandbox_cache_env("test-session");
        assert!(env.len() >= 25, "expected the full cache variable set");
        for (name, value) in &env {
            assert!(
                PathBuf::from(value).starts_with(&root),
                "{name} points outside the session cache root: {value}"
            );
        }
        assert!(env.iter().any(|(name, _)| name == "NPM_CONFIG_CACHE"));
        assert!(env.iter().any(|(name, _)| name == "npm_config_store_dir"));
        assert!(!env.iter().any(|(name, _)| name == "PNPM_STORE_PATH"));
        assert!(env.iter().any(|(name, _)| name == "CARGO_HOME"));
        assert!(!env.iter().any(|(name, _)| name == "CARGO_TARGET_DIR"));
        assert!(env.iter().any(|(name, _)| name == "GOCACHE"));
        assert!(env.iter().any(|(name, _)| name == "PIP_CACHE_DIR"));
        assert!(env.iter().any(|(name, _)| name == "GRADLE_USER_HOME"));
        assert!(env.iter().any(|(name, _)| name == "YARN_CACHE_FOLDER"));
        assert!(env.iter().any(|(name, _)| name == "YARN_GLOBAL_FOLDER"));
        assert!(env.iter().any(|(name, _)| name == "COMPOSER_CACHE_DIR"));
        assert!(!env.iter().any(|(name, _)| name == "COMPOSER_HOME"));
    }

    #[test]
    fn apply_sandbox_cache_env_uses_the_workspace_cargo_target() {
        let mut env = HashMap::new();
        env.insert("CARGO_TARGET_DIR".to_string(), "/host/target".to_string());
        env.insert("COMPOSER_HOME".to_string(), "/host/composer".to_string());
        env.insert(
            "COMPOSER_CACHE_DIR".to_string(),
            "/host/composer-cache".to_string(),
        );
        env.insert(
            "MAVEN_OPTS".to_string(),
            "-Xmx2g -Dmaven.repo.local=/host/maven".to_string(),
        );
        env.insert("PATH".to_string(), "/usr/bin".to_string());

        let applied = apply_sandbox_cache_env(env, "test-session").unwrap();

        assert_eq!(applied.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!applied.contains_key("CARGO_TARGET_DIR"));
        assert_eq!(
            applied.get("COMPOSER_HOME").map(String::as_str),
            Some("/host/composer")
        );
        assert_eq!(
            applied.get("COMPOSER_CACHE_DIR").map(PathBuf::from),
            Some(sandbox_cache_root("test-session").join("composer"))
        );
        let maven_opts = applied.get("MAVEN_OPTS").expect("MAVEN_OPTS set");
        assert!(maven_opts.starts_with("-Xmx2g -Dmaven.repo.local=/host/maven "));
        assert!(maven_opts.ends_with(&format!(
            "-Dmaven.repo.local={}",
            sandbox_cache_root("test-session").join("maven").display()
        )));
    }

    #[cfg(unix)]
    #[test]
    fn prepare_sandbox_cache_root_is_owner_only() {
        use std::os::unix::fs::MetadataExt as _;

        let temp = private_tempdir();
        let root = prepare_sandbox_cache_root_in(temp.path(), "private-session").unwrap();
        let parent = root.parent().unwrap();

        assert_eq!(std::fs::metadata(parent).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&root).unwrap().uid(), unsafe {
            libc::geteuid()
        });
    }

    #[cfg(unix)]
    #[test]
    fn prepare_sandbox_cache_root_rejects_a_symlink_parent() {
        use std::os::unix::fs::symlink;

        let temp = private_tempdir();
        let attacker = tempfile::tempdir().unwrap();
        symlink(attacker.path(), temp.path().join(SANDBOX_CACHE_DIR)).unwrap();

        let error = prepare_sandbox_cache_root_in(temp.path(), "session").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!attacker.path().join("session").exists());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_sandbox_cache_root_rejects_a_shared_parent() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = private_tempdir();
        let parent = temp.path().join(SANDBOX_CACHE_DIR);
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = prepare_sandbox_cache_root_in(temp.path(), "session").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!parent.join("session").exists());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_sandbox_cache_root_reclaims_exited_process_caches_but_keeps_live_ones() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = private_tempdir();
        let parent = temp.path().join(SANDBOX_CACHE_DIR);
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();

        let live = parent.join("live");
        std::fs::create_dir(&live).unwrap();
        std::fs::write(
            live.join(SANDBOX_CACHE_PROCESS_MARKER),
            std::process::id().to_string(),
        )
        .unwrap();
        for index in 0..4 {
            let inactive = parent.join(format!("inactive-{index}"));
            std::fs::create_dir(&inactive).unwrap();
            std::fs::write(inactive.join(SANDBOX_CACHE_PROCESS_MARKER), "4294967295").unwrap();
        }

        prepare_sandbox_cache_root_in(temp.path(), "current").unwrap();

        assert!(
            live.exists(),
            "a live process cache must never be reclaimed"
        );
        let inactive_count = std::fs::read_dir(&parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("inactive-"))
            .count();
        assert_eq!(inactive_count, SANDBOX_CACHE_RETAINED_INACTIVE);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_cache_reclaim_tolerates_entries_removed_by_another_process() {
        use std::sync::{Arc, Barrier};

        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join(SANDBOX_CACHE_DIR);
        std::fs::create_dir(&parent).unwrap();
        for index in 0..64 {
            let inactive = parent.join(format!("inactive-{index}"));
            std::fs::create_dir(&inactive).unwrap();
            std::fs::write(inactive.join(SANDBOX_CACHE_PROCESS_MARKER), "4294967295").unwrap();
        }

        let barrier = Arc::new(Barrier::new(8));
        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..8 {
                let barrier = Arc::clone(&barrier);
                let parent = parent.clone();
                workers.push(scope.spawn(move || {
                    barrier.wait();
                    reclaim_inactive_sandbox_caches(&parent, "current")
                }));
            }
            for worker in workers {
                worker
                    .join()
                    .expect("reclaim worker must not panic")
                    .expect("a concurrently removed inactive entry is already reclaimed");
            }
        });
    }

    #[test]
    fn seed_toolchain_user_config_preserves_cargo_and_gradle_configuration() {
        let temp = private_tempdir();
        let home = temp.path().join("home");
        let cargo = home.join(".cargo");
        let gradle = home.join(".gradle");
        std::fs::create_dir_all(&cargo).unwrap();
        std::fs::create_dir_all(gradle.join("init.d")).unwrap();
        std::fs::write(cargo.join("config.toml"), "[net]\noffline = true\n").unwrap();
        std::fs::write(
            cargo.join("credentials.toml"),
            "[registry]\ntoken = 'secret'\n",
        )
        .unwrap();
        std::fs::write(
            gradle.join("gradle.properties"),
            "org.gradle.daemon=false\n",
        )
        .unwrap();
        std::fs::write(gradle.join("init.d/company.gradle"), "// company init\n").unwrap();

        let cache = prepare_sandbox_cache_root_in(temp.path(), "session").unwrap();
        let env = HashMap::from([
            ("HOME".to_string(), home.to_string_lossy().into_owned()),
            (
                "CARGO_HOME".to_string(),
                cargo.to_string_lossy().into_owned(),
            ),
            (
                "GRADLE_USER_HOME".to_string(),
                gradle.to_string_lossy().into_owned(),
            ),
        ]);
        seed_toolchain_user_config(&env, &cache).unwrap();

        assert_eq!(
            std::fs::read_to_string(cache.join("cargo-home/config.toml")).unwrap(),
            "[net]\noffline = true\n"
        );
        assert!(cache.join("cargo-home/credentials.toml").is_file());
        assert_eq!(
            std::fs::read_to_string(cache.join("gradle/gradle.properties")).unwrap(),
            "org.gradle.daemon=false\n"
        );
        assert!(cache.join("gradle/init.d/company.gradle").is_file());

        std::fs::remove_file(cargo.join("config.toml")).unwrap();
        std::fs::remove_file(gradle.join("gradle.properties")).unwrap();
        std::fs::remove_file(gradle.join("init.d/company.gradle")).unwrap();
        std::fs::write(gradle.join("init.d/replacement.gradle"), "// replacement\n").unwrap();
        seed_toolchain_user_config(&env, &cache).unwrap();

        assert!(!cache.join("cargo-home/config.toml").exists());
        assert!(!cache.join("gradle/gradle.properties").exists());
        assert!(!cache.join("gradle/init.d/company.gradle").exists());
        assert!(cache.join("gradle/init.d/replacement.gradle").is_file());
    }

    #[test]
    fn sandbox_cache_session_id_is_stable_within_the_process() {
        assert_eq!(sandbox_cache_session_id(), sandbox_cache_session_id());
        assert_eq!(sandbox_cache_session_id().len(), 32);
    }

    #[test]
    fn dev_cache_writable_roots_never_grants_reusable_npx_installations() {
        let roots = SandboxPolicy::dev_cache_writable_roots();
        assert!(roots.iter().all(|root| {
            root.file_name().is_none_or(|name| name != ".npm")
                && !root.components().any(|part| part.as_os_str() == "_npx")
        }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_writable_roots_exclude_git_metadata() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("src");
        let git = workspace.path().join(".git");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(git.join("hooks")).unwrap();

        let roots = vec![WritableRoot {
            root: workspace.path().to_path_buf(),
            read_only_subpaths: vec![git.clone()],
        }];
        let writable = super::linux::writable_paths_without_exclusions(roots);

        assert!(writable.full.iter().any(|path| path == &source));
        assert!(writable.full.iter().all(|path| !path.starts_with(&git)));
    }

    /// Stage-1: when the workspace contains `.git`, expansion grants full RW
    /// only to existing non-excluded children, plus Make*/Remove* on the root
    /// (never WriteFile on the root — that would OR-grant write under `.git`).
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_excluded_root_is_granted_creation_rights_for_new_children() {
        let workspace = tempfile::tempdir().unwrap();
        let git = workspace.path().join(".git");
        std::fs::create_dir_all(&git).unwrap();

        let roots = vec![WritableRoot {
            root: workspace.path().to_path_buf(),
            read_only_subpaths: vec![git.clone()],
        }];
        let writable = super::linux::writable_paths_without_exclusions(roots);

        assert!(
            writable
                .make_remove_only
                .iter()
                .any(|path| path == workspace.path()),
            "the excluded root must be granted creation/removal rights"
        );
        assert!(
            writable.full.iter().all(|path| !path.starts_with(&git)),
            ".git must not gain full read-write access"
        );
        assert!(
            !writable.full.iter().any(|path| path == workspace.path()),
            "the root must not be granted full read-write access while .git is excluded"
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_write_rejects_dangling_symlink_targets() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = workspace.path().join("escape.ipynb");
        symlink(outside.path().join("created-outside.ipynb"), &link).unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        assert!(!policy.allows_write_to(workspace.path(), &link));
    }

    #[test]
    fn commit_native_write_creates_and_replaces_files_inside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };
        let target = workspace.path().join("nested").join("file.txt");

        commit_native_write(Some(&policy), workspace.path(), &target, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "first");

        commit_native_write(Some(&policy), workspace.path(), &target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn commit_native_write_denies_a_path_outside_every_writable_root() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };
        let target = outside.path().join("escaped.txt");

        let result = commit_native_write(Some(&policy), workspace.path(), &target, b"nope");
        assert!(result.is_err());
        assert!(!target.exists());
    }

    /// Regression test for the TOCTOU review finding on #3144: a preflight
    /// path check and the write that follows it are separate filesystem
    /// operations, so a directory swapped for a symlink to outside the
    /// workspace between the two must still be denied. `commit_native_write`
    /// pins the parent directory and revalidates the policy against the
    /// directory descriptor it actually writes through.
    #[cfg(unix)]
    #[test]
    fn commit_native_write_denies_a_parent_swapped_for_a_symlink_after_preflight() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let subdir = workspace.path().join("sub");
        std::fs::create_dir_all(&subdir).unwrap();
        let target = subdir.join("escaped.txt");

        // Preflight sees a legitimate in-workspace directory and passes.
        preflight_native_write(Some(&policy), workspace.path(), &target).unwrap();

        // The swap: a background task replaces the directory with a symlink
        // pointing outside every writable root.
        std::fs::remove_dir(&subdir).unwrap();
        symlink(outside.path(), &subdir).unwrap();

        let result = commit_native_write(Some(&policy), workspace.path(), &target, b"nope");
        assert!(result.is_err(), "the swapped parent must be denied");
        assert!(
            !outside.path().join("escaped.txt").exists(),
            "no byte may be written outside the workspace"
        );
    }

    #[test]
    fn dev_cache_writable_roots_never_grants_the_xdg_cache() {
        // The XDG cache root holds installed tool environments (e.g.
        // `~/.cache/pre-commit/<hash>/.../bin/`). No part of it is granted
        // now that `PIP_CACHE_DIR` and `UV_CACHE_DIR` are redirected into the
        // session-private cache root instead.
        let _guard = dev_cache_env_lock();
        let xdg_cache_home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(xdg_cache_home.path().join("pip")).unwrap();
        std::fs::create_dir_all(xdg_cache_home.path().join("pre-commit")).unwrap();
        std::env::set_var("XDG_CACHE_HOME", xdg_cache_home.path());
        std::env::remove_var("CARGO_HOME");

        let roots = SandboxPolicy::dev_cache_writable_roots();

        std::env::remove_var("XDG_CACHE_HOME");

        assert!(
            roots
                .iter()
                .all(|root| !root.starts_with(xdg_cache_home.path())),
            "no writable root may live under $XDG_CACHE_HOME: {roots:?}"
        );
    }

    #[test]
    fn mode_label_matches_the_config_grammar() {
        assert_eq!(
            SandboxPolicy::DangerFullAccess.mode_label(),
            "danger-full-access"
        );
        assert_eq!(SandboxPolicy::ReadOnly.mode_label(), "read-only");
        assert_eq!(
            SandboxPolicy::workspace_write_default().mode_label(),
            "workspace-write"
        );
    }

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
        assert!(
            roots
                .iter()
                .any(|r| r.root.as_path() == Path::new("/custom"))
        );
        assert!(
            roots
                .iter()
                .any(|r| r.root.as_path() == Path::new("/workspace"))
        );
    }

    #[test]
    fn allows_write_to_danger_full_access_allows_anything() {
        let policy = SandboxPolicy::DangerFullAccess;
        assert!(policy.allows_write_to(Path::new("/workspace"), Path::new("/etc/shadow")));
    }

    #[test]
    fn allows_write_to_read_only_denies_everything() {
        let policy = SandboxPolicy::ReadOnly;
        let workspace = tempfile::tempdir().unwrap();
        assert!(!policy.allows_write_to(workspace.path(), &workspace.path().join("in_cwd.txt")));
    }

    #[test]
    fn canonicalize_best_effort_resolves_ancestor_symlinks_for_nonexistent_targets() {
        let real_dir = tempfile::tempdir().unwrap();
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("link-to-real");
        #[cfg(unix)]
        std::os::unix::fs::symlink(real_dir.path(), &link).unwrap();
        #[cfg(not(unix))]
        return;

        // The target file does not exist yet, only its ancestor (the
        // symlink) does. The resolved path must follow the symlink, matching
        // what `dunce::canonicalize` would return if the file already
        // existed.
        let resolved = canonicalize_best_effort(&link.join("new_file.txt"));
        let expected = dunce::canonicalize(real_dir.path())
            .unwrap()
            .join("new_file.txt");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn allows_write_to_workspace_write_allows_cwd_and_denies_outside() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        assert!(policy.allows_write_to(workspace.path(), &workspace.path().join("src/main.rs")));
        // A native write/edit tool call must not be able to escape the
        // workspace via an absolute path outside every writable root, e.g.
        // `~/.bashrc` or `~/.ssh/authorized_keys` (the exact bypasses
        // flagged in review for #3144).
        assert!(!policy.allows_write_to(workspace.path(), &outside.path().join("bashrc")));
    }

    #[test]
    fn allows_write_to_denies_read_only_subpath_inside_writable_root() {
        let workspace = tempfile::tempdir().unwrap();
        let git_dir = workspace.path().join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        // .git is writable-root territory but carved out as read-only.
        assert!(!policy.allows_write_to(workspace.path(), &git_dir.join("HOOKS")));
        // A sibling file in the same cwd remains writable.
        assert!(policy.allows_write_to(workspace.path(), &workspace.path().join("README.md")));
    }

    #[test]
    fn allows_write_to_workspace_write_allows_extra_writable_root() {
        let workspace = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![cache.path().to_path_buf()],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        assert!(policy.allows_write_to(workspace.path(), &cache.path().join("registry/lock")));
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

    #[test]
    fn test_sandbox_unavailable_reason_matches_availability() {
        // The two functions must never disagree: `Some(reason)` iff the
        // sandbox is unavailable. A future edit to either function that
        // forgets to update the other should fail this test.
        assert_eq!(
            sandbox_unavailable_reason().is_none(),
            is_sandbox_available()
        );
    }

    #[test]
    fn test_workspace_write_default_has_network_and_no_writable_roots_on_a_bare_machine() {
        // dev_cache_writable_roots() returns the session cache root, which it
        // creates, so this assertion holds regardless of whether the test
        // runner happens to have a Rust/Node toolchain installed.
        let policy = SandboxPolicy::workspace_write_default();
        assert!(policy.has_full_network_access());
        assert!(!policy.has_full_disk_write_access());
        let SandboxPolicy::WorkspaceWrite { writable_roots, .. } = &policy else {
            panic!("workspace_write_default() must return WorkspaceWrite");
        };
        for root in writable_roots {
            assert!(
                root.exists(),
                "dev_cache_writable_roots() must only return roots that exist: {root:?}"
            );
        }
    }

    #[test]
    fn dev_cache_writable_roots_never_grants_rustup_home() {
        // Regression guard for the review finding on #3144: granting
        // $RUSTUP_HOME lets a sandboxed build script overwrite an installed
        // toolchain binary (rustc, cargo, clippy-driver under
        // toolchains/*/bin) and persist code execution across later
        // sandboxed sessions. Ordinary dependency fetching never needs to
        // write there, so it must never appear in this list, regardless of
        // whether RUSTUP_HOME is set in the test environment.
        let roots = SandboxPolicy::dev_cache_writable_roots();
        if let Some(rustup_home) = std::env::var_os("RUSTUP_HOME") {
            let rustup_home = PathBuf::from(rustup_home);
            assert!(
                !roots.iter().any(|root| root == &rustup_home),
                "dev_cache_writable_roots() must not grant $RUSTUP_HOME: {roots:?}"
            );
        }
        if let Some(home) = dirs::home_dir() {
            let default_rustup_home = home.join(".rustup");
            assert!(
                !roots.iter().any(|root| root == &default_rustup_home),
                "dev_cache_writable_roots() must not grant ~/.rustup: {roots:?}"
            );
        }
    }

    #[test]
    fn test_default_and_workspace_write_default_diverge_on_network_access() {
        // Regression guard for the documented split between the conservative
        // library `Default` (network off) and the product default used by
        // interactive/exec sessions (network on) — see both doc comments.
        assert!(!SandboxPolicy::default().has_full_network_access());
        assert!(SandboxPolicy::workspace_write_default().has_full_network_access());
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

    /// Regression test for the review finding on #3144: `ReadOnly` means
    /// "no writes allowed", not "no filesystem access" (see the enum's own
    /// docs), and must keep granting reads on macOS exactly as the Linux
    /// Landlock implementation already does. Before this fix, the Seatbelt
    /// translation omitted `(allow file-read*)` for `ReadOnly` because it
    /// (wrongly) keyed the read allow off `has_full_disk_read_access()`,
    /// which returns `false` specifically for `ReadOnly`.
    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_read_only_still_allows_reads() {
        use super::macos::create_seatbelt_args;

        let cwd = std::env::temp_dir();
        let args = create_seatbelt_args(
            vec!["cat".to_string(), "Cargo.toml".to_string()],
            &SandboxPolicy::ReadOnly,
            &cwd,
        );
        let policy_text = args
            .iter()
            .find(|arg| arg.contains("allow file-read*"))
            .expect("-p <policy> argument must contain the policy text");
        assert!(
            policy_text.contains("(allow file-read*)"),
            "ReadOnly must still allow reads on macOS: {policy_text}"
        );
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

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_workspace_write_blocks_home_writes() {
        if !is_sandbox_available() {
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() || home.starts_with("/tmp") {
            return;
        }

        let probe = PathBuf::from(home).join(format!(
            "maestro-rust-sandbox-should-not-write-{}",
            std::process::id()
        ));
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let child = spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("printf blocked > {}", probe.to_string_lossy()),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        .unwrap();
        let output = child.wait_with_output().await.unwrap();

        assert!(!output.status.success());
        assert!(!probe.exists());
        let _ = std::fs::remove_file(probe);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_workspace_write_denies_writes_outside_writable_roots() {
        if !is_sandbox_available() {
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        let writable = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![writable.path().to_path_buf()],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        // Writes inside a writable root succeed.
        let allowed = writable.path().join("allowed.txt");
        let child = match spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("printf ok > {}", allowed.to_string_lossy()),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            // Enforcement unavailable on this runner (e.g. Landlock ABI
            // missing despite the LSM listing): skip rather than fail CI.
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success());
        assert_eq!(std::fs::read_to_string(&allowed).unwrap(), "ok");

        // Writes outside every writable root are denied.
        let denied = outside.path().join("denied.txt");
        let child = match spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("printf blocked > {}", denied.to_string_lossy()),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(!output.status.success());
        assert!(!denied.exists());
    }

    /// Stage-1 residual: existing non-git trees stay fully writable, `.git`
    /// content stays unwritable, and writing *content* into a brand-new root
    /// child fails closed (no WriteFile on the root). Shell redirection may
    /// still create an empty name via MakeReg.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_workspace_write_existing_children_ok_git_and_new_root_writes_denied() {
        if !is_sandbox_available() {
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(".git")).unwrap();
        std::fs::write(
            workspace.path().join(".git").join("HEAD"),
            "ref: refs/heads/main\n",
        )
        .unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src").join("lib.rs"), "before\n").unwrap();

        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let child = match spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf 'after\\n' > src/lib.rs".to_string(),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "writing an existing non-git child must work: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("src").join("lib.rs")).unwrap(),
            "after\n"
        );

        let lock_path = workspace.path().join("Cargo.lock");
        let child = match spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf lock > Cargo.lock".to_string(),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(
            !output.status.success(),
            "writing a new root child must fail closed without WriteFile on root"
        );
        if lock_path.exists() {
            let body = std::fs::read(&lock_path).unwrap_or_default();
            assert!(
                body.is_empty(),
                "stage-1 may create an empty root name via MakeReg, but WriteFile must stay denied (got {:?})",
                String::from_utf8_lossy(&body)
            );
        }

        let child = match spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf evil > .git/HEAD".to_string(),
            ],
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(workspace.path().join(".git").join("HEAD")).unwrap(),
            "ref: refs/heads/main\n"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_read_only_blocks_network_sockets() {
        if !is_sandbox_available() {
            return;
        }

        // The probe needs a program that can open a network socket; skip when
        // no Python interpreter is available on this runner.
        let python = ["python3", "python"].iter().find(|name| {
            std::process::Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        });
        let Some(python) = python else {
            return;
        };

        let workspace = tempfile::tempdir().unwrap();
        let probe_args = vec![
            (*python).to_string(),
            "-c".to_string(),
            "import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)".to_string(),
        ];

        // Control: the probe works without a sandbox; otherwise it cannot
        // prove enforcement and the test is inconclusive on this runner.
        let control = spawn_unsandboxed_command(
            probe_args.clone(),
            workspace.path().to_path_buf(),
            HashMap::new(),
        )
        .await
        .unwrap();
        if !control.wait_with_output().await.unwrap().status.success() {
            return;
        }

        // Under ReadOnly the seccomp filter denies socket() for non-AF_UNIX
        // domains, so the probe must fail.
        let policy = SandboxPolicy::ReadOnly;
        let child = match spawn_sandboxed_command(
            probe_args,
            workspace.path().to_path_buf(),
            &policy,
            HashMap::new(),
        )
        .await
        {
            Ok(child) => child,
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(!output.status.success());
    }

    /// Regression test for the review finding: `spawn_unsandboxed_command`
    /// (the `bypass_sandbox` helper) must not leak variables filtered out of
    /// its caller's `env` map by inheriting Maestro's own environment.
    ///
    /// This deliberately avoids `std::env::set_var`/`remove_var`: those
    /// mutate real, process-wide state that every other test in this binary
    /// shares, which is exactly the kind of cross-test race the existing
    /// `env_lock()` helpers elsewhere in this crate (`config_cli.rs`,
    /// `device_identity.rs`) exist to paper over. Instead this reads `HOME`,
    /// a variable already guaranteed to be set in the process running the
    /// test suite, without ever writing to the environment. `HOME` (unlike
    /// `PATH`) has no shell-assigned fallback value, so an unset `$HOME`
    /// inside the child unambiguously proves the environment was cleared
    /// rather than merely overlaid.
    #[tokio::test]
    async fn spawn_unsandboxed_command_does_not_leak_process_environment() {
        assert!(
            std::env::var_os("HOME").is_some(),
            "test precondition: HOME must be set in the current process"
        );

        let mut filtered_env = HashMap::new();
        filtered_env.insert("ONLY_THIS_VAR".to_string(), "present".to_string());

        let child = spawn_unsandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf '%s|%s' \"${HOME:-absent}\" \"${ONLY_THIS_VAR:-absent}\"".to_string(),
            ],
            std::env::temp_dir(),
            filtered_env,
        )
        .await
        .unwrap();
        let output = child.wait_with_output().await.unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "absent|present",
            "spawn_unsandboxed_command must clear the parent environment before \
             applying the caller's filtered env map (HOME must not leak through), \
             not merely overlay the filtered map on top of it"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn spawn_sandboxed_command_does_not_leak_process_environment() {
        if !is_sandbox_available() {
            return;
        }
        assert!(
            std::env::var_os("HOME").is_some(),
            "test precondition: HOME must be set in the current process"
        );

        let workspace = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };
        let mut filtered_env = HashMap::new();
        filtered_env.insert("ONLY_THIS_VAR".to_string(), "present".to_string());

        let child = spawn_sandboxed_command(
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf '%s|%s' \"${HOME:-absent}\" \"${ONLY_THIS_VAR:-absent}\"".to_string(),
            ],
            workspace.path().to_path_buf(),
            &policy,
            filtered_env,
        )
        .await;

        let child = match child {
            Ok(child) => child,
            // Enforcement unavailable on this runner: skip rather than fail CI.
            Err(_) => return,
        };
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "absent|present",
            "a policy-sandboxed spawn must not inherit Maestro's own process \
             environment underneath its filtered env map (HOME must not leak through)"
        );
    }
}
