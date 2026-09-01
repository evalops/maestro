//! File-level checkpoints for `/rewind files`.
//!
//! Each user prompt submission in the TUI records a lightweight checkpoint of the
//! git worktree so the files an agent turn modifies can be restored later. This
//! mirrors grok-build's rewind behavior without ever creating commits or stashes
//! in the user's repository: all checkpoint data lives under the per-session
//! storage directory (`<sessions_dir>/checkpoints/<session_key>/<checkpoint_id>/`).
//!
//! # Snapshot mechanism (two-phase)
//!
//! A naive "snapshot everything before the turn" is too expensive on large
//! worktrees, and a naive "diff after the turn" cannot recover pre-turn content
//! for files that were clean at turn start. This module combines both:
//!
//! - **Begin (pre-turn)**: capture `git status --porcelain -z --no-renames` and
//!   the HEAD commit. For every *already dirty* tracked file, snapshot the full
//!   worktree content into the checkpoint's blob store. Untracked paths are
//!   recorded by name only (never snapshotted, so untracked dumps like
//!   `node_modules/` are never read).
//! - **Finalize (post-turn)**: re-run `git status` and diff it against the
//!   pre-turn snapshot. For each file the turn touched, the pre-turn content is
//!   either the begin-phase blob (dirty files) or `git show <head>:<path>`
//!   (files that were clean at turn start — the blob object exists in the repo
//!   regardless of later commits). The pre-turn blob and the post-turn content
//!   hash are recorded in a self-contained `checkpoint.json` manifest.
//!
//! # Restore semantics
//!
//! `/rewind files` restores the most recent checkpoint:
//!
//! - Modified/deleted files are written back **only if** their current content
//!   hash still equals the recorded post-turn hash. A mismatch means the user
//!   (or another tool) edited the file after the turn; the file is skipped with
//!   a warning and never clobbered.
//! - Untracked files created during the turn are deleted only if they are
//!   unchanged since the turn ended.
//! - The checkpoint is consumed (popped) once applied.
//!
//! Non-git directories: checkpointing silently no-ops and `/rewind files`
//! reports that checkpoints require a git worktree.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git;

/// Maximum number of checkpoints retained per session (FIFO eviction).
pub const MAX_CHECKPOINTS_PER_SESSION: usize = 20;

/// Safety cap on expanding an untracked directory created during a turn.
/// Larger directories (e.g. a freshly installed `node_modules/`) are not
/// recorded, so they are never deleted on rewind.
const MAX_EXPANDED_UNTRACKED_FILES: usize = 1000;

const MANIFEST_FILE: &str = "checkpoint.json";

/// On-disk store for one session's checkpoints.
pub struct CheckpointStore {
    root: PathBuf,
    legacy_root: PathBuf,
}

