use super::*;

pub(crate) fn is_chat_endpoint(head: &RequestHead) -> bool {
    head.method == "POST" && head.path == "/api/chat"
}

pub(crate) fn is_chat_websocket_endpoint(head: &RequestHead) -> bool {
    head.method == "GET" && head.path == "/api/chat/ws"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    pub(crate) model: Option<String>,
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: Value,
    #[serde(default)]
    pub(crate) attachments: Vec<ChatAttachment>,
    #[serde(default, flatten)]
    pub(crate) extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatAttachment {
    pub(crate) id: Option<String>,
    #[serde(rename = "type")]
    pub(crate) attachment_type: Option<String>,
    pub(crate) file_name: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) content_omitted: Option<bool>,
    pub(crate) extracted_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractAttachmentRequest {
    pub(crate) file_name: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) content_base64: String,
    pub(crate) max_chars: Option<usize>,
}

pub(crate) struct ExtractDocumentOutput {
    pub(crate) file_name: String,
    pub(crate) format: String,
    pub(crate) extractor: String,
    pub(crate) size_bytes: usize,
    pub(crate) truncated: bool,
    pub(crate) extracted_text: String,
}

pub(crate) struct PreparedAttachments {
    pub(crate) paths: Vec<String>,
    pub(crate) temp_dir: Option<PathBuf>,
}

impl Drop for PreparedAttachments {
    fn drop(&mut self) {
        if let Some(temp_dir) = self.temp_dir.take() {
            let _ = std::fs::remove_dir_all(temp_dir);
        }
    }
}

async fn selected_chat_model(chat: &ChatRequest, state: &AppState) -> String {
    if let Some(model) = chat
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        return model.to_string();
    }
    let selected = state.selected_model.lock().await;
    format!("{}/{}", selected.provider, selected.id)
}

async fn handle_codex_app_server_chat(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<(), String> {
    handle_codex_app_server_chat_transport(
        stream,
        state,
        session_id,
        model,
        prompt,
        attachment_paths,
        CodexBridgeTransport::Sse,
    )
    .await
}

pub(crate) async fn handle_codex_app_server_chat_transport(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
    transport: CodexBridgeTransport,
) -> Result<(), String> {
    let session_approval_mode = approval_mode_for_session(state, session_id).await;
    let approval_mode = codex_app_server_approval_mode(&session_approval_mode);
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "agent_start" }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "turn_start" }),
    )
    .await?;
    let message = composer_assistant_message("", "", None);
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "message_start", "message": message }),
    )
    .await?;

    let assistant_output_result = if approval_mode == "prompt" {
        run_codex_app_server_headless_cli(
            stream,
            transport,
            state,
            session_id,
            &state.config.cwd,
            model,
            prompt,
            attachment_paths,
        )
        .await
    } else {
        run_codex_app_server_cli(
            &state.config.cwd,
            model,
            approval_mode,
            prompt,
            attachment_paths,
        )
        .await
    };
    let assistant_output = match assistant_output_result {
        Ok(output) => output,
        Err(error) => {
            send_codex_bridge_event(
                stream,
                transport,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_codex_bridge_event(stream, transport, &serde_json::json!({ "type": "done" }))
                .await?;
            return Ok(());
        }
    };
    for tool_event in &assistant_output.tool_events {
        send_codex_bridge_tool_event(stream, transport, tool_event).await?;
    }

    let message =
        composer_assistant_message(&assistant_output.text, "", assistant_output.usage.clone());
    if !assistant_output.text.is_empty() {
        send_codex_bridge_event(
            stream,
            transport,
            &serde_json::json!({
                "type": "message_update",
                "message": message,
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": assistant_output.text
                }
            }),
        )
        .await?;
    }
    record_chat_assistant_message(state, session_id, message.clone()).await;
    record_usage_entry(
        state,
        session_id,
        "openai-codex",
        model,
        assistant_output.usage.as_ref(),
    )
    .await;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({ "type": "message_end", "message": message }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({
            "type": "turn_end",
            "message": message,
            "toolResults": []
        }),
    )
    .await?;
    send_codex_bridge_event(
        stream,
        transport,
        &serde_json::json!({
            "type": "agent_end",
            "messages": [message],
            "stopReason": "stop"
        }),
    )
    .await?;
    send_codex_bridge_event(stream, transport, &serde_json::json!({ "type": "done" })).await?;
    Ok(())
}

async fn handle_codex_app_server_chat_ws(
    stream: &mut TcpStream,
    state: &AppState,
    session_id: Option<&str>,
    model: &str,
    prompt: &str,
    attachment_paths: &[String],
) -> Result<(), String> {
    handle_codex_app_server_chat_transport(
        stream,
        state,
        session_id,
        model,
        prompt,
        attachment_paths,
        CodexBridgeTransport::WebSocket,
    )
    .await
}

