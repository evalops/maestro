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
            ActiveModal::Operations => return self.handle_operations_key(code),
            ActiveModal::CommandPalette => {
                return self.handle_command_palette_key(code, ctrl).await
            }
            ActiveModal::Approval => return self.handle_approval_key(code, modifiers).await,
            ActiveModal::ModelSelector => return self.handle_model_selector_key(code, ctrl).await,
            ActiveModal::ThemeSelector => return self.handle_theme_selector_key(code, ctrl).await,
            ActiveModal::ShortcutsHelp => return self.handle_shortcuts_help_key(code).await,
            ActiveModal::RewindPicker => return self.handle_rewind_picker_key(code),
            ActiveModal::DetailView => return self.handle_detail_view_key(code),
            ActiveModal::None => {}
        }

        if self
            .try_restore_last_queued_follow_up(code, modifiers)
            .await?
        {
            return Ok(());
        }

        // Grok-style Shift+Tab: cycle Normal → Plan → Always-approve
        // (only when not typing a slash command and input is empty)
        if matches!(code, KeyCode::BackTab) && self.state.input().is_empty() && !self.state.busy {
            self.cycle_interaction_mode();
            return Ok(());
        }

        if self.matches_binding(self.command_palette_binding, code, modifiers) {
            self.show_command_palette();
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
        // Ctrl+E: open the full-output detail view for the most recent
        // expandable transcript item (Droid parity: Ctrl+O shows full
        // accumulated output; Ctrl+O is file search in maestro's map).
        if ctrl && !alt && matches!(code, KeyCode::Char('e')) {
            self.open_detail_view();
            return Ok(());
        }

        match code {
            // Quit
            KeyCode::Char('c') if ctrl => {
                if self.state.busy {
                    // Drop in-flight guardian reviews: a verdict arriving
                    // after the interrupt must neither relay an approval nor
                    // pop the approval modal.
                    self.cancel_pending_guardian_reviews();

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
                    // Make cancel vs quit explicit: first Ctrl+C cancels the
                    // turn; a second Ctrl+C while idle quits (handled below).
                    self.state.status = Some("Cancelled. Ctrl+C again to quit.".to_string());
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
            // Swallow extra leading slashes while the menu is open so the input
            // never becomes `//` / `///` from double-tapping `/` (// menu bug).
            KeyCode::Char('/')
                if !ctrl
                    && self.state.input().starts_with('/')
                    && self.state.input().chars().all(|c| c == '/') =>
            {
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
                } else if self.state.cursor() == self.state.input().len()
                    && self.state.ghost_completion.is_some()
                {
                    // Accept the ghost-text completion (fish-shell style).
                    if let Some(suffix) = self.state.ghost_completion.take() {
                        self.state.insert_str(&suffix);
                        self.update_slash_state();
                    }
                } else {
                    self.state.move_right();
                }
            }
            KeyCode::Home => {
                self.state.move_home_smart();
            }
            KeyCode::End => {
                if self.state.cursor() == self.state.input().len()
                    && self.state.ghost_completion.is_some()
                {
                    // Already at end: End accepts the ghost-text completion.
                    if let Some(suffix) = self.state.ghost_completion.take() {
                        self.state.insert_str(&suffix);
                        self.update_slash_state();
                    }
                } else {
                    self.state.move_end();
                }
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
                    // Insert text including newlines for multi-line support;
                    // large pastes are folded into a display chip.
                    self.state.insert_paste(&text);
                    self.update_slash_state();
                }
            }

            // Clear screen
            KeyCode::Char('l') if ctrl => {
                // Clear messages
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }

            // Escape: dismiss completions; double-Esc clears a draft input or,
            // when the input is empty, opens the rewind picker.
            KeyCode::Esc => {
                if self.slash_state.has_completions() {
                    self.slash_state.reset();
                    self.last_esc_at = None;
                } else if !self.state.input().is_empty() {
                    let now = Instant::now();
                    let double_press = self
                        .last_esc_at
                        .is_some_and(|t| now.duration_since(t) < Duration::from_millis(700));
                    if double_press {
                        self.state.set_input("");
                        self.update_slash_state();
                        self.last_esc_at = None;
                        self.state.status.replace("Input cleared".to_string());
                    } else {
                        self.last_esc_at = Some(now);
                        self.state
                            .status
                            .replace("Press Esc again to clear input".to_string());
                    }
                } else {
                    let now = Instant::now();
                    let double_press = self
                        .last_esc_at
                        .is_some_and(|t| now.duration_since(t) < Duration::from_millis(700));
                    if double_press {
                        self.last_esc_at = None;
                        self.open_rewind_picker();
                    } else {
                        self.last_esc_at = Some(now);
                        self.state
                            .status
                            .replace("Press Esc again to rewind files".to_string());
                    }
                }
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

    /// Route a bracketed paste to the open modal's text input, or to the
    /// main input when no modal is open.
    pub(super) fn handle_paste(&mut self, raw: &str) {
        // Normalize line endings like the main-input paste path does.
        let text: String = raw.chars().filter(|c| *c != '\r').collect();
        match self.active_modal {
            ActiveModal::FileSearch => self.file_search.insert_str(&text),
            ActiveModal::SessionSwitcher => self.session_switcher.insert_str(&text),
            ActiveModal::CommandPalette => self.command_palette.insert_str(&text),
            ActiveModal::ModelSelector => self.model_selector.insert_str(&text),
            ActiveModal::ThemeSelector => self.theme_selector.insert_str(&text),
            ActiveModal::None => {
                self.state.insert_paste(raw);
                self.update_slash_state();
            }
            // Modals without a text input have nothing to paste into.
            _ => {}
        }
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
                if self.state.busy {
                    self.state.status = Some(
                        "Wait for the active response to finish before switching sessions."
                            .to_string(),
                    );
                    return Ok(());
                }
                if let Some(session_id) = self.session_switcher.confirm() {
                    // Load and restore the session
                    match self.session_manager.load_session(&session_id) {
                        Ok(session) => self.apply_resumed_session(&session),
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

    fn handle_operations_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.operations.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => self.operations.move_up(),
            KeyCode::Down => self.operations.move_down(),
            KeyCode::Home => self.operations.select_first(),
            KeyCode::End => self.operations.select_last(),
            KeyCode::Left | KeyCode::BackTab => self.operations.focus_previous(),
            KeyCode::Right | KeyCode::Tab => self.operations.focus_next(),
            KeyCode::PageUp => self.operations.scroll_up(),
            KeyCode::PageDown => self.operations.scroll_down(),
            KeyCode::Char('r') => self.operations.refresh(),
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in command palette modal
    pub(super) fn show_command_palette(&mut self) {
        let mut resources = Vec::new();
        let mut commands = self.command_registry.all();
        commands.sort_by(|left, right| left.name.cmp(&right.name));
        resources.extend(commands.into_iter().map(|command| {
            PaletteResource::new(
                PaletteResourceKind::Command,
                command.name.clone(),
                format!("/{}", command.name),
            )
            .description(command.description.clone())
            .search_terms(command.aliases.clone())
        }));
        resources.extend(self.workspace_files.iter().map(|file| {
            PaletteResource::new(
                PaletteResourceKind::File,
                file.relative_path.clone(),
                file.relative_path.clone(),
            )
            .description(file.name.clone())
        }));
        if let Ok(sessions) = self.session_manager.list_sessions() {
            resources.extend(sessions.into_iter().map(|session| {
                let mut resource = PaletteResource::new(
                    PaletteResourceKind::Session,
                    session.id.clone(),
                    session.title(),
                )
                .description(format!(
                    "{} · {} messages · {}",
                    session.timestamp,
                    session.stats.total_messages(),
                    session.model
                ))
                .search_terms([session.cwd.clone(), session.model.clone()]);
                if session.is_favorite() {
                    resource = resource.status("favorite");
                }
                resource
            }));
        }
        resources.extend(
            crate::model_catalog::available_models()
                .into_iter()
                .map(|model| {
                    let mut resource = PaletteResource::from(&model).description(format!(
                        "{} · {}k context · {:?}",
                        model.provider,
                        model.capabilities.context_tokens / 1000,
                        model.verification.state
                    ));
                    if model.id == self.current_model {
                        resource = resource.status("current");
                    }
                    resource
                }),
        );
        let current_theme = crate::themes::current_theme_name();
        resources.extend(crate::themes::available_themes().into_iter().map(|theme| {
            let mut resource =
                PaletteResource::new(PaletteResourceKind::Theme, theme.clone(), theme.clone());
            if theme == current_theme {
                resource = resource.status("current");
            }
            resource
        }));
        self.command_palette.set_resources(resources);
        self.command_palette.show();
        self.active_modal = ActiveModal::CommandPalette;
    }

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
                if let Some(resource) = self.command_palette.confirm() {
                    match resource.kind {
                        PaletteResourceKind::Command => {
                            self.state.set_input(&format!("/{}", resource.id));
                            self.execute_slash_command().await?;
                        }
                        PaletteResourceKind::File => {
                            for c in resource.id.chars() {
                                self.state.insert_char(c);
                            }
                            self.state.insert_char(' ');
                        }
                        PaletteResourceKind::Session => {
                            if self.state.busy {
                                self.state.status = Some(
                                    "Wait for the active response to finish before switching sessions."
                                        .to_string(),
                                );
                                self.active_modal = ActiveModal::None;
                                return Ok(());
                            }
                            self.session_switcher.show();
                            if self.session_switcher.select_by_id(&resource.id) {
                                self.handle_session_switcher_key(KeyCode::Enter, false)
                                    .await?;
                            } else {
                                self.state.error = Some("Session no longer exists".to_string());
                            }
                        }
                        PaletteResourceKind::Model => {
                            self.handle_command_action(CommandAction::SetModel(resource.id))
                                .await;
                        }
                        PaletteResourceKind::Theme => {
                            self.handle_command_action(CommandAction::SetTheme(resource.id))
                                .await;
                        }
                    }
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

    /// Handle keys in rewind picker modal
    pub(super) fn handle_rewind_picker_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Esc => {
                self.rewind_picker.hide();
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Enter => {
                if let Some(checkpoint) = self.rewind_picker.confirm() {
                    self.restore_file_checkpoint(checkpoint);
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Up => {
                self.rewind_picker.move_up();
            }
            KeyCode::Down => {
                self.rewind_picker.move_down();
            }
            _ => {}
        }
        Ok(())
    }

    /// Handle keys in the full-output detail view overlay.
    ///
    /// Esc/q/Enter closes the overlay and restores the modal that was active
    /// when it opened (the approval modal when expanded from there).
    pub(super) fn handle_detail_view_key(&mut self, code: KeyCode) -> Result<()> {
        let viewport_height = self.capabilities.viewport_height as usize;
        let Some(detail) = &mut self.detail_view else {
            self.active_modal = ActiveModal::None;
            return Ok(());
        };
        if detail.handle_key(code, viewport_height) {
            self.detail_view = None;
            let mut return_modal = self.detail_return_modal;
            self.detail_return_modal = ActiveModal::None;
            // The approval queue may have drained while the overlay was open.
            if return_modal == ActiveModal::Approval && !self.approval_controller.is_visible() {
                return_modal = ActiveModal::None;
            }
            self.active_modal = return_modal;
        }
        Ok(())
    }

    /// Open the detail view for the most recent expandable transcript item:
    /// full untruncated tool output, full thinking, or full message text,
    /// falling back to the current error surface when the transcript is empty.
    pub(super) fn open_detail_view(&mut self) {
        match self.latest_detail_target() {
            Some((title, content)) => {
                self.detail_view = Some(DetailView::new(title, content));
                self.detail_return_modal = ActiveModal::None;
                self.active_modal = ActiveModal::DetailView;
            }
            None => {
                self.state.status.replace("Nothing to expand".to_string());
            }
        }
    }

    /// Pick the most recent expandable item and build its full-content view.
    fn latest_detail_target(&self) -> Option<(String, String)> {
        for message in self.state.messages.iter().rev() {
            if let Some(call) = message
                .tool_calls
                .iter()
                .rev()
                .find(|call| !call.output.trim().is_empty())
            {
                let args = serde_json::to_string_pretty(&call.args)
                    .unwrap_or_else(|_| call.args.to_string());
                let content = format!("Args:\n{args}\n\nOutput:\n{}", call.output);
                return Some((format!("Tool: {}", call.tool), content));
            }
            if !message.thinking.trim().is_empty() {
                return Some(("Thinking".to_string(), message.thinking.clone()));
            }
            if !message.content.trim().is_empty() {
                let title = match message.kind {
                    MessageKind::System => "System message",
                    _ if message.role == MessageRole::User => "User message",
                    _ => "Assistant message",
                };
                return Some((title.to_string(), message.content.clone()));
            }
        }
        self.state
            .error
            .as_ref()
            .map(|error| ("Error".to_string(), error.clone()))
    }

    /// Handle keys in approval modal
    pub(super) async fn handle_approval_key(
        &mut self,
        code: KeyCode,
        modifiers: CrosstermModifiers,
    ) -> Result<()> {
        // Ctrl+E: expand the command/diff being approved into the detail view
        // (Droid parity: Ctrl+O on tool confirmation prompts). The approval
        // modal clips the command to a few lines; the detail view shows the
        // full command and arguments. Esc returns to the approval modal.
        if modifiers.contains(CrosstermModifiers::CONTROL) && matches!(code, KeyCode::Char('e')) {
            if let Some(request) = self.approval_controller.selected_request() {
                self.detail_view = Some(DetailView::new(
                    format!("Approval: {}", request.tool),
                    approval_detail_content(request),
                ));
                self.detail_return_modal = ActiveModal::Approval;
                self.active_modal = ActiveModal::DetailView;
            }
            return Ok(());
        }
        // More than one pending approval means parallel tool calls landed in the
        // same batch: use the batch interaction so the user answers one modal.
        if approval_modal_kind(&self.approval_controller) == ApprovalModalKind::Batched {
            return self.handle_batched_approval_key(code).await;
        }
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

    /// Handle keys in the batched approval modal (multiple pending requests).
    ///
    /// `y`/`n` decide the selected request; `a`/`d` decide the whole batch at
    /// once. Each decision flows through `handle_tool_approval`, so approval
    /// recording and agent-owned execution semantics are identical to the
    /// single-call path.
    async fn handle_batched_approval_key(&mut self, code: KeyCode) -> Result<()> {
        match code {
            KeyCode::Up => self.approval_controller.select_prev(),
            KeyCode::Down => self.approval_controller.select_next(),
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                if let Some((request, _decision)) = self
                    .approval_controller
                    .decide_selected(ApprovalDecision::Approve)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('n' | 'N') | KeyCode::Esc => {
                if let Some((request, _decision)) = self
                    .approval_controller
                    .decide_selected(ApprovalDecision::Deny)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, false)
                        .await?;
                }
                if self.approval_controller.current().is_none() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('a' | 'A') => {
                // Approve all pending calls in FIFO order
                for (request, _decision) in self
                    .approval_controller
                    .decide_all(ApprovalDecision::Approve)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, true)
                        .await?;
                }
                self.active_modal = ActiveModal::None;
            }
            KeyCode::Char('d' | 'D') => {
                // Deny all pending calls in FIFO order
                for (request, _decision) in
                    self.approval_controller.decide_all(ApprovalDecision::Deny)
                {
                    self.handle_tool_approval(request.call_id, request.tool, request.args, false)
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
                    self.switch_model(&model_id, false);
                }
                // Confirming the "show all models" row expands the list and
                // keeps the modal open.
                if !self.model_selector.is_visible() {
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Char('d') if ctrl => {
                // Ctrl+D: persist the highlighted model as the user default
                // and switch to it.
                let model_id = self.model_selector.selected_model().map(|m| m.id.clone());
                if let Some(model_id) = model_id {
                    self.model_selector.hide();
                    self.switch_model(&model_id, true);
                    self.active_modal = ActiveModal::None;
                }
            }
            KeyCode::Tab => {
                self.model_selector.toggle_show_all();
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
        _tool: String,
        _args: serde_json::Value,
        approved: bool,
    ) -> Result<()> {
        self.tool_history.record_approval(&call_id, approved);
        if approved {
            // Relay only the decision. The native agent executes approved
            // calls in model order and emits their lifecycle events. Starting
            // execution here would let batched approvals run concurrently and
            // reorder a gated write/edit relative to later calls.
            if let Some(tx) = &self.tool_response_tx {
                let _ = tx.send((call_id, true, None, ExecutionSource::Native));
            }
        } else {
            self.tool_history.fail(&call_id, "Denied".to_string());
            // Move the transcript row out of `Pending` on denial.
            self.state.fail_tool_call(&call_id, "Denied");
            // Send denial
            if let Some(tx) = &self.tool_response_tx {
                let _ = tx.send((call_id, false, None, ExecutionSource::Native));
            }
        }
        Ok(())
    }
}

/// Build the full-content body for expanding an approval request: the reason,
/// the complete (unclipped) command, and the pretty-printed arguments.
fn approval_detail_content(request: &ApprovalRequest) -> String {
    let mut sections = Vec::new();
    if let Some(reason) = &request.reason {
        sections.push(format!("Reason:\n{reason}"));
    }
    sections.push(format!("Command:\n{}", request.display_command()));
    if let Some(source) = &request.command_source {
        sections.push(format!("Source and execution context:\n{source}"));
    }
    sections.push(format!("Args:\n{}", request.display_args_pretty()));
    sections.join("\n\n")
}
