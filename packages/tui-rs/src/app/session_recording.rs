use super::*;

impl App {
    pub(super) fn active_session_count(&self) -> Option<usize> {
        let sessions = self.session_manager.list_all_sessions().ok()?;
        let cutoff = SystemTime::now().checked_sub(Duration::from_hours(1))?;
        let mut count = 0usize;
        for session in sessions {
            if let Some(modified) = session.modified {
                if modified >= cutoff {
                    count += 1;
                }
            }
        }
        Some(count)
    }

    pub(super) fn ensure_session_started(&mut self) -> Result<()> {
        if self.session_resume_failed {
            self.state.error =
                Some("Session resume failed; use /new to start a new session.".to_string());
            bail!("Session resume failed");
        }

        if self.session_manager.writer().is_some() {
            return Ok(());
        }

        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string());
        let session_id = uuid::Uuid::new_v4().to_string();
        let model = if !self.current_model.is_empty() {
            self.current_model.clone()
        } else {
            self.state
                .model
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        };
        if self.current_model.is_empty() {
            self.current_model = model.clone();
        }
        let policy_model = policy_model_id(&model);
        if let Some(reason) = check_model_allowed(&policy_model) {
            self.state.error = Some(reason.clone());
            bail!(reason);
        }
        let tools = ToolRegistry::new()
            .tools()
            .map(|tool| ToolInfo {
                name: tool.tool.name.clone(),
                label: None,
                description: Some(tool.tool.description.clone()),
            })
            .collect::<Vec<_>>();

        let header = SessionHeader {
            version: Some(2),
            id: session_id.clone(),
            timestamp: Utc::now().to_rfc3339(),
            cwd,
            model: policy_model,
            subject: None,
            model_metadata: None,
            thinking_level: self.current_thinking_level,
            system_prompt: None,
            prompt_metadata: None,
            prompt_context_manifest: None,
            unified_context_manifest: None,
            tools,
            branched_from: None,
            parent_session: None,
        };

        self.session_manager
            .start_session(header)
            .context("Failed to start session")?;
        let _ = self.session_manager.flush();

        self.state.session_id = Some(session_id.clone());
        self.session_started_at = SystemTime::now();
        self.session_resume_failed = false;
        self.usage_tracker = crate::usage::UsageTracker::with_session(session_id.clone());
        self.usage_tracker.set_model(self.current_model.clone());

        if let Some(agent) = &self.native_agent {
            agent.send_session_info(
                &std::env::current_dir()
                    .map_or_else(|_| ".".to_string(), |p| p.to_string_lossy().to_string()),
                Some(session_id),
                self.current_git_branch.clone(),
            );
        }