pub(crate) async fn record_chat_user_message(
    state: &AppState,
    chat: &ChatRequest,
    auth: &AuthContext,
) -> Result<(), String> {
    let Some(session_id) = chat.session_id.as_deref() else {
        return Ok(());
    };
    let Some(latest) = chat.messages.last() else {
        return Ok(());
    };
    let mut message = chat_message_prompt_value(latest);
    if let Value::Object(object) = &mut message {
        object.insert("timestamp".to_string(), Value::String(now_rfc3339()));
    }
    if !latest.attachments.is_empty() {
        message["attachments"] = serde_json::json!(latest.attachments);
    }
    append_session_message(
        state,
        session_id,
        message,
        Some(&latest.content),
        auth.subject.clone(),
        Some(auth),
    )
    .await
}

async fn record_chat_assistant_message(state: &AppState, session_id: Option<&str>, message: Value) {
    let Some(session_id) = session_id else {
        return;
    };
    let _ = append_session_message(state, session_id, message, None, None, None).await;
}

async fn append_session_message(
    state: &AppState,
    session_id: &str,
    message: Value,
    title_source: Option<&Value>,
    owner: Option<String>,
    auth: Option<&AuthContext>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = if sessions.sessions.contains_key(session_id) {
        let session = sessions
            .sessions
            .get_mut(session_id)
            .expect("session existence checked");
        if auth.is_some_and(|auth| !session_visible_to_auth(session, auth)) {
            return Err("Session not found".to_string());
        }
        session
    } else {
        sessions
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let mut session =
                    create_session_record(title_source.and_then(title_from_content), owner);
                session.id = session_id.to_string();
                session
            })
    };
    if session.message_count == 0 {
        if let Some(title) = title_source.and_then(title_from_content) {
            session.title = title;
        }
    }
    session.messages.push(message);
    session.message_count = session.messages.len() as u64;
    session.updated_at = now_rfc3339();
    drop(sessions);
    persist_session_store(state).await;
    Ok(())
}

fn title_from_content(content: &Value) -> Option<String> {
    let text = composer_text_content(content);
    let title = text
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ");
    normalize_title(Some(title)).map(|title| title.chars().take(80).collect())
}

