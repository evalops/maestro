use super::*;

impl App {
    pub(super) async fn handle_follow_up_submit(&mut self, content: String) -> Result<bool> {
        if content.trim().is_empty() {
            return Ok(false);
        }
        if self.state.busy && !self.state.follow_up_mode.allows_queue() {
            self.state.status = Some(
                "Follow-up mode set to one-at-a-time. Use /queue mode followup all to enable follow-ups while running."
                    .to_string(),
            );
            return Ok(false);
        }
        if self.state.busy {
            return self
                .queue_prompt(content, PromptKind::FollowUp, false)
                .await;
        }
        self.submit_prompt_with_kind(content, PromptKind::FollowUp)
            .await
    }

    pub(super) async fn handle_steer_submit(&mut self, content: String) -> Result<bool> {
        if content.trim().is_empty() {
            return Ok(false);
        }
        if self.state.busy && !self.state.steering_mode.allows_queue() {
            self.state.status = Some(
                "Steering mode set to one-at-a-time. Use /queue mode steer all to allow multiple steering messages."
                    .to_string(),
            );
            return Ok(false);
        }
        if self.state.busy {
            return self.queue_prompt(content, PromptKind::Steer, true).await;
        }
        self.submit_prompt_with_kind(content, PromptKind::Steer)
            .await
    }

    pub(super) async fn queue_prompt(
        &mut self,
        content: String,
        kind: PromptKind,
        front: bool,
    ) -> Result<bool> {
        let queue_id = self.reserve_queue_id();
        let Some(agent) = &self.native_agent else {
            self.state.error = Some("Agent not initialized".to_string());
            return Ok(false);
        };
        if let Err(e) = agent
            .prompt_with_kind(content.clone(), vec![], kind, Some(queue_id))
            .await
        {
            self.state.error = Some(format!("Failed to queue prompt: {e}"));
            return Ok(false);
        }

        let dropped = self.enqueue_pending_prompt(queue_id, content, kind, front);
        if let Some(dropped) = dropped {
            self.state.status = Some(format!(
                "Queue full, dropped oldest {}.",
                dropped.kind.label()
            ));
        }
        Ok(true)
    }

    pub(super) fn reserve_queue_id(&mut self) -> u64 {
        let id = self.next_queue_id;
        self.next_queue_id = self.next_queue_id.saturating_add(1).max(1);
        id
    }

    pub(super) fn enqueue_pending_prompt(
        &mut self,
        id: u64,
        content: String,
        kind: PromptKind,
        front: bool,
    ) -> Option<QueuedPrompt> {
        let entry = QueuedPrompt { id, content, kind };
        if front {
            let insert_at = self
                .queued_prompts
                .iter()
                .position(|prompt| prompt.kind != kind)
                .unwrap_or(self.queued_prompts.len());
            self.queued_prompts.insert(insert_at, entry);
        } else {
            self.queued_prompts.push_back(entry);
        }
        let inflight_offset = usize::from(self.queued_prompt_inflight.is_some());
        let effective_len = self.queued_prompts.len().saturating_sub(inflight_offset);
        if effective_len > MAX_PENDING_MESSAGES {
            let dropped = self.queued_prompts.pop_back();
            self.sync_queue_prompt_count();
            return dropped;
        }
        self.sync_queue_prompt_count();
        None
    }

    pub(super) fn enqueue_follow_up_front_for_edit(
        &mut self,
        entry: QueuedPrompt,
    ) -> Option<QueuedPrompt> {
        let insert_at = self
            .queued_prompts
            .iter()
            .position(|prompt| prompt.kind == PromptKind::FollowUp)
            .unwrap_or(self.queued_prompts.len());
        self.queued_prompts.insert(insert_at, entry);
        let inflight_offset = usize::from(self.queued_prompt_inflight.is_some());
        let effective_len = self.queued_prompts.len().saturating_sub(inflight_offset);
        if effective_len > MAX_PENDING_MESSAGES {
            let dropped = self.queued_prompts.pop_back();
            self.sync_queue_prompt_count();
            return dropped;
        }
        self.sync_queue_prompt_count();
        None
    }

    pub(super) fn remove_queued_prompt(&mut self, id: u64) -> Option<QueuedPrompt> {
        let index = self
            .queued_prompts
            .iter()
            .position(|prompt| prompt.id == id)?;
        let removed = self.queued_prompts.remove(index);
        self.sync_queue_prompt_count();
        removed
    }

