use super::*;

impl App {
    /// Capture a pre-turn file checkpoint when the session runs inside a git
    /// worktree. Silently no-ops outside git repositories or before a session
    /// has started.
    pub(super) fn begin_file_checkpoint(&mut self, prompt: &str) {
        // A still-pending checkpoint means the previous turn never finalized
        // (e.g. the app missed the terminal event); close it out first.
        self.finalize_file_checkpoint();
        let Ok(cwd) = std::env::current_dir() else {
            return;
        };
        let Some(session_id) = self.state.session_id.clone() else {
            return;
        };
        let turn_index = self
            .session_manager
            .flush()
            .ok()
            .and_then(|()| self.session_manager.current_session_path())
            .and_then(|path| crate::session::SessionReader::read_file(&path).ok())
            .map(|session| session.stats.user_messages);
        self.pending_checkpoint = crate::checkpoints::begin_turn(
            &cwd,
            self.session_manager.sessions_dir(),
            &session_id,
            prompt,
        );
        if let Some(pending) = &mut self.pending_checkpoint {
            pending.user_turn_index = turn_index;
        }
    }

    pub(super) fn preview_rewind_files(&mut self, first_turn: usize) -> anyhow::Result<()> {
        let store = self
            .file_checkpoint_store()
            .ok_or_else(|| anyhow::anyhow!("No session checkpoint store."))?;
        let (candidates, skipped) = crate::checkpoints::preview_turns(&store, first_turn)?;
        let mut message = if candidates.is_empty() {
            "No restorable file changes recorded for these turns.".to_string()
        } else {
            format!("Restore: {}.", candidates.join(", "))
        };
        if !skipped.is_empty() {
            message.push_str(&format!(" Keep later changes: {}.", skipped.join(", ")));
        }
        self.state.add_system_message(message);
        Ok(())
    }

    pub(super) fn restore_rewind_files(
        &mut self,
        source_id: Option<&str>,
        first_turn: usize,
    ) -> anyhow::Result<()> {
        let source_id = source_id.ok_or_else(|| anyhow::anyhow!("No source session."))?;
        let store = crate::checkpoints::CheckpointStore::new(
            self.session_manager.sessions_dir(),
            source_id,
        );
        for report in crate::checkpoints::restore_turns(&store, first_turn)? {
            self.report_file_restore(Ok(Some(report)));
        }
        Ok(())
    }

    /// Persist the pending checkpoint now that the agent turn has ended.
    pub(super) fn finalize_file_checkpoint(&mut self) {
        let Some(pending) = self.pending_checkpoint.take() else {
            return;
        };
        // Best effort: a failed finalize only loses one checkpoint.
        let _ = crate::checkpoints::finalize_turn(pending);
    }

    fn file_checkpoint_store(&self) -> Option<crate::checkpoints::CheckpointStore> {
        let session_id = self.state.session_id.as_deref()?;
        Some(crate::checkpoints::CheckpointStore::new(
            self.session_manager.sessions_dir(),
            session_id,
        ))
    }

    /// `/rewind files`: restore file contents from the most recent checkpoint.
    pub(super) fn rewind_files(&mut self) {
        if self.state.busy {
            self.state.status =
                Some("Wait for the active response to finish before rewinding.".to_string());
            return;
        }
        let cwd = std::env::current_dir().ok();
        if !cwd.as_deref().is_some_and(crate::git::is_git_repo) {
            self.state.add_system_message(
                "File checkpoints require a git worktree; this directory is not one.".to_string(),
            );
            return;
        }
        let Some(store) = self.file_checkpoint_store() else {
            self.state.status = Some("No file checkpoints recorded for this session.".to_string());
            return;
        };
        let result = crate::checkpoints::restore_latest(&store);
        self.report_file_restore(result);
    }

    /// Double-Esc on an empty composer: open the rewind picker with this
    /// session's file checkpoints, newest first. Falls back to a status
    /// message when there is nothing to pick.
    pub(super) fn open_rewind_picker(&mut self) {
        if self.state.busy {
            self.state.status =
                Some("Wait for the active response to finish before rewinding.".to_string());
            return;
        }
        let Some(store) = self.file_checkpoint_store() else {
            self.state.status = Some("No file checkpoints recorded for this session.".to_string());
            return;
        };
        let checkpoints = store.list();
        if checkpoints.is_empty() {
            self.state.status = Some("No file checkpoints recorded for this session.".to_string());
            return;
        }
        self.rewind_picker
            .show(checkpoints.into_iter().rev().collect());
        self.active_modal = ActiveModal::RewindPicker;
    }

