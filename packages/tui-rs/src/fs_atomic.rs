//! Shared atomic-write helper for persisted JSON/text state.
//!
//! Tracking issue: adopt one atomic-write helper for all persisted state
//! (session index, checkpoint manifests, UI state, run records, profiler
//! output, ...) instead of the mix of direct `fs::write` and ad hoc
//! temp-file dances that had accumulated across the tree.
//!
//! # Durability guarantees
//!
//! [`write_atomic`] writes to a sibling temp file in the same directory as
//! the target, `fsync`s that file's data, renames it onto the target path,
//! then `fsync`s the *parent directory*. This gives two distinct guarantees
//! that are easy to conflate:
//!
//! - **Survives a killed process (`kill -9`, panic, OOM-kill).** The rename
//!   is atomic on POSIX filesystems: a concurrent reader always observes
//!   either the fully-old file or the fully-new file, never a torn mix of
//!   both. This guarantee holds even without any `fsync` calls, because it
//!   only depends on rename atomicity, not on data reaching disk.
//! - **Survives power loss / unclean shutdown.** This requires the two
//!   `fsync` calls above. Without fsyncing the temp file, the rename can
//!   land before the file's data is durable, so a power loss right after
//!   can leave the target pointing at a temp file with truncated content.
//!   Without fsyncing the *parent directory*, the rename itself (a
//!   directory-entry update) can be lost on power loss even though the
//!   process observed the `rename()` syscall return successfully — the
//!   directory entry update is itself buffered by the filesystem until the
//!   directory inode is flushed.
//!
//! What this does **not** guarantee: durability against a storage device
//! that lies about `fsync` completion (common on some consumer SSDs and
//! virtualized/network block devices), or atomicity on filesystems that
//! don't support same-directory rename semantics (some network filesystems,
//! FAT-family filesystems in certain configurations). Parent-directory
//! `fsync` also has no equivalent on Windows, so it is unconditionally a
//! no-op there (the kill-process guarantee, the common case this codebase
//! cares about most, doesn't depend on it). On Unix, where directory fsync
//! is supported, a real failure to open or sync the directory is
//! propagated as an error from [`write_atomic`] rather than silently
//! ignored: the rename has already published the file by that point, so
//! swallowing the failure would let a caller believe the power-loss
//! guarantee held when it didn't.
//!
//! Any failure during the write leaves no temp file behind: the temp file
//! created by that call is removed on its error path. Temp files from other
//! processes are left untouched: PID liveness is namespace-local, so a
//! process using a shared directory cannot prove that a numerically absent
//! PID is not a live writer in another container.
//!
//! Each call gets its own collision-resistant temp name (pid plus a
//! per-process counter, opened with `create_new`), so two threads in the
//! same process writing the same target concurrently never share — and
//! never truncate or rename — each other's temp file.
//!
//! When `path` is a symlink to an existing file, the write goes to the
//! symlink's referent (matching historical `fs::write` behavior) instead of
//! replacing the link itself with a regular file.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Write `contents` to `path` atomically.
///
/// Readers of `path` never observe a partially written file, even if this
/// process is killed mid-write. See the module docs for the exact
/// crash-safety vs. power-loss-safety guarantees this provides.
///
/// Creates the parent directory if it does not already exist. Accepts
/// anything that derefs to `[u8]`, so both `&str` (via UTF-8 text) and
/// `Vec<u8>`/`&[u8]` (binary content) callers can use the same helper.
pub fn write_atomic<C: AsRef<[u8]>>(path: impl AsRef<Path>, contents: C) -> io::Result<()> {
    write_atomic_impl(path.as_ref(), contents.as_ref(), false)
}

/// Atomically write sensitive contents, creating the replacement inode with
/// owner-only permissions even when the process umask is permissive.
pub fn write_atomic_private<C: AsRef<[u8]>>(path: impl AsRef<Path>, contents: C) -> io::Result<()> {
    write_atomic_impl(path.as_ref(), contents.as_ref(), true)
}