pub(crate) async fn handle_chat_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    let Some(auth) = auth_context(&head, &state.config) else {
        let response = json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if let Err(response) = validate_csrf(&head, &state.config) {
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let body = match read_request_body(&mut stream, &mut initial, &head).await {
        Ok(body) => body,
        Err(error) => {
            stream
                .write_all(&json_response(400, &serde_json::json!({ "error": error })))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    let chat = match serde_json::from_slice::<ChatRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            stream
                .write_all(&json_response(
                    400,
                    &serde_json::json!({ "error": format!("invalid chat request: {error}") }),
                ))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };

    let Some(latest) = chat.messages.last() else {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "No messages supplied" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if latest.role != "user" {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "Last message must be a user message" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    if !chat_message_has_input(latest) {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "User message cannot be empty" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let prompt = build_prompt_from_chat(&chat);

    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat, &state.config.cwd).await {
        Ok(attachments) => attachments,
        Err(error) => {
            stream
                .write_all(&json_response(400, &serde_json::json!({ "error": error })))
                .await
                .map_err(|error| error.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    if let Err(error) = record_chat_user_message(&state, &chat, &auth).await {
        cleanup_prepared_attachments(prepared_attachments).await;
        stream
            .write_all(&json_response(404, &serde_json::json!({ "error": error })))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    stream
        .write_all(sse_headers().as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let model = selected_chat_model(&chat, &state).await;
    if let Some(codex_model) = codex_app_server_model_id(&model) {
        if let Some(session_id) = session_id.as_deref() {
            send_sse(
                &mut stream,
                &serde_json::json!({
                    "type": "status",
                    "status": "session",
                    "details": { "sessionId": session_id, "runtime": "rust-codex-app-server" }
                }),
            )
            .await?;
        }
        handle_codex_app_server_chat(
            &mut stream,
            &state,
            session_id.as_deref(),
            &codex_model,
            &prompt,
            &prepared_attachments.paths,
        )
        .await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }
    let (usage_provider, usage_model) = usage_provider_model(&chat, &state, &model).await;
    let thinking_enabled = chat
        .thinking_level
        .as_deref()
        .map(|level| !matches!(level, "off" | "none" | "disabled"))
        .unwrap_or(false);
    let config = NativeAgentConfig {
        model,
        cwd: state.config.cwd.to_string_lossy().to_string(),
        thinking_enabled,
        thinking_budget: env::var("MAESTRO_THINKING_BUDGET")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        ..NativeAgentConfig::default()
    };

    let (agent, mut events) = match NativeAgent::new(config) {
        Ok(agent) => agent,
        Err(error) => {
            send_sse(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error.to_string() }),
            )
            .await?;
            send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            let _ = stream.shutdown().await;
            cleanup_prepared_attachments(prepared_attachments).await;
            return Ok(());
        }
    };

    if let Some(session_id) = session_id.as_deref() {
        send_sse(
            &mut stream,
            &serde_json::json!({
                "type": "status",
                "status": "session",
                "details": { "sessionId": session_id, "runtime": "rust" }
            }),
        )
        .await?;
    }
    send_sse(&mut stream, &serde_json::json!({ "type": "agent_start" })).await?;
    send_sse(&mut stream, &serde_json::json!({ "type": "turn_start" })).await?;

    let prompt_result = agent
        .prompt(prompt, prepared_attachments.paths.clone())
        .await;
    if let Err(error) = prompt_result {
        send_sse(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error.to_string() }),
        )
        .await?;
        send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }

    let mut assistant_text = String::new();
    let mut thinking_text = String::new();
    let mut response_started = false;
    let mut thinking_started = false;
    let mut terminal_sent = false;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut assistant_tools: Vec<Value> = Vec::new();

    while let Some(event) = events.recv().await {
        match event {
            FromAgent::Ready { .. }
            | FromAgent::ModelChanged { .. }
            | FromAgent::ModelChangeFailed { .. }
            | FromAgent::SessionInfo { .. } => {}
            FromAgent::ResponseStart { .. } => {
                response_started = true;
                let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "message_start", "message": message }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "message_update",
                        "message": message,
                        "assistantMessageEvent": {
                            "type": "start",
                            "partial": message
                        }
                    }),
                )
                .await?;
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if !response_started {
                    response_started = true;
                    let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({ "type": "message_start", "message": message }),
                    )
                    .await?;
                }
                if is_thinking {
                    if !thinking_started {
                        thinking_started = true;
                        let message =
                            composer_assistant_message(&assistant_text, &thinking_text, None);
                        send_sse(
                            &mut stream,
                            &serde_json::json!({
                                "type": "message_update",
                                "message": message,
                                "assistantMessageEvent": {
                                    "type": "thinking_start",
                                    "contentIndex": 0,
                                    "partial": message
                                }
                            }),
                        )
                        .await?;
                    }
                    thinking_text.push_str(&content);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "thinking_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                } else {
                    assistant_text.push_str(&content);
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                tool_names.insert(call_id.clone(), tool.clone());
                record_tool_call_metadata(&mut assistant_tools, &call_id, &tool, args.clone());
                if requires_approval {
                    match approval_mode_for_session(&state, session_id.as_deref())
                        .await
                        .as_str()
                    {
                        "auto" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), true, None));
                            send_sse(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "tool_execution_start",
                                    "toolCallId": call_id,
                                }),
                            )
                            .await?;
                        }
                        "fail" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), false, None));
                            finish_tool_metadata(&mut assistant_tools, &call_id, false);
                            send_sse(&mut stream, &approval_blocked_tool_event(&call_id, &tool))
                                .await?;
                        }
                        _ => {
                            state
                                .pending_tool_responses
                                .lock()
                                .await
                                .insert(call_id.clone(), agent.tool_response_sender());
                            send_sse(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "action_approval_required",
                                    "request": {
                                        "id": call_id,
                                        "toolName": tool,
                                        "args": args,
                                        "reason": "Tool execution requires approval"
                                    }
                                }),
                            )
                            .await?;
                        }
                    }
                } else {
                    send_sse(
                        &mut stream,
                        &serde_json::json!({
                            "type": "tool_execution_start",
                            "toolCallId": call_id,
                            "toolName": tool,
                            "args": args
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolStart { call_id } => {
                update_tool_metadata_status(&mut assistant_tools, &call_id, "running");
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {}
                    }),
                )
                .await?;
            }
            FromAgent::ToolOutput { call_id, content } => {
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_update",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {},
                        "partialResult": content
                    }),
                )
                .await?;
            }
            FromAgent::ToolEnd { call_id, success } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, success);
                let tool = tool_names
                    .remove(&call_id)
                    .unwrap_or_else(|| "tool".to_string());
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": { "success": success },
                        "isError": !success
                    }),
                )
                .await?;
            }
            FromAgent::BatchStart { total } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": "tool_batch_start",
                        "details": { "total": total }
                    }),
                )
                .await?;
            }
            FromAgent::BatchEnd {
                total,
                successes,
                failures,
            } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_batch_summary",
                        "summary": format!("{successes}/{total} tools succeeded"),
                        "summaryLabels": [],
                        "toolCallIds": [],
                        "toolNames": [],
                        "callsSucceeded": successes,
                        "callsFailed": failures
                    }),
                )
                .await?;
            }
            FromAgent::Error { message, .. } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "error", "message": message }),
                )
                .await?;
            }
            FromAgent::Status { message } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": message,
                        "details": {}
                    }),
                )
                .await?;
            }
            FromAgent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => {
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "compaction",
                        "summary": summary,
                        "firstKeptEntryIndex": first_kept_entry_index,
                        "tokensBefore": tokens_before,
                        "auto": auto,
                        "customInstructions": custom_instructions,
                        "timestamp": timestamp
                    }),
                )
                .await?;
            }
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, false);
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": reason,
                        "isError": true
                    }),
                )
                .await?;
            }
            FromAgent::ResponseEnd { usage, .. } => {
                record_usage_entry(
                    &state,
                    session_id.as_deref(),
                    &usage_provider,
                    &usage_model,
                    usage.as_ref(),
                )
                .await;
                let message = composer_assistant_message_with_tools(
                    &assistant_text,
                    &thinking_text,
                    usage,
                    &assistant_tools,
                );
                record_chat_assistant_message(&state, session_id.as_deref(), message.clone()).await;
                send_sse(
                    &mut stream,
                    &serde_json::json!({ "type": "message_end", "message": message }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "turn_end",
                        "message": message,
                        "toolResults": []
                    }),
                )
                .await?;
                send_sse(
                    &mut stream,
                    &serde_json::json!({
                        "type": "agent_end",
                        "messages": [message],
                        "stopReason": "stop"
                    }),
                )
                .await?;
                send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
                terminal_sent = true;
                break;
            }
        }
    }

    if !terminal_sent {
        send_sse(
            &mut stream,
            &serde_json::json!({
                "type": "error",
                "message": "Agent stream closed before response completed"
            }),
        )
        .await?;
        send_sse(&mut stream, &serde_json::json!({ "type": "done" })).await?;
    }

    let _ = stream.shutdown().await;
    cleanup_prepared_attachments(prepared_attachments).await;
    Ok(())
}

