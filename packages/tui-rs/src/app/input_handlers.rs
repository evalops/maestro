use super::*;

impl App {
    /// Handle a key press
    pub(super) async fn handle_key(
        &mut self,
        code: KeyCode,
        modifiers: CrosstermModifiers,
    ) -> Result<()> {
        let ctrl = modifiers.contains(CrosstermModifiers::CONTROL);
        let alt = modifiers.contains(CrosstermModifiers::ALT);
        let shift = modifiers.contains(CrosstermModifiers::SHIFT);

        // Handle modal-specific input first
        match self.active_modal {
            ActiveModal::FileSearch => return self.handle_file_search_key(code, ctrl).await,
            ActiveModal::SessionSwitcher => {
                return self.handle_session_switcher_key(code, ctrl).await
            }
            ActiveModal::CommandPalette => {
                return self.handle_command_palette_key(code, ctrl).await
            }
            ActiveModal::Approval => return self.handle_approval_key(code).await,
            ActiveModal::ModelSelector => return self.handle_model_selector_key(code, ctrl).await,
            ActiveModal::ThemeSelector => return self.handle_theme_selector_key(code, ctrl).await,
            ActiveModal::ShortcutsHelp => return self.handle_shortcuts_help_key(code).await,
            ActiveModal::None => {}
        }

        if self
            .try_restore_last_queued_follow_up(code, modifiers)
            .await?
        {
            return Ok(());
        }

        if self.matches_binding(self.command_palette_binding, code, modifiers) {
            self.command_palette.show();
            self.active_modal = ActiveModal::CommandPalette;
            return Ok(());
        }
        if self.matches_binding(self.file_search_binding, code, modifiers) {
            self.file_search.show();
            self.active_modal = ActiveModal::FileSearch;
            return Ok(());
        }
        if !self.state.busy
            && self.matches_binding(self.toggle_tool_outputs_binding, code, modifiers)
        {
            self.toggle_last_tool_call();
            return Ok(());
        }

        match code {
            // Quit
            KeyCode::Char('c') if ctrl => {
                if self.state.busy {
                    let has_queued_steering = self.state.queued_steering_count > 0;
                    self.submit_queued_steering_after_interrupt = has_queued_steering;
                    self.restore_queued_prompts_after_interrupt =
                        !has_queued_steering && self.state.queued_prompt_count > 0;

                    if let Some(agent) = &self.native_agent {
                        if self.state.queued_prompt_count > 0 {
                            agent.cancel_keep_queue();
                        } else {
                            agent.cancel();
                        }
                    } else {
                        self.state.busy = false;
                        self.queued_prompt_inflight = None;
                        self.queued_prompt_active = None;
                        if self.submit_queued_steering_after_interrupt {
                            self.submit_queued_steering_after_interrupt = false;
                            let batch = self.drain_queued_steering_batch_for_interrupt();
                            self.restore_queued_prompts_to_input(batch);
                        } else if self.restore_queued_prompts_after_interrupt {
                            self.restore_queued_prompts_after_interrupt = false;
                            let batch = self.drain_queued_prompts_for_restore();
                            self.restore_queued_prompts_to_input(batch);
                        } else {
                            self.sync_queue_prompt_count();
                        }
                    }
                } else {
                    self.should_quit = true;
                }
            }
            KeyCode::Char('d') if ctrl => {
                self.should_quit = true;
            }

            // Open modals
            KeyCode::Char('r') if ctrl && alt => {
                // Session switcher
                self.session_switcher.show();
                self.active_modal = ActiveModal::SessionSwitcher;
            }
            KeyCode::F(1) => {
                // Keyboard shortcuts help
                self.shortcuts_help.show();
                self.active_modal = ActiveModal::ShortcutsHelp;
            }

            // @ trigger for file search
            KeyCode::Char('@') if !self.state.busy => {
                self.state.insert_char('@');
                self.file_search.show();
                self.active_modal = ActiveModal::FileSearch;
            }

            // / trigger for slash commands
            KeyCode::Char('/') if self.state.input().is_empty() => {
                self.state.insert_char('/');
                self.slash_state.set_query("", &self.slash_matcher);
            }

            // Tab for slash command completion
            KeyCode::Tab if self.state.input().starts_with('/') => {
                self.handle_slash_tab();
            }
            KeyCode::Tab if self.should_queue_follow_up_on_tab() => {
                let input = self.state.input().to_string();
                let ok = self.handle_follow_up_submit(input).await?;
                if ok {
                    self.editing_queued_follow_up = None;
                    self.state.set_input("");
                }
            }
            KeyCode::Tab if self.should_submit_on_tab() => {
                let input = self.state.take_input();
                self.submit_prompt(input).await?;
            }

            // Navigation
            KeyCode::Up => {
                if self.state.input().starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_prev();
                    self.apply_slash_completion();
                } else if !self.state.input().is_empty() {
                    self.state.move_up();
                } else {
                    self.state.scroll_up(1);
                }
            }
            KeyCode::Down => {
                if self.state.input().starts_with('/') && self.slash_state.has_completions() {
                    self.slash_state.cycle_next();
                    self.apply_slash_completion();
                } else if !self.state.input().is_empty() {
                    self.state.move_down();
                } else {
                    self.state.scroll_down(1);
                }
            }
            // Vim-style scrolling: only when input is empty (not typing)
            KeyCode::Char('k') if ctrl => {
                if self.state.input().is_empty() {
                    self.state.scroll_up(1);
                } else {
                    self.state.delete_to_end_of_line();
                    self.update_slash_state();
                }
            }
            KeyCode::Char('j') if ctrl && self.state.input().is_empty() => {
                self.state.scroll_down(1);
            }
            KeyCode::PageUp => {
                let step = (self.capabilities.viewport_height as usize).max(5) / 2;
                self.state.scroll_up(step.max(1));
            }
            KeyCode::PageDown => {
                let step = (self.capabilities.viewport_height as usize).max(5) / 2;
                self.state.scroll_down(step.max(1));
            }
            // Jump shortcuts: only when input is empty (not typing)
            KeyCode::Char('g') if self.state.input().is_empty() && !ctrl => {
                // Jump to top (oldest messages)
                self.state.scroll_offset = usize::MAX / 2;
            }
            KeyCode::Char('G') if self.state.input().is_empty() => {
                // Jump to bottom (newest messages)
                self.state.scroll_offset = 0;
            }
            KeyCode::Tab if !self.state.busy && self.state.input().is_empty() => {
                // Tab: toggle thinking on last assistant message with thinking
                self.toggle_last_thinking();
            }

            // Input editing
            KeyCode::Char('a') if ctrl => {
                self.state.move_home_smart();
            }
            KeyCode::Char('b') if alt => {
                self.state.move_word_left();
            }
            KeyCode::Char('f') if alt => {
                self.state.move_word_right();
            }
            KeyCode::Char('w') if ctrl => {
                self.state.delete_word_backward();
                self.update_slash_state();
            }
            KeyCode::Char('y') if alt => {
                self.state.yank_kill_ring();
                self.update_slash_state();
            }
            KeyCode::Char(c) if !ctrl => {
                self.state.insert_char(c);
                self.update_slash_state();
            }
            KeyCode::Backspace => {
                if alt {
                    self.state.delete_word_backward();
                } else {
                    self.state.backspace();
                }
                self.update_slash_state();
            }
            KeyCode::Delete => {
                self.state.delete();
            }
            KeyCode::Left => {
                if ctrl || alt {
                    self.state.move_word_left();
                } else {
                    self.state.move_left();
                }
            }
            KeyCode::Right => {
                if ctrl || alt {
                    self.state.move_word_right();
                } else {
                    self.state.move_right();
                }
            }
            KeyCode::Home => {
                self.state.move_home_smart();
            }
            KeyCode::End => {
                self.state.move_end();
            }

            // Submit or newline (Shift+Enter for newline)
            KeyCode::Enter => {
                if shift {
                    // Shift+Enter: insert newline for multi-line input
                    self.state.insert_char('\n');
                } else if !self.state.input().is_empty() {
                    if self.state.input().starts_with('/') {
                        self.execute_slash_command().await?;
                    } else if self.state.busy {
                        let input = self.state.input().to_string();
                        if alt && input.trim_start().starts_with('!') {
                            self.state.insert_char('\n');
                        } else {
                            let ok = if alt {
                                self.handle_follow_up_submit(input).await?
                            } else {
                                self.handle_steer_submit(input).await?
                            };
                            if ok {
                                self.editing_queued_follow_up = None;
                                self.state.set_input("");
                            }
                        }
                    } else if alt {
                        self.state.insert_char('\n');
                    } else {
                        let input = self.state.take_input();
                        self.submit_prompt(input).await?;
                    }
                }
            }

            // Delete to start of line
            KeyCode::Char('u') if ctrl => {
                self.state.delete_to_start_of_line();
                self.update_slash_state();
            }

            // Paste from clipboard
            KeyCode::Char('y') if ctrl => {
                if let Ok(text) = self.clipboard.paste() {
                    // Insert text including newlines for multi-line support
                    // Skip carriage returns to normalize line endings
                    for c in text.chars() {
                        if c != '\r' {
                            self.state.insert_char(c);
                        }
                    }
                    self.update_slash_state();
                }
            }

            // Clear screen
            KeyCode::Char('l') if ctrl => {
                // Clear messages
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }

            // Escape to clear completions
            KeyCode::Esc => {
                self.slash_state.reset();
            }

            _ => {}
        }