    pub(super) async fn try_restore_last_queued_follow_up(
        &mut self,
        code: KeyCode,
        modifiers: CrosstermModifiers,
    ) -> Result<bool> {
        if code != self.queued_follow_up_edit_binding.key
            || modifiers != self.queued_follow_up_edit_binding.modifiers
        {
            return Ok(false);
        }

        if let Some(current) = self.capture_edited_queued_follow_up() {
            if self.state.queued_follow_up_count == 0 {
                return Ok(false);
            }
            if let Some(agent) = &self.native_agent {
                agent
                    .requeue_follow_up_front(current.content.clone(), vec![], current.id)
                    .await?;
            }
            let dropped = self.enqueue_follow_up_front_for_edit(current);
            if let Some(dropped) = dropped {
                self.state.status = Some(format!(
                    "Queue full, dropped oldest {}.",
                    dropped.kind.label()
                ));
            }
        }

        let inflight_id = self.queued_prompt_inflight.map(|cursor| cursor.id);
        let queued_id = self
            .queued_prompts
            .iter()
            .rev()
            .find(|prompt| prompt.kind == PromptKind::FollowUp && Some(prompt.id) != inflight_id)
            .map(|prompt| prompt.id);
        let Some(id) = queued_id else {
            return Ok(false);
        };

        let Some(restored) = self.remove_queued_prompt(id) else {
            return Ok(false);
        };
        if let Some(agent) = &self.native_agent {
            agent.cancel_queued(id);
        }
        self.state.set_input(&restored.content);
        self.update_slash_state();
        self.editing_queued_follow_up = Some(restored.clone());
        self.state
            .status
            .replace(format!("Editing queued follow-up #{}.", restored.id));
        Ok(true)
    }

    pub(super) fn matches_binding(
        &self,
        binding: crate::key_hints::KeyBinding,
        code: KeyCode,
        modifiers: CrosstermModifiers,
    ) -> bool {
        binding.key == code && binding.modifiers == modifiers
    }

    pub(super) fn capture_edited_queued_follow_up(&self) -> Option<QueuedPrompt> {
        let current = self.editing_queued_follow_up.clone()?;
        let content = self.state.input().to_string();
        let trimmed = content.trim();
        if trimmed.is_empty() || trimmed.starts_with('/') {
            return None;
        }
        Some(QueuedPrompt { content, ..current })
    }

    pub(super) fn format_queue_snippet(text: &str, max_len: usize) -> String {
        let mut condensed = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if condensed.is_empty() {
            condensed = "(empty message)".to_string();
        }
        if condensed.len() <= max_len {
            return condensed;
        }
        if max_len <= 3 {
            return "...".to_string();
        }
        let cutoff = max_len.saturating_sub(3);
        let mut truncated = condensed.chars().take(cutoff).collect::<String>();
        truncated.push_str("...");
        truncated
    }