pub(crate) async fn handle_chat_websocket_endpoint(
    mut stream: TcpStream,
    mut initial: Vec<u8>,
    head: RequestHead,
    state: AppState,
) -> Result<(), String> {
    let Some(auth) = auth_context(&head, &state.config) else {
        let response = json_response(401, &serde_json::json!({ "error": "Unauthorized" }));
        stream
            .write_all(&response)
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };

    if !origin_allowed(&head) {
        stream
            .write_all(&json_response(
                403,
                &serde_json::json!({ "error": "WebSocket origin is not allowed" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let Some(key) = head.headers.get("sec-websocket-key") else {
        stream
            .write_all(&json_response(
                400,
                &serde_json::json!({ "error": "Missing Sec-WebSocket-Key" }),
            ))
            .await
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    let accept_key = websocket_accept_key(key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept_key}\r\n\
         \r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let body_start = header_end(&initial)? + 4;
    let mut websocket_buffer = initial.split_off(body_start);
    let request_body = match read_websocket_text_message(&mut stream, &mut websocket_buffer).await {
        Ok(body) => body,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    let chat = match serde_json::from_slice::<ChatRequest>(&request_body) {
        Ok(request) => request,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": format!("invalid chat request: {error}") }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };

    let Some(latest) = chat.messages.last() else {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "No messages supplied" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    };
    if latest.role != "user" {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "Last message must be a user message" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    if !chat_message_has_input(latest) {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": "User message cannot be empty" }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let prompt = build_prompt_from_chat(&chat);

    let session_id = chat.session_id.clone();
    let prepared_attachments = match prepare_chat_attachments(&chat, &state.config.cwd).await {
        Ok(attachments) => attachments,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    };
    if let Err(error) = record_chat_user_message(&state, &chat, &auth).await {
        cleanup_prepared_attachments(prepared_attachments).await;
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let model = selected_chat_model(&chat, &state).await;
    if let Some(codex_model) = codex_app_server_model_id(&model) {
        if let Some(session_id) = session_id.as_deref() {
            send_ws_json(
                &mut stream,
                &serde_json::json!({
                    "type": "status",
                    "status": "session",
                    "details": { "sessionId": session_id, "runtime": "rust-codex-app-server" }
                }),
            )
            .await?;
        }
        handle_codex_app_server_chat_ws(
            &mut stream,
            &state,
            session_id.as_deref(),
            &codex_model,
            &prompt,
            &prepared_attachments.paths,
        )
        .await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }
    let (usage_provider, usage_model) = usage_provider_model(&chat, &state, &model).await;
    let thinking_enabled = chat
        .thinking_level
        .as_deref()
        .map(|level| !matches!(level, "off" | "none" | "disabled"))
        .unwrap_or(false);
    let config = NativeAgentConfig {
        model,
        cwd: state.config.cwd.to_string_lossy().to_string(),
        thinking_enabled,
        thinking_budget: env::var("MAESTRO_THINKING_BUDGET")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        ..NativeAgentConfig::default()
    };

    let (agent, mut events) = match NativeAgent::new(config) {
        Ok(agent) => agent,
        Err(error) => {
            send_ws_json(
                &mut stream,
                &serde_json::json!({ "type": "error", "message": error.to_string() }),
            )
            .await?;
            send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
            send_ws_close(&mut stream).await?;
            let _ = stream.shutdown().await;
            cleanup_prepared_attachments(prepared_attachments).await;
            return Ok(());
        }
    };

    send_ws_json(&mut stream, &serde_json::json!({ "type": "agent_start" })).await?;
    send_ws_json(&mut stream, &serde_json::json!({ "type": "turn_start" })).await?;

    if let Err(error) = agent
        .prompt(prompt, prepared_attachments.paths.clone())
        .await
    {
        send_ws_json(
            &mut stream,
            &serde_json::json!({ "type": "error", "message": error.to_string() }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
        send_ws_close(&mut stream).await?;
        let _ = stream.shutdown().await;
        cleanup_prepared_attachments(prepared_attachments).await;
        return Ok(());
    }

    let mut assistant_text = String::new();
    let mut thinking_text = String::new();
    let mut response_started = false;
    let mut thinking_started = false;
    let mut terminal_sent = false;
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut assistant_tools: Vec<Value> = Vec::new();

    while let Some(event) = events.recv().await {
        match event {
            FromAgent::Ready { .. }
            | FromAgent::ModelChanged { .. }
            | FromAgent::ModelChangeFailed { .. }
            | FromAgent::SessionInfo { .. } => {}
            FromAgent::ResponseStart { .. } => {
                response_started = true;
                let message = composer_assistant_message(&assistant_text, &thinking_text, None);
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "message_update",
                        "message": message,
                        "assistantMessageEvent": { "type": "start", "partial": message }
                    }),
                )
                .await?;
            }
            FromAgent::ResponseChunk {
                content,
                is_thinking,
                ..
            } => {
                if !response_started {
                    response_started = true;
                }
                if is_thinking {
                    if !thinking_started {
                        thinking_started = true;
                        let message =
                            composer_assistant_message(&assistant_text, &thinking_text, None);
                        send_ws_json(
                            &mut stream,
                            &serde_json::json!({
                                "type": "message_update",
                                "message": message,
                                "assistantMessageEvent": {
                                    "type": "thinking_start",
                                    "contentIndex": 0,
                                    "partial": message
                                }
                            }),
                        )
                        .await?;
                    }
                    thinking_text.push_str(&content);
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "thinking_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                } else {
                    assistant_text.push_str(&content);
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "message_update",
                            "message": composer_assistant_message(&assistant_text, &thinking_text, None),
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "contentIndex": 0,
                                "delta": content
                            }
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolCall {
                call_id,
                tool,
                args,
                requires_approval,
            } => {
                tool_names.insert(call_id.clone(), tool.clone());
                record_tool_call_metadata(&mut assistant_tools, &call_id, &tool, args.clone());
                if requires_approval {
                    match approval_mode_for_session(&state, session_id.as_deref())
                        .await
                        .as_str()
                    {
                        "auto" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), true, None));
                            send_ws_json(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "tool_execution_start",
                                    "toolCallId": call_id,
                                }),
                            )
                            .await?;
                        }
                        "fail" => {
                            let _ =
                                agent
                                    .tool_response_sender()
                                    .send((call_id.clone(), false, None));
                            finish_tool_metadata(&mut assistant_tools, &call_id, false);
                            send_ws_json(
                                &mut stream,
                                &approval_blocked_tool_event(&call_id, &tool),
                            )
                            .await?;
                        }
                        _ => {
                            state
                                .pending_tool_responses
                                .lock()
                                .await
                                .insert(call_id.clone(), agent.tool_response_sender());
                            send_ws_json(
                                &mut stream,
                                &serde_json::json!({
                                    "type": "action_approval_required",
                                    "request": {
                                        "id": call_id,
                                        "toolName": tool,
                                        "args": args,
                                        "reason": "Tool execution requires approval"
                                    }
                                }),
                            )
                            .await?;
                        }
                    }
                } else {
                    send_ws_json(
                        &mut stream,
                        &serde_json::json!({
                            "type": "tool_execution_start",
                            "toolCallId": call_id,
                            "toolName": tool,
                            "args": args
                        }),
                    )
                    .await?;
                }
            }
            FromAgent::ToolStart { call_id } => {
                update_tool_metadata_status(&mut assistant_tools, &call_id, "running");
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {}
                    }),
                )
                .await?;
            }
            FromAgent::ToolOutput { call_id, content } => {
                let tool = tool_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_update",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "args": {},
                        "partialResult": content
                    }),
                )
                .await?;
            }
            FromAgent::ToolEnd { call_id, success } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, success);
                let tool = tool_names
                    .remove(&call_id)
                    .unwrap_or_else(|| "tool".to_string());
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": { "success": success },
                        "isError": !success
                    }),
                )
                .await?;
            }
            FromAgent::BatchStart { total } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": "tool_batch_start",
                        "details": { "total": total }
                    }),
                )
                .await?;
            }
            FromAgent::BatchEnd {
                total,
                successes,
                failures,
            } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_batch_summary",
                        "summary": format!("{successes}/{total} tools succeeded"),
                        "summaryLabels": [],
                        "toolCallIds": [],
                        "toolNames": [],
                        "callsSucceeded": successes,
                        "callsFailed": failures
                    }),
                )
                .await?;
            }
            FromAgent::Error { message, .. } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({ "type": "error", "message": message }),
                )
                .await?;
            }
            FromAgent::Status { message } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "status",
                        "status": message,
                        "details": {}
                    }),
                )
                .await?;
            }
            FromAgent::Compaction {
                summary,
                first_kept_entry_index,
                tokens_before,
                auto,
                custom_instructions,
                timestamp,
            } => {
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "compaction",
                        "summary": summary,
                        "firstKeptEntryIndex": first_kept_entry_index,
                        "tokensBefore": tokens_before,
                        "auto": auto,
                        "customInstructions": custom_instructions,
                        "timestamp": timestamp
                    }),
                )
                .await?;
            }
            FromAgent::HookBlocked {
                call_id,
                tool,
                reason,
            } => {
                state.pending_tool_responses.lock().await.remove(&call_id);
                finish_tool_metadata(&mut assistant_tools, &call_id, false);
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": tool,
                        "result": reason,
                        "isError": true
                    }),
                )
                .await?;
            }
            FromAgent::ResponseEnd { usage, .. } => {
                record_usage_entry(
                    &state,
                    session_id.as_deref(),
                    &usage_provider,
                    &usage_model,
                    usage.as_ref(),
                )
                .await;
                let message = composer_assistant_message_with_tools(
                    &assistant_text,
                    &thinking_text,
                    usage,
                    &assistant_tools,
                );
                record_chat_assistant_message(&state, session_id.as_deref(), message.clone()).await;
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({ "type": "message_end", "message": message }),
                )
                .await?;
                send_ws_json(
                    &mut stream,
                    &serde_json::json!({
                        "type": "agent_end",
                        "messages": [message],
                        "stopReason": "stop"
                    }),
                )
                .await?;
                send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
                terminal_sent = true;
                break;
            }
        }
    }

    if !terminal_sent {
        send_ws_json(
            &mut stream,
            &serde_json::json!({
                "type": "error",
                "message": "Agent stream closed before response completed"
            }),
        )
        .await?;
        send_ws_json(&mut stream, &serde_json::json!({ "type": "done" })).await?;
    }

    send_ws_close(&mut stream).await?;
    let _ = stream.shutdown().await;
    cleanup_prepared_attachments(prepared_attachments).await;
    Ok(())
}