        Ok(())
    }

    pub(super) fn write_session_entry(&mut self, entry: SessionEntry) {
        let error = {
            let Some(writer) = self.session_manager.writer() else {
                return;
            };
            writer.write_entry(entry).err()
        };
        if let Some(err) = error {
            self.state.error = Some(format!("Failed to write session entry: {err}"));
        }
    }

    pub(super) fn record_user_message(&mut self, content: &str) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let entry = SessionEntry::Message(MessageEntry {
            id: None,
            parent_id: None,
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::User {
                content: MessageContent::Text(content.to_string()),
                attachments: None,
                timestamp: system_time_to_millis(SystemTime::now()),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    pub(super) fn record_assistant_message(
        &mut self,
        response_id: &str,
        usage: Option<crate::agent::TokenUsage>,
    ) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let Some(message) = self
            .state
            .messages
            .iter()
            .find(|m| m.id == response_id && m.role == MessageRole::Assistant)
            .cloned()
        else {
            return;
        };

        let mut blocks = Vec::new();
        if !message.thinking.is_empty() {
            blocks.push(SessionContentBlock::Thinking {
                text: message.thinking.clone(),
                signature: None,
            });
        }
        if !message.content.is_empty() {
            blocks.push(SessionContentBlock::Text {
                text: message.content.clone(),
            });
        }
        for call in &message.tool_calls {
            blocks.push(SessionContentBlock::ToolCall {
                id: call.call_id.clone(),
                name: call.tool.clone(),
                args: call.args.clone(),
            });
        }

        let usage = usage
            .as_ref()
            .map(to_session_usage)
            .or_else(|| message.usage.as_ref().map(to_session_usage));

        let entry = SessionEntry::Message(MessageEntry {
            id: None,
            parent_id: None,
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::Assistant {
                content: blocks,
                api: self.state.provider.clone(),
                provider: self.state.provider.clone(),
                model: Some(policy_model_id(&self.current_model)),
                usage,
                stop_reason: None,
                timestamp: system_time_to_millis(message.timestamp),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    pub(super) fn record_tool_result(&mut self, call_id: &str, tool: &str, result: &ToolResult) {
        if result.success {
            self.tool_history.complete_with_details(
                call_id,
                result.output.clone(),
                result.details.clone(),
            );
        } else {
            let error = result
                .error
                .clone()
                .unwrap_or_else(|| result.output.clone());
            self.tool_history
                .fail_with_details(call_id, error, result.details.clone());
        }

        if self.ensure_session_started().is_err() {
            return;
        }

        let content = if result.success {
            result.output.clone()
        } else {
            result
                .error
                .clone()
                .unwrap_or_else(|| result.output.clone())
        };

        let entry = SessionEntry::Message(MessageEntry {
            id: None,
            parent_id: None,
            timestamp: Utc::now().to_rfc3339(),
            message: AppMessage::ToolResult {
                tool_call_id: call_id.to_string(),
                tool_name: tool.to_string(),
                content,
                details: result.details.clone(),
                is_error: !result.success,
                timestamp: system_time_to_millis(SystemTime::now()),
            },
        });
        self.write_session_entry(entry);
        let _ = self.session_manager.flush();
    }

    pub(super) fn record_model_change(&mut self, model: &str) {
        if self.session_manager.writer().is_none() {
            return;
        }

        let entry = SessionEntry::ModelChange(ModelChange {
            timestamp: Utc::now().to_rfc3339(),
            model: policy_model_id(model),
            model_metadata: None,
        });
        self.write_session_entry(entry);
    }

    pub(super) fn record_thinking_level_change(&mut self, level: ThinkingLevel) {
        if self.session_manager.writer().is_none() {
            return;
        }

        let entry = SessionEntry::ThinkingLevelChange(ThinkingLevelChange {
            timestamp: Utc::now().to_rfc3339(),
            thinking_level: level,
        });
        self.write_session_entry(entry);
    }

    pub(super) fn record_compaction_entry(
        &mut self,
        summary: String,
        first_kept_entry_index: usize,
        tokens_before: u64,
        auto: bool,
        custom_instructions: Option<String>,
    ) {
        if self.ensure_session_started().is_err() {
            return;
        }

        let entry = SessionEntry::Compaction(CompactionEntry {
            id: None,
            parent_id: None,
            timestamp: Utc::now().to_rfc3339(),
            summary,
            first_kept_entry_id: None,
            first_kept_entry_index: Some(first_kept_entry_index),
            tokens_before,
            auto,
            custom_instructions,
        });
        self.write_session_entry(entry);
    }

    pub(super) fn hydrate_usage_from_session(&mut self, session: &ParsedSession) {
        self.usage_tracker = crate::usage::UsageTracker::with_session(session.id());
        self.usage_tracker.set_model(session.header.model.clone());

        for entry in &session.usage_entries {
            let usage = crate::headless::TokenUsage {
                input_tokens: entry.usage.input,
                output_tokens: entry.usage.output,
                cache_read_tokens: entry.usage.cache_read,
                cache_write_tokens: entry.usage.cache_write,
                cost: entry.usage.cost.as_ref().map(|c| c.total),
                total_tokens: None,
                model_id: None,
                provider: None,
            };
            let _ = self.usage_tracker.add_turn_for_model(&entry.model, &usage);
        }
    }
}
