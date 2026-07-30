//! Shared process helpers for tool execution.

/// Return whether a Unix process group still has at least one member.
#[cfg(unix)]
pub(crate) fn process_group_exists(process_group_id: u32) -> bool {
    let Ok(process_group_id) = i32::try_from(process_group_id) else {
        return false;
    };
    // SAFETY: `kill` with signal 0 performs an existence/permission check and
    // only accepts integer arguments. A negative PID addresses the process
    // group whose ID is the absolute value.
    let result = unsafe { libc::kill(-process_group_id, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Kill a Unix process group by its stable group identity.
///
/// This works after the original leader exits while descendants remain.
#[cfg(unix)]
pub(crate) fn kill_process_group(process_group_id: u32) {
    let Ok(process_group_id) = i32::try_from(process_group_id) else {
        return;
    };
    // SAFETY: `kill` only accepts integer arguments. A negative PID targets
    // the process group rather than an individual process.
    unsafe {
        let _ = libc::kill(-process_group_id, libc::SIGKILL);
    }
}

#[cfg(unix)]
fn descendant_processes(root_pid: u32) -> Vec<u32> {
    use std::process::Command;

    let mut descendants = Vec::new();
    let mut pending = vec![root_pid];
    while let Some(parent_pid) = pending.pop() {
        let Ok(output) = Command::new("pgrep")
            .args(["-P", &parent_pid.to_string()])
            .output()
        else {
            continue;
        };
        for child_pid in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            if !descendants.contains(&child_pid) {
                descendants.push(child_pid);
                pending.push(child_pid);
            }
        }
    }
    descendants
}

#[cfg(unix)]
fn kill_process_or_group(pid: u32) -> Option<u32> {
    let Ok(pid) = i32::try_from(pid) else {
        return None;
    };
    // SAFETY: `getpgid` accepts and returns integer process identifiers only.
    let process_group_id = unsafe { libc::getpgid(pid) };
    let target = if process_group_id == pid { -pid } else { pid };
    // SAFETY: `kill` accepts integer process/group and signal identifiers only.
    unsafe {
        let _ = libc::kill(target, libc::SIGKILL);
    }
    (process_group_id == pid).then_some(pid as u32)
}

/// Kill an entire process tree by PID.
///
/// On Unix systems, this uses SIGKILL to terminate the process and all its descendants.
/// On Windows, it uses `taskkill /T /F`.
#[cfg(unix)]
pub(crate) fn kill_process_tree_tracked(pid: u32) -> Vec<u32> {
    let descendants = descendant_processes(pid);
    let mut killed_process_groups = Vec::new();
    for descendant_pid in descendants.into_iter().rev() {
        if let Some(process_group_id) = kill_process_or_group(descendant_pid) {
            if !killed_process_groups.contains(&process_group_id) {
                killed_process_groups.push(process_group_id);
            }
        }
    }
    if let Some(process_group_id) = kill_process_or_group(pid) {
        if !killed_process_groups.contains(&process_group_id) {
            killed_process_groups.push(process_group_id);
        }
    }
    killed_process_groups
}

#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    let _ = kill_process_tree_tracked(pid);
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

/// Make the spawned Linux process a child subreaper.
///
/// Session-detached grandchildren are then reparented to the supervising shell
/// instead of escaping to the host process. The shell remains alive until its
/// adopted descendants exit, so cancellation can still discover and terminate
/// the complete tree.
#[cfg(target_os = "linux")]
pub(crate) fn set_child_subreaper(cmd: &mut tokio::process::Command) {
    // SAFETY: `pre_exec` runs after fork and before exec. `prctl` with
    // PR_SET_CHILD_SUBREAPER takes integer arguments only, performs no
    // allocation, and is safe to invoke in this restricted child context.
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn set_child_subreaper(_cmd: &mut tokio::process::Command) {}

#[cfg(not(unix))]
pub(crate) fn kill_process_tree_tracked(pid: u32) -> Vec<u32> {
    use std::process::Command;

    // On Windows, use taskkill /T /F /PID <pid>
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
    Vec::new()
}

#[cfg(not(unix))]
pub(crate) fn kill_process_tree(pid: u32) {
    let _ = kill_process_tree_tracked(pid);
}

#[cfg(not(unix))]
pub(crate) fn set_new_process_group(_cmd: &mut tokio::process::Command) {}