pub(crate) async fn prepare_chat_attachments(
    chat: &ChatRequest,
    cwd: &Path,
) -> Result<PreparedAttachments, String> {
    let Some(latest) = chat.messages.last() else {
        return Ok(PreparedAttachments {
            paths: Vec::new(),
            temp_dir: None,
        });
    };
    let mut temp_dir: Option<PathBuf> = None;
    let mut paths = Vec::new();

    for (index, attachment) in latest.attachments.iter().enumerate() {
        let Some(content) = attachment
            .content
            .as_deref()
            .map(str::trim)
            .filter(|content| !content.is_empty())
        else {
            continue;
        };
        let encoded = strip_data_url_prefix(content);
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| {
            format!(
                "attachment {} content is not valid base64: {error}",
                attachment.file_name.as_deref().unwrap_or("attachment")
            )
        })?;

        if temp_dir.is_none() {
            let dir = chat_attachment_temp_dir(cwd);
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|error| format!("failed to create attachment temp directory: {error}"))?;
            temp_dir = Some(dir);
        }
        let file_name =
            sanitize_attachment_file_name(attachment.file_name.as_deref().unwrap_or("attachment"));
        let path = temp_dir
            .as_ref()
            .expect("attachment temp dir should be initialized")
            .join(format!("{index}-{file_name}"));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|error| format!("failed to write attachment {file_name}: {error}"))?;
        paths.push(path.to_string_lossy().to_string());
    }

    Ok(PreparedAttachments { paths, temp_dir })
}

