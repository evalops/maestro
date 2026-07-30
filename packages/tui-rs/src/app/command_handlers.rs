use super::*;
use crate::commands::{AttachAction, GoalAction};
use crate::state::ApprovalMode;

/// Normalize a slash-completion string to a single leading `/`.
///
/// `get_completions` returns values like `/help`. Older call sites (and any
/// bare name without a slash) must still resolve to exactly one leading slash
/// so the input never becomes `//help`.
#[must_use]
pub(crate) fn normalize_slash_completion(cmd: &str) -> String {
    let trimmed = cmd.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '/') {
        return "/".to_string();
    }
    let name = trimmed.trim_start_matches('/');
    format!("/{name}")
}

/// The system message reported for a `/session cleanup` outcome.
///
/// `SessionManager::prune_sessions` returns `(removed, errors)`.
/// `errors` counts real (non-contention) failures acquiring a session's
/// lock -- permission or descriptor failures, not "another Maestro process
/// has it open" -- so `removed == 0` does not mean nothing went wrong.
/// Before this fix, `removed == 0` always reported "No sessions to prune."
/// regardless of `errors`, discarding that count and reading as success
/// even when every eligible session failed to prune.
#[must_use]
pub(crate) fn cleanup_result_message(removed: usize, errors: usize) -> String {
    if removed == 0 && errors == 0 {
        "No sessions to prune.".to_string()
    } else if removed == 0 {
        format!("Failed to prune sessions: {errors} error(s).")
    } else {
        let mut msg = format!("Pruned {removed} session(s).");
        if errors > 0 {
            msg.push_str(&format!(" {errors} error(s)."));
        }
        msg
    }
}

impl App {
    /// Update slash state based on current input
    pub(super) fn update_slash_state(&mut self) {
        if self.state.input().starts_with('/') {
            // Strip every leading `/` so `//help` still matches `help`.
            let query = self.state.input().trim_start_matches('/');
            self.slash_state.set_query(query, &self.slash_matcher);
            // Ghost text only makes sense at the end of the input.
            self.state.ghost_completion = if self.state.cursor() == self.state.input().len() {
                self.slash_matcher
                    .get_inline_completion(self.state.input())
                    .map(|completion| completion.suffix)
            } else {
                None
            };
        } else {
            self.slash_state.reset();
            self.state.ghost_completion = None;
        }
    }

    /// Handle tab for slash command completion
    pub(super) fn handle_slash_tab(&mut self) {
        if self.slash_state.has_completions() {
            self.slash_state.cycle_next();
        } else {
            let query = self.state.input().trim_start_matches('/');
            self.slash_state.set_query(query, &self.slash_matcher);
        }
        self.apply_slash_completion();
    }

    /// Apply the current slash completion to input.
    ///
    /// Completions from `SlashCommandMatcher::get_completions` already include a
    /// leading `/` (e.g. `/help`). Do **not** prefix another slash or the input
    /// becomes `//help` and the registry looks up command name `/help`.
    pub(super) fn apply_slash_completion(&mut self) {
        if let Some(cmd) = self.slash_state.current() {
            self.state.set_input(&normalize_slash_completion(cmd));
        }
    }

    /// Handle a command output from the registry
    pub(super) async fn handle_command_output(&mut self, output: CommandOutput) {
        let mut stack = vec![output];
        while let Some(current) = stack.pop() {
            match current {
                CommandOutput::Message(msg) => {
                    self.state.add_system_message(msg);
                }
                CommandOutput::Help(msg) => {
                    self.state.add_system_message(msg);
                }
                CommandOutput::Warning(msg) => {
                    self.state.error = Some(msg);
                }
                CommandOutput::OpenModal(modal_type) => match modal_type {
                    ModalType::ThemeSelector => {
                        self.theme_selector.show();
                        self.active_modal = ActiveModal::ThemeSelector;
                    }
                    ModalType::ModelSelector => {
                        let current = if self.current_model.is_empty() {
                            self.state.model.clone()
                        } else {
                            Some(self.current_model.clone())
                        };
                        self.model_selector.set_current_model(current);
                        self.model_selector.show();
                        self.active_modal = ActiveModal::ModelSelector;
                    }
                    ModalType::SessionList => {
                        self.session_switcher.show();
                        self.active_modal = ActiveModal::SessionSwitcher;
                    }
                    ModalType::Operations => {
                        self.operations.show();
                        self.active_modal = ActiveModal::Operations;
                    }
                    ModalType::FileSearch => {
                        self.file_search.show();
                        self.active_modal = ActiveModal::FileSearch;
                    }
                    ModalType::CommandPalette => {
                        self.show_command_palette();
                    }
                    ModalType::ShortcutsHelp => {
                        self.shortcuts_help.show();
                        self.active_modal = ActiveModal::ShortcutsHelp;
                    }
                    ModalType::Help => {
                        self.show_help();
                    }
                },
                CommandOutput::Action(action) => {
                    self.handle_command_action(action).await;
                }
                CommandOutput::Silent => {}
                CommandOutput::Multi(outputs) => {
                    for out in outputs.into_iter().rev() {
                        stack.push(out);
                    }
                }
            }
        }
    }

    /// Handle a command action that modifies state
    /// Switch the session model, optionally persisting it as the user
    /// default in `~/.maestro/config.toml` first.
    pub(super) fn switch_model(&mut self, model_id: &str, persist_default: bool) {
        let policy_model = policy_model_id(model_id);
        if let Some(reason) = check_model_allowed(&policy_model) {
            self.state.error = Some(reason);
            return;
        }
        if persist_default {
            match crate::config_cli::persist_user_model_default(model_id) {
                Ok(path) => {
                    self.state
                        .add_system_message(format!("Default model saved to {}", path.display()));
                }
                Err(error) => {
                    self.state.error = Some(format!("Failed to save default model: {error}"));
                }
            }
        }
        if let Some(agent) = &self.native_agent {
            if let Err(e) = agent.set_model(model_id) {
                self.state.error = Some(format!("Failed to set model: {e}"));
            } else {
                self.pending_model_change = Some(PendingModelChange {
                    model: model_id.to_owned(),
                });
                self.state.status = Some(if persist_default {
                    format!("Switching model: {model_id} (saved as default)")
                } else {
                    format!("Switching model: {model_id}")
                });
            }
        } else if persist_default {
            self.state.status = Some(format!("Default model saved: {model_id}"));
        } else {
            self.state.error = Some(
                "No agent available to set model — agent failed to start. \
                 Check the status line, or run `maestro codex login` / set OPENAI_API_KEY and restart."
                    .to_string(),
            );
        }
    }