        Ok(())
    }

    pub(super) fn should_queue_follow_up_on_tab(&self) -> bool {
        self.state.can_queue_follow_up_shortcut()
    }

    pub(super) fn should_submit_on_tab(&self) -> bool {
        if self.state.busy {
            return false;
        }
        let input = self.state.input();
        let trimmed = input.trim_start();
        !input.trim().is_empty() && !trimmed.starts_with('/') && !trimmed.starts_with('!')
    }

    /// Handle keys in file search modal
    pub(super) async fn handle_file_search_key(&mut self, code: KeyCode, ctrl: bool) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.file_search.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(file) = self.file_search.confirm() {
                    // Insert file path at cursor
                    for c in file.relative_path.chars() {
                        self.state.insert_char(c);
                    }
                    self.state.insert_char(' ');
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.file_search.move_up();
            }
            KeyCode::Down => {
                self.file_search.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.file_search.insert_char(c);
            }
            KeyCode::Backspace => {
                self.file_search.backspace();
            }
            KeyCode::Left => {
                self.file_search.move_left();
            }
            KeyCode::Right => {
                self.file_search.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in session switcher modal
    pub(super) async fn handle_session_switcher_key(
        &mut self,
        code: KeyCode,
        ctrl: bool,
    ) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.session_switcher.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(session_id) = self.session_switcher.confirm() {
                    // Load and restore the session
                    match self.session_manager.load_session(&session_id) {
                        Ok(session) => {
                            restore_visible_session_messages(&mut self.state, &session);

                            self.state.session_id = Some(session_id.clone());
                            self.state.status = Some(format!("Resumed session: {session_id}"));

                            let mut model_applied = true;
                            let mut thinking_applied = true;
                            if let Some(agent) = &self.native_agent {
                                if let Err(e) = agent.set_model(&session.header.model) {
                                    self.state.error = Some(format!("Failed to set model: {e}"));
                                    model_applied = false;
                                    thinking_applied = false;
                                } else {
                                    let (enabled, budget) =
                                        session.header.thinking_level.to_config();
                                    if let Err(e) = agent.set_thinking(enabled, budget) {
                                        self.state.error =
                                            Some(format!("Failed to set thinking: {e}"));
                                        thinking_applied = false;
                                    }
                                }
                            }

                            self.session_started_at =
                                chrono::DateTime::parse_from_rfc3339(&session.header.timestamp)
                                    .ok()
                                    .and_then(|dt| {
                                        let secs = dt.timestamp();
                                        if secs < 0 {
                                            None
                                        } else {
                                            Some(
                                                UNIX_EPOCH
                                                    + Duration::new(
                                                        secs as u64,
                                                        dt.timestamp_subsec_nanos(),
                                                    ),
                                            )
                                        }
                                    })
                                    .unwrap_or_else(SystemTime::now);
                            self.hydrate_usage_from_session(&session);

                            if model_applied {
                                self.current_model = session.header.model.clone();
                                self.state.model = Some(session.header.model.clone());
                                self.usage_tracker.set_model(session.header.model.clone());
                                if thinking_applied {
                                    self.current_thinking_level = session.header.thinking_level;
                                    self.state.thinking_level = self.current_thinking_level;
                                }
                            } else if !self.current_model.is_empty() {
                                self.usage_tracker.set_model(self.current_model.clone());
                            }

                            if let Err(err) = self.session_manager.resume_session_by_path(
                                session_id.clone(),
                                session.file_path.as_str(),
                            ) {
                                self.session_manager.reset_session();
                                self.session_resume_failed = true;
                                self.state.error =
                                    Some(format!("Failed to resume session writer: {err}"));
                                self.state.status = Some(format!(
                                    "Session resume failed ({session_id}); use /new to continue"
                                ));
                            } else {
                                self.session_resume_failed = false;
                            }
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to load session: {e}"));
                        }
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.session_switcher.move_up();
            }
            KeyCode::Down => {
                self.session_switcher.move_down();
            }
            KeyCode::Delete => {
                if let Err(e) = self.session_switcher.delete_selected() {
                    self.state.error = Some(e);
                }
            }
            KeyCode::Char(c) if !ctrl => {
                self.session_switcher.insert_char(c);
            }
            KeyCode::Backspace => {
                self.session_switcher.backspace();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in command palette modal
    pub(super) async fn handle_command_palette_key(
        &mut self,
        code: KeyCode,
        ctrl: bool,
    ) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.command_palette.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(cmd_name) = self.command_palette.confirm() {
                    // Set input to the command
                    self.state.set_input(&format!("/{cmd_name}"));
                    // Execute it
                    self.execute_slash_command().await?;
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.command_palette.move_up();
            }
            KeyCode::Down => {
                self.command_palette.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.command_palette.insert_char(c);
            }
            KeyCode::Backspace => {
                self.command_palette.backspace();
            }
            KeyCode::Left => {
                self.command_palette.move_left();
            }
            KeyCode::Right => {
                self.command_palette.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in approval modal
    pub(super) async fn handle_approval_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                if let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Approve)
                {
                    // Execute the tool and send response
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                // Check if more approvals pending
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('n' | 'N') | KeyCode::Esc => {
                if let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Deny)
                {
                    // Send denial
                    self.handle_tool_approval(request.call_id, request.tool, request.args, false)
                        .await?;
                }
                // Check if more approvals pending
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('a' | 'A') => {
                // Approve all
                while let Some((request, _decision)) =
                    self.approval_controller.decide(ApprovalDecision::Approve)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                self.active_modal = ActiveModal::None;
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in model selector modal
    pub(super) async fn handle_model_selector_key(
        &mut self,
        code: KeyCode,
        ctrl: bool,
    ) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.model_selector.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(model_id) = self.model_selector.confirm() {
                    // Set the new model
                    if let Some(agent) = &self.native_agent {
                        let policy_model = policy_model_id(&model_id);
                        if let Some(reason) = check_model_allowed(&policy_model) {
                            self.state.error = Some(reason);
                        } else if let Err(e) = agent.set_model(&model_id) {
                            self.state.error = Some(format!("Failed to set model: {e}"));
                        } else {
                            self.pending_model_change = Some(PendingModelChange {
                                model: model_id.clone(),
                            });
                            self.state.status = Some(format!("Switching model: {model_id}"));
                        }
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.model_selector.move_up();
            }
            KeyCode::Down => {
                self.model_selector.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.model_selector.insert_char(c);
            }
            KeyCode::Backspace => {
                self.model_selector.backspace();
            }
            KeyCode::Left => {
                self.model_selector.move_left();
            }
            KeyCode::Right => {
                self.model_selector.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in theme selector modal
    pub(super) async fn handle_theme_selector_key(
        &mut self,
        code: KeyCode,
        ctrl: bool,
    ) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.theme_selector.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(theme_name) = self.theme_selector.confirm() {
                    // Set the new theme
                    if crate::themes::set_theme_by_name(&theme_name).is_ok() {
                        self.state.status = Some(format!("Theme: {theme_name}"));
                    } else {
                        self.state.error = Some(format!("Unknown theme: {theme_name}"));
                    }
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.theme_selector.move_up();
            }
            KeyCode::Down => {
                self.theme_selector.move_down();
            }
            KeyCode::Char(c) if !ctrl => {
                self.theme_selector.insert_char(c);
            }
            KeyCode::Backspace => {
                self.theme_selector.backspace();
            }
            KeyCode::Left => {
                self.theme_selector.move_left();
            }
            KeyCode::Right => {
                self.theme_selector.move_right();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keyboard shortcuts help key events
    pub(super) async fn handle_shortcuts_help_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Esc | KeyCode::F(1) => {
                self.shortcuts_help.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.shortcuts_help.scroll_up(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.shortcuts_help.scroll_down(1);
            }
            KeyCode::PageUp => {
                self.shortcuts_help.scroll_up(10);
            }
            KeyCode::PageDown => {
                self.shortcuts_help.scroll_down(10);
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle tool approval decision
    pub(super) async fn handle_tool_approval(
        &mut self,
        call_id: String,
        tool: String,
        args: serde_json::Value,
        approved: bool,
    ) -> Result<()> {
        self.tool_history.record_approval(&call_id, approved);
        if approved {
            // Execute the tool (resolves vaulted credentials internally)
            self.execute_tool_and_respond(call_id, tool, args).await?;
        } else {
            self.tool_history.fail(&call_id, "Denied".to_string());
            // Send denial
            if let Some(tx) = &self.tool_response_tx {
                let _ = tx.send((call_id, false, None));
            }
        }
        Ok(())
    }
}