    pub(super) fn merge_queued_prompt_batch(batch: &[QueuedPrompt]) -> String {
        batch
            .iter()
            .map(|prompt| prompt.content.trim())
            .filter(|content| !content.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub(super) fn describe_next_queue_batch(
        count: usize,
        mode: QueueMode,
        timing: &str,
    ) -> Option<String> {
        if count == 0 {
            return None;
        }
        let batch = if count == 1 {
            "1 message".to_string()
        } else {
            match mode {
                QueueMode::All => format!("all {count} messages"),
                QueueMode::One => format!("1 of {count} messages"),
            }
        };
        Some(format!("{batch} {timing}"))
    }

    pub(super) fn drain_queued_steering_batch_for_interrupt(&mut self) -> Vec<QueuedPrompt> {
        let drain_count = match self.state.steering_mode {
            QueueMode::All => self
                .queued_prompts
                .iter()
                .take_while(|prompt| prompt.kind == PromptKind::Steer)
                .count(),
            QueueMode::One => self
                .queued_prompts
                .front()
                .filter(|prompt| prompt.kind == PromptKind::Steer)
                .map(|_| 1)
                .unwrap_or(0),
        };
        let mut drained = Vec::new();
        for _ in 0..drain_count {
            if let Some(prompt) = self.queued_prompts.pop_front() {
                drained.push(prompt);
            }
        }
        self.sync_queue_prompt_count();
        drained
    }

    pub(super) fn drain_queued_prompts_for_restore(&mut self) -> Vec<QueuedPrompt> {
        let drained = self.queued_prompts.drain(..).collect::<Vec<_>>();
        self.sync_queue_prompt_count();
        drained
    }

    pub(super) fn cancel_native_queued_batch(&self, batch: &[QueuedPrompt]) {
        if let Some(agent) = &self.native_agent {
            for prompt in batch {
                agent.cancel_queued(prompt.id);
            }
        }
    }

    pub(super) fn restore_queued_prompts_to_input(&mut self, batch: Vec<QueuedPrompt>) {
        if batch.is_empty() {
            return;
        }
        let existing_draft = self.state.input().to_string();
        let merged_existing_draft = !existing_draft.trim().is_empty();
        let mut restored = Self::merge_queued_prompt_batch(&batch);
        if merged_existing_draft {
            if !restored.trim().is_empty() {
                restored.push_str("\n\n");
            }
            restored.push_str(&existing_draft);
        }
        self.cancel_native_queued_batch(&batch);
        self.state.set_input(&restored);
        self.update_slash_state();
        self.editing_queued_follow_up = if !merged_existing_draft
            && batch.len() == 1
            && batch[0].kind == PromptKind::FollowUp
        {
            Some(batch[0].clone())
        } else {
            None
        };
        self.state.status = Some(format!(
            "Restored {} queued prompt{} to the composer.",
            batch.len(),
            if batch.len() == 1 { "" } else { "s" }
        ));
    }

    pub(super) async fn maybe_handle_post_interrupt_queue(&mut self) -> Result<bool> {
        if self.submit_queued_steering_after_interrupt {
            self.submit_queued_steering_after_interrupt = false;
            self.queued_prompt_inflight = None;
            self.queued_prompt_active = None;
            let batch = self.drain_queued_steering_batch_for_interrupt();
            if batch.is_empty() {
                return Ok(false);
            }
            let merged = Self::merge_queued_prompt_batch(&batch);
            self.cancel_native_queued_batch(&batch);
            if merged.trim().is_empty() {
                return Ok(false);
            }
            self.state.status = Some(if batch.len() == 1 {
                "Submitting queued steer.".to_string()
            } else {
                format!("Submitting {} queued steers.", batch.len())
            });
            self.submit_prompt(merged).await?;
            return Ok(true);
        }

        if self.restore_queued_prompts_after_interrupt {
            self.restore_queued_prompts_after_interrupt = false;
            self.queued_prompt_inflight = None;
            self.queued_prompt_active = None;
            let batch = self.drain_queued_prompts_for_restore();
            self.restore_queued_prompts_to_input(batch);
        }

        Ok(false)
    }

    pub(super) fn sync_queue_prompt_count(&mut self) {
        let inflight_id = self.queued_prompt_inflight.map(|cursor| cursor.id);
        let mut total_count: usize = 0;
        let mut steer_count: usize = 0;
        let mut follow_up_count: usize = 0;
        let mut steering_preview: Vec<String> = Vec::new();
        let mut follow_up_preview: Vec<String> = Vec::new();

        for prompt in &self.queued_prompts {
            if Some(prompt.id) == inflight_id {
                continue;
            }

            total_count += 1;
            match prompt.kind {
                PromptKind::Steer => {
                    steer_count += 1;
                    steering_preview.push(Self::format_queue_snippet(&prompt.content, 120));
                }
                PromptKind::FollowUp => {
                    follow_up_count += 1;
                    follow_up_preview.push(Self::format_queue_snippet(&prompt.content, 120));
                }
                PromptKind::Prompt => {}
            }
        }

        self.state.queued_prompt_count = total_count;
        self.state.queued_steering_count = steer_count;
        self.state.queued_follow_up_count = follow_up_count;
        self.state.queued_steering_preview = steering_preview;
        self.state.queued_follow_up_preview = follow_up_preview;
    }

    /// Submit a prompt to the agent
    pub(super) async fn submit_prompt(&mut self, content: String) -> Result<()> {
        let _ = self
            .submit_prompt_with_kind(content, PromptKind::Prompt)
            .await?;
        Ok(())
    }

    pub(super) async fn submit_prompt_with_kind(
        &mut self,
        content: String,
        kind: PromptKind,
    ) -> Result<bool> {
        if self.session_resume_failed {
            self.state.error =
                Some("Session resume failed; use /new to start a new session.".to_string());
            return Ok(false);
        }

        let mut active_sessions = self.active_session_count();
        if self.session_manager.writer().is_none() {
            // Count the session we're about to start.
            active_sessions = active_sessions.map(|count| count.saturating_add(1));
        }

        let started_at = if self.session_manager.writer().is_some() {
            self.session_started_at
        } else {
            SystemTime::now()
        };

        let token_count = if self.usage_tracker.turn_count() == 0 {
            let has_assistant = self
                .state
                .messages
                .iter()
                .any(|message| message.is_assistant_reply());
            if has_assistant {
                // We don't have usage entries for this session; fail closed.
                None
            } else {
                Some(0)
            }
        } else {
            Some(self.usage_tracker.total_tokens())
        };

        if let Some(reason) = check_session_limits(started_at, token_count, active_sessions) {
            self.state.error = Some(reason);
            return Ok(false);
        }

        if let Err(err) = self.ensure_session_started() {
            self.state.error = Some(format!("Failed to start session: {err}"));
            return Ok(false);
        }

        // Add user message to state
        self.state.add_user_message(content.clone());
        self.state.busy = true;
        self.record_user_message(&content);
        if let Some(session_id) = self.state.session_id.clone() {
            self.prompt_history
                .add_with_session(content.clone(), session_id);
        } else {
            self.prompt_history.add(content.clone());
        }

        if let Some(agent) = &self.native_agent {
            // Send the prompt - returns immediately, actual work happens in background task
            // Events will be received via poll_agent in the main loop
            if let Err(e) = agent.prompt_with_kind(content, vec![], kind, None).await {
                self.state.error = Some(format!("Failed to send prompt: {e}"));
                self.state.busy = false;
                return Ok(false);
            }
            return Ok(true);
        }
        self.state.error = Some("Agent not initialized".to_string());
        self.state.busy = false;
        Ok(false)
    }
}
