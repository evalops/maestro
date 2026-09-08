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

pub(super) fn writable_paths_without_exclusions(roots: Vec<WritableRoot>) -> LandlockWritablePaths {
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
            if exclusions
                .iter()
                .any(|excluded| candidate.starts_with(excluded) || excluded.starts_with(&candidate))
            {
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
        let writable = writable_paths_without_exclusions(policy.get_writable_roots_with_cwd(cwd));
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
