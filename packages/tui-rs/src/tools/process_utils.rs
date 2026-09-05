//! Shared process helpers for tool execution.

/// Return whether a Unix process group still has at least one member.
#[cfg(unix)]
pub(crate) fn process_group_exists(process_group_id: u32) -> bool {
    if process_group_id <= 1 {
        return false;
    }
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
    if process_group_id <= 1 {
        return;
    }
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

/// Kill an entire process tree by PID.
///
/// Signal parents before children: killing a child first can wake a waiting
/// shell and let it execute another command before shutdown reaches the shell.
/// Snapshot owned process groups before any leaders exit, then sweep those
/// groups for children forked after discovery.
#[cfg(unix)]
pub(crate) fn kill_process_tree_tracked(pid: u32) -> Vec<u32> {
    if pid <= 1 || i32::try_from(pid).is_err() {
        return Vec::new();
    }
    let processes: Vec<i32> = std::iter::once(pid)
        .chain(descendant_processes(pid))
        .filter_map(|pid| i32::try_from(pid).ok())
        .collect();
    let mut process_groups = Vec::new();
    for &pid in &processes {
        // SAFETY: `getpgid` accepts and returns integer process identifiers.
        let group = unsafe { libc::getpgid(pid) };
        // A group's leader must belong to this tree before we may kill the
        // whole group; a descendant can belong to an unrelated caller's group.
        if group == pid && !process_groups.contains(&(group as u32)) {
            process_groups.push(group as u32);
        }
    }
    for pid in processes {
        // SAFETY: `kill` takes integer identifiers. Each positive PID came
        // from the requested root or its descendant snapshot, parent first.
        unsafe {
            let _ = libc::kill(pid, libc::SIGKILL);
        }
    }
    for &group in &process_groups {
        kill_process_group(group);
    }
    process_groups
}

#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    let _ = kill_process_tree_tracked(pid);
}

#[cfg(unix)]
pub(crate) fn set_new_process_group(cmd: &mut tokio::process::Command) {
    set_std_process_group(cmd.as_std_mut());
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

/// Establish containment before exec; failure is returned by spawn.
#[cfg(unix)]
pub(crate) fn set_std_process_group(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// Own a group created before exec, including pipes inherited after leader exit.
#[cfg(unix)]
pub(crate) struct ProcessGroupGuard(Option<u32>);

#[cfg(unix)]
impl ProcessGroupGuard {
    pub(crate) fn new(pid: Option<u32>) -> Self {
        Self(pid.filter(|pid| *pid > 1 && i32::try_from(*pid).is_ok()))
    }
    pub(crate) fn disarm(&mut self) {
        self.0 = None;
    }
    pub(crate) fn terminate(&mut self) {
        if let Some(pid) = self.0.take() {
            kill_process_group(pid);
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_group_owner_stops_commands_after_readiness() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("unexpected");
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "printf ready; sleep 30; touch unexpected"])
            .current_dir(dir.path())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        set_new_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let guard = ProcessGroupGuard::new(child.id());
        let mut stdout = child.stdout.take().unwrap();
        let mut ready = [0; 5];
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stdout.read_exact(&mut ready),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&ready, b"ready");
        drop(guard);
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        let mut tail = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stdout.read_to_end(&mut tail),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(tail.is_empty());
        assert!(!marker.exists());
    }

    #[test]
    fn invalid_process_roots_do_not_signal_the_calling_group() {
        assert!(!process_group_exists(0));
        kill_process_group(0);
        assert!(!process_group_exists(1));
        kill_process_group(1);
        assert!(kill_process_tree_tracked(1).is_empty());
        assert!(kill_process_tree_tracked(0).is_empty());
        assert!(kill_process_tree_tracked(u32::MAX).is_empty());
    }
}