impl CheckpointStore {
    #[must_use]
    pub fn new(sessions_dir: &Path, session_id: &str) -> Self {
        let checkpoints_root = sessions_dir.join("checkpoints");
        Self {
            root: checkpoints_root.join(encode_session_component(session_id)),
            legacy_root: checkpoints_root.join(sanitize_component(session_id)),
        }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The pre-v2 root used by existing sessions. New checkpoints are never
    /// written here, but old checkpoints remain readable and removable.
    pub(crate) fn legacy_root(&self) -> &Path {
        &self.legacy_root
    }

    /// Load all finalized checkpoints, oldest first. Corrupt or half-written
    /// checkpoint directories are ignored.
    #[must_use]
    pub fn list(&self) -> Vec<Checkpoint> {
        // Read v2 first so a checkpoint ID present in both roots resolves to
        // the collision-proof copy rather than the legacy copy.
        let mut by_id = HashMap::new();
        for root in [&self.root, &self.legacy_root] {
            for checkpoint in read_checkpoints_from_root(root) {
                by_id.entry(checkpoint.id.clone()).or_insert(checkpoint);
            }
        }
        let mut checkpoints = by_id.into_values().collect::<Vec<_>>();
        checkpoints.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        checkpoints
    }

    #[must_use]
    pub fn latest(&self) -> Option<Checkpoint> {
        self.list().pop()
    }

    fn save(&self, checkpoint: &Checkpoint) -> io::Result<()> {
        let dir = self.new_checkpoint_dir(&checkpoint.id);
        // Usually a no-op by the time this runs (`begin_turn` already
        // created `dir` via the same synced path), but kept consistent
        // with it rather than a bare `fs::create_dir_all` in case `save`
        // is ever reached some other way.
        crate::fs_atomic::create_dir_all_synced(&dir)?;
        let bytes = serde_json::to_vec_pretty(checkpoint)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        crate::fs_atomic::write_atomic(dir.join(MANIFEST_FILE), bytes)
    }

    pub fn remove(&self, id: &str) -> io::Result<()> {
        let component = sanitize_component(id);
        let mut first_error = None;
        for root in [&self.root, &self.legacy_root] {
            match fs::remove_dir_all(root.join(&component)) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => {
                    first_error.get_or_insert(err);
                }
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    fn new_checkpoint_dir(&self, id: &str) -> PathBuf {
        self.root.join(sanitize_component(id))
    }

    fn checkpoint_dir_for_restore(&self, id: &str) -> PathBuf {
        let component = sanitize_component(id);
        let v2_dir = self.root.join(&component);
        if v2_dir.join(MANIFEST_FILE).is_file() {
            v2_dir
        } else {
            self.legacy_root.join(component)
        }
    }

    /// Keep only the newest `keep` checkpoints (FIFO eviction). Best effort.
    pub fn evict(&self, keep: usize) {
        let checkpoints = self.list();
        if checkpoints.len() <= keep {
            return;
        }
        for checkpoint in &checkpoints[..checkpoints.len() - keep] {
            let _ = self.remove(&checkpoint.id);
        }
    }
}

/// What happened to a file during the turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// Tracked file content changed (or a deleted tracked file reappeared).
    Modified,
    /// Tracked file deleted during the turn.
    Deleted,
    /// File created during the turn (untracked, or previously absent).
    Created,
}

/// One file recorded in a checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Repo-relative path (forward slashes).
    pub path: String,
    pub kind: EntryKind,
    /// SHA-256 of the pre-turn content; blob stored at `blobs/<hash>`.
    /// `None` means the file did not exist before the turn.
    pub pre_blob: Option<String>,
    /// SHA-256 of the post-turn content. `None` means the file was absent
    /// after the turn.
    pub post_hash: Option<String>,
}

/// A finalized checkpoint manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    /// RFC 3339 timestamp; also used for FIFO ordering.
    pub created_at: String,
    /// Excerpt of the prompt that started the turn.
    pub prompt: String,
    pub repo_root: PathBuf,
    /// HEAD commit at turn start (used to recover clean files' content).
    pub head: Option<String>,
    pub entries: Vec<FileEntry>,
}

impl Checkpoint {
    /// Short id for display.
    #[must_use]
    pub fn short_id(&self) -> &str {
        self.id.get(..8).unwrap_or(&self.id)
    }
}

/// Pre-turn snapshot awaiting turn completion.
pub struct PendingTurn {
    store: CheckpointStore,
    id: String,
    prompt: String,
    created_at: String,
    repo_root: PathBuf,
    head: Option<String>,
    /// Dirty tracked files at turn start: path → pre-turn content hash
    /// (`None` = file absent from the worktree at turn start).
    pre_dirty: HashMap<String, Option<String>>,
    /// Untracked paths at turn start. Never snapshotted or restored.
    pre_untracked: HashSet<String>,
    /// Dirty files whose content could not be read; never restored.
    unreadable: HashSet<String>,
}