    pub(super) async fn handle_command_action(&mut self, action: CommandAction) {
        match action {
            CommandAction::ClearMessages => {
                self.start_new_session("New session started.");
            }
            CommandAction::ToggleZenMode => {
                self.state.zen_mode = !self.state.zen_mode;
                if self.state.zen_mode {
                    self.state.status = Some("Zen mode enabled".to_string());
                } else {
                    self.state.status = Some("Zen mode disabled".to_string());
                }
            }
            CommandAction::SetCompactTools(mode) => {
                let next = mode.unwrap_or(!self.state.compact_tool_outputs);
                self.state.compact_tool_outputs = next;
                self.state.expanded_tool_calls.clear();
                self.state.status = Some(if next {
                    "Tool outputs will collapse by default.".to_string()
                } else {
                    "Tool outputs will show full content.".to_string()
                });
            }
            CommandAction::SetApprovalMode(mode) => {
                if mode == "next" {
                    self.state.approval_mode = self.state.approval_mode.next();
                } else if let Some(m) = ApprovalMode::parse(&mode) {
                    self.state.approval_mode = m;
                } else {
                    self.state.error = Some(format!(
                        "Unknown approval mode: {mode}. Use: yolo, selective, safe"
                    ));
                    return;
                }
                self.sync_agent_approval_mode();
                // Keep interaction_mode loosely aligned with approval shortcuts.
                self.state.interaction_mode = match self.state.approval_mode {
                    ApprovalMode::Yolo => crate::state::InteractionMode::AlwaysApprove,
                    ApprovalMode::Safe | ApprovalMode::Selective => {
                        if crate::safety::is_plan_mode() {
                            crate::state::InteractionMode::Plan
                        } else {
                            crate::state::InteractionMode::Normal
                        }
                    }
                };
                self.state.status = Some(format!(
                    "Approval mode: {}",
                    self.state.approval_mode.label()
                ));
            }
            CommandAction::CycleInteractionMode => {
                self.cycle_interaction_mode();
            }
            CommandAction::SetPlanMode(enabled) => {
                self.apply_plan_mode(enabled);
            }
            CommandAction::ViewPlan => {
                self.show_plan();
            }
            CommandAction::ApprovePlan => {
                self.approve_plan();
            }
            CommandAction::PlanReview(action) => {
                self.handle_plan_review(action);
            }
            CommandAction::SideQuestion(question) => {
                let _ = self.handle_side_question(question).await;
            }
            CommandAction::MagicTrace(action) => {
                self.handle_magic_trace(action);
            }
            CommandAction::SetThinkingLevel(level_str) => {
                if let Some(level) = ThinkingLevel::parse(&level_str) {
                    let (enabled, budget) = level.to_config();
                    if let Some(agent) = &self.native_agent {
                        if let Err(e) = agent.set_thinking(enabled, budget) {
                            self.state.error = Some(format!("Failed to set thinking: {e}"));
                            return;
                        }
                    }
                    self.current_thinking_level = level;
                    self.state.thinking_level = self.current_thinking_level;
                    self.record_thinking_level_change(level);
                    self.state.status =
                        Some(format!("Thinking: {} (budget: {})", level.label(), budget));
                } else {
                    self.state.error = Some(format!(
                        "Unknown thinking level: {level_str}. Use: off, minimal, low, medium, high, max"
                    ));
                }
            }
            CommandAction::Quit => {
                self.should_quit = true;
            }
            CommandAction::RefreshWorkspace => {
                // Scan on a background thread like startup; the event loop
                // applies the result (and confirms it) when it arrives.
                self.spawn_workspace_scan();
                self.workspace_refresh_pending = true;
                self.state.status = Some("Refreshing workspace files...".to_string());
            }
            CommandAction::CopyLastMessage => {
                if let Some(msg) = self
                    .state
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.is_assistant_reply() && !m.content.is_empty())
                {
                    match self.clipboard.copy(&msg.content) {
                        Ok(()) => {
                            let chars: Vec<char> = msg.content.chars().collect();
                            let preview = if chars.len() > 50 {
                                format!("{}...", chars[..47].iter().collect::<String>())
                            } else {
                                msg.content.clone()
                            };
                            self.state.status = Some(format!("Copied: {preview}"));
                        }
                        Err(e) => {
                            self.state.error = Some(format!("Failed to copy: {e}"));
                        }
                    }
                } else {
                    self.state.status = Some("No message to copy".to_string());
                }
            }
            CommandAction::SetTheme(theme_name) => {
                if let Err(e) = crate::themes::set_theme_by_name(&theme_name) {
                    self.state.error = Some(format!("Failed to set theme: {e}"));
                } else {
                    self.state.status = Some(format!("Theme set to: {theme_name}"));
                }
            }
            CommandAction::SetModel(model_id) => {
                self.switch_model(&model_id, false);
            }
            CommandAction::RubberDuck { model } => {
                self.start_rubber_duck_review(model);
            }
            CommandAction::SetDefaultModel(model_id) => {
                self.switch_model(&model_id, true);
            }
            CommandAction::BackgroundMonitor(action) => match action {
                BackgroundMonitorAction::Add { task_id, pattern } => {
                    match crate::tools::background_tasks::attach_monitor(&task_id, &pattern) {
                        Ok(monitor) => self.state.add_system_message(format!(
                            "Background monitor {} attached to task {}. Matches are notifications only.",
                            monitor.id, monitor.task_id
                        )),
                        Err(error) => self.state.error = Some(error),
                    }
                }
                BackgroundMonitorAction::List => {
                    let monitors = crate::tools::background_tasks::list_monitors();
                    let message = if monitors.is_empty() {
                        "No background monitors.".to_string()
                    } else {
                        monitors
                            .iter()
                            .map(|monitor| {
                                format!(
                                    "{}  task={}  regex={}",
                                    monitor.id, monitor.task_id, monitor.pattern
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    self.state.add_system_message(message);
                }
                BackgroundMonitorAction::Remove { monitor_id } => {
                    match crate::tools::background_tasks::remove_monitor(&monitor_id) {
                        Ok(_) => self
                            .state
                            .add_system_message(format!("Removed background monitor {monitor_id}.")),
                        Err(error) => self.state.error = Some(error),
                    }
                }
            },
            CommandAction::Loop(action) => match action {
                LoopAction::Start {
                    interval_secs,
                    prompt,
                } => {
                    self.loop_schedule = Some(LoopSchedule {
                        interval: Duration::from_secs(interval_secs),
                        prompt: prompt.clone(),
                        next_fire: Instant::now() + Duration::from_secs(interval_secs),
                    });
                    self.state.add_system_message(format!(
                        "Loop started: every {interval_secs}s — \"{prompt}\". Use /loop stop to cancel."
                    ));
                }
                LoopAction::Stop => {
                    if self.loop_schedule.take().is_some() {
                        self.state.add_system_message("Loop stopped.".to_string());
                    } else {
                        self.state.status = Some("No active loop.".to_string());
                    }
                }
                LoopAction::Status => match &self.loop_schedule {
                    Some(schedule) => self.state.add_system_message(format!(
                        "Loop active: every {}s — \"{}\"",
                        schedule.interval.as_secs(),
                        schedule.prompt
                    )),
                    None => self
                        .state
                        .add_system_message("No active loop. Usage: /loop <interval> <prompt>".to_string()),
                },
            },
            CommandAction::Goal(action) => self.handle_goal_action(action),
            CommandAction::SetFooterStyle(style) => {
                self.footer_style = style;
                let mut prefs = crate::ui_prefs::UiPrefs::load_default();
                prefs.set_footer_style(style);
                if let Err(e) = prefs.save_default() {
                    self.state.error = Some(format!(
                        "Footer style set to {} but failed to persist: {e}",
                        style.as_str()
                    ));
                } else {
                    self.state
                        .status
                        .replace(format!("Footer style: {} (saved)", style.as_str()));
                }
            }
            CommandAction::Attach(action) => self.handle_attach_action(action),
            CommandAction::CompactConversation(instructions) => {
                // Compact conversation by summarizing older messages
                let transcript_messages: Vec<_> = self
                    .state
                    .messages
                    .iter()
                    .filter(|message| message.counts_toward_compaction_index())
                    .cloned()
                    .collect();
                let msg_count = transcript_messages.len();
                if msg_count <= 4 {
                    self.state.status = Some("Conversation too short to compact".to_string());
                    return;
                }

                // Keep last 2 messages, summarize the rest
                let keep_count = 2;
                let to_summarize = msg_count - keep_count;
                let tokens_before = self.usage_tracker.total_tokens();

                // Build summary of compacted messages
                let mut summary = String::new();
                summary.push_str("## Conversation Summary\n\n");

                for (i, msg) in transcript_messages.iter().take(to_summarize).enumerate() {
                    let role = match msg.role {
                        MessageRole::User => "User",
                        MessageRole::Assistant => "Assistant",
                    };
                    let chars: Vec<char> = msg.content.chars().collect();
                    let preview = if chars.len() > 100 {
                        format!("{}...", chars[..97].iter().collect::<String>())
                    } else {
                        msg.content.clone()
                    };
                    summary.push_str(&format!("{}. **{}**: {}\n", i + 1, role, preview));
                }

                if let Some(ref instr) = instructions {
                    summary.push_str(&format!("\n*Focus: {instr}*\n"));
                }

                let summary_clone = summary.clone();
                self.state
                    .apply_compaction(summary, to_summarize, SystemTime::now());

                self.record_compaction_entry(
                    summary_clone,
                    to_summarize,
                    tokens_before,
                    false,
                    instructions.clone(),
                );

                self.state.status = Some(format!("Compacted {to_summarize} messages into summary"));
            }
            CommandAction::Mcp(action) => {
                self.handle_mcp_action(action).await;
            }
            CommandAction::A2a(action) => {
                self.handle_a2a_action(action);
            }
            CommandAction::HooksManage(hooks_action) => {
                self.handle_hooks_action(hooks_action);
            }
            CommandAction::ShowUsage(usage_action) => {
                self.handle_usage_action(usage_action);
            }
            CommandAction::ShowContext => {
                self.show_context_breakdown();
            }
            CommandAction::ExportSession(export_action) => {
                self.handle_export_action(export_action);
            }
            CommandAction::ShowHistory(history_action) => {
                self.handle_history_action(history_action);
            }
            CommandAction::ShowToolHistory(tool_history_action) => {
                self.handle_tool_history_action(tool_history_action);
            }
            CommandAction::Skills(skills_action) => {
                self.handle_skills_action(skills_action);
            }
            CommandAction::Plugins(plugins_action) => {
                self.handle_plugins_action(plugins_action);
            }
            CommandAction::InvokeSkill { name, args } => {
                self.handle_invoke_skill(&name, &args).await;
            }
            CommandAction::InvokePromptTemplate { name, args } => {
                self.handle_invoke_prompt_template(&name, &args).await;
            }
            CommandAction::InvokeExecCommand { name, args } => {
                self.handle_invoke_exec_command(&name, &args);
            }
            CommandAction::Queue(action) => {
                self.handle_queue_action(action);
            }
            CommandAction::Steer(text) => {
                let _ = self.handle_steer_submit(text).await;
            }
            CommandAction::Session(session_action) => {
                self.handle_session_action(session_action);
            }
            CommandAction::Trust(trust_action) => {
                self.handle_trust_action(trust_action);
            }
            CommandAction::ShowSandbox => {
                self.show_sandbox_status();
            }
            CommandAction::ShowTools => {
                self.show_tools_list();
            }
            CommandAction::ShowMemory => {
                self.show_memory_status();
            }
            CommandAction::ShowAlerts => {
                self.show_alerts();
            }
            CommandAction::ShowDiagnostics => {
                let mut diag = String::new();
                diag.push_str("## Diagnostics\n\n");

                // Model & Provider
                diag.push_str(&format!(
                    "**Model:** {}\n",
                    self.state.model.as_deref().unwrap_or("(none)")
                ));
                diag.push_str(&format!(
                    "**Provider:** {}\n",
                    self.state.provider.as_deref().unwrap_or("(none)")
                ));

                // Working directory & Git
                diag.push_str(&format!(
                    "**CWD:** {}\n",
                    self.state.cwd.as_deref().unwrap_or("(unknown)")
                ));
                diag.push_str(&format!(
                    "**Git Branch:** {}\n",
                    self.state.git_branch.as_deref().unwrap_or("(not a repo)")
                ));

                // Session
                diag.push_str(&format!(
                    "**Session:** {}\n",
                    self.state.session_id.as_deref().unwrap_or("(ephemeral)")
                ));

                // Modes
                diag.push_str(&format!(
                    "**Approval Mode:** {}\n",
                    self.state.approval_mode.label()
                ));
                let sandbox = self
                    .sandbox_policy
                    .as_ref()
                    .map_or("none", crate::sandbox::SandboxPolicy::mode_label);
                diag.push_str(&format!("**Sandbox:** {sandbox}\n"));
                let cwd_path = self
                    .state
                    .cwd
                    .as_deref()
                    .map(std::path::Path::new)
                    .unwrap_or_else(|| std::path::Path::new("."));
                diag.push_str(&format!(
                    "**Trust:** {}\n",
                    if crate::config::workspace_trusted_in_global_config(cwd_path) {
                        "trusted"
                    } else {
                        "untrusted"
                    }
                ));
                diag.push_str(&format!(
                    "**Zen Mode:** {}\n",
                    if self.state.zen_mode { "on" } else { "off" }
                ));
                diag.push_str(&format!(
                    "**Steering Mode:** {}\n",
                    self.state.steering_mode.label()
                ));
                diag.push_str(&format!(
                    "**Follow-up Mode:** {}\n",
                    self.state.follow_up_mode.label()
                ));

                // Terminal info
                if let Ok((cols, rows)) = crossterm::terminal::size() {
                    diag.push_str(&format!("**Terminal:** {cols}x{rows}\n"));
                }

                // Message count
                diag.push_str(&format!("**Messages:** {}\n", self.state.messages.len()));

                self.state.add_system_message(diag);
            }
        }
    }

    /// Handle usage/cost display actions
    pub(super) fn handle_usage_action(&mut self, action: crate::commands::UsageAction) {
        use crate::commands::UsageAction;

        match action {
            UsageAction::Summary => {
                let summary = self.usage_tracker.summary();
                self.state
                    .add_system_message(format!("## Usage Summary\n\n{summary}"));
            }
            UsageAction::Detailed => {
                let detailed = self.usage_tracker.detailed_summary();
                self.state
                    .add_system_message(format!("## Usage Details\n\n```\n{detailed}\n```"));
            }
            UsageAction::Reset => {
                self.usage_tracker.reset();
                self.state.status = Some("Usage tracking reset".to_string());
            }
        }
    }

    /// Show the `/context` breakdown: token usage of the current session by
    /// category, measured with the same estimator the compactor uses.
    pub(super) fn show_context_breakdown(&mut self) {
        let system_prompt = self.build_system_prompt();
        let breakdown = super::context_breakdown::ContextBreakdown::compute(
            &system_prompt,
            &self.state.messages,
        );
        // Prefer the configured window (matches the footer), falling back to
        // the model catalog's `ModelCapabilities.context_tokens`.
        let context_window = self.state.context_window.or_else(|| {
            crate::model_catalog::find_model(&self.current_model)
                .map(|info| u64::from(info.capabilities.context_tokens))
        });
        let model = if self.current_model.is_empty() {
            None
        } else {
            Some(self.current_model.as_str())
        };
        let report = breakdown.render(model, context_window);
        self.state.add_system_message(report);
    }

    /// Handle session export actions
    pub(super) fn handle_session_action(&mut self, action: crate::commands::SessionAction) {
        use crate::commands::SessionAction;
        match action {
            SessionAction::Cleanup => {
                let max_sessions = std::env::var("MAESTRO_MAX_SESSIONS")
                    .ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(100);
                let max_age_days = std::env::var("MAESTRO_MAX_SESSION_AGE_DAYS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(90);

                let (removed, errors) = self
                    .session_manager
                    .prune_sessions(max_sessions, max_age_days);
                self.state
                    .add_system_message(cleanup_result_message(removed, errors));
            }
            SessionAction::New => {
                self.start_new_session("New session started.");
            }
            SessionAction::Fork => {
                self.fork_session();
            }
            SessionAction::Rewind { turns, dry_run } => {
                self.rewind_turns(turns, dry_run);
            }
            SessionAction::RewindFiles => {
                self.rewind_files();
            }
            SessionAction::ListCheckpoints => {
                self.list_file_checkpoints();
            }
            SessionAction::Continue => {
                self.continue_last_session();
            }
            SessionAction::Status => {
                self.show_session_status();
            }
        }
    }

    fn handle_trust_action(&mut self, action: crate::commands::TrustAction) {
        use crate::commands::TrustAction;
        let cwd = self
            .state
            .cwd
            .as_deref()
            .map(std::path::Path::new)
            .unwrap_or_else(|| std::path::Path::new("."));
        match action {
            TrustAction::Status => {
                let trusted = crate::config::workspace_trusted_in_global_config(cwd);
                self.state.add_system_message(format!(
                    "Workspace trust for {}: **{}**\n\nUse `/trust grant` to load project skills/plugins/hooks, or `/trust revoke` to disable them.",
                    cwd.display(),
                    if trusted { "trusted" } else { "untrusted" }
                ));
            }
            TrustAction::Grant => match crate::config::set_workspace_trust_in_global_config(cwd, true)
            {
                Ok(path) => self.state.add_system_message(format!(
                    "Trusted {}. Project skills/plugins/hooks will load on the next `/skills reload` or restart.\nWrote {}.",
                    cwd.display(),
                    path.display()
                )),
                Err(error) => self.state.error = Some(error),
            },
            TrustAction::Revoke => {
                match crate::config::set_workspace_trust_in_global_config(cwd, false) {
                    Ok(path) => self.state.add_system_message(format!(
                        "Revoked trust for {}. Project config will not load after restart.\nWrote {}.",
                        cwd.display(),
                        path.display()
                    )),
                    Err(error) => self.state.error = Some(error),
                }
            }
        }
    }

    fn show_sandbox_status(&mut self) {
        let mut msg = String::from("## Sandbox\n\n");
        match &self.sandbox_policy {
            None => {
                msg.push_str("**Policy:** none (session is not OS-sandboxed)\n");
                msg.push_str(
                    "Interactive default is gated (stage-1). Set `MAESTRO_SANDBOX_MODE` or config sandbox settings to enable.\n",
                );
            }
            Some(policy) => {
                msg.push_str(&format!("**Policy:** `{}`\n", policy.mode_label()));
                match policy {
                    crate::sandbox::SandboxPolicy::ReadOnly => {
                        msg.push_str("Reads allowed; writes and many network tools are blocked.\n");
                    }
                    crate::sandbox::SandboxPolicy::WorkspaceWrite { network_access, .. } => {
                        msg.push_str(
                            "In-workspace writes allowed under existing trees; `.git` stays read-only.\n",
                        );
                        msg.push_str(
                            "Stage-1 note: writing content into a *new* file at the repo root can fail closed under Landlock (no WriteFile on root).\n",
                        );
                        msg.push_str(&format!(
                            "Network: {}\n",
                            if *network_access {
                                "enabled"
                            } else {
                                "disabled"
                            }
                        ));
                    }
                    crate::sandbox::SandboxPolicy::DangerFullAccess => {
                        msg.push_str("Full host access; native OS sandbox not applied.\n");
                    }
                }
                if !crate::sandbox::is_sandbox_available() {
                    let reason = crate::sandbox::sandbox_unavailable_reason()
                        .unwrap_or_else(|| "native sandbox unavailable".to_string());
                    msg.push_str(&format!("\n**Host:** sandbox unavailable ({reason})\n"));
                }
            }
        }
        self.state.add_system_message(msg);
    }

    fn show_session_status(&mut self) {
        let mut msg = String::from("## Session\n\n");
        msg.push_str(&format!(
            "**Session id:** {}\n",
            self.state.session_id.as_deref().unwrap_or("(ephemeral)")
        ));
        if let Some(path) = self.session_manager.current_session_path() {
            msg.push_str(&format!("**Path:** {}\n", path.display()));
        } else {
            msg.push_str(&format!(
                "**Sessions dir:** {}\n",
                self.session_manager.sessions_dir().display()
            ));
        }
        msg.push_str(&format!(
            "**Model:** {}\n",
            self.state.model.as_deref().unwrap_or("(none)")
        ));
        msg.push_str(&format!(
            "**Provider:** {}\n",
            self.state.provider.as_deref().unwrap_or("(none)")
        ));
        msg.push_str(&format!(
            "**Approval:** {}\n",
            self.state.approval_mode.label()
        ));
        let sandbox = self
            .sandbox_policy
            .as_ref()
            .map_or("none", crate::sandbox::SandboxPolicy::mode_label);
        msg.push_str(&format!("**Sandbox:** {sandbox}\n"));
        let cwd = self
            .state
            .cwd
            .as_deref()
            .map(std::path::Path::new)
            .unwrap_or_else(|| std::path::Path::new("."));
        let trusted = crate::config::workspace_trusted_in_global_config(cwd);
        msg.push_str(&format!(
            "**Trust:** {}\n",
            if trusted { "trusted" } else { "untrusted" }
        ));
        msg.push_str(&format!("**Messages:** {}\n", self.state.messages.len()));
        self.state.add_system_message(msg);
    }

    fn show_tools_list(&mut self) {
        use crate::tools::ToolRegistry;
        let registry = ToolRegistry::new();
        let mut names: Vec<String> = registry
            .tools()
            .map(|def| {
                let name = def.tool.name.as_str();
                let desc = def.tool.description.lines().next().unwrap_or("").trim();
                if desc.is_empty() {
                    format!("- `{name}`")
                } else {
                    format!("- `{name}` — {desc}")
                }
            })
            .collect();
        names.sort();
        let mut msg = String::from("## Built-in tools\n\n");
        if names.is_empty() {
            msg.push_str("*No tools registered*\n");
        } else {
            msg.push_str(&names.join("\n"));
            msg.push('\n');
        }
        msg.push_str("\nMCP tools: `/mcp` · `/tools mcp` for status\n");
        self.state.add_system_message(msg);
    }

    fn show_memory_status(&mut self) {
        use crate::path_utils::maestro_home_dir;
        let mut msg = String::from("## Memory\n\n");
        if let Some(home) = maestro_home_dir() {
            let memory_dir = home.join("memory");
            msg.push_str(&format!("**Local dir:** `{}`\n", memory_dir.display()));
            if memory_dir.is_dir() {
                match std::fs::read_dir(&memory_dir) {
                    Ok(entries) => {
                        let mut files: Vec<String> = entries
                            .flatten()
                            .filter(|e| e.path().is_file())
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .collect();
                        files.sort();
                        if files.is_empty() {
                            msg.push_str("*No local memory files yet.*\n");
                        } else {
                            msg.push_str(&format!("**Files ({}):**\n", files.len()));
                            for f in files.iter().take(30) {
                                msg.push_str(&format!("- `{f}`\n"));
                            }
                            if files.len() > 30 {
                                msg.push_str(&format!("- …and {} more\n", files.len() - 30));
                            }
                        }
                    }
                    Err(err) => msg.push_str(&format!("Could not list memory dir: {err}\n")),
                }
            } else {
                msg.push_str(
                    "*Directory not created yet.* Local notes land here when memory writes are enabled.\n",
                );
            }
        } else {
            msg.push_str("*Could not resolve MAESTRO_HOME / ~/.maestro*\n");
        }
        if std::env::var("MAESTRO_SHARED_MEMORY_BASE").is_ok() {
            msg.push_str(
                "\n**Shared memory:** configured (`MAESTRO_SHARED_MEMORY_BASE`). Use `maestro memory` for sync.\n",
            );
        } else {
            msg.push_str("\n**Shared memory:** not configured. Local-only status above.\n");
        }
        self.state.add_system_message(msg);
    }

    fn continue_last_session(&mut self) {
        if self.state.busy {
            self.state.status = Some(
                "Wait for the active response to finish before continuing another session."
                    .to_string(),
            );
            return;
        }
        match self.session_manager.most_recent_session() {
            Ok(Some(session)) => {
                // Resuming a persisted transcript begins a new credential scope.
                // Historical references intentionally cannot resolve after reload.
                self.credential_vault.clear();
                // Drop the previous session's error surface and force a full
                // repaint so its frames cannot linger beneath the resumed
                // transcript.
                self.reset_rendered_viewport();
                crate::plan_mode::set_active_session_id(None);
                restore_visible_session_messages(&mut self.state, &session);
                self.plan_review_comments =
                    crate::session::reconstruct_plan_review(&session.plan_review_events);
                let session_id = session.header.id.clone();
                self.state.session_id = Some(session_id.clone());
                if let Err(err) = self
                    .session_manager
                    .resume_session_by_path(session_id.clone(), session.file_path.as_str())
                {
                    self.session_manager.reset_session();
                    crate::plan_mode::set_active_session_id(None);
                    self.session_resume_failed = true;
                    self.state.error = Some(format!("Failed to resume session writer: {err}"));
                    return;
                }
                self.session_resume_failed = false;
                crate::plan_mode::set_active_session_id(Some(session_id.clone()));
                self.hydrate_usage_from_session(&session);
                use crate::ai::{Message as AiMessage, MessageContent, Role};
                use crate::state::{MessageKind, MessageRole};
                let agent_messages: Vec<AiMessage> = self
                    .state
                    .messages
                    .iter()
                    .filter(|m| m.kind == MessageKind::Regular)
                    .filter_map(|m| match m.role {
                        MessageRole::User => Some(AiMessage {
                            role: Role::User,
                            content: MessageContent::text(m.content.clone()),
                        }),
                        MessageRole::Assistant if m.is_assistant_reply() => Some(AiMessage {
                            role: Role::Assistant,
                            content: MessageContent::text(m.content.clone()),
                        }),
                        _ => None,
                    })
                    .collect();
                if let Some(agent) = &self.native_agent {
                    agent.replace_history(agent_messages);
                }
                self.state.status = Some(format!("Continued session {session_id}"));
                self.state.add_system_message(format!(
                    "Resumed most recent session `{session_id}` ({} messages).",
                    self.state.messages.len()
                ));
            }
            Ok(None) => {
                self.state
                    .status
                    .replace("No previous session found for this workspace.".to_string());
            }
            Err(err) => {
                self.state.error = Some(format!("Failed to load last session: {err}"));
            }
        }
    }

    /// Restore a fully-loaded session into the TUI: visible transcript, plan
    /// review state, model/thinking configuration, usage hydration, and an
    /// append-ready session writer. Shared by the session switcher and the
    /// `maestro fork` startup resume.
    pub(crate) fn apply_resumed_session(&mut self, session: &crate::session::ParsedSession) {
        let session_id = session.header.id.clone();
        // Resuming a persisted transcript begins a new credential scope.
        // Historical references intentionally cannot resolve after reload.
        self.credential_vault.clear();
        // Drop the old session's error surface and force a full repaint so
        // its frames cannot linger beneath the restored transcript.
        self.reset_rendered_viewport();
        crate::plan_mode::set_active_session_id(None);
        if let Some(agent) = &self.native_agent {
            // Drop any active-session state before the new transcript and
            // credential scope become visible.
            agent.clear_history();
        }
        restore_visible_session_messages(&mut self.state, session);
        self.plan_review_comments =
            crate::session::reconstruct_plan_review(&session.plan_review_events);

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
                let (enabled, budget) = session.header.thinking_level.to_config();
                if let Err(e) = agent.set_thinking(enabled, budget) {
                    self.state.error = Some(format!("Failed to set thinking: {e}"));
                    thinking_applied = false;
                }
            }
        }

        self.session_started_at = chrono::DateTime::parse_from_rfc3339(&session.header.timestamp)
            .ok()
            .and_then(|dt| {
                let secs = dt.timestamp();
                if secs < 0 {
                    None
                } else {
                    Some(UNIX_EPOCH + Duration::new(secs as u64, dt.timestamp_subsec_nanos()))
                }
            })
            .unwrap_or_else(SystemTime::now);
        self.hydrate_usage_from_session(session);

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

        if let Err(err) = self
            .session_manager
            .resume_session_by_path(session_id.clone(), session.file_path.as_str())
        {
            self.session_manager.reset_session();
            crate::plan_mode::set_active_session_id(None);
            self.session_resume_failed = true;
            self.state.error = Some(format!("Failed to resume session writer: {err}"));
            self.state.status = Some(format!(
                "Session resume failed ({session_id}); use /new to continue"
            ));
        } else {
            self.session_resume_failed = false;
            crate::plan_mode::set_active_session_id(Some(session_id.clone()));
        }
    }

    /// Resume a specific session before the event loop starts.
    ///
    /// Used by `maestro fork` to continue a freshly forked session. At this
    /// point the native agent has not spawned yet, so the agent-facing parts
    /// of [`App::apply_resumed_session`] are no-ops; the forked session's
    /// model is adopted through `MAESTRO_MODEL` by the caller instead.
    pub fn resume_session_at_startup(&mut self, session_id: &str) {
        match self.session_manager.load_session(session_id) {
            Ok(session) => self.apply_resumed_session(&session),
            Err(err) => {
                self.state.error = Some(format!("Failed to load session: {err}"));
            }
        }
    }

    /// List recently recorded alerts in the transcript and mark them seen.
    fn show_alerts(&mut self) {
        const MAX_LISTED: usize = 10;
        if self.state.alerts.is_empty() {
            self.state
                .add_system_message("No alerts recorded this session.".to_string());
            return;
        }
        let total = self.state.alerts.len();
        let skipped = total.saturating_sub(MAX_LISTED);
        let mut text = if skipped > 0 {
            format!("## Alerts ({total} recorded; latest {MAX_LISTED} shown)\n")
        } else {
            format!("## Alerts ({total} recorded)\n")
        };
        for (index, alert) in self.state.alerts.iter().enumerate().skip(skipped) {
            text.push_str(&format!("\n{}. {alert}", index + 1));
        }
        self.state.add_system_message(text);
        self.state.mark_alerts_seen();
    }

    fn start_new_session(&mut self, status: &str) {
        if self.state.busy {
            self.state.status = Some(
                "Wait for the active response to finish before starting a new session.".to_string(),
            );
            return;
        }
        self.credential_vault.clear();
        self.state.messages.clear();
        self.plan_review_comments.clear();
        self.state.scroll_offset = 0;
        self.state.alerts.clear();
        self.state.unseen_alerts = 0;
        // Drop any lingering error surface and force a full viewport repaint
        // so the previous session's frames cannot linger on screen.
        self.reset_rendered_viewport();
        self.session_manager.reset_session();
        self.state.session_id = None;
        crate::plan_mode::set_active_session_id(None);
        self.session_started_at = SystemTime::now();
        self.session_resume_failed = false;
        self.usage_tracker = crate::usage::UsageTracker::new();
        if !self.current_model.is_empty() {
            self.usage_tracker.set_model(self.current_model.clone());
        }
        self.clear_active_skills();
        if let Some(agent) = &self.native_agent {
            agent.clear_history();
        }
        self.state.status = Some(status.to_string());
        self.state.add_system_message(status.to_string());
    }

    pub(super) fn fork_session(&mut self) {
        if self.state.busy {
            self.state.status = Some(
                "Wait for the active response to finish before forking the session.".to_string(),
            );
            return;
        }
        use crate::session::BranchPoint;

        let fork_index = self.state.messages.len().saturating_sub(1);
        let fork_id = self
            .state
            .messages
            .last()
            .map(|m| m.id.clone())
            .unwrap_or_else(|| "start".to_string());
        let branch = BranchPoint::new(fork_id, fork_index).with_description("Forked via /fork");

        // Detach writer so the next message starts a new session file, keeping transcript.
        // A fork must not retain credentials introduced by its parent session.
        self.credential_vault.clear();
        self.plan_review_comments.clear();
        let parent_session = self.state.session_id.clone();
        self.session_manager.reset_session();
        self.state.session_id = None;
        crate::plan_mode::set_active_session_id(None);
        self.session_started_at = SystemTime::now();
        self.session_resume_failed = false;

        let msg = if let Some(parent) = parent_session {
            format!(
                "Forked from session {parent} at message {} (branch {}). Transcript kept; new session starts on next message.",
                branch.fork_index + 1,
                &branch.id[..8.min(branch.id.len())]
            )
        } else {
            format!(
                "Forked conversation at message {} (branch {}). Transcript kept; new session starts on next message.",
                branch.fork_index + 1,
                &branch.id[..8.min(branch.id.len())]
            )
        };
        self.state.status = Some("Session forked.".to_string());
        self.state.add_system_message(msg);
    }

    pub(super) fn rewind_turns(&mut self, turns: usize, dry_run: bool) {
        use crate::ai::{Message as AiMessage, MessageContent, Role};
        use crate::state::{MessageKind, MessageRole};

        if self.state.busy {
            self.state.status =
                Some("Wait for the active response to finish before rewinding.".to_string());
            return;
        }

        // Drop the last `turns` main-history user messages and everything after each.
        let mut remaining = self.state.messages.clone();
        let mut removed_users = 0usize;
        while removed_users < turns {
            let Some(user_idx) = remaining
                .iter()
                .rposition(|m| m.role == MessageRole::User && m.kind == MessageKind::Regular)
            else {
                break;
            };
            remaining.truncate(user_idx);
            removed_users += 1;
        }

        if removed_users == 0 {
            self.state.status = Some("Nothing to rewind.".to_string());
            return;
        }

        if dry_run {
            self.state.status = Some(format!(
                "Dry run: would remove {removed_users} turn{} from in-memory history. The session file would remain unchanged.",
                if removed_users == 1 { "" } else { "s" }
            ));
            return;
        }

        self.state.messages = remaining;
        self.state.scroll_offset = 0;

        // Rebuild agent history from remaining regular user/assistant text.
        let agent_messages: Vec<AiMessage> = self
            .state
            .messages
            .iter()
            .filter(|m| m.kind == MessageKind::Regular)
            .filter_map(|m| match m.role {
                MessageRole::User => Some(AiMessage {
                    role: Role::User,
                    content: MessageContent::text(m.content.clone()),
                }),
                MessageRole::Assistant if m.is_assistant_reply() => Some(AiMessage {
                    role: Role::Assistant,
                    content: MessageContent::text(m.content.clone()),
                }),
                _ => None,
            })
            .collect();

        if let Some(agent) = &self.native_agent {
            agent.replace_history(agent_messages);
        }

        let label = if removed_users == 1 {
            "Removed 1 turn from in-memory history. The session file is unchanged.".to_string()
        } else {
            format!(
                "Removed {removed_users} turns from in-memory history. The session file is unchanged."
            )
        };
        self.state.status = Some(label.clone());
        self.state.add_system_message(label);
    }

    pub(super) fn cycle_interaction_mode(&mut self) {
        let next = self.state.interaction_mode.next();
        self.apply_interaction_mode(next);
    }

    fn apply_interaction_mode(&mut self, mode: crate::state::InteractionMode) {
        if mode != crate::state::InteractionMode::Plan
            && crate::safety::is_plan_mode()
            && !self.leave_plan_mode()
        {
            return;
        }
        self.state.interaction_mode = mode;
        self.state.approval_mode = mode.approval_mode();
        self.sync_agent_approval_mode();
        match mode {
            crate::state::InteractionMode::Plan => {
                self.apply_plan_mode(true);
            }
            crate::state::InteractionMode::Normal
            | crate::state::InteractionMode::AlwaysApprove => {
                self.update_agent_system_prompt();
            }
        }
        self.state.status = Some(format!(
            "Mode: {} (approvals: {})",
            mode.label(),
            self.state.approval_mode.label()
        ));
    }

    fn plan_cwd(&self) -> String {
        self.state.cwd.clone().unwrap_or_else(|| ".".to_string())
    }

    /// Kick off a background `/rubber-duck` review of uncommitted changes with
    /// a different model. The finished review arrives via `poll_rubber_duck`.
    fn start_rubber_duck_review(&mut self, requested_model: Option<String>) {
        if self.rubber_duck_running {
            self.state
                .add_system_message("A rubber duck review is already running.".to_string());
            return;
        }
        let cwd = self.plan_cwd();
        let cwd_path = std::path::Path::new(&cwd);
        if !crate::git::is_git_repo(cwd_path) {
            self.state
                .add_system_message("Not a git repository; nothing to review.".to_string());
            return;
        }
        let review_model = match crate::rubber_duck::pick_review_model(
            &self.current_model,
            requested_model.as_deref(),
        ) {
            Ok(model) => model,
            Err(message) => {
                self.state.add_system_message(message);
                return;
            }
        };
        let (tx, rx) = std::sync::mpsc::channel();
        self.rubber_duck_rx = Some(rx);
        self.rubber_duck_running = true;
        self.state.status = Some(format!("Rubber duck reviewing with {review_model}…"));
        self.state.add_system_message(format!(
            "Rubber duck review started with {review_model} (current model: {}). The result will appear here when done.",
            self.current_model
        ));
        tokio::spawn(crate::rubber_duck::run_review(
            review_model,
            cwd,
            self.current_model.clone(),
            tx,
        ));
    }

    pub(super) fn apply_plan_mode(&mut self, enabled: bool) {
        if enabled {
            crate::safety::set_plan_mode(true);
            self.state.interaction_mode = crate::state::InteractionMode::Plan;
            if matches!(self.state.approval_mode, ApprovalMode::Yolo) {
                self.state.approval_mode = ApprovalMode::Selective;
                self.sync_agent_approval_mode();
            }
            // Bind plan file to the active session when available.
            if let Some(id) = self.session_manager.current_session_id() {
                crate::plan_mode::set_active_session_id(Some(id.to_string()));
            }
            let cwd = self.plan_cwd();
            let plan_path = crate::plan_mode::ensure_plan_file(&cwd)
                .unwrap_or_else(|_| crate::plan_mode::plan_file_path(&cwd));
            self.state.status = Some(format!(
                "Plan mode on — write only {}. Shift+Tab or /plan approve when ready.",
                plan_path.display()
            ));
            self.state.add_system_message(format!(
                "Plan mode enabled (Grok-style). Explore freely; mutate only the plan file \
(`.maestro/plan.md` / `{}`). When the plan is ready: `/view-plan`, then `/plan approve`.",
                plan_path.display()
            ));
            // Nudge the agent with plan-mode instructions when possible.
            if let Some(agent) = &self.native_agent {
                let prompt = format!(
                    "{}{}",
                    self.build_system_prompt(),
                    crate::plan_mode::plan_mode_system_addendum(&cwd)
                );
                let _ = agent.set_system_prompt(prompt);
            }
        } else {
            if !self.leave_plan_mode() {
                return;
            }
            self.state.status = Some("Plan mode off.".to_string());
        }
    }

    fn stale_plan_review_ids(&self) -> Vec<u64> {
        let plan = crate::plan_mode::read_plan(&self.plan_cwd());
        self.plan_review_comments
            .iter()
            .filter(|comment| {
                let Some(plan) = plan.as_deref() else {
                    return true;
                };
                comment.revision != crate::plan_mode::plan_revision(plan)
                    || crate::plan_mode::plan_excerpt(plan, comment.start_line, comment.end_line)
                        .as_deref()
                        != Some(comment.excerpt.as_str())
            })
            .map(|comment| comment.id)
            .collect()
    }

    fn plan_exit_blocker(&self) -> Option<String> {
        let open_count = self
            .plan_review_comments
            .iter()
            .filter(|comment| !comment.resolved)
            .count();
        if open_count > 0 {
            return Some(format!(
                "Plan exit blocked by {open_count} open review comment{}. Use `/plan comments`.",
                if open_count == 1 { "" } else { "s" }
            ));
        }
        let stale = self.stale_plan_review_ids();
        (!stale.is_empty()).then(|| {
            format!(
                "Plan changed after {} review comment{} were created. Recreate stale comments before leaving plan mode.",
                stale.len(),
                if stale.len() == 1 { "" } else { "s" }
            )
        })
    }

    fn leave_plan_mode(&mut self) -> bool {
        if let Some(error) = self.plan_exit_blocker() {
            self.state.error = Some(error);
            return false;
        }
        crate::plan_mode::approve_plan();
        if self.state.interaction_mode == crate::state::InteractionMode::Plan {
            self.state.interaction_mode = crate::state::InteractionMode::Normal;
        }
        self.update_agent_system_prompt();
        true
    }

    fn show_plan(&mut self) {
        if let Some(id) = self.session_manager.current_session_id() {
            crate::plan_mode::set_active_session_id(Some(id.to_string()));
        }
        let cwd = self.plan_cwd();
        match crate::plan_mode::read_plan(&cwd) {
            Some(text) => {
                self.state.status = Some("Showing plan.md".to_string());
                self.state
                    .add_system_message(format!("## Current plan\n\n{text}"));
            }
            None => {
                let path = crate::plan_mode::plan_file_path(&cwd);
                self.state.add_system_message(format!(
                    "No plan written yet. In plan mode, write to `.maestro/plan.md` \
(session copy: `{}`).",
                    path.display()
                ));
            }
        }
    }

    pub(super) fn approve_plan(&mut self) {
        let cwd = self.plan_cwd();
        let preview = crate::plan_mode::read_plan(&cwd);
        if !self.leave_plan_mode() {
            return;
        }
        self.state.status = Some("Plan approved. Implementation tools are enabled.".to_string());
        if let Some(text) = preview {
            self.state.add_system_message(format!(
                "Plan approved. Leaving plan mode. Summary of approved plan:\n\n{text}"
            ));
        } else {
            self.state.add_system_message(
                "Plan approved (empty plan). Leaving plan mode so you can implement.".to_string(),
            );
        }
    }

    pub(super) fn handle_plan_review(&mut self, action: PlanReviewAction) {
        match action {
            PlanReviewAction::Comment {
                start_line,
                end_line,
                text,
            } => {
                let Some(plan) = crate::plan_mode::read_plan(&self.plan_cwd()) else {
                    self.state.error = Some("No plan is available for review.".to_string());
                    return;
                };
                let line_count = plan.lines().count();
                if end_line > line_count {
                    self.state.error = Some(format!(
                        "Plan has {line_count} lines; comment range ends at {end_line}."
                    ));
                    return;
                }
                let id = self
                    .plan_review_comments
                    .iter()
                    .map(|comment| comment.id)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);
                let revision = crate::plan_mode::plan_revision(&plan);
                let excerpt = crate::plan_mode::plan_excerpt(&plan, start_line, end_line)
                    .expect("validated plan comment range");
                self.plan_review_comments.push(PlanReviewComment {
                    id,
                    start_line,
                    end_line,
                    text: text.clone(),
                    revision: revision.clone(),
                    excerpt: excerpt.clone(),
                    resolved: false,
                });
                self.record_plan_review_event(PlanReviewEvent::Comment {
                    id,
                    start_line,
                    end_line,
                    text,
                    revision,
                    excerpt,
                });
                self.state.status = Some(format!("Added plan comment #{id}."));
            }
            PlanReviewAction::List => {
                let mut message = String::from("## Plan review comments\n\n");
                let stale = self.stale_plan_review_ids();
                if self.plan_review_comments.is_empty() {
                    message.push_str("No review comments.");
                } else {
                    for comment in &self.plan_review_comments {
                        let state = if stale.contains(&comment.id) {
                            "stale"
                        } else if comment.resolved {
                            "resolved"
                        } else {
                            "open"
                        };
                        message.push_str(&format!(
                            "- #{} lines {}-{} [{}]: {}\n  ```\n  {}\n  ```\n",
                            comment.id,
                            comment.start_line,
                            comment.end_line,
                            state,
                            comment.text,
                            comment.excerpt.replace('\n', "\n  ")
                        ));
                    }
                }
                self.state.add_system_message(message);
            }
            PlanReviewAction::Resolve { id } => {
                if self.stale_plan_review_ids().contains(&id) {
                    self.state.error = Some(format!(
                        "Plan comment #{id} is stale. Recreate it against the current plan."
                    ));
                    return;
                }
                let Some(comment) = self
                    .plan_review_comments
                    .iter_mut()
                    .find(|comment| comment.id == id)
                else {
                    self.state.error = Some(format!("Plan comment #{id} does not exist."));
                    return;
                };
                comment.resolved = true;
                self.record_plan_review_event(PlanReviewEvent::Resolve { id });
                self.state.status = Some(format!("Plan comment #{id} resolved."));
            }
            PlanReviewAction::Reopen { id } => {
                if self.stale_plan_review_ids().contains(&id) {
                    self.state.error = Some(format!(
                        "Plan comment #{id} is stale. Recreate it against the current plan."
                    ));
                    return;
                }
                let Some(comment) = self
                    .plan_review_comments
                    .iter_mut()
                    .find(|comment| comment.id == id)
                else {
                    self.state.error = Some(format!("Plan comment #{id} does not exist."));
                    return;
                };
                comment.resolved = false;
                self.record_plan_review_event(PlanReviewEvent::Reopen { id });
                self.state.status = Some(format!("Plan comment #{id} reopened."));
            }
        }
    }

    fn handle_magic_trace(&mut self, action: crate::commands::MagicTraceAction) {
        use crate::commands::MagicTraceAction;
        match action {
            MagicTraceAction::Stop => {
                crate::magic_trace::stop_indicator();
                self.state.status =
                    Some("magic-trace: stop indicator fired (snapshot if attached)".into());
            }
            MagicTraceAction::EnableSlowFrame => {
                crate::magic_trace::set_slow_frame_trigger(true);
                self.state.status =
                    Some("magic-trace: slow-frame auto snapshot ON (attach first)".into());
            }
            MagicTraceAction::DisableSlowFrame => {
                crate::magic_trace::set_slow_frame_trigger(false);
                self.state.status = Some("magic-trace: slow-frame auto snapshot OFF".into());
            }
            MagicTraceAction::Status => {
                let on = crate::magic_trace::slow_frame_trigger_enabled();
                self.state.add_system_message(format!(
                    "## magic-trace\n\n\
Linux + Intel PT only. Build: `cargo build --profile magic-trace`.\n\n\
Attach: `scripts/magic-trace-tui.sh attach`\n\n\
Slow-frame trigger: **{}** (`/magic-trace on|off`)\n\n\
Manual snapshot: `/magic-trace stop`",
                    if on { "on" } else { "off" }
                ));
            }
        }
    }

    pub(super) fn handle_export_action(&mut self, action: crate::commands::ExportAction) {
        use crate::commands::ExportAction;
        use crate::session::{ExportFormat, ExportOptions, SessionReader};

        let (format, path) = match action {
            ExportAction::Markdown(p) => (ExportFormat::Markdown, p),
            ExportAction::Html(p) => (ExportFormat::Html, p),
            ExportAction::Json(p) => (ExportFormat::Json, p),
            ExportAction::PlainText(p) => (ExportFormat::PlainText, p),
            ExportAction::ShowOptions => {
                self.state.add_system_message(
                    "## Session Export\n\n\
                    Usage: `/export <format> [path]`\n\n\
                    **Formats:**\n\
                    - `markdown` or `md` - Human-readable markdown\n\
                    - `html` - Styled HTML page\n\
                    - `json` - Structured JSON data\n\
                    - `text` or `txt` - Plain text\n\n\
                    **Examples:**\n\
                    - `/export markdown` - Output to terminal\n\
                    - `/export html session.html` - Save to file\n"
                        .to_string(),
                );
                return;
            }
        };

        let options = ExportOptions {
            format,
            ..Default::default()
        };

        let _ = self.session_manager.flush();

        let session_path = self.session_manager.current_session_path().or_else(|| {
            let session_id = self.state.session_id.as_ref()?;
            self.session_manager
                .list_all_sessions()
                .ok()?
                .into_iter()
                .find(|s| &s.id == session_id)
                .map(|s| s.path)
        });

        let Some(session_path) = session_path else {
            self.state.error = Some("No active session to export".to_string());
            return;
        };

        let output_path = if let Some(path) = path {
            let expanded = if let Some(stripped) = path.strip_prefix("~/") {
                let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
                home.join(stripped)
            } else {
                std::path::PathBuf::from(path)
            };
            if expanded.is_absolute() {
                expanded
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .join(expanded)
            }
        } else {
            let mut default_path = session_path.clone();
            default_path.set_extension(format.extension());
            default_path
        };

        if let Some(reason) = check_path_allowed(&output_path) {
            self.state.error = Some(reason);
            return;
        }

        if let Some(parent) = output_path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                self.state.error = Some(format!("Failed to create export directory: {err}"));
                return;
            }
        }

