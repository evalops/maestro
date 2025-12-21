//! Shared process helpers for tool execution.

/// Kill an entire process tree by PID.
///
/// On Unix systems, this uses SIGKILL to terminate the process and all its descendants.
/// On Windows, it uses `taskkill /T /F`.
#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    use std::process::Command;

    // First, try to kill all child processes using pkill
    // pkill -P kills processes whose parent PID matches
    let _ = Command::new("pkill")
        .args(["-KILL", "-P", &pid.to_string()])
        .output();

    // Then kill the process itself using libc
    // SIGKILL (9) ensures immediate termination
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
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