/// Capture the pre-turn snapshot. Returns `None` when `cwd` is not inside a
/// git worktree (checkpointing silently no-ops there).
#[must_use]
pub fn begin_turn(
    cwd: &Path,
    sessions_dir: &Path,
    session_id: &str,
    prompt: &str,
) -> Option<PendingTurn> {
    let repo_root = PathBuf::from(git::repo_root(cwd)?);
    let head = git_text(&repo_root, &["rev-parse", "--verify", "HEAD"]);
    let status = status_snapshot(&repo_root)?;

    let store = CheckpointStore::new(sessions_dir, session_id);
    let id = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let cp_dir = store.new_checkpoint_dir(&id);
    // `create_dir_all_synced` (not a bare `fs::create_dir_all`) so this
    // checkpoint directory's creation is itself durable: for a turn that
    // only creates new files, `store_blob` below is never called, making
    // this the *only* thing that creates `cp_dir` and its ancestors --
    // a bare `fs::create_dir_all` here would let `write_atomic` later see
    // an already-existing parent and skip its own new-directory fsync
    // logic entirely, so a power loss right after `finalize_turn` returns
    // could still make the whole checkpoint (and its manifest) disappear.
    crate::fs_atomic::create_dir_all_synced(cp_dir.join("blobs")).ok()?;

    let mut pre_dirty = HashMap::new();
    let mut unreadable = HashSet::new();
    for path in status.dirty {
        match fs::read(repo_root.join(&path)) {
            Ok(bytes) => match store_blob(&cp_dir, &bytes) {
                Ok(hash) => {
                    pre_dirty.insert(path, Some(hash));
                }
                Err(_) => {
                    unreadable.insert(path);
                }
            },
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                pre_dirty.insert(path, None);
            }
            Err(_) => {
                // Unreadable (permissions, gitlink dir, ...): never restore it.
                unreadable.insert(path);
            }
        }
    }

    Some(PendingTurn {
        store,
        id,
        prompt: prompt_excerpt(prompt),
        created_at: chrono::Utc::now().to_rfc3339(),
        repo_root,
        head,
        pre_dirty,
        pre_untracked: status.untracked,
        unreadable,
    })
}