fn write_atomic_impl(path: &Path, contents: &[u8], private: bool) -> io::Result<()> {
    // Follow symlinks like `fs::write` did: when the target is a symlink,
    // write through to the referent instead of replacing the link itself
    // with a regular file. Resolved by following `read_link` hops manually
    // rather than `canonicalize`, which requires the final referent to
    // already exist: a dangling symlink whose referent's parent exists --
    // e.g. `MAESTRO_UI_STATE` pointing into a dotfiles directory before its
    // first save -- must still create the referent through the link, not
    // replace the link itself with a regular file.
    let resolved;
    let path = if path.is_symlink() {
        resolved = resolve_symlink_target(path)?;
        resolved.as_path()
    } else {
        path
    };
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let parent = match parent {
        Some(parent) => parent,
        None => Path::new("."),
    };
    create_dir_all_synced(parent)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("fs_atomic_target");

    // Collision-resistant temp name: pid disambiguates across processes and
    // a per-process counter disambiguates concurrent in-process writers.
    // `create_new` guards against any residual collision instead of
    // truncating another writer's active temp file.
    let (temp_path, file) = loop {
        let counter = TEMP_NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(".{file_name}.{}.{counter}.tmp", std::process::id()));
        match open_new_temp(&candidate, private) {
            Ok(file) => break (candidate, file),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    };

    // Capture the existing target's metadata (if any) before it is
    // replaced, so the temp file can inherit its ownership and permissions;
    // see `write_and_rename`.
    let existing_metadata = fs::metadata(path).ok();

    let result = write_and_rename(&temp_path, path, file, contents, existing_metadata, private);
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn open_new_temp(path: &Path, private: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

static TEMP_NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Create `dir` and any missing ancestors, fsyncing each newly created
/// directory's entry in its parent so the creation itself survives an
/// unclean shutdown, not just a killed process.
///
/// Creating a directory does not make its entry in *its* parent durable on
/// its own; without this, a power loss can lose an entire newly created
/// subtree (e.g. a session's first checkpoint directory, or a config file's
/// first-ever nested parent) even though every file written into it was
/// itself fully synced. Exposed publicly so callers that need to create a
/// directory *without* also writing a file into it right away (e.g.
/// `checkpoints::begin_turn`, which creates a checkpoint's directory before
/// it's known whether anything will be written into it this turn) get the
/// same durability [`write_atomic`] gives its own parent-directory creation,
/// instead of bypassing it with a bare `fs::create_dir_all` that nothing
/// downstream can retroactively sync.
pub fn create_dir_all_synced(dir: impl AsRef<Path>) -> io::Result<()> {
    let dir = dir.as_ref();
    // Record which ancestor directories are missing so their directory
    // entries can be fsynced after `create_dir_all`.
    let mut created_dirs: Vec<&Path> = Vec::new();
    if !dir.exists() {
        for ancestor in dir.ancestors() {
            if ancestor.exists() {
                break;
            }
            created_dirs.push(ancestor);
        }
    }
    fs::create_dir_all(dir)?;
    if created_dirs.is_empty() {
        return Ok(());
    }
    for created in &created_dirs {
        // The empty path is `Path::ancestors()`'s terminal element for a
        // relative path whose every ancestor is missing -- not a real
        // directory to open and fsync (that would fail with `ENOENT` on
        // Unix even though `create_dir_all` above already succeeded). It
        // implicitly means "the process's current directory", which
        // `anchor_for` below already maps to `.` and syncs.
        if created.as_os_str().is_empty() {
            continue;
        }
        sync_dir(created)?;
    }
    sync_dir(&anchor_for(&created_dirs))
}

/// The pre-existing ancestor directory that holds the topmost newly created
/// entry in `created_dirs`, i.e. the directory whose own fsync makes that
/// top-level creation durable.
///
/// `created_dirs` is ordered deepest-first (matching `Path::ancestors`), so
/// its *last* element is that topmost entry; its own parent is the anchor.
/// A relative path whose every ancestor was missing ends with the empty
/// path (`Path::ancestors`'s terminal element for a relative path), which
/// has no `parent()` at all -- that implicitly means the anchor is the
/// process's current directory, so this falls back to `.` rather than
/// silently having no anchor at all (as a
/// `parent.ancestors().nth(created_dirs.len())` lookup would: it runs off
/// the end of a relative path's finite ancestor chain and returns `None`
/// with no explicit fallback, silently skipping the anchor sync).
fn anchor_for(created_dirs: &[&Path]) -> PathBuf {
    created_dirs
        .last()
        .and_then(|deepest_missing| deepest_missing.parent())
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Resolve `path`'s symlink target by following `read_link` hops manually,
/// without requiring the final referent to exist.
///
/// `Path::canonicalize`/`dunce::canonicalize` fully resolve a path, but
/// require every component -- including the final referent -- to already
/// exist, so they fail on a dangling symlink even when the referent's
/// *parent* directory exists (e.g. a fresh dotfiles-style indirection
/// pointing at a file that has simply never been written yet). Following
/// `read_link` hops directly handles that case: each hop only requires the
/// symlink itself to exist, not its target. Bounded to guard against a
/// symlink cycle; if the bound is hit or a hop can't be read, the
/// last-resolved path is returned as-is (mirroring `canonicalize`'s
/// dangling-link fallback of replacing the link itself).
fn resolve_symlink_target(path: &Path) -> io::Result<PathBuf> {
    const MAX_HOPS: u32 = 40;
    let mut current = path.to_path_buf();
    for _ in 0..MAX_HOPS {
        match fs::read_link(&current) {
            Ok(target) if target.is_absolute() => current = target,
            Ok(target) => {
                current = current
                    .parent()
                    .map_or_else(|| target.clone(), |parent| parent.join(&target));
            }
            Err(_) => return Ok(current),
        }
    }
    // Exhausted the hop bound while `current` is still a symlink: a
    // self-referential or multi-link cycle, not a legitimately deep chain.
    // `fs::write`'s historical behavior (via `open()`) failed with `ELOOP`
    // without touching anything; error out the same way here instead of
    // returning a path that is still a symlink -- `write_atomic` renaming a
    // fresh regular file onto it would silently destroy part of the cycle.
    if current.is_symlink() {
        Err(io::Error::other(format!(
            "symlink cycle detected resolving {} (exceeded {MAX_HOPS} hops)",
            path.display()
        )))
    } else {
        Ok(current)
    }
}

fn write_and_rename(
    temp_path: &Path,
    target: &Path,
    mut file: File,
    contents: &[u8],
    existing_metadata: Option<fs::Metadata>,
    private: bool,
) -> io::Result<()> {
    // Preserve the target's existing ownership and permissions (e.g. a
    // user-owned `0600` secrets file during a one-off privileged run) on the
    // temp file *before writing any contents to it*, not after. Rename
    // installs the temp inode's metadata, so copying only the mode could
    // otherwise leave a user-owned state file owned by root.
    if let Some(metadata) = existing_metadata {
        apply_existing_metadata(&file, metadata)?;
    }
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents)?;
    // Durability guarantee #1 (power loss): flush the temp file's data (and,
    // per the above, its mode) to disk before it becomes visible under the
    // target name.
    file.sync_all()?;
    drop(file);

    fs::rename(temp_path, target)?;

    // Durability guarantee #2 (power loss): fsync the parent directory so
    // the rename's directory-entry update survives an unclean shutdown.
    // Propagated (not best-effort) on platforms where directory fsync is
    // supported: the rename has already published the file by this point,
    // so a failure here means the advertised power-loss guarantee was not
    // actually met, and a caller relying on that guarantee needs to know.
    sync_dir(temp_path.parent().unwrap_or_else(|| Path::new(".")))
}

#[cfg(unix)]
fn apply_existing_metadata(file: &File, metadata: fs::Metadata) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    apply_existing_metadata_with(file, metadata, |metadata| {
        // SAFETY: `file` owns a valid, open descriptor for the private temp
        // file, and `fchown` does not retain the descriptor or pointers.
        if unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    })
}

#[cfg(unix)]
fn apply_existing_metadata_with(
    file: &File,
    metadata: fs::Metadata,
    preserve_ownership: impl FnOnce(&fs::Metadata) -> io::Result<()>,
) -> io::Result<()> {
    match preserve_ownership(&metadata) {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(libc::EPERM) => {
            // A caller may legitimately be able to overwrite a group- or
            // world-writable file without being allowed to chown a fresh
            // inode to the file's owner. Preserve the mode and continue;
            // the replacement will be owned by the writing process.
        }
        Err(err) => return Err(err),
    }
    // chown may clear setuid/setgid bits, so restore the exact mode after
    // the ownership attempt rather than before it.
    file.set_permissions(metadata.permissions())
}

#[cfg(not(unix))]
fn apply_existing_metadata(file: &File, metadata: fs::Metadata) -> io::Result<()> {
    file.set_permissions(metadata.permissions())
}

/// Fsync a directory so a just-created entry inside it (a file rename, or
/// the directory itself having just been created) survives an unclean
/// shutdown.
///
/// Directory fsync has no equivalent on Windows, so it is unconditionally
/// treated as unsupported (and therefore always succeeds as a no-op)
/// there; on Unix, a real failure to open or sync the directory is
/// propagated rather than silently ignored, since it means this function's
/// entire reason for existing -- the power-loss guarantee -- was not met.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Rotate a corrupt/unreadable state file aside instead of silently
/// discarding it, so there is forensic evidence a load-time corruption
/// happened. Best-effort: failures to rename are logged to stderr and
/// otherwise ignored, since callers of this helper are already on a
/// best-effort recovery path.
///
/// Returns the rotated-aside path on success.
pub fn rotate_corrupt_aside(path: &Path) -> Option<std::path::PathBuf> {
    let mut rotated: OsString = path.as_os_str().to_os_string();
    let suffix = format!(
        ".corrupt.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    rotated.push(suffix);
    let rotated = std::path::PathBuf::from(rotated);
    match fs::rename(path, &rotated) {
        Ok(()) => Some(rotated),
        Err(err) => {
            eprintln!(
                "fs_atomic: failed to rotate corrupt file {} aside: {err}",
                path.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writes_and_reads_back_str_contents() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");

        write_atomic(&path, "{\"a\":1}").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn writes_and_reads_back_binary_contents() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blob.bin");
        let bytes: Vec<u8> = vec![0, 159, 146, 150, 255];

        write_atomic(&path, &bytes).unwrap();

        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn creates_parent_directory_if_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("deep").join("state.json");

        write_atomic(&path, "content").unwrap();

        assert!(path.exists());
    }

    /// Regression test: for a relative path whose every ancestor is
    /// missing, `Path::ancestors()` terminates at the empty path, which
    /// has no `parent()` -- the anchor computation must recognize that as
    /// "the process's current directory" (`.`) instead of silently having
    /// no anchor at all.
    #[test]
    fn anchor_for_relative_path_with_every_ancestor_missing_is_cwd() {
        let created_dirs: Vec<&Path> =
            vec![Path::new("state/agent"), Path::new("state"), Path::new("")];
        assert_eq!(anchor_for(&created_dirs), PathBuf::from("."));
    }

    #[test]
    fn anchor_for_absolute_path_is_the_first_pre_existing_ancestor() {
        let created_dirs: Vec<&Path> = vec![Path::new("/tmp/foo/bar"), Path::new("/tmp/foo")];
        assert_eq!(anchor_for(&created_dirs), PathBuf::from("/tmp"));
    }

    #[test]
    fn anchor_for_single_missing_level_is_its_direct_parent() {
        let created_dirs: Vec<&Path> = vec![Path::new("/tmp/only-missing")];
        assert_eq!(anchor_for(&created_dirs), PathBuf::from("/tmp"));
    }

    /// `create_dir_all_synced` (used directly by `checkpoints::begin_turn`
    /// so a directory can be created and made durable without also writing
    /// a file into it right away) must create and sync a deep,
    /// entirely-missing subtree, not just its own immediate parent.
    #[test]
    fn create_dir_all_synced_creates_a_deep_missing_subtree() {
        let dir = TempDir::new().unwrap();
        let target = dir
            .path()
            .join("checkpoints")
            .join("session-1")
            .join("chk1");

        create_dir_all_synced(&target).unwrap();

        assert!(target.is_dir());
    }

    /// A real, non-Windows fsync failure (here: the directory does not
    /// exist, so `File::open` fails) must be propagated, not silently
    /// swallowed -- the whole point of `sync_dir` existing is a durability
    /// guarantee that a caller needs to know was not met.
    #[cfg(unix)]
    #[test]
    fn sync_dir_propagates_a_real_failure() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(sync_dir(&missing).is_err());
    }

    #[test]
    fn overwrite_replaces_content_exactly_and_leaves_no_temp_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");

        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second-and-longer-content").unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "second-and-longer-content"
        );

        let leftover_tmp = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover_tmp, "no .tmp file should remain after a write");
    }

    #[test]
    fn cleans_up_temp_file_when_rename_fails() {
        // Target path is an existing non-empty directory, so the rename
        // in write_and_rename cannot succeed on any platform.
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("occupied.txt"), b"keep").unwrap();

        let result = write_atomic(&target, "should not land");
        assert!(result.is_err());

        // The directory at `target` must be untouched.
        assert!(target.is_dir());
        assert!(target.join("occupied.txt").exists());

        // No temp file left behind in the parent directory.
        let leftover_tmp = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(
            !leftover_tmp,
            "temp file must be cleaned up on rename failure"
        );
    }

    /// PID liveness is namespace-local, so an absent numeric PID cannot prove
    /// a foreign writer using a shared directory is dead. Leave its inert temp
    /// file alone; successful writers clean up their own error paths.
    #[test]
    fn preserves_foreign_temp_file_when_liveness_cannot_be_proven() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");
        fs::write(&path, "{\"committed\":true}").unwrap();

        let foreign_temp = dir.path().join(".state.json.999999999.tmp");
        fs::write(&foreign_temp, "{\"in_progress\":").unwrap();

        write_atomic(&path, "{\"committed\":true,\"generation\":2}").unwrap();

        assert!(
            foreign_temp.exists(),
            "a foreign PID that is invisible locally may still be a live writer"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"committed\":true,\"generation\":2}"
        );
    }

    #[test]
    fn rotate_corrupt_aside_moves_file_and_preserves_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("manifest.json");
        fs::write(&path, "not valid json {{{").unwrap();

        let rotated = rotate_corrupt_aside(&path).expect("rotate should succeed");

        assert!(!path.exists());
        assert!(rotated.exists());
        assert_eq!(fs::read_to_string(&rotated).unwrap(), "not valid json {{{");
        assert!(
            rotated
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".corrupt.")
        );
    }

    /// A temp file whose embedded pid belongs to a live process (here: this
    /// one) must not be swept — it may be another writer's active temp.
    #[test]
    fn keeps_temp_file_whose_pid_is_alive() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");

        let live_temp = dir
            .path()
            .join(format!(".state.json.{}.0.tmp", std::process::id()));
        fs::write(&live_temp, "{\"in_progress\":").unwrap();

        write_atomic(&path, "{\"committed\":true}").unwrap();

        assert!(
            live_temp.exists(),
            "temp file of a live process must not be swept"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"committed\":true}");
    }

    /// Two in-process threads writing the same target concurrently use
    /// distinct temp names, so neither can truncate or rename the other's
    /// temp mid-write; every observed content is a complete write.
    #[test]
    fn concurrent_writers_publish_only_complete_contents() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("state.json");
        write_atomic(&path, "initial").unwrap();

        let contents = [
            "{\"writer\":\"a\",\"payload\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
            "{\"writer\":\"b\",\"payload\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
        ];
        std::thread::scope(|scope| {
            for content in contents {
                let path = &path;
                scope.spawn(move || {
                    for _ in 0..50 {
                        write_atomic(path, content).unwrap();
                    }
                });
            }
        });

        let final_content = fs::read_to_string(&path).unwrap();
        assert!(
            contents.contains(&final_content.as_str()),
            "final content must be one complete write, got: {final_content}"
        );
        let leftover_tmp = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover_tmp, "no .tmp file should remain after the writes");
    }

    /// Writing to a symlink target updates the referent (historical
    /// `fs::write` behavior) instead of replacing the link with a file.
    #[cfg(unix)]
    #[test]
    fn writes_through_symlink_to_referent() {
        let dir = TempDir::new().unwrap();
        let referent = dir.path().join("real-state.json");
        fs::write(&referent, "old").unwrap();
        let link = dir.path().join("ui-state.json");
        std::os::unix::fs::symlink(&referent, &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(link.is_symlink(), "symlink itself must be preserved");
        assert_eq!(fs::read_to_string(&referent).unwrap(), "new");
        assert_eq!(fs::read_to_string(&link).unwrap(), "new");
    }

    /// A dangling symlink (referent does not exist yet, but its parent
    /// directory does -- e.g. a fresh dotfiles-style indirection before its
    /// first save) must still write through to the referent, not replace
    /// the link itself with a regular file. `canonicalize` fails on a
    /// dangling link, which is exactly why `write_atomic` resolves symlinks
    /// via `read_link` hops instead.
    #[cfg(unix)]
    #[test]
    fn write_atomic_follows_dangling_symlink_to_referent() {
        let dir = TempDir::new().unwrap();
        let referent = dir.path().join("real-state.json");
        let link = dir.path().join("ui-state.json");
        std::os::unix::fs::symlink(&referent, &link).unwrap();
        assert!(!referent.exists(), "referent must not exist yet");

        write_atomic(&link, "first save").unwrap();

        assert!(
            link.is_symlink(),
            "the dangling symlink itself must be preserved, not replaced"
        );
        assert_eq!(fs::read_to_string(&referent).unwrap(), "first save");
        assert_eq!(fs::read_to_string(&link).unwrap(), "first save");
    }

    /// A self-referential symlink cycle must error out (matching
    /// `fs::write`'s historical `ELOOP` behavior via `open()`), not have a
    /// fresh regular file renamed onto part of the cycle.
    #[cfg(unix)]
    #[test]
    fn write_atomic_errors_on_a_symlink_cycle_instead_of_replacing_it() {
        let dir = TempDir::new().unwrap();
        let link = dir.path().join("cycle.json");
        std::os::unix::fs::symlink(&link, &link).unwrap();

        let result = write_atomic(&link, "should not land");

        assert!(result.is_err(), "a symlink cycle must be rejected");
        assert!(
            link.is_symlink(),
            "the cycle must be untouched, not partially replaced"
        );
    }

    /// An existing target's permissions must survive a `write_atomic`
    /// overwrite: the temp file inherits them before the durability sync,
    /// so a crash right after a successful write can never leave a durable
    /// file with the wrong (umask-derived default) mode.
    #[cfg(unix)]
    #[test]
    fn write_atomic_preserves_existing_target_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("secret.json");
        write_atomic(&path, "first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let original = fs::metadata(&path).unwrap();

        write_atomic(&path, "second").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let replaced = fs::metadata(&path).unwrap();
        assert_eq!(
            replaced.uid(),
            original.uid(),
            "owner uid must be preserved"
        );
        assert_eq!(
            replaced.gid(),
            original.gid(),
            "owner group must be preserved"
        );
        assert_eq!(
            replaced.permissions().mode() & 0o777,
            0o600,
            "overwrite must preserve the existing target's permissions",
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_private_enforces_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("tool-output.txt");
        write_atomic(&path, "public mode").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_atomic_private(&path, "sensitive output").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "sensitive output");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_continues_when_chown_is_not_permitted() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let target = dir.path().join("shared.json");
        let temp = dir.path().join("temp.json");
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o666)).unwrap();
        fs::write(&temp, "new").unwrap();
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).unwrap();

        let target_metadata = fs::metadata(&target).unwrap();
        let file = OpenOptions::new().write(true).open(&temp).unwrap();
        apply_existing_metadata_with(&file, target_metadata, |_| {
            Err(io::Error::from_raw_os_error(libc::EPERM))
        })
        .expect("EPERM from chown must not reject an otherwise writable target");

        assert_eq!(
            fs::metadata(&temp).unwrap().permissions().mode() & 0o777,
            0o666
        );
    }

    /// A brand-new target (no prior file to inherit permissions from) still
    /// gets the process's normal umask-derived default mode, matching
    /// `fs::write`'s historical behavior for a first write.
    #[cfg(unix)]
    #[test]
    fn write_atomic_uses_default_permissions_for_a_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("new-file.json");

        write_atomic(&path, "content").unwrap();

        // Not asserting an exact mode (umask varies by environment): just
        // that this doesn't panic/error and the file is readable, i.e. no
        // permissions were carried over from a nonexistent prior target.
        assert_eq!(fs::read_to_string(&path).unwrap(), "content");
    }
}