    /// Restore the checkpoint chosen in the rewind picker. Uses the same
    /// hash-guarded restore path as `/rewind files`: files the user edited
    /// after the turn are skipped, never clobbered.
    pub(super) fn restore_file_checkpoint(&mut self, checkpoint: crate::checkpoints::Checkpoint) {
        if self.state.busy {
            self.state.status =
                Some("Wait for the active response to finish before rewinding.".to_string());
            return;
        }
        let Some(store) = self.file_checkpoint_store() else {
            self.state.status = Some("No file checkpoints recorded for this session.".to_string());
            return;
        };
        if let Some(index) = checkpoint.user_turn_index {
            match crate::checkpoints::restore_turns(&store, index) {
                Ok(reports) => {
                    for report in reports {
                        self.report_file_restore(Ok(Some(report)));
                    }
                }
                Err(error) => self.report_file_restore(Err(error)),
            }
            return;
        }
        let result = crate::checkpoints::restore_checkpoint(&store, &checkpoint).map(Some);
        self.report_file_restore(result);
    }

    /// Surface the outcome of a file checkpoint restore to the user.
    fn report_file_restore(
        &mut self,
        result: std::io::Result<Option<crate::checkpoints::RestoreReport>>,
    ) {
        match result {
            Ok(Some(report)) => {
                let mut msg = format!(
                    "Restored checkpoint {} (\"{}\"):",
                    &report.checkpoint_id[..8.min(report.checkpoint_id.len())],
                    report.prompt
                );
                if !report.restored.is_empty() {
                    msg.push_str(&format!("\n- restored: {}", report.restored.join(", ")));
                }
                if !report.deleted.is_empty() {
                    msg.push_str(&format!(
                        "\n- deleted (created by the turn): {}",
                        report.deleted.join(", ")
                    ));
                }
                if !report.skipped.is_empty() {
                    msg.push_str(&format!(
                        "\n- skipped (changed after the turn): {}",
                        report.skipped.join(", ")
                    ));
                }
                if !report.gone.is_empty() {
                    msg.push_str(&format!("\n- already removed: {}", report.gone.join(", ")));
                }
                if report.restored.is_empty()
                    && report.deleted.is_empty()
                    && report.skipped.is_empty()
                {
                    msg.push_str("\n- nothing to restore");
                }
                if !report.failed.is_empty() {
                    msg.push_str(&format!("\n- failed: {}", report.failed.join(", ")));
                }
                self.state.status = Some(
                    if !report.failed.is_empty() {
                        "Some files could not be restored."
                    } else if !report.skipped.is_empty() {
                        "Restored available files; later changes were kept."
                    } else {
                        "Files restored from checkpoint."
                    }
                    .to_string(),
                );
                self.state.add_system_message(msg);
            }
            Ok(None) => {
                self.state.status =
                    Some("No file checkpoints recorded for this session.".to_string());
            }
            Err(err) => {
                self.state.error = Some(format!("Failed to restore checkpoint: {err}"));
            }
        }
    }

    /// `/rewind checkpoints`: list file checkpoints recorded for this session.
    pub(super) fn list_file_checkpoints(&mut self) {
        let Some(store) = self.file_checkpoint_store() else {
            self.state
                .add_system_message("No file checkpoints recorded for this session.".to_string());
            return;
        };
        let checkpoints = store.list();
        if checkpoints.is_empty() {
            self.state
                .add_system_message("No file checkpoints recorded for this session.".to_string());
            return;
        }
        let mut msg = String::from("## File checkpoints\n\n");
        for (index, checkpoint) in checkpoints.iter().rev().enumerate() {
            let file_count = checkpoint.entries.len();
            msg.push_str(&format!(
                "{}. `{}` — {} — \"{}\" — {} file{}\n",
                index + 1,
                checkpoint.short_id(),
                checkpoint.created_at,
                checkpoint.prompt,
                file_count,
                if file_count == 1 { "" } else { "s" }
            ));
        }
        msg.push_str("\n`/rewind files` restores the most recent one.");
        self.state.add_system_message(msg);
    }
}