/// Diff the worktree against the pre-turn snapshot and persist a checkpoint
/// for everything the turn changed. Returns `None` when nothing changed (the
/// pending directory is removed) or the repository disappeared.
pub fn finalize_turn(pending: PendingTurn) -> io::Result<Option<Checkpoint>> {
    let cp_dir = pending.store.new_checkpoint_dir(&pending.id);
    let Some(post) = status_snapshot(&pending.repo_root) else {
        let _ = fs::remove_dir_all(&cp_dir);
        return Ok(None);
    };

    let mut entries: Vec<FileEntry> = Vec::new();

    // Tracked candidates: anything dirty before or after the turn.
    let mut candidates: HashSet<&str> = pending.pre_dirty.keys().map(String::as_str).collect();
    candidates.extend(post.dirty.iter().map(String::as_str));
    for path in candidates {
        if pending.unreadable.contains(path) {
            continue;
        }
        if pending.pre_untracked.contains(path) {
            // Pre-existing untracked file: content was never snapshotted.
            continue;
        }
        let pre_blob = match pending.pre_dirty.get(path) {
            Some(hash) => hash.clone(),
            None => {
                // Clean at turn start: pre-turn content is the HEAD blob. If
                // the file is not in HEAD it was created (and staged) during
                // the turn.
                pending
                    .head
                    .as_deref()
                    .and_then(|head| head_blob(&pending.repo_root, head, path))
                    .map(|bytes| store_blob(&cp_dir, &bytes))
                    .transpose()?
            }
        };
        let Ok(post_hash) = file_hash(&pending.repo_root.join(path)) else {
            continue;
        };
        if pre_blob == post_hash {
            continue;
        }
        let kind = match (&pre_blob, &post_hash) {
            (None, Some(_)) => EntryKind::Created,
            (Some(_), None) => EntryKind::Deleted,
            _ => EntryKind::Modified,
        };
        entries.push(FileEntry {
            path: path.to_string(),
            kind,
            pre_blob,
            post_hash,
        });
    }

    // Untracked files created during the turn.
    for path in post.untracked.difference(&pending.pre_untracked) {
        if path.ends_with('/') {
            // Collapsed untracked directory: expand to per-file entries so
            // rewind can delete files individually and skip changed ones.
            let mut files = Vec::new();
            collect_files(
                &pending.repo_root.join(path),
                &pending.repo_root,
                &mut files,
            );
            if files.len() > MAX_EXPANDED_UNTRACKED_FILES {
                continue;
            }
            for (rel, abs) in files {
                if let Ok(Some(hash)) = file_hash(&abs) {
                    entries.push(FileEntry {
                        path: rel,
                        kind: EntryKind::Created,
                        pre_blob: None,
                        post_hash: Some(hash),
                    });
                }
            }
        } else if let Ok(Some(hash)) = file_hash(&pending.repo_root.join(path)) {
            entries.push(FileEntry {
                path: path.clone(),
                kind: EntryKind::Created,
                pre_blob: None,
                post_hash: Some(hash),
            });
        }
    }

    if entries.is_empty() {
        let _ = fs::remove_dir_all(&cp_dir);
        return Ok(None);
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let checkpoint = Checkpoint {
        id: pending.id,
        created_at: pending.created_at,
        prompt: pending.prompt,
        repo_root: pending.repo_root,
        head: pending.head,
        entries,
    };
    pending.store.save(&checkpoint)?;
    pending.store.evict(MAX_CHECKPOINTS_PER_SESSION);
    Ok(Some(checkpoint))
}

/// Outcome of restoring one checkpoint.
#[derive(Debug, Default)]
pub struct RestoreReport {
    pub checkpoint_id: String,
    pub prompt: String,
    /// Files whose pre-turn content was written back.
    pub restored: Vec<String>,
    /// Agent-created files deleted.
    pub deleted: Vec<String>,
    /// Files changed after the turn; left untouched.
    pub skipped: Vec<String>,
    /// Agent-created files already gone; nothing to do.
    pub gone: Vec<String>,
}

/// Restore the most recent checkpoint, consuming it. Returns `None` when the
/// session has no checkpoints.
pub fn restore_latest(store: &CheckpointStore) -> io::Result<Option<RestoreReport>> {
    let Some(checkpoint) = store.latest() else {
        return Ok(None);
    };
    restore_checkpoint(store, &checkpoint).map(Some)
}

/// Restore a specific checkpoint: write back snapshotted pre-turn content for
/// files the turn modified and delete files the turn created — but only when
/// the file is byte-identical to its post-turn state. Anything the user
/// touched after the turn is skipped. The checkpoint is consumed afterwards.
pub fn restore_checkpoint(
    store: &CheckpointStore,
    checkpoint: &Checkpoint,
) -> io::Result<RestoreReport> {
    let cp_dir = store.checkpoint_dir_for_restore(&checkpoint.id);
    let mut report = RestoreReport {
        checkpoint_id: checkpoint.id.clone(),
        prompt: checkpoint.prompt.clone(),
        ..RestoreReport::default()
    };

    for entry in &checkpoint.entries {
        let abs = checkpoint.repo_root.join(&entry.path);
        let Ok(current_hash) = file_hash(&abs) else {
            report.skipped.push(entry.path.clone());
            continue;
        };
        if current_hash == entry.post_hash {
            // Post-turn state intact: safe to revert.
            match &entry.pre_blob {
                Some(hash) => {
                    let bytes = read_blob(&cp_dir, hash)?;
                    // Atomic: this overwrites a file in the user's working
                    // tree, so a torn write here would corrupt their source
                    // file, not just internal checkpoint state. `write_atomic`
                    // itself preserves the existing file's permissions (e.g.
                    // executable bits on a restored script) as part of its
                    // own durability sync, so there is no separate
                    // `set_permissions` step here that could itself be lost
                    // to a crash between the write succeeding and the mode
                    // change landing.
                    crate::fs_atomic::write_atomic(&abs, &bytes)?;
                    report.restored.push(entry.path.clone());
                }
                None => {
                    // File created during the turn: remove it and prune any
                    // directories the turn created with it.
                    fs::remove_file(&abs)?;
                    prune_empty_dirs(abs.parent(), &checkpoint.repo_root);
                    report.deleted.push(entry.path.clone());
                }
            }
        } else if entry.kind == EntryKind::Created && current_hash.is_none() {
            report.gone.push(entry.path.clone());
        } else {
            report.skipped.push(entry.path.clone());
        }
    }

    store.remove(&checkpoint.id)?;
    Ok(report)
}

// --- git helpers ---------------------------------------------------------

struct StatusSnapshot {
    /// Repo-relative paths of dirty tracked files (staged and/or unstaged).
    dirty: Vec<String>,
    /// Repo-relative paths of untracked files (dirs collapsed with trailing `/`).
    untracked: HashSet<String>,
}

fn status_snapshot(repo_root: &Path) -> Option<StatusSnapshot> {
    let output = Command::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
        ])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut dirty = Vec::new();
    let mut untracked = HashSet::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.len() < 4 {
            continue;
        }
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if &record[..2] == b"??" {
            untracked.insert(path);
        } else {
            dirty.push(path);
        }
    }
    Some(StatusSnapshot { dirty, untracked })
}

