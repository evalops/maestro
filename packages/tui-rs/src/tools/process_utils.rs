//! Shared process helpers for tool execution.

/// Kill an entire process tree by PID.
///
/// On Unix systems, this uses SIGKILL to terminate the process and all its descendants.
/// On Windows, it uses `taskkill /T /F`.
#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    use std::process::Command;

    let pid_i32 = i32::try_from(pid).ok();
    if let Some(pid_i32) = pid_i32 {
        // If the process is the leader of its own group, kill the group first.
        // SAFETY: `getpgid` only takes/returns integers (`pid_t`); there is no
        // pointer or buffer for the FFI boundary to invalidate. `pid_i32` may
        // reference a process that has already exited and had its pid recycled
        // by the OS (an inherent PID-reuse race on POSIX): at worst we read the
        // pgid of an unrelated process and skip the group-kill below, which is
        // acceptable for this best-effort cleanup path.
        let pgid = unsafe { libc::getpgid(pid_i32) };
        if pgid > 0 && pgid == pid_i32 {
            // SAFETY: `kill` only takes integer args (pid/signal); no
            // memory-safety precondition crosses the FFI boundary. Same
            // PID-reuse caveat as the `getpgid` call above: if `pid_i32` was
            // recycled, this can signal an unrelated process group. Acceptable
            // here since this is best-effort teardown, not a security boundary.
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }

    // First, try to kill all child processes using pkill
    // pkill -P kills processes whose parent PID matches
    let _ = Command::new("pkill")
        .args(["-KILL", "-P", &pid.to_string()])
        .output();

    // Then kill the process itself using libc
    // SIGKILL (9) ensures immediate termination
    if let Some(pid_i32) = pid_i32 {
        // SAFETY: `kill` only takes integer args; no memory-safety precondition.
        // Same PID-reuse caveat: if the process already exited and its pid was
        // recycled by the OS, SIGKILL is delivered to an unrelated process.
        // Acceptable here because this runs after the `pkill` best-effort pass
        // above and is not a security boundary.
        unsafe {
            libc::kill(pid_i32, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
pub(crate) fn set_new_process_group(cmd: &mut tokio::process::Command) {
    // SAFETY: `pre_exec` runs in the forked child between `fork()` and `exec()`,
    // so the closure must be async-signal-safe. `setpgid(0, 0)` is the only
    // call made here; it takes no pointers, performs no allocation, and is
    // async-signal-safe, satisfying `pre_exec`'s contract.
    unsafe {
        cmd.pre_exec(|| {
            let _ = libc::setpgid(0, 0);
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub(crate) fn kill_process_tree(pid: u32) {
    use std::process::Command;

    // On Windows, use taskkill /T /F /PID <pid>
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

#[cfg(not(unix))]
pub(crate) fn set_new_process_group(_cmd: &mut tokio::process::Command) {}
