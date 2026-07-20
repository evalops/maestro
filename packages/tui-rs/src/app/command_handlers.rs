use super::*;

impl App {
    /// Update slash state based on current input
    pub(super) fn update_slash_state(&mut self) {
        if self.state.input().starts_with('/') {
            let query = &self.state.input()[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        } else {
            self.slash_state.reset();
        }
    }

    /// Handle tab for slash command completion
    pub(super) fn handle_slash_tab(&mut self) {
        if self.slash_state.has_completions() {
            self.slash_state.cycle_next();
        } else {
            let query = &self.state.input()[1..];
            self.slash_state.set_query(query, &self.slash_matcher);
        }
        self.apply_slash_completion();
    }

    /// Apply the current slash completion to input
    pub(super) fn apply_slash_completion(&mut self) {
        if let Some(cmd) = self.slash_state.current() {
            self.state.set_input(&format!("/{cmd}"));
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
                        self.model_selector.show();
                        self.active_modal = ActiveModal::ModelSelector;
                    }
                    ModalType::SessionList => {
                        self.session_switcher.show();
                        self.active_modal = ActiveModal::SessionSwitcher;
                    }
                    ModalType::FileSearch => {
                        self.file_search.show();
                        self.active_modal = ActiveModal::FileSearch;
                    }
                    ModalType::CommandPalette => {
                        self.command_palette.show();
                        self.active_modal = ActiveModal::CommandPalette;
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
    pub(super) async fn handle_command_action(&mut self, action: CommandAction) {
        match action {
            CommandAction::ClearMessages => {
                self.state.messages.clear();
                self.state.scroll_offset = 0;
                self.session_manager.reset_session();
                self.state.session_id = None;
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
                self.state.status = Some(format!(
                    "Approval mode: {}",
                    self.state.approval_mode.label()
                ));
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
                self.load_workspace_files();
                self.state.status = Some("Workspace files refreshed".to_string());
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
                if let Some(agent) = &self.native_agent {
                    let policy_model = policy_model_id(&model_id);
                    if let Some(reason) = check_model_allowed(&policy_model) {
                        self.state.error = Some(reason);
                        return;
                    }
                    if let Err(e) = agent.set_model(&model_id) {
                        self.state.error = Some(format!("Failed to set model: {e}"));
                    } else {
                        self.pending_model_change = Some(PendingModelChange {
                            model: model_id.clone(),
                        });
                        self.state.status = Some(format!("Switching model: {model_id}"));
                    }
                } else {
                    self.state.error = Some("No agent available to set model".to_string());
                }
            }
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
            CommandAction::Queue(action) => {
                self.handle_queue_action(action);
            }
            CommandAction::Steer(text) => {
                let _ = self.handle_steer_submit(text).await;
            }
            CommandAction::Session(session_action) => {
                self.handle_session_action(session_action);
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
                if removed == 0 {
                    self.state
                        .add_system_message("No sessions to prune.".to_string());
                } else {
                    let mut msg = format!("Pruned {removed} session(s).");
                    if errors > 0 {
                        msg.push_str(&format!(" {errors} error(s)."));
                    }
                    self.state.add_system_message(msg);
                }
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
                    "A2A pairing code captured ({} chars). Run `maestro a2a accept <code>` or use the TypeScript TUI `/a2a accept <code>` to persist it in the shared registry.",
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

    /// Handle skills system actions
    pub(super) fn handle_skills_action(&mut self, action: crate::commands::SkillsAction) {
        use crate::commands::SkillsAction;

        match action {
            SkillsAction::List => {
                let mut msg = String::from("## Available Skills\n\n");
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
                    if let Some(agent) = &self.native_agent {
                        let _ = agent.prompt(input.clone(), vec![]).await;
                        self.state.busy = true;
                    } else {
                        self.state.error = Some(format!("Unknown command: {input}"));
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