fn git_text(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Fetch the committed content of `path` at `head`.
fn head_blob(repo_root: &Path, head: &str, path: &str) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("show")
        .arg(format!("{head}:{path}"))
        .current_dir(repo_root)
        .output()
        .ok()?;
    if output.status.success() {
        Some(output.stdout)
    } else {
        None
    }
}

// --- file helpers --------------------------------------------------------

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// SHA-256 of a file's content; `Ok(None)` when the file does not exist.
fn file_hash(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(sha256(&bytes))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn store_blob(cp_dir: &Path, bytes: &[u8]) -> io::Result<String> {
    let hash = sha256(bytes);
    let blob_path = cp_dir.join("blobs").join(&hash);
    if !blob_path.exists() {
        // The blob's filename *is* its content hash, so a torn write here
        // (name present, content wrong) would be silently trusted by
        // `read_blob` on a later restore and written back into the user's
        // repo without any integrity check. Atomic write removes the torn
        // half-write window entirely.
        crate::fs_atomic::write_atomic(&blob_path, bytes)?;
    }
    Ok(hash)
}

fn read_blob(cp_dir: &Path, hash: &str) -> io::Result<Vec<u8>> {
    fs::read(cp_dir.join("blobs").join(hash))
}

/// Recursively collect regular files under `dir` as (repo-relative, absolute)
/// pairs. Best effort; symlinks and unreadable entries are skipped.
fn collect_files(dir: &Path, repo_root: &Path, out: &mut Vec<(String, PathBuf)>) {
    if out.len() > MAX_EXPANDED_UNTRACKED_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&path, repo_root, out);
        } else if file_type.is_file() {
            if let Ok(rel) = path.strip_prefix(repo_root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), path.clone()));
            }
        }
    }
}

/// Remove empty parent directories left behind by a deleted file, up to (but
/// not including) the repo root.
fn prune_empty_dirs(mut dir: Option<&Path>, repo_root: &Path) {
    while let Some(current) = dir {
        if current == repo_root || !current.starts_with(repo_root) {
            break;
        }
        if fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
}

fn sanitize_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // An empty or dot-only component does not name a child directory at
    // all: joining it is a no-op or resolves to the parent (".."), which
    // would let `remove_dir_all` escape the checkpoints directory and
    // delete unrelated session data. Map such components to a safe name.
    if sanitized.chars().all(|c| c == '.') {
        "_".repeat(sanitized.len().max(1))
    } else {
        sanitized
    }
}

