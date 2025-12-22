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
        let pgid = unsafe { libc::getpgid(pid_i32) };
        if pgid > 0 && pgid == pid_i32 {
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
        unsafe {
            libc::kill(pid_i32, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
pub(crate) fn set_new_process_group(cmd: &mut tokio::process::Command) {
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