pub(crate) fn strip_data_url_prefix(content: &str) -> &str {
    content
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:"))
        .map(|(_, data)| data.trim())
        .unwrap_or(content)
}

fn chat_attachment_temp_dir(cwd: &Path) -> PathBuf {
    sandbox_visible_temp_dir(cwd, "maestro-chat", &ATTACHMENT_TEMP_COUNTER)
}

fn sanitize_attachment_file_name(name: &str) -> String {
    let leaf = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment")
        .trim();
    let sanitized: String = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('_');
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.chars().take(120).collect()
    }
}

async fn cleanup_prepared_attachments(mut attachments: PreparedAttachments) {
    if let Some(temp_dir) = attachments.temp_dir.take() {
        let _ = tokio::fs::remove_dir_all(temp_dir).await;
    }
}

pub(crate) fn build_prompt_from_chat(chat: &ChatRequest) -> String {
    let mut parts = Vec::new();
    if chat.messages.len() > 1 {
        let history: Vec<Value> = chat.messages[..chat.messages.len() - 1]
            .iter()
            .map(chat_message_prompt_value)
            .collect();
        let rendered =
            serde_json::to_string_pretty(&history).expect("chat history should serialize");
        parts.push(format!(
            "Conversation so far (structured JSON, preserving content blocks and tool metadata):\n{rendered}"
        ));
        parts.push("Current user message:".to_string());
    }

    if let Some(latest) = chat.messages.last() {
        let rendered = serde_json::to_string_pretty(&chat_message_prompt_value(latest))
            .expect("chat message should serialize");
        parts.push(rendered);
        let attachment_notes: Vec<String> =
            latest.attachments.iter().map(attachment_note).collect();
        if !attachment_notes.is_empty() {
            parts.push(attachment_notes.join("\n\n"));
        }
    }

    parts.join("\n\n")
}