/// Encode a session ID without collapsing distinct IDs onto one directory.
/// The `v2~` prefix keeps the empty ID distinct from any path-like component
/// and makes the result impossible for the legacy sanitizer to produce (`~`
/// is not in its pass-through set).
fn encode_session_component(value: &str) -> String {
    let mut encoded = String::with_capacity(3 + value.len() * 2);
    encoded.push_str("v2~");
    for byte in value.as_bytes() {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn read_checkpoints_from_root(root: &Path) -> Vec<Checkpoint> {
    let mut checkpoints = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return checkpoints;
    };
    for entry in entries.flatten() {
        let manifest = entry.path().join(MANIFEST_FILE);
        let Ok(bytes) = fs::read(&manifest) else {
            continue;
        };
        if let Ok(checkpoint) = serde_json::from_slice::<Checkpoint>(&bytes) {
            checkpoints.push(checkpoint);
        }
    }
    checkpoints
}

fn prompt_excerpt(prompt: &str) -> String {
    const MAX_LEN: usize = 80;
    let condensed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if condensed.chars().count() <= MAX_LEN {
        return condensed;
    }
    let mut excerpt: String = condensed.chars().take(MAX_LEN - 3).collect();
    excerpt.push_str("...");
    excerpt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git invocation failed");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        repo: PathBuf,
        sessions: PathBuf,
    }

    /// A temp git repo with one committed file (`a.rs`) and a separate temp
    /// sessions directory.
    fn git_fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let sessions = tmp.path().join("sessions");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        run_git(&repo, &["init", "--quiet"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("a.rs"), "original\n").unwrap();
        run_git(&repo, &["add", "a.rs"]);
        run_git(&repo, &["commit", "--quiet", "-m", "init"]);
        Fixture {
            _tmp: tmp,
            repo,
            sessions,
        }
    }

    fn store(fx: &Fixture) -> CheckpointStore {
        CheckpointStore::new(&fx.sessions, "session-1")
    }

    #[test]
    fn dot_only_and_empty_ids_sanitize_to_safe_components() {
        // ".." joined onto the checkpoints dir resolves to the sessions dir
        // itself, and "" joins as a no-op; `remove_dir_all` on either would
        // delete unrelated session data instead of one session's
        // checkpoints.
        assert_eq!(sanitize_component(".."), "__");
        assert_eq!(sanitize_component("."), "_");
        assert_eq!(sanitize_component(""), "_");
        assert_eq!(sanitize_component("..."), "___");
        // Dots inside an otherwise normal component are unaffected.
        assert_eq!(sanitize_component("v1.2.3"), "v1.2.3");
    }

    #[test]
    fn store_root_for_dot_only_session_id_stays_under_checkpoints_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "..");
        assert_eq!(store.root(), tmp.path().join("checkpoints").join("v2~2e2e"));
    }

    #[test]
    fn session_components_do_not_collide_and_stay_under_checkpoints_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let checkpoints_root = tmp.path().join("checkpoints");
        let slash = CheckpointStore::new(tmp.path(), "team/a");
        let question = CheckpointStore::new(tmp.path(), "team?a");
        let dots = CheckpointStore::new(tmp.path(), "..");
        let underscores = CheckpointStore::new(tmp.path(), "__");
        let encoded_name = CheckpointStore::new(tmp.path(), "a");
        let legacy_name = CheckpointStore::new(tmp.path(), "v2-61");

        assert_ne!(slash.root(), question.root());
        assert_ne!(dots.root(), underscores.root());
        assert_ne!(encoded_name.root(), legacy_name.legacy_root());
        for root in [
            slash.root(),
            question.root(),
            dots.root(),
            underscores.root(),
        ] {
            assert!(root.starts_with(&checkpoints_root));
            assert!(
                root.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("v2~")),
                "new checkpoint roots must use the versioned encoding: {}",
                root.display()
            );
        }
    }

    #[test]
    fn legacy_checkpoints_are_listed_and_removed_alongside_v2_data() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "legacy/session");
        let checkpoint = Checkpoint {
            id: "cp-legacy".to_string(),
            created_at: "2026-08-01T00:00:00Z".to_string(),
            prompt: "legacy".to_string(),
            repo_root: tmp.path().to_path_buf(),
            head: None,
            entries: Vec::new(),
        };
        let legacy_dir = store.legacy_root().join(&checkpoint.id);
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join(MANIFEST_FILE),
            serde_json::to_vec(&checkpoint).unwrap(),
        )
        .unwrap();
        let v2_dir = store.new_checkpoint_dir(&checkpoint.id);
        fs::create_dir_all(&v2_dir).unwrap();

        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].prompt, "legacy");

        store.remove(&checkpoint.id).unwrap();
        assert!(!legacy_dir.exists());
        assert!(!v2_dir.exists());
    }

    #[test]
    fn begin_turn_noops_outside_git() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        assert!(begin_turn(tmp.path(), &sessions, "s1", "prompt").is_none());
    }

    #[test]
    fn finalize_without_changes_yields_no_checkpoint() {
        let fx = git_fixture();
        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "do nothing").unwrap();
        let checkpoint = finalize_turn(pending).unwrap();
        assert!(checkpoint.is_none());
        assert!(store(&fx).list().is_empty());
    }

    #[test]
    fn captures_modified_and_created_files_and_restores_them() {
        let fx = git_fixture();

        // The user has uncommitted work in progress; it must survive a rewind.
        fs::write(fx.repo.join("wip.rs"), "user wip\n").unwrap();
        run_git(&fx.repo, &["add", "wip.rs"]);

        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "change things").unwrap();
        fs::write(fx.repo.join("a.rs"), "agent edit\n").unwrap();
        fs::write(fx.repo.join("wip.rs"), "agent overwrote wip\n").unwrap();
        fs::write(fx.repo.join("new.txt"), "agent file\n").unwrap();

        let checkpoint = finalize_turn(pending).unwrap().expect("checkpoint");
        assert_eq!(checkpoint.entries.len(), 3);
        assert_eq!(store(&fx).list().len(), 1);

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert_eq!(report.restored.len(), 2);
        assert_eq!(report.deleted, vec!["new.txt".to_string()]);
        assert!(report.skipped.is_empty());

        assert_eq!(
            fs::read_to_string(fx.repo.join("a.rs")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(fx.repo.join("wip.rs")).unwrap(),
            "user wip\n"
        );
        assert!(!fx.repo.join("new.txt").exists());

        // The checkpoint was consumed.
        assert!(store(&fx).list().is_empty());
        assert!(restore_latest(&store(&fx)).unwrap().is_none());
    }

    #[test]
    fn restores_files_deleted_during_turn() {
        let fx = git_fixture();
        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "delete a.rs").unwrap();
        fs::remove_file(fx.repo.join("a.rs")).unwrap();
        let checkpoint = finalize_turn(pending).unwrap().expect("checkpoint");
        assert_eq!(checkpoint.entries.len(), 1);
        assert_eq!(checkpoint.entries[0].kind, EntryKind::Deleted);

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert_eq!(report.restored, vec!["a.rs".to_string()]);
        assert_eq!(
            fs::read_to_string(fx.repo.join("a.rs")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn restore_recreates_deleted_parent_tree_through_atomic_writer() {
        let fx = git_fixture();
        let nested = fx.repo.join("nested/deep/file.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "original\n").unwrap();
        run_git(&fx.repo, &["add", "nested/deep/file.txt"]);
        run_git(&fx.repo, &["commit", "--quiet", "-m", "add nested file"]);

        let pending =
            begin_turn(&fx.repo, &fx.sessions, "session-1", "delete nested tree").unwrap();
        fs::remove_file(&nested).unwrap();
        fs::remove_dir(nested.parent().unwrap()).unwrap();
        fs::remove_dir(fx.repo.join("nested")).unwrap();
        finalize_turn(pending).unwrap().expect("checkpoint");

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");

        assert_eq!(report.restored, vec!["nested/deep/file.txt".to_string()]);
        assert_eq!(fs::read_to_string(&nested).unwrap(), "original\n");
    }

    /// Restoring a file replaces it via rename; the pre-existing file's
    /// permissions (e.g. an executable script's mode) must survive.
    #[cfg(unix)]
    #[test]
    fn restore_preserves_executable_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let fx = git_fixture();
        let script = fx.repo.join("run.sh");
        fs::write(&script, "#!/bin/sh\necho original\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        run_git(&fx.repo, &["add", "run.sh"]);
        run_git(&fx.repo, &["commit", "--quiet", "-m", "add script"]);

        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "edit script").unwrap();
        fs::write(&script, "#!/bin/sh\necho agent edit\n").unwrap();
        finalize_turn(pending).unwrap().expect("checkpoint");

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert_eq!(report.restored, vec!["run.sh".to_string()]);
        assert_eq!(
            fs::read_to_string(&script).unwrap(),
            "#!/bin/sh\necho original\n"
        );
        assert_eq!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o755,
            "restore must preserve the executable bits"
        );
    }

    #[test]
    fn skips_files_the_user_edited_after_the_turn() {
        let fx = git_fixture();
        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "edit").unwrap();
        fs::write(fx.repo.join("a.rs"), "agent edit\n").unwrap();
        fs::write(fx.repo.join("new.txt"), "agent file\n").unwrap();
        finalize_turn(pending).unwrap().expect("checkpoint");

        // User edits both files after the turn ended.
        fs::write(fx.repo.join("a.rs"), "user follow-up edit\n").unwrap();
        fs::write(fx.repo.join("new.txt"), "user extended\n").unwrap();

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert!(report.restored.is_empty());
        assert!(report.deleted.is_empty());
        assert_eq!(report.skipped.len(), 2);
        assert_eq!(
            fs::read_to_string(fx.repo.join("a.rs")).unwrap(),
            "user follow-up edit\n"
        );
        assert_eq!(
            fs::read_to_string(fx.repo.join("new.txt")).unwrap(),
            "user extended\n"
        );
    }

    #[test]
    fn cleans_up_untracked_directories_created_during_turn() {
        let fx = git_fixture();
        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "scaffold").unwrap();
        fs::create_dir_all(fx.repo.join("gen/nested")).unwrap();
        fs::write(fx.repo.join("gen/nested/out.txt"), "generated\n").unwrap();
        fs::write(fx.repo.join("gen/top.txt"), "generated top\n").unwrap();
        let checkpoint = finalize_turn(pending).unwrap().expect("checkpoint");
        assert_eq!(checkpoint.entries.len(), 2);
        assert!(
            checkpoint
                .entries
                .iter()
                .all(|e| e.kind == EntryKind::Created)
        );

        let report = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert_eq!(report.deleted.len(), 2);
        assert!(!fx.repo.join("gen").exists(), "empty dirs are pruned");
    }

    #[test]
    fn ignores_pre_existing_untracked_files() {
        let fx = git_fixture();
        fs::write(fx.repo.join("scratch.txt"), "user scratch\n").unwrap();

        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "edit scratch").unwrap();
        fs::write(fx.repo.join("scratch.txt"), "agent touched it\n").unwrap();

        // Out of scope: pre-existing untracked content is never snapshotted,
        // so the turn produced no restorable checkpoint.
        assert!(finalize_turn(pending).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(fx.repo.join("scratch.txt")).unwrap(),
            "agent touched it\n"
        );
    }

    #[test]
    fn evicts_oldest_checkpoints_beyond_cap() {
        let fx = git_fixture();
        for round in 0..MAX_CHECKPOINTS_PER_SESSION + 2 {
            let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "round").unwrap();
            fs::write(fx.repo.join("a.rs"), format!("round {round}\n")).unwrap();
            finalize_turn(pending).unwrap().expect("checkpoint");
        }
        let checkpoints = store(&fx).list();
        assert_eq!(checkpoints.len(), MAX_CHECKPOINTS_PER_SESSION);
        // FIFO: the two oldest rounds were evicted.
        let restored = restore_latest(&store(&fx)).unwrap().expect("restore");
        assert_eq!(restored.restored, vec!["a.rs".to_string()]);
        assert_eq!(
            fs::read_to_string(fx.repo.join("a.rs")).unwrap(),
            format!("round {}\n", MAX_CHECKPOINTS_PER_SESSION)
        );
    }

    #[test]
    fn list_skips_a_torn_or_corrupt_manifest_without_panicking() {
        let fx = git_fixture();

        // A real checkpoint, finalized normally.
        let pending = begin_turn(&fx.repo, &fx.sessions, "session-1", "good").unwrap();
        fs::write(fx.repo.join("a.rs"), "changed\n").unwrap();
        finalize_turn(pending).unwrap().expect("checkpoint");

        // Simulate a crash mid-write of a second checkpoint's manifest: the
        // directory exists (created before the manifest write) but
        // checkpoint.json is truncated/invalid JSON.
        let store = store(&fx);
        let torn_dir = store.root().join("torn-checkpoint");
        fs::create_dir_all(&torn_dir).unwrap();
        fs::write(
            torn_dir.join(MANIFEST_FILE),
            "{\"id\": \"torn\", \"entries\":",
        )
        .unwrap();

        let checkpoints = store.list();
        assert_eq!(
            checkpoints.len(),
            1,
            "the torn checkpoint must be skipped, not crash the whole list"
        );
        assert_ne!(checkpoints[0].id, "torn");
    }
}