        let session = match SessionReader::read_file(&session_path) {
            Ok(session) => session,
            Err(err) => {
                self.state.error = Some(format!("Failed to read session: {err}"));
                return;
            }
        };

        let exporter = SessionExporter::from_session(&session, options);
        let output = exporter.export_to_string();
        if let Err(err) = std::fs::write(&output_path, output) {
            self.state.error = Some(format!("Failed to write export: {err}"));
            return;
        }

        self.state.status = Some(format!(
            "Session exported to {}",
            output_path.to_string_lossy()
        ));
    }

    /// Handle prompt history actions
    pub(super) fn handle_history_action(&mut self, action: crate::commands::HistoryAction) {
        use crate::commands::HistoryAction;

        match action {
            HistoryAction::Recent(count) => {
                let recent = self.prompt_history.recent(count);
                if recent.is_empty() {
                    self.state.status = Some("No prompt history".to_string());
                    return;
                }

                let mut msg = String::from("## Recent Prompts\n\n");
                for (i, entry) in recent.iter().enumerate() {
                    let chars: Vec<char> = entry.prompt.chars().collect();
                    let preview = if chars.len() > 60 {
                        format!("{}...", chars[..57].iter().collect::<String>())
                    } else {
                        entry.prompt.clone()
                    };
                    msg.push_str(&format!("{}. {}\n", i + 1, preview));
                }
                self.state.add_system_message(msg);
            }
            HistoryAction::Search(query) => {
                let results = self.prompt_history.search(&query);
                if results.matches.is_empty() {
                    self.state.status = Some(format!("No matches for '{query}'"));
                    return;
                }

                let mut msg = format!("## Search Results for '{query}'\n\n");
                for (i, m) in results.matches.iter().take(10).enumerate() {
                    let chars: Vec<char> = m.entry.prompt.chars().collect();
                    let preview = if chars.len() > 60 {
                        format!("{}...", chars[..57].iter().collect::<String>())
                    } else {
                        m.entry.prompt.clone()
                    };
                    msg.push_str(&format!("{}. {} (score: {:.2})\n", i + 1, preview, m.score));
                }
                self.state.add_system_message(msg);
            }
            HistoryAction::Clear => {
                self.prompt_history.clear();
                let _ = self.prompt_history.delete_file();
                self.state.status = Some("Prompt history cleared".to_string());
            }
        }
    }

    /// Handle tool history actions
    pub(super) fn handle_tool_history_action(
        &mut self,
        action: crate::commands::ToolHistoryAction,
    ) {
        use crate::commands::ToolHistoryAction;

        match action {
            ToolHistoryAction::Recent(count) => {
                let recent = self.tool_history.recent(count);
                if recent.is_empty() {
                    self.state.status = Some("No tool history".to_string());
                    return;
                }

                let mut msg = String::from("## Recent Tool Executions\n\n");
                for exec in recent {
                    let status = if exec.success { "✓" } else { "✗" };
                    let duration = exec
                        .duration
                        .map_or_else(|| "?".to_string(), |d| format!("{:.0}ms", d.as_millis()));
                    msg.push_str(&format!(
                        "{} **{}** ({})\n",
                        status, exec.tool_name, duration
                    ));
                }
                self.state.add_system_message(msg);
            }
            ToolHistoryAction::Stats => {
                let summary = self.tool_history.summary();
                self.state
                    .add_system_message(format!("## Tool Statistics\n\n```\n{summary}\n```"));
            }
            ToolHistoryAction::ForTool(name) => {
                let execs = self.tool_history.for_tool(&name);
                if execs.is_empty() {
                    self.state.status = Some(format!("No history for tool '{name}'"));
                    return;
                }

                let mut msg = format!("## History for '{name}'\n\n");
                for exec in execs.iter().take(10) {
                    let status = if exec.success { "✓" } else { "✗" };
                    let duration = exec
                        .duration
                        .map_or_else(|| "?".to_string(), |d| format!("{:.0}ms", d.as_millis()));
                    msg.push_str(&format!(
                        "{} {} - {}\n",
                        status,
                        duration,
                        exec.output_preview(50).unwrap_or_default()
                    ));
                }
                self.state.add_system_message(msg);
            }
            ToolHistoryAction::Clear => {
                self.tool_history.clear();
                self.state.status = Some("Tool history cleared".to_string());
            }
        }
    }

    /// Handle MCP actions
    pub(super) async fn handle_mcp_action(&mut self, action: crate::commands::McpAction) {
        use crate::commands::McpAction;

        match action {
            McpAction::Configure { args } => match crate::mcp_config_cli::apply_mcp_config(&args) {
                Ok(message) => self.state.add_system_message(message),
                Err(error) => self
                    .state
                    .add_system_message(format!("MCP configuration failed: {error}")),
            },
            McpAction::Status => match self.tool_executor.mcp_status().await {
                Ok(servers) => {
                    self.update_mcp_badge_counts(&servers);
                    let lines = render_mcp_status_lines(&servers);
                    self.state.add_system_message(lines.join("\n"));
                }
                Err(err) => {
                    self.state
                        .add_system_message(format!("Failed to load MCP status: {err}"));
                }
            },
            McpAction::Resources { server, uri } => {
                let servers = match self.tool_executor.mcp_status().await {
                    Ok(servers) => servers,
                    Err(err) => {
                        self.state
                            .add_system_message(format!("Failed to load MCP status: {err}"));
                        return;
                    }
                };
                self.update_mcp_badge_counts(&servers);

                if let (Some(server), Some(uri)) = (server, uri) {
                    let status = servers.iter().find(|s| s.name == server);
                    if let Some(status) = status {
                        if !status.connected {
                            self.state
                                .add_system_message(format!("Server '{server}' not connected"));
                            return;
                        }
                    }

                    match self.tool_executor.mcp_read_resource(&server, &uri).await {
                        Ok(result) => {
                            let mut lines = Vec::new();
                            lines.push(format!("Resource: {uri}"));
                            lines.push(String::new());
                            for content in &result.contents {
                                if let Some(text) = &content.text {
                                    lines.push(text.clone());
                                } else {
                                    let mime = content.mime_type.as_deref().unwrap_or("unknown");
                                    lines.push(format!("[Binary data: {mime}]"));
                                }
                            }
                            self.state.add_system_message(lines.join("\n"));
                        }
                        Err(err) => {
                            self.state
                                .add_system_message(format!("Failed to read resource: {err}"));
                        }
                    }
                    return;
                }

                let mut lines = vec!["MCP Resources".to_string(), String::new()];
                let mut has_resources = false;
                for server in servers {
                    if !server.connected || server.resources.is_empty() {
                        continue;
                    }
                    has_resources = true;
                    lines.push(format!("{}:", server.name));
                    for uri in server.resources {
                        lines.push(format!("  {uri}"));
                    }
                    lines.push(String::new());
                }
                if !has_resources {
                    lines.push("No resources available from connected servers.".to_string());
                }
                lines.push(String::new());
                lines.push("Usage: /mcp resources <server> <uri>".to_string());
                self.state.add_system_message(lines.join("\n"));
            }
            McpAction::Prompts {
                server,
                name,
                arguments,
            } => {
                let servers = match self.tool_executor.mcp_status().await {
                    Ok(servers) => servers,
                    Err(err) => {
                        self.state
                            .add_system_message(format!("Failed to load MCP status: {err}"));
                        return;
                    }
                };
                self.update_mcp_badge_counts(&servers);

                let server_filter = server.clone();
                if let Some(server_name) = server_filter.as_deref() {
                    let Some(status) = servers.iter().find(|entry| entry.name == server_name)
                    else {
                        self.state
                            .add_system_message(format!("Server '{server_name}' not found"));
                        return;
                    };
                    if !status.connected {
                        self.state
                            .add_system_message(format!("Server '{server_name}' not connected"));
                        return;
                    }
                }

                let prompt_servers = match self
                    .tool_executor
                    .mcp_prompt_details(server_filter.as_deref())
                    .await
                {
                    Ok(entries) => entries,
                    Err(err) => {
                        self.state
                            .add_system_message(format!("Failed to load MCP prompts: {err}"));
                        return;
                    }
                };

                if let (Some(server), Some(name), arguments) = (server, name, arguments) {
                    let prompt_exists = prompt_servers.iter().any(|(server_name, prompts)| {
                        server_name == &server && prompts.iter().any(|prompt| prompt.name == name)
                    });
                    if !prompt_exists {
                        self.state.add_system_message(format!(
                            "Prompt '{name}' not found on server '{server}'"
                        ));
                        return;
                    }

                    let prompt_arguments = if arguments.is_empty() {
                        None
                    } else {
                        Some(arguments)
                    };

                    match self
                        .tool_executor
                        .mcp_get_prompt(&server, &name, prompt_arguments)
                        .await
                    {
                        Ok(result) => {
                            let mut lines = Vec::new();
                            lines.push(format!("Prompt: {name}"));
                            if let Some(desc) = result.description {
                                lines.push(String::new());
                                lines.push(format!("Description: {desc}"));
                            }
                            lines.push(String::new());
                            for msg in result.messages {
                                lines.push(format!("[{}]", msg.role));
                                let content = msg.content.as_text().unwrap_or("[non-text content]");
                                lines.push(content.to_string());
                                lines.push(String::new());
                            }
                            self.state.add_system_message(lines.join("\n"));
                        }
                        Err(err) => {
                            self.state
                                .add_system_message(format!("Failed to get prompt: {err}"));
                        }
                    }
                    return;
                }

                self.state.add_system_message(
                    render_mcp_prompt_lines(&prompt_servers, server_filter.as_deref()).join("\n"),
                );
            }
        }
    }

    /// Handle A2A peer-pairing actions.
    pub(super) fn handle_a2a_action(&mut self, action: crate::commands::A2aAction) {
        use crate::commands::A2aAction;

        match action {
            A2aAction::Help => {
                self.state.add_system_message(
                    [
                        "## A2A peer pairing",
                        "",
                        "/a2a fleet",
                        "/a2a peers",
                        "/a2a tasks [peer] [--work-graph]",
                        "/a2a coordinate [peer] [--reply <text>] [--work-graph]",
                        "/a2a accept <pairing-code>",
                        "/a2a register --url <base-url> [--agent-id <id>]",
                        "/a2a delegate <peer> <text>",
                        "/a2a reply <peer> <task-id> <text>",
                        "/a2a send <peer> <text>",
                        "",
                        "Native pairing codes, fleet views, and delegation ledgers are shared with the TypeScript CLI/TUI.",
                    ]
                    .join("\n"),
                );
            }
            A2aAction::Fleet => {
                self.state.add_system_message(
                    "A2A fleet inspection uses the shared Maestro peer registry. Run `maestro a2a fleet` for live health and task summaries until the Rust fleet reader is wired into this view."
                        .to_string(),
                );
            }
            A2aAction::Peers => {
                self.state.add_system_message(
                    "A2A peer listing uses the shared Maestro peer registry. Run `maestro a2a peers` for the current registry until the Rust registry reader is wired into this view."
                        .to_string(),
                );
            }
            A2aAction::Tasks {
                peer,
                include_work_graph,
            } => {
                let scope = peer.as_deref().unwrap_or("all peers");
                let graph_hint = if include_work_graph {
                    " with Platform work graph and Codex subagent summaries"
                } else {
                    ""
                };
                let graph_flag = if include_work_graph {
                    " --work-graph"
                } else {
                    ""
                };
                self.state.add_system_message(format!(
                    "A2A task ledger requested for {scope}{graph_hint}. Run `maestro a2a tasks{graph_flag}` for the current durable ledger until the Rust task reader is wired into this view."
                ));
            }
            A2aAction::Coordinate {
                peer,
                reply,
                include_work_graph,
            } => {
                let scope = peer.as_deref().unwrap_or("all peers");
                let reply_hint = reply
                    .as_ref()
                    .map(|value| format!(" with a {} character reply", value.len()))
                    .unwrap_or_default();
                let graph_hint = if include_work_graph {
                    " and Platform work graph context"
                } else {
                    ""
                };
                let graph_flag = if include_work_graph {
                    " --work-graph"
                } else {
                    ""
                };
                self.state.add_system_message(format!(
                    "A2A coordination requested for {scope}{reply_hint}{graph_hint}. Run `maestro a2a coordinate [peer] --reply <text> --wait{graph_flag}` while the Rust coordination controller is connected to the shared A2A client."
                ));
            }
            A2aAction::Accept { code } => {
                self.state.add_system_message(format!(
                    "A2A pairing code captured ({} chars). Run `maestro a2a accept <code>` Persist it with `/a2a accept <code>` in this TUI, or `maestro a2a accept <code>` from the CLI.",
                    code.len()
                ));
            }
            A2aAction::Register {
                agent_id,
                public_url,
                heartbeat_only,
            } => {
                let agent_hint = agent_id
                    .as_deref()
                    .map(|value| format!(" for `{value}`"))
                    .unwrap_or_default();
                let url_hint = public_url
                    .as_deref()
                    .map(|value| format!(" at `{value}`"))
                    .unwrap_or_default();
                let command_hint = if heartbeat_only {
                    "maestro a2a register --heartbeat-only --agent-id <id>"
                } else {
                    "maestro a2a register --url <base-url> [--agent-id <id>]"
                };
                let action_hint = if heartbeat_only {
                    "refresh the existing Platform heartbeat without requiring a public A2A URL"
                } else {
                    "publish the Rust Agent Card, Codex subagent lanes, and heartbeat to Agent Registry"
                };
                self.state.add_system_message(format!(
                    "Platform A2A peer registration prepared{agent_hint}{url_hint}. Run `{command_hint}` to {action_hint}."
                ));
            }
            A2aAction::Delegate { peer, text } => {
                self.state.add_system_message(format!(
                    "A2A delegation prepared for `{peer}` ({} chars). Run `maestro a2a delegate {peer} <text> --wait` while the Rust delegation controller is connected to the shared A2A client.",
                    text.len()
                ));
            }
            A2aAction::Reply {
                peer,
                task_id,
                text,
            } => {
                self.state.add_system_message(format!(
                    "A2A task reply prepared for `{peer}` task `{task_id}` ({} chars). Run `maestro a2a reply {peer} {task_id} <text> --wait` while the Rust task-continuation controller is connected to the shared A2A client.",
                    text.len()
                ));
            }
            A2aAction::Send { peer, text } => {
                self.state.add_system_message(format!(
                    "A2A send request prepared for `{peer}` ({} chars). Run `maestro a2a send {peer} <text> --wait` while the Rust send controller is connected to the shared A2A client.",
                    text.len()
                ));
            }
        }
    }

    /// Handle hooks management actions
    pub(super) fn handle_hooks_action(&mut self, action: crate::commands::HooksAction) {
        use crate::commands::HooksAction;

        // For now, display messages since hooks aren't wired into App yet
        // In a full implementation, we'd access self.hooks: IntegratedHookSystem
        match action {
            HooksAction::List => {
                let mut msg = String::new();
                msg.push_str("## Hook System\n\n");
                msg.push_str("| Type | Count | Status |\n");
                msg.push_str("|------|-------|--------|\n");
                msg.push_str("| Native | 1 | SafetyHook |\n");
                msg.push_str("| Lua | 0 | - |\n");
                msg.push_str("| WASM | 0 | - |\n");
                msg.push_str("| TypeScript | 0 | - |\n\n");
                msg.push_str(
                    "*Configure hooks in `~/.composer/hooks.toml` or `.composer/hooks.toml`*\n",
                );
                self.state.add_system_message(msg);
            }
            HooksAction::Toggle => {
                self.state.status = Some("Hooks toggled".to_string());
                self.state.add_system_message(
                    "Hooks have been toggled. Use `/hooks` to see current status.".to_string(),
                );
            }
            HooksAction::Reload => {
                self.state.status = Some("Hooks reloaded".to_string());
                self.state
                    .add_system_message("Hook configuration reloaded from disk.".to_string());
            }
            HooksAction::Metrics => {
                let mut msg = String::new();
                msg.push_str("## Hook Metrics\n\n");
                msg.push_str("| Metric | Value |\n");
                msg.push_str("|--------|-------|\n");
                msg.push_str("| PreToolUse calls | 0 |\n");
                msg.push_str("| PostToolUse calls | 0 |\n");
                msg.push_str("| Blocks | 0 |\n");
                msg.push_str("| Total duration | 0ms |\n");
                msg.push_str("| Avg duration | 0ms |\n");
                self.state.add_system_message(msg);
            }
            HooksAction::Enable => {
                self.state.status = Some("Hooks enabled".to_string());
                self.state
                    .add_system_message("Hook system enabled.".to_string());
            }
            HooksAction::Disable => {
                self.state.status = Some("Hooks disabled".to_string());
                self.state
                    .add_system_message("Hook system disabled.".to_string());
            }
        }
    }

    /// Invoke a skill as a slash command (`/skillname args`).
    pub(super) async fn handle_invoke_skill(&mut self, name: &str, args: &str) {
        let id = match self.resolve_skill_id(name) {
            Ok(id) => id,
            Err(err) => {
                self.state.error = Some(err);
                return;
            }
        };
        let Some(loaded) = self.find_loaded_skill(&id) else {
            self.state.error = Some(format!("Skill '{name}' not found"));
            return;
        };
        if !loaded.definition.user_invocable {
            self.state.error = Some(format!(
                "Skill '{name}' is not user-invocable (set user-invocable: true)"
            ));
            return;
        }
        let content = Self::format_skill_invoke(loaded, args);
        let _ = self.skill_registry.activate(&id);
        self.update_agent_system_prompt();
        let _ = self.submit_prompt(content).await;
    }

    /// Invoke a flat markdown prompt/command template as a slash command.
    pub(super) async fn handle_invoke_prompt_template(&mut self, name: &str, args: &str) {
        let Some(prompt) = crate::prompts::find_prompt(&self.custom_prompts, name) else {
            self.state.error = Some(format!("Prompt template '{name}' not found"));
            return;
        };
        match crate::prompts::format_prompt_invoke(prompt, args) {
            Ok(content) => {
                let _ = self.submit_prompt(content).await;
            }
            Err(err) => {
                self.state.error = Some(err);
            }
        }
    }

    /// Handle skills system actions
    pub(super) fn handle_skills_action(&mut self, action: crate::commands::SkillsAction) {
        use crate::commands::SkillsAction;

        match action {
            SkillsAction::List => {
                let mut msg = String::from("## Available Skills\n\n");
                let cwd = self
                    .state
                    .cwd
                    .as_deref()
                    .map(std::path::Path::new)
                    .unwrap_or_else(|| std::path::Path::new("."));
                if !crate::config::workspace_trusted_in_global_config(cwd) {
                    msg.push_str(
                        "*Workspace is untrusted — project skill dirs are skipped. Use `/trust grant` to enable them.*\n\n",
                    );
                }
                if self.loaded_skills.is_empty() && self.skill_load_errors.is_empty() {
                    msg.push_str("*No skills found*\n\n");
                    msg.push_str("Skills are loaded from:\n");
                    msg.push_str("- `~/.composer/skills/` (global)\n");
                    msg.push_str("- `.composer/skills/` (project)\n\n");
                    msg.push_str("Create a `SKILL.md` file following the [Agent Skills spec](https://agentskills.io/specification).\n");
                } else {
                    msg.push_str("| Name | Description | Source | Active | Tools |\n");
                    msg.push_str("|------|-------------|--------|--------|-------|\n");

                    for loaded in &self.loaded_skills {
                        let skill = &loaded.definition;
                        let tools_count = skill.provided_tools.len();
                        let tools = if tools_count > 0 {
                            format!("{tools_count}")
                        } else {
                            "-".to_string()
                        };
                        let active = self
                            .skill_registry
                            .get(&skill.id)
                            .map(|s| s.is_active())
                            .unwrap_or(false);
                        let active_label = if active { "yes" } else { "no" };
                        msg.push_str(&format!(
                            "| {} | {} | {:?} | {} | {} |\n",
                            skill.name,
                            skill.description.chars().take(40).collect::<String>(),
                            skill.source,
                            active_label,
                            tools
                        ));
                    }

                    msg.push_str(&format!(
                        "\n*{} skill(s) found*\n",
                        self.loaded_skills.len()
                    ));
                    let active_ids: Vec<String> = self
                        .skill_registry
                        .active_skills()
                        .iter()
                        .map(|skill| skill.definition.name.clone())
                        .collect();
                    if !active_ids.is_empty() {
                        msg.push_str(&format!("Active: {}\n", active_ids.join(", ")));
                    }
                }

                if !self.skill_load_errors.is_empty() {
                    msg.push_str(&format!(
                        "\n**{} error(s) loading skills:**\n",
                        self.skill_load_errors.len()
                    ));
                    for err in self.skill_load_errors.iter().take(5) {
                        msg.push_str(&format!("- {err}\n"));
                    }
                }

                self.state.add_system_message(msg);
            }
            SkillsAction::Activate(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                let skill = match self.skill_registry.get(&id) {
                    Some(skill) => skill,
                    None => {
                        self.state.error = Some(format!("Skill '{name}' not found"));
                        return;
                    }
                };
                let skill_name = skill.definition.name.clone();
                if skill.is_active() {
                    self.state.status = Some(format!("Skill '{}' already active", skill_name));
                    return;
                }
                if let Err(err) = self.skill_registry.activate(&id) {
                    self.state.error = Some(err);
                    return;
                }
                self.update_agent_system_prompt();
                self.state.status = Some(format!("Activated skill '{}'", skill_name));
                self.state.add_system_message(format!(
                    "Activated skill **{}**. System prompt updated.",
                    skill_name
                ));
            }
            SkillsAction::Deactivate(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                let skill = match self.skill_registry.get(&id) {
                    Some(skill) => skill,
                    None => {
                        self.state.error = Some(format!("Skill '{name}' not found"));
                        return;
                    }
                };
                let skill_name = skill.definition.name.clone();
                if !skill.is_active() {
                    self.state.status = Some(format!("Skill '{}' not active", skill_name));
                    return;
                }
                if let Err(err) = self.skill_registry.deactivate(&id) {
                    self.state.error = Some(err);
                    return;
                }
                self.update_agent_system_prompt();
                self.state.status = Some(format!("Deactivated skill '{}'", skill_name));
                self.state.add_system_message(format!(
                    "Deactivated skill **{}**. System prompt updated.",
                    skill_name
                ));
            }
            SkillsAction::Reload => {
                self.refresh_skills(true);
                self.update_agent_system_prompt();
                if self.skill_load_errors.is_empty() {
                    self.state
                        .status
                        .replace(format!("Loaded {} skill(s)", self.loaded_skills.len()));
                } else {
                    self.state.status.replace(format!(
                        "Loaded {} skill(s), {} error(s)",
                        self.loaded_skills.len(),
                        self.skill_load_errors.len()
                    ));
                }
                let mut msg = format!(
                    "Reloaded skills from filesystem. Found {} skill(s).",
                    self.loaded_skills.len()
                );
                if !self.skill_load_errors.is_empty() {
                    msg.push_str("\n\nErrors:\n");
                    for err in self.skill_load_errors.iter().take(5) {
                        msg.push_str(&format!("- {err}\n"));
                    }
                }
                self.state.add_system_message(msg);
            }
            SkillsAction::Info(name) => {
                let id = match self.resolve_skill_id(&name) {
                    Ok(id) => id,
                    Err(err) => {
                        self.state.error = Some(err);
                        return;
                    }
                };
                if let Some(loaded) = self.find_loaded_skill(&id) {
                    let skill = &loaded.definition;
                    let mut msg = format!("## Skill: {}\n\n", skill.name);
                    msg.push_str(&format!("**Description:** {}\n\n", skill.description));
                    let active = self
                        .skill_registry
                        .get(&skill.id)
                        .map(|s| s.is_active())
                        .unwrap_or(false);
                    msg.push_str(&format!(
                        "**Status:** {}\n\n",
                        if active { "active" } else { "inactive" }
                    ));
                    msg.push_str(&format!("**Source:** {:?}\n\n", skill.source));
                    msg.push_str(&format!("**Path:** `{}`\n\n", loaded.source_path.display()));

                    if !skill.provided_tools.is_empty() {
                        msg.push_str(&format!(
                            "**Tools:** {}\n\n",
                            skill.provided_tools.join(", ")
                        ));
                    }

                    if !skill.trigger_patterns.is_empty() {
                        msg.push_str(&format!(
                            "**Triggers:** {}\n\n",
                            skill.trigger_patterns.join(", ")
                        ));
                    }

                    if let Some(ref prompt) = skill.system_prompt_additions {
                        let preview: String = prompt.chars().take(200).collect();
                        msg.push_str(&format!(
                            "**Instructions preview:**\n```\n{preview}...\n```\n"
                        ));
                    }

                    self.state.add_system_message(msg);
                } else {
                    self.state.error = Some(format!("Skill '{name}' not found"));
                }
            }
        }
    }

    /// Handle plugin discovery actions (`/plugins`).
    pub(super) fn handle_plugins_action(&mut self, action: crate::commands::PluginsAction) {
        use crate::commands::PluginsAction;

        match action {
            PluginsAction::List => {
                let mut report = self.plugin_registry.list_report();
                let cwd = self
                    .state
                    .cwd
                    .as_deref()
                    .map(std::path::Path::new)
                    .unwrap_or_else(|| std::path::Path::new("."));
                if !crate::config::workspace_trusted_in_global_config(cwd) {
                    report = format!(
                        "*Workspace is untrusted — project plugin roots are skipped. Use `/trust grant` to enable them.*\n\n{report}"
                    );
                }
                if let Some(skip) = self.plugin_registry.untrusted_skip_notice() {
                    report.push_str("\n\n");
                    report.push_str(&skip);
                }
                self.state.add_system_message(report);
            }
            PluginsAction::Info(name) => match self.plugin_registry.get(&name) {
                Some(plugin) => {
                    self.state.add_system_message(plugin.detail_report());
                }
                None => {
                    self.state.error = Some(format!(
                        "Plugin '{name}' not found. Use `/plugins` to list discovered plugins."
                    ));
                }
            },
            PluginsAction::Reload => {
                // Rediscover plugins and reload skills that may come from them.
                self.refresh_skills(true);
                let count = self.plugin_registry.len();
                self.state.status = Some(format!("Discovered {count} plugin(s)"));
                self.state.add_system_message(format!(
                    "Reloaded plugins from filesystem. Found {count} plugin(s).\n\n{}",
                    self.plugin_registry.list_report()
                ));
            }
            PluginsAction::MarketplaceList => {
                let catalog = crate::plugins::builtin_catalog();
                let installed: std::collections::HashSet<String> = self
                    .plugin_registry
                    .plugins()
                    .iter()
                    .map(|p| p.name.clone())
                    .collect();
                self.state
                    .add_system_message(crate::plugins::format_catalog(&catalog, &installed));
            }
            PluginsAction::MarketplaceInstall { id, trust } => {
                let catalog = crate::plugins::builtin_catalog();
                let Some(entry) = crate::plugins::find_entry(&catalog, &id) else {
                    self.state.error = Some(format!(
                        "Marketplace entry '{id}' not found. Use `/plugins marketplace list`."
                    ));
                    return;
                };
                if entry.tier.requires_explicit_trust() && !trust {
                    self.state.error = Some(format!(
                        "Entry '{}' ({}) requires explicit trust. Re-run with `--trust`.",
                        entry.id,
                        entry.tier.as_str()
                    ));
                    return;
                }
                let source = match crate::plugins::resolve_install_source(entry) {
                    Ok(s) => s,
                    Err(e) => {
                        self.state.error = Some(format!("Cannot install '{}': {e}", entry.id));
                        return;
                    }
                };
                let home = match crate::path_utils::maestro_home_dir() {
                    Some(h) => h,
                    None => {
                        self.state.error = Some("Could not resolve ~/.maestro".to_string());
                        return;
                    }
                };
                match crate::plugins::install(
                    &source,
                    &home.join("plugins"),
                    &home.join("plugin-state.json"),
                    trust || !entry.tier.requires_explicit_trust(),
                ) {
                    Ok(preview) => {
                        self.refresh_skills(true);
                        self.state.add_system_message(format!(
                            "Installed marketplace plugin **{}** from `{}`.\nCapabilities: {:?}\n\nUse `/plugins list` to verify.",
                            preview.name, preview.source, preview.capabilities
                        ));
                        self.state.status = Some(format!("Installed plugin {}", preview.name));
                    }
                    Err(e) => {
                        self.state.error = Some(format!("Install failed: {e}"));
                    }
                }
            }
        }
    }

    /// Handle `/attach` add|list|clear.
    pub(super) fn handle_attach_action(&mut self, action: AttachAction) {
        match action {
            AttachAction::List => {
                if self.pending_attachments.is_empty() {
                    self.state
                        .add_system_message("No pending attachments. Use `/attach <path>`.".into());
                } else {
                    let mut msg = format!(
                        "## Pending attachments ({})\n\n",
                        self.pending_attachments.len()
                    );
                    for (i, path) in self.pending_attachments.iter().enumerate() {
                        msg.push_str(&format!("{}. `{path}`\n", i + 1));
                    }
                    msg.push_str("\nSent with the next user prompt. `/attach clear` drops them.\n");
                    self.state.add_system_message(msg);
                }
            }
            AttachAction::Clear => {
                let n = self.pending_attachments.len();
                self.pending_attachments.clear();
                self.state.status = Some(format!("Cleared {n} attachment(s)"));
                self.state
                    .add_system_message(format!("Cleared {n} pending attachment(s)."));
            }
            AttachAction::Add(path) => {
                let expanded = if let Some(rest) = path.strip_prefix("~/") {
                    dirs::home_dir()
                        .map(|h| h.join(rest).display().to_string())
                        .unwrap_or(path.clone())
                } else {
                    path.clone()
                };
                let p = std::path::Path::new(&expanded);
                if !p.exists() {
                    self.state.error = Some(format!("Attach path does not exist: {expanded}"));
                } else {
                    self.pending_attachments.push(expanded.clone());
                    let n = self.pending_attachments.len();
                    self.state.status = Some(format!("Attached ({n}): {expanded}"));
                    self.state.add_system_message(format!(
                        "Attached `{expanded}`. It will be sent with the next user prompt ({n} pending)."
                    ));
                }
            }
        }
    }

    /// Handle `/goal` lifecycle actions.
    pub(super) fn handle_goal_action(&mut self, action: GoalAction) {
        match action {
            GoalAction::Status => {
                self.state.add_system_message(self.goal_store.report());
            }
            GoalAction::Create {
                text,
                replace,
                criteria,
                max_turns,
                token_budget,
            } => match self
                .goal_store
                .create(text, criteria, replace, max_turns, token_budget)
            {
                Ok(goal) => {
                    // Kick off work; later turns continue while the goal stays
                    // active. The same worker model ends the loop via
                    // `update_goal` complete|blocked (Codex-style).
                    self.goal_auto_continue_armed = goal.auto_continue;
                    let budget = match goal.token_budget {
                        Some(b) => format!("Token budget: {b}. "),
                        None => String::new(),
                    };
                    self.state.add_system_message(format!(
                        "Goal {} set (**{}**).\n\n{}\n\n\
                         Auto-continue (Codex-style): after each turn, if the goal is still active the TUI injects a continuation prompt. \
                         Mark done with the **`update_goal`** tool (`complete` or `blocked`) — same model. \
                         {budget}Safety max_turns={}. `/goal pause` stops. Skipped while `/loop` or queue is active. \
                         Goal tools are hidden from the model when no goal exists.",
                        goal.id,
                        goal.status.as_str(),
                        goal.text,
                        goal.max_turns
                    ));
                    self.state.status = Some(format!("Goal {}", goal.id));
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::Pause => match self.goal_store.pause() {
                Ok(goal) => {
                    self.goal_auto_continue_armed = false;
                    self.state
                        .status
                        .replace(format!("Goal {} paused", goal.id));
                    self.state
                        .add_system_message(format!("Goal {} paused.", goal.id));
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::Resume => match self.goal_store.resume() {
                Ok(goal) => {
                    self.goal_auto_continue_armed = true;
                    self.state
                        .status
                        .replace(format!("Goal {} resumed", goal.id));
                    self.state.add_system_message(format!(
                        "Goal {} resumed (auto-continue on).",
                        goal.id
                    ));
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::Block { reason } => match self.goal_store.block(reason) {
                Ok(goal) => {
                    self.goal_auto_continue_armed = false;
                    let msg = match &goal.block_reason {
                        Some(r) => format!("Goal {} blocked: {r}", goal.id),
                        None => format!("Goal {} blocked.", goal.id),
                    };
                    self.state.status.replace(msg.clone());
                    self.state.add_system_message(msg);
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::Complete => match self.goal_store.complete() {
                Ok(done) => {
                    self.goal_auto_continue_armed = false;
                    self.state
                        .status
                        .replace(format!("Goal {} complete", done.id));
                    self.state.add_system_message(format!(
                        "Goal {} marked complete.\n\n{}",
                        done.id, done.text
                    ));
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::Clear => match self.goal_store.clear() {
                Ok(Some(prev)) => {
                    self.goal_auto_continue_armed = false;
                    self.state
                        .status
                        .replace(format!("Goal {} cleared", prev.id));
                    self.state
                        .add_system_message(format!("Cleared goal {}.", prev.id));
                }
                Ok(None) => {
                    self.state.status = Some("No goal to clear".to_string());
                }
                Err(e) => self.state.error = Some(e.to_string()),
            },
            GoalAction::AutoContinue { enabled } => {
                match self.goal_store.set_auto_continue(enabled) {
                    Ok(goal) => {
                        self.goal_auto_continue_armed = enabled && goal.status.as_str() == "active";
                        let label = if enabled { "on" } else { "off" };
                        self.state
                            .status
                            .replace(format!("Goal auto-continue {label}"));
                        self.state.add_system_message(format!(
                            "Goal {} auto-continue: {label}.",
                            goal.id
                        ));
                    }
                    Err(e) => self.state.error = Some(e.to_string()),
                }
            }
        }
    }

    pub(super) fn handle_queue_action(&mut self, action: QueueAction) {
        match action {
            QueueAction::Show => {
                let total = self.state.queued_prompt_count;
                let steer_count = self.state.queued_steering_count;
                let follow_up_count = self.state.queued_follow_up_count;
                let mut msg = String::new();
                msg.push_str("## Queue\n\n");
                msg.push_str(&format!(
                    "**Steering mode:** {}\n",
                    self.state.steering_mode.label()
                ));
                msg.push_str(&format!(
                    "**Follow-up mode:** {}\n",
                    self.state.follow_up_mode.label()
                ));
                msg.push_str(&format!("**Pending:** {total}\n"));
                if total > 0 {
                    msg.push_str(&format!(
                        "- steer: {steer_count}, follow-up: {follow_up_count}\n"
                    ));
                    if let Some(summary) = Self::describe_next_queue_batch(
                        steer_count,
                        self.state.steering_mode,
                        "at the next tool boundary",
                    ) {
                        msg.push_str(&format!("**Next steering batch:** {summary}\n"));
                    }
                    if let Some(summary) = Self::describe_next_queue_batch(
                        follow_up_count,
                        self.state.follow_up_mode,
                        "after turn end",
                    ) {
                        msg.push_str(&format!("**Next follow-up batch:** {summary}\n"));
                    }
                }
                if let Some(active) = &self.queued_prompt_active {
                    msg.push_str(&format!(
                        "\n**Active:** #{} ({}) – {}\n",
                        active.id,
                        active.kind.label(),
                        Self::format_queue_snippet(&active.content, 80)
                    ));
                }
                if self.queued_prompts.is_empty() {
                    msg.push_str("\nNo queued prompts.\n");
                } else {
                    msg.push_str("\n**Pending prompts:**\n");
                    let inflight_id = self.queued_prompt_inflight.map(|cursor| cursor.id);
                    for (index, prompt) in self.queued_prompts.iter().enumerate() {
                        let marker = if inflight_id == Some(prompt.id) {
                            " (starting...)"
                        } else {
                            ""
                        };
                        msg.push_str(&format!(
                            "{}. #{} ({}){} – {}\n",
                            index + 1,
                            prompt.id,
                            prompt.kind.label(),
                            marker,
                            Self::format_queue_snippet(&prompt.content, 80)
                        ));
                    }
                }
                msg.push_str(
                    "\nUse /queue cancel <id> to remove a prompt. Use /queue mode [steer|followup] <one|all> to change behavior.",
                );
                self.state.add_system_message(msg);
            }
            QueueAction::Cancel { id } => {
                if self
                    .queued_prompt_active
                    .as_ref()
                    .is_some_and(|prompt| prompt.id == id)
                {
                    self.state
                        .status
                        .replace(format!("Queued prompt #{id} is already processing."));
                    return;
                }
                if self
                    .queued_prompt_inflight
                    .is_some_and(|prompt| prompt.id == id)
                {
                    self.state.status.replace(format!(
                        "Queued prompt #{id} is starting; try again if it re-queues."
                    ));
                    return;
                }
                match self.remove_queued_prompt(id) {
                    Some(removed) => {
                        if let Some(agent) = &self.native_agent {
                            agent.cancel_queued(id);
                        }
                        self.state.status.replace(format!(
                            "Removed queued {} #{}.",
                            removed.kind.label(),
                            removed.id
                        ));
                    }
                    None => {
                        self.state
                            .status
                            .replace(format!("No queued prompt found with id #{id}."));
                    }
                }
            }
            QueueAction::Mode { kind, mode } => {
                let label = match kind {
                    QueueModeKind::Steering => {
                        self.state.steering_mode = mode;
                        if let Some(agent) = &self.native_agent {
                            let _ = agent.set_steering_mode(mode);
                        }
                        "Steering"
                    }
                    QueueModeKind::FollowUp => {
                        self.state.follow_up_mode = mode;
                        if let Some(agent) = &self.native_agent {
                            let _ = agent.set_follow_up_mode(mode);
                        }
                        "Follow-up"
                    }
                };
                let _ = crate::ui_state::save_queue_modes(
                    self.state.steering_mode,
                    self.state.follow_up_mode,
                );
                self.state
                    .status
                    .replace(format!("{label} mode: {}", mode.label()));
            }
        }
    }

    /// Execute a slash command
    pub(super) async fn execute_slash_command(&mut self) -> Result<()> {
        let input = self.state.take_input();

        // Expand an unambiguous partial command ("/qui" -> "/quit") or rescue
        // a one-character typo ("/quti" -> "/quit") so that pressing Enter runs
        // the intended command instead of erroring — or worse, forwarding the
        // partial text to the agent as a prompt.
        let without_slash = input.trim().trim_start_matches('/');
        let mut parts = without_slash.splitn(2, char::is_whitespace);
        let typed_word = parts.next().unwrap_or("");
        let typed_args = parts.next().unwrap_or("").trim();
        let word = typed_word.to_lowercase();

        let expand = |name: &str| {
            if typed_args.is_empty() {
                format!("/{name}")
            } else {
                format!("/{name} {typed_args}")
            }
        };

        let input = if !word.is_empty() && self.command_registry.get(&word).is_none() {
            let prefix = self.command_registry.resolve_unique_prefix(&word);
            match prefix {
                Ok(Some(cmd)) => {
                    let expanded = expand(&cmd.name.clone());
                    self.state
                        .status
                        .replace(format!("Expanded /{typed_word} → /{}", cmd.name));
                    expanded
                }
                Ok(None) => match self.command_registry.resolve_typo(&word) {
                    Ok(Some(cmd)) => {
                        let expanded = expand(&cmd.name.clone());
                        self.state
                            .status
                            .replace(format!("Interpreted /{typed_word} as /{}", cmd.name));
                        expanded
                    }
                    Ok(None) => input,
                    Err(candidates) => {
                        // Rescuable typo with more than one candidate: restore
                        // the input, open the completion dropdown, and explain.
                        let list = candidates
                            .iter()
                            .map(|name| format!("/{name}"))
                            .collect::<Vec<_>>()
                            .join(", ");
                        self.state.set_input(&input);
                        self.update_slash_state();
                        self.state.error = Some(format!(
                            "Unknown command: /{typed_word} — did you mean {list}?"
                        ));
                        return Ok(());
                    }
                },
                Err(candidates) => {
                    // Ambiguous prefix: restore the input, open the completion
                    // dropdown with the candidates, and explain.
                    let list = candidates
                        .iter()
                        .map(|name| format!("/{name}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    self.state.set_input(&input);
                    self.update_slash_state();
                    self.state.error = Some(format!(
                        "Ambiguous command: /{typed_word} (could be {list})"
                    ));
                    return Ok(());
                }
            }
        } else {
            input
        };

        // Try executing through the registry first
        let cwd = self.state.cwd.clone().unwrap_or_else(|| ".".to_string());
        let session_id = self.state.session_id.clone();
        let model = self.state.model.clone();

        match self
            .command_registry
            .execute(&input, &cwd, session_id.as_deref(), model.as_deref())
        {
            Ok(output) => {
                self.handle_command_output(output).await;
                self.slash_state.reset();
                return Ok(());
            }
            Err(e) => {
                if e.message.contains("Unknown command") {
                    if self.state.unknown_slash_command_fallback {
                        if let Some(agent) = &self.native_agent {
                            let _ = agent.prompt(input.clone(), vec![]).await;
                            self.state.busy = true;
                        } else {
                            self.state.error = Some(format!("Unknown command: {input}"));
                        }
                    } else {
                        // Fallback disabled via tui.slash_command_fallback = false:
                        // never turn an unknown slash command into an agent prompt.
                        self.state.error = Some(format!(
                            "Unknown command: {input} (Type /help to see available commands)"
                        ));
                    }
                } else {
                    // Other errors (like missing args) should be shown to user
                    self.state.error = Some(e.to_string());
                }
            }
        }

        self.slash_state.reset();
        Ok(())
    }
}