pub(crate) fn chat_message_prompt_value(message: &ChatMessage) -> Value {
    let mut object = Map::new();
    object.insert("role".to_string(), Value::String(message.role.clone()));
    object.insert("content".to_string(), message.content.clone());
    if !message.attachments.is_empty() {
        object.insert(
            "attachments".to_string(),
            serde_json::json!(message.attachments),
        );
    }
    for (key, value) in &message.extra {
        object.insert(key.clone(), value.clone());
    }
    Value::Object(object)
}

pub(crate) fn chat_message_has_input(message: &ChatMessage) -> bool {
    !composer_text_content(&message.content).trim().is_empty() || !message.attachments.is_empty()
}

fn attachment_note(attachment: &ChatAttachment) -> String {
    let name = attachment.file_name.as_deref().unwrap_or("attachment");
    if let Some(text) = attachment
        .extracted_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return format!("Attachment {name}:\n{text}");
    }

    let mime = attachment
        .mime_type
        .as_deref()
        .filter(|mime| !mime.trim().is_empty())
        .unwrap_or("unknown type");
    let kind = attachment
        .attachment_type
        .as_deref()
        .filter(|kind| !kind.trim().is_empty())
        .unwrap_or("file");
    let id = attachment
        .id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| format!(" id={id}"))
        .unwrap_or_default();
    if attachment
        .content
        .as_deref()
        .is_some_and(|content| !content.trim().is_empty())
    {
        format!("Attachment {name}{id} ({kind}, {mime}) is attached for model input.")
    } else if attachment.content_omitted.unwrap_or(false) {
        format!(
            "Attachment {name}{id} ({kind}, {mime}) was referenced, but its content was omitted."
        )
    } else {
        format!("Attachment {name}{id} ({kind}, {mime}) was referenced.")
    }
}

pub(crate) fn composer_text_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| {
                if let Some(object) = block.as_object() {
                    if object.get("type").and_then(Value::as_str) == Some("text") {
                        return object
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                    }
                }
                block.to_string()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn composer_assistant_message(
    content: &str,
    thinking: &str,
    usage: Option<TokenUsage>,
) -> Value {
    composer_assistant_message_with_tools(content, thinking, usage, &[])
}

pub(crate) fn composer_assistant_message_with_tools(
    content: &str,
    thinking: &str,
    usage: Option<TokenUsage>,
    tools: &[Value],
) -> Value {
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": content,
        "timestamp": now_rfc3339()
    });
    if !thinking.is_empty() {
        message["thinking"] = Value::String(thinking.to_string());
    }
    if let Some(usage) = usage {
        message["usage"] = serde_json::json!({
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cacheRead": usage.cache_read_tokens,
            "cacheWrite": usage.cache_write_tokens,
            "cost": {
                "input": 0.0,
                "output": 0.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": usage.cost.unwrap_or(0.0)
            }
        });
    }
    if !tools.is_empty() {
        message["tools"] = Value::Array(tools.to_vec());
    }
    message
}

pub(crate) fn record_tool_call_metadata(
    tools: &mut Vec<Value>,
    call_id: &str,
    name: &str,
    args: Value,
) {
    tools.push(serde_json::json!({
        "id": call_id,
        "name": name,
        "args": args,
        "status": "pending"
    }));
}

pub(crate) fn update_tool_metadata_status(tools: &mut [Value], call_id: &str, status: &str) {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.get("id").and_then(Value::as_str) == Some(call_id))
    {
        tool["status"] = Value::String(status.to_string());
    }
}

pub(crate) fn finish_tool_metadata(tools: &mut [Value], call_id: &str, success: bool) {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.get("id").and_then(Value::as_str) == Some(call_id))
    {
        tool["status"] = Value::String(if success { "completed" } else { "error" }.to_string());
        tool["result"] = serde_json::json!({
            "success": success,
            "isError": !success
        });
    }
}

pub(crate) fn approval_blocked_tool_event(call_id: &str, tool_name: &str) -> Value {
    serde_json::json!({
        "type": "tool_execution_end",
        "toolCallId": call_id,
        "toolName": tool_name,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": "Tool execution blocked by approval mode"
                }
            ],
            "isError": true,
            "timestamp": now_rfc3339()
        },
        "isError": true
    })
}

pub(crate) async fn send_sse(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("data: {body}\n\n").as_bytes())
        .await
        .map_err(|error| error.to_string())
}

pub(crate) fn websocket_accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    BASE64_STANDARD.encode(hasher.finalize())
}

pub(crate) async fn send_ws_json(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_ws_text_frame(stream, &body).await
}

async fn write_ws_text_frame(stream: &mut TcpStream, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x81);
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    stream
        .write_all(&frame)
        .await
        .map_err(|error| error.to_string())
}

async fn send_ws_close(stream: &mut TcpStream) -> Result<(), String> {
    stream
        .write_all(&[0x88, 0x00])
        .await
        .map_err(|error| error.to_string())
}

async fn read_websocket_text_message(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> Result<Vec<u8>, String> {
    loop {
        if let Some(message) = try_parse_websocket_text_message(buffer)? {
            return Ok(message);
        }

        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("WebSocket closed before chat request".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_JSON_BODY_BYTES + 14 {
            return Err("WebSocket chat request exceeds maximum allowed size".to_string());
        }
    }
}

pub(crate) fn try_parse_websocket_text_message(
    buffer: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    let mut cursor = 0usize;
    let mut started = false;
    let mut message = Vec::new();

    loop {
        let Some(frame) = parse_websocket_frame(buffer, cursor)? else {
            return Ok(None);
        };

        match frame.opcode {
            0x0 => {
                if !started {
                    return Err("unexpected WebSocket continuation frame".to_string());
                }
            }
            0x1 | 0x2 => {
                if started {
                    return Err(
                        "new WebSocket data frame started before continuation finished".to_string(),
                    );
                }
                started = true;
            }
            0x8 => return Err("WebSocket closed before chat request".to_string()),
            opcode => return Err(format!("unsupported WebSocket opcode: {opcode}")),
        }

        message.extend_from_slice(&frame.payload);
        if message.len() > MAX_JSON_BODY_BYTES {
            return Err("WebSocket chat request exceeds maximum allowed size".to_string());
        }
        cursor = frame.next;

        if frame.fin {
            buffer.drain(..cursor);
            return Ok(Some(message));
        }
    }
}

struct ParsedWebSocketFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
    next: usize,
}

fn parse_websocket_frame(
    buffer: &[u8],
    start: usize,
) -> Result<Option<ParsedWebSocketFrame>, String> {
    if buffer.len() < start + 2 {
        return Ok(None);
    }

    let fin = buffer[start] & 0x80 != 0;
    let opcode = buffer[start] & 0x0f;
    let masked = buffer[start + 1] & 0x80 != 0;
    if !masked {
        return Err("client WebSocket frames must be masked".to_string());
    }

    let mut offset = start + 2;
    let mut len = (buffer[start + 1] & 0x7f) as usize;
    if len == 126 {
        if buffer.len() < offset + 2 {
            return Ok(None);
        }
        len = u16::from_be_bytes([buffer[offset], buffer[offset + 1]]) as usize;
        offset += 2;
    } else if len == 127 {
        if buffer.len() < offset + 8 {
            return Ok(None);
        }
        let raw_len = u64::from_be_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
            buffer[offset + 4],
            buffer[offset + 5],
            buffer[offset + 6],
            buffer[offset + 7],
        ]);
        len = usize::try_from(raw_len)
            .map_err(|_| "WebSocket frame length is too large".to_string())?;
        offset += 8;
    }

    if len > MAX_JSON_BODY_BYTES {
        return Err("WebSocket chat request exceeds maximum allowed size".to_string());
    }
    if buffer.len() < offset + 4 + len {
        return Ok(None);
    }

    let mask = [
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ];
    offset += 4;
    let mut payload = buffer[offset..offset + len].to_vec();
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Ok(Some(ParsedWebSocketFrame {
        fin,
        opcode,
        payload,
        next: offset + len,
    }))
}

pub(crate) fn sse_headers() -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}\r\n",
        response_cors_origin(),
        response_cors_credentials_header()
    )
}
