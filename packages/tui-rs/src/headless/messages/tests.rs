use super::*;

#[test]
fn parse_ready_message() {
    let json = r#"{"type":"ready","protocol_version":"2026-03-30","model":"claude-3-opus","provider":"anthropic","session_id":"sess_123"}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::Ready {
            protocol_version,
            model,
            provider,
            session_id,
        } => {
            assert_eq!(protocol_version.as_deref(), Some("2026-03-30"));
            assert_eq!(model, "claude-3-opus");
            assert_eq!(provider, "anthropic");
            assert_eq!(session_id.as_deref(), Some("sess_123"));
        }
        _ => panic!("Expected Ready message"),
    }
}

#[test]
fn parse_response_chunk() {
    let json =
        r#"{"type":"response_chunk","response_id":"abc","content":"Hello","is_thinking":false}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ResponseChunk {
            response_id,
            content,
            is_thinking,
        } => {
            assert_eq!(response_id, "abc");
            assert_eq!(content, "Hello");
            assert!(!is_thinking);
        }
        _ => panic!("Expected ResponseChunk message"),
    }
}

#[test]
fn parse_response_end_with_tools_summary() {
    let json = r#"{"type":"response_end","response_id":"abc","usage":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":0,"cache_write_tokens":0,"total_tokens":3,"total_cost_usd":0.25,"model_id":"claude-sonnet","provider":"anthropic"},"tools_summary":{"tools_used":["read","bash"],"calls_succeeded":1,"calls_failed":1,"summary_labels":["Read package.json","Ran cargo test"]},"duration_ms":2500,"ttft_ms":120}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ResponseEnd {
            response_id,
            usage,
            tools_summary,
            duration_ms,
            ttft_ms,
            ..
        } => {
            assert_eq!(response_id, "abc");
            let usage = usage.expect("expected usage");
            assert_eq!(usage.total_tokens(), 3);
            assert_eq!(usage.cost, Some(0.25));
            assert_eq!(usage.model_id.as_deref(), Some("claude-sonnet"));
            assert_eq!(usage.provider.as_deref(), Some("anthropic"));
            let tools_summary = tools_summary.expect("expected tools summary");
            assert_eq!(tools_summary.tools_used, vec!["read", "bash"]);
            assert_eq!(tools_summary.calls_succeeded, 1);
            assert_eq!(tools_summary.calls_failed, 1);
            assert_eq!(duration_ms, Some(2500));
            assert_eq!(ttft_ms, Some(120));
            assert_eq!(
                tools_summary.summary_labels,
                vec!["Read package.json", "Ran cargo test"]
            );
        }
        _ => panic!("Expected ResponseEnd message"),
    }
}

#[test]
fn parse_compaction_message() {
    let json = r###"{"type":"compaction","summary":"## Conversation Summary","first_kept_entry_index":3,"tokens_before":9000,"auto":true,"timestamp":"2026-03-31T12:00:00Z"}"###;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::Compaction {
            first_kept_entry_index,
            tokens_before,
            auto,
            ..
        } => {
            assert_eq!(first_kept_entry_index, 3);
            assert_eq!(tokens_before, 9000);
            assert!(auto);
        }
        _ => panic!("Expected Compaction message"),
    }
}

#[test]
fn parse_server_request_message() {
    let json = r#"{"type":"server_request","request_id":"call_approval","request_type":"approval","call_id":"call_approval","tool":"bash","args":{"command":"git push --force"},"reason":"Force push requires approval"}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ServerRequest {
            request_id,
            request_type,
            call_id,
            tool,
            args,
            reason,
            ..
        } => {
            assert_eq!(request_id, "call_approval");
            assert_eq!(request_type, ServerRequestType::Approval);
            assert_eq!(call_id, "call_approval");
            assert_eq!(tool, "bash");
            assert_eq!(args["command"], "git push --force");
            assert_eq!(reason, "Force push requires approval");
        }
        _ => panic!("Expected ServerRequest message"),
    }
}

#[test]
fn parse_client_tool_server_request_message() {
    let json = r#"{"type":"server_request","request_id":"call_client","request_type":"client_tool","call_id":"call_client","tool":"artifacts","args":{"command":"create","filename":"report.txt"},"reason":"Client tool artifacts requires local execution"}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ServerRequest {
            request_id,
            request_type,
            call_id,
            tool,
            args,
            reason,
            ..
        } => {
            assert_eq!(request_id, "call_client");
            assert_eq!(request_type, ServerRequestType::ClientTool);
            assert_eq!(call_id, "call_client");
            assert_eq!(tool, "artifacts");
            assert_eq!(args["command"], "create");
            assert_eq!(reason, "Client tool artifacts requires local execution");
        }
        _ => panic!("Expected ServerRequest message"),
    }
}

#[test]
fn parse_user_input_server_request_message() {
    let json = r#"{"type":"server_request","request_id":"call_user_input","request_type":"user_input","call_id":"call_user_input","tool":"ask_user","args":{"questions":[{"header":"Stack","question":"Which schema library should we use?","options":[{"label":"Zod","description":"Use Zod schemas"}]}]},"reason":"Agent requested structured user input"}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ServerRequest {
            request_id,
            request_type,
            call_id,
            tool,
            args,
            reason,
            ..
        } => {
            assert_eq!(request_id, "call_user_input");
            assert_eq!(request_type, ServerRequestType::UserInput);
            assert_eq!(call_id, "call_user_input");
            assert_eq!(tool, "ask_user");
            assert_eq!(args["questions"][0]["header"], "Stack");
            assert_eq!(reason, "Agent requested structured user input");
        }
        _ => panic!("Expected ServerRequest message"),
    }
}

#[test]
fn parse_client_tool_request_message() {
    let json = r#"{"type":"client_tool_request","call_id":"call_client","tool":"artifacts","args":{"command":"create","filename":"report.txt"}}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ClientToolRequest {
            call_id,
            tool,
            args,
            ..
        } => {
            assert_eq!(call_id, "call_client");
            assert_eq!(tool, "artifacts");
            assert_eq!(args["command"], "create");
            assert_eq!(args["filename"], "report.txt");
        }
        _ => panic!("Expected ClientToolRequest message"),
    }
}

#[test]
fn parse_connection_info_message() {
    let json = r#"{"type":"connection_info","connection_id":"conn_remote","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval","client_tool"]},"opt_out_notifications":["status","heartbeat"],"role":"controller","connection_count":1,"controller_connection_id":"conn_remote","connections":[{"connection_id":"conn_remote","role":"controller","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval","client_tool"]},"opt_out_notifications":["status","heartbeat"],"subscription_count":1,"attached_subscription_count":1,"controller_lease_granted":true}]}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::ConnectionInfo {
            connection_id,
            client_protocol_version,
            client_info,
            capabilities,
            opt_out_notifications,
            role,
            connection_count,
            controller_connection_id,
            connections,
            ..
        } => {
            assert_eq!(connection_id.as_deref(), Some("conn_remote"));
            assert_eq!(client_protocol_version.as_deref(), Some("2026-03-30"));
            assert_eq!(
                client_info.as_ref().map(|info| info.name.as_str()),
                Some("maestro-web")
            );
            assert_eq!(
                capabilities
                    .as_ref()
                    .and_then(|caps| caps.server_requests.as_ref())
                    .map(|caps| caps.len()),
                Some(2)
            );
            assert_eq!(
                opt_out_notifications.as_ref().map(|items| items.len()),
                Some(2)
            );
            assert_eq!(role, Some(ConnectionRole::Controller));
            assert_eq!(connection_count, Some(1));
            assert_eq!(controller_connection_id.as_deref(), Some("conn_remote"));
            assert_eq!(connections.as_ref().map(Vec::len), Some(1));
        }
        _ => panic!("Expected ConnectionInfo message"),
    }
}

#[test]
fn parse_hello_ok_message() {
    let json = r#"{"type":"hello_ok","protocol_version":"2026-04-02","connection_id":"conn_remote","client_protocol_version":"2026-03-30","client_info":{"name":"maestro-web","version":"1.2.3"},"capabilities":{"server_requests":["approval"]},"opt_out_notifications":["status"],"role":"controller","controller_connection_id":"conn_remote"}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::HelloOk {
            protocol_version,
            connection_id,
            client_protocol_version,
            client_info,
            capabilities,
            opt_out_notifications,
            role,
            controller_connection_id,
            lease_expires_at,
        } => {
            assert_eq!(protocol_version, "2026-04-02");
            assert_eq!(connection_id.as_deref(), Some("conn_remote"));
            assert_eq!(client_protocol_version.as_deref(), Some("2026-03-30"));
            assert_eq!(
                client_info.as_ref().map(|info| info.name.as_str()),
                Some("maestro-web")
            );
            assert_eq!(
                capabilities
                    .as_ref()
                    .and_then(|caps| caps.server_requests.as_ref())
                    .map(|caps| caps.len()),
                Some(1)
            );
            assert_eq!(opt_out_notifications, Some(vec!["status".to_string()]));
            assert_eq!(role, Some(ConnectionRole::Controller));
            assert_eq!(controller_connection_id.as_deref(), Some("conn_remote"));
            assert!(lease_expires_at.is_none());
        }
        _ => panic!("Expected HelloOk message"),
    }
}

#[test]
fn parse_raw_agent_event_message() {
    let json = r#"{"type":"raw_agent_event","event_type":"status","event":{"type":"status","status":"Working","details":{}}}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::RawAgentEvent { event_type, event } => {
            assert_eq!(event_type, "status");
            assert_eq!(event["type"], "status");
            assert_eq!(event["status"], "Working");
        }
        _ => panic!("Expected RawAgentEvent message"),
    }
}

#[test]
fn serialize_prompt_message() {
    let msg = ToAgentMessage::Prompt {
        content: "Hello".to_string(),
        attachments: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"prompt""#));
    assert!(json.contains(r#""content":"Hello""#));
}

#[test]
fn serialize_init_message() {
    let msg = ToAgentMessage::Init {
        system_prompt: Some("You are Maestro".to_string()),
        append_system_prompt: None,
        thinking_level: Some(ThinkingLevel::High),
        approval_mode: Some(ApprovalMode::Prompt),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"init""#));
    assert!(json.contains(r#""system_prompt":"You are Maestro""#));
    assert!(json.contains(r#""thinking_level":"high""#));
    assert!(json.contains(r#""approval_mode":"prompt""#));
}

#[test]
fn serialize_hello_message() {
    let msg = ToAgentMessage::Hello {
        protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: "maestro-tui-rs".to_string(),
            version: Some("0.1.0".to_string()),
        }),
        capabilities: Some(ClientCapabilities {
            server_requests: Some(vec![ServerRequestType::Approval]),
            utility_operations: Some(vec![UtilityOperation::CommandExec]),
            raw_agent_events: Some(true),
        }),
        role: Some(ConnectionRole::Controller),
        opt_out_notifications: Some(vec!["status".to_string()]),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"hello""#));
    assert!(json.contains(&format!(
        r#""protocol_version":"{}""#,
        HEADLESS_PROTOCOL_VERSION
    )));
    assert!(json.contains(r#""name":"maestro-tui-rs""#));
    assert!(json.contains(r#""role":"controller""#));
    assert!(json.contains(r#""opt_out_notifications":["status"]"#));
}

#[test]
fn serialize_server_request_response_message() {
    let msg = ToAgentMessage::ServerRequestResponse {
        request_id: "call_user_input".to_string(),
        request_type: ServerRequestType::UserInput,
        approved: None,
        result: None,
        content: Some(vec![ClientToolResultContent::Text {
            text: "Use Zod".to_string(),
        }]),
        is_error: Some(false),
        decision_action: None,
        reason: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"server_request_response""#));
    assert!(json.contains(r#""request_id":"call_user_input""#));
    assert!(json.contains(r#""request_type":"user_input""#));
}

#[test]
fn serialize_utility_command_start_message_with_stdin() {
    let msg = ToAgentMessage::UtilityCommandStart {
        command_id: "cmd_stdin".to_string(),
        command: "cat".to_string(),
        cwd: None,
        env: None,
        shell_mode: Some(UtilityCommandShellMode::Direct),
        terminal_mode: Some(UtilityCommandTerminalMode::Pipe),
        allow_stdin: Some(true),
        columns: None,
        rows: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"utility_command_start""#));
    assert!(json.contains(r#""command_id":"cmd_stdin""#));
    assert!(json.contains(r#""allow_stdin":true"#));
}

#[test]
fn serialize_utility_command_stdin_message() {
    let msg = ToAgentMessage::UtilityCommandStdin {
        command_id: "cmd_stdin".to_string(),
        content: "hello maestro".to_string(),
        eof: Some(true),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"utility_command_stdin""#));
    assert!(json.contains(r#""command_id":"cmd_stdin""#));
    assert!(json.contains(r#""content":"hello maestro""#));
    assert!(json.contains(r#""eof":true"#));
}

#[test]
fn serialize_utility_command_resize_message() {
    let msg = ToAgentMessage::UtilityCommandResize {
        command_id: "cmd_stdin".to_string(),
        columns: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"utility_command_resize""#));
    assert!(json.contains(r#""columns":120"#));
    assert!(json.contains(r#""rows":40"#));
}

#[test]
fn serialize_utility_file_search_message() {
    let msg = ToAgentMessage::UtilityFileSearch {
        search_id: "search_src".to_string(),
        query: "headless".to_string(),
        cwd: Some("/tmp/project".to_string()),
        limit: Some(25),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"utility_file_search""#));
    assert!(json.contains(r#""search_id":"search_src""#));
    assert!(json.contains(r#""query":"headless""#));
    assert!(json.contains(r#""limit":25"#));
}

#[test]
fn serialize_utility_file_read_message() {
    let msg = ToAgentMessage::UtilityFileRead {
        read_id: "read_src".to_string(),
        path: "src/headless/mod.rs".to_string(),
        cwd: Some("/tmp/project".to_string()),
        offset: Some(25),
        limit: Some(40),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains(r#""type":"utility_file_read""#));
    assert!(json.contains(r#""read_id":"read_src""#));
    assert!(json.contains(r#""path":"src/headless/mod.rs""#));
    assert!(json.contains(r#""offset":25"#));
    assert!(json.contains(r#""limit":40"#));
}

#[test]
fn parse_utility_file_watch_event_message() {
    let json = r#"{"type":"utility_file_watch_event","watch_id":"watch_src","change_type":"modify","path":"/tmp/project/src/app.ts","relative_path":"src/app.ts","timestamp":1234,"is_directory":false}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::UtilityFileWatchEvent {
            watch_id,
            change_type,
            path,
            relative_path,
            timestamp,
            is_directory,
        } => {
            assert_eq!(watch_id, "watch_src");
            assert_eq!(change_type, UtilityFileWatchChangeType::Modify);
            assert_eq!(path, "/tmp/project/src/app.ts");
            assert_eq!(relative_path, "src/app.ts");
            assert_eq!(timestamp, 1234);
            assert!(!is_directory);
        }
        _ => panic!("Expected UtilityFileWatchEvent message"),
    }
}

#[test]
fn parse_utility_file_read_result_message() {
    let json = r#"{"type":"utility_file_read_result","read_id":"read_src","path":"/tmp/project/src/main.rs","relative_path":"src/main.rs","cwd":"/tmp/project","content":"fn main() {}","start_line":1,"end_line":1,"total_lines":1,"truncated":false}"#;
    let msg: FromAgentMessage = serde_json::from_str(json).unwrap();
    match msg {
        FromAgentMessage::UtilityFileReadResult {
            read_id,
            path,
            relative_path,
            cwd,
            content,
            start_line,
            end_line,
            total_lines,
            truncated,
        } => {
            assert_eq!(read_id, "read_src");
            assert_eq!(path, "/tmp/project/src/main.rs");
            assert_eq!(relative_path, "src/main.rs");
            assert_eq!(cwd, "/tmp/project");
            assert_eq!(content, "fn main() {}");
            assert_eq!(start_line, 1);
            assert_eq!(end_line, 1);
            assert_eq!(total_lines, 1);
            assert!(!truncated);
        }
        _ => panic!("Expected UtilityFileReadResult message"),
    }
}

#[test]
fn state_handles_response_stream() {
    let mut state = AgentState::default();
    state.handle_message(FromAgentMessage::Ready {
        protocol_version: Some("2026-03-30".to_string()),
        model: "claude-3-opus".to_string(),
        provider: "anthropic".to_string(),
        session_id: Some("sess_123".to_string()),
    });

    assert_eq!(state.protocol_version.as_deref(), Some("2026-03-30"));
    assert_eq!(state.session_id.as_deref(), Some("sess_123"));

    // Start response
    state.handle_message(FromAgentMessage::ResponseStart {
        response_id: "resp1".to_string(),
    });
    assert!(state.is_responding);
    assert!(state.current_response.is_some());

    // Add chunks
    state.handle_message(FromAgentMessage::ResponseChunk {
        response_id: "resp1".to_string(),
        content: "Hello ".to_string(),
        is_thinking: false,
    });
    state.handle_message(FromAgentMessage::ResponseChunk {
        response_id: "resp1".to_string(),
        content: "world".to_string(),
        is_thinking: false,
    });

    assert_eq!(state.current_response.as_ref().unwrap().text, "Hello world");

    // End response
    state.handle_message(FromAgentMessage::ResponseEnd {
        response_id: "resp1".to_string(),
        usage: None,
        tools_summary: Some(ResponseToolsSummary {
            tools_used: vec!["read".to_string()],
            calls_succeeded: 1,
            calls_failed: 0,
            summary_labels: vec!["Read package.json".to_string()],
        }),
        duration_ms: Some(2300),
        ttft_ms: Some(150),
    });
    assert!(!state.is_responding);
    assert!(state.current_response.is_none());
    assert_eq!(state.last_response_duration_ms, Some(2300));
    assert_eq!(state.last_ttft_ms, Some(150));
}

#[test]
fn state_tracks_structured_errors() {
    let mut state = AgentState::default();
    state.handle_message(FromAgentMessage::ResponseStart {
        response_id: "resp1".to_string(),
    });
    let event = state.handle_message(FromAgentMessage::Error {
        request_id: Some("read_missing".to_string()),
        message: "Cancelled by user".to_string(),
        fatal: false,
        error_type: Some(HeadlessErrorType::Cancelled),
    });

    assert_eq!(state.last_error.as_deref(), Some("Cancelled by user"));
    assert_eq!(state.last_error_type, Some(HeadlessErrorType::Cancelled));
    assert!(state.is_responding);
    assert!(matches!(
        event,
        Some(AgentEvent::Error {
            request_id: Some(ref request_id),
            error_type: Some(HeadlessErrorType::Cancelled),
            ..
        }) if request_id == "read_missing"
    ));
}

#[test]
fn state_tracks_and_clears_file_watches() {
    let mut state = AgentState::default();
    state.handle_message(FromAgentMessage::UtilityCommandStarted {
        command_id: "cmd_owned".to_string(),
        command: "echo hi".to_string(),
        cwd: Some("/tmp/project".to_string()),
        shell_mode: UtilityCommandShellMode::Direct,
        terminal_mode: UtilityCommandTerminalMode::Pipe,
        pid: Some(42),
        columns: None,
        rows: None,
        owner_connection_id: Some("conn_owned".to_string()),
    });
    state.handle_message(FromAgentMessage::UtilityFileWatchStarted {
        watch_id: "watch_src".to_string(),
        root_dir: "/tmp/project".to_string(),
        include_patterns: Some(vec!["src/**".to_string()]),
        exclude_patterns: Some(vec!["dist/**".to_string()]),
        debounce_ms: 50,
        owner_connection_id: Some("conn_owned".to_string()),
    });

    assert_eq!(state.active_utility_commands.len(), 1);
    assert_eq!(
        state
            .active_utility_commands
            .get("cmd_owned")
            .and_then(|command| command.owner_connection_id.as_deref()),
        Some("conn_owned")
    );
    assert_eq!(state.active_file_watches.len(), 1);
    assert_eq!(
        state
            .active_file_watches
            .get("watch_src")
            .map(|watch| watch.root_dir.as_str()),
        Some("/tmp/project")
    );
    assert_eq!(
        state
            .active_file_watches
            .get("watch_src")
            .and_then(|watch| watch.owner_connection_id.as_deref()),
        Some("conn_owned")
    );

    state.handle_message(FromAgentMessage::UtilityFileWatchStopped {
        watch_id: "watch_src".to_string(),
        reason: Some("Stopped by controller".to_string()),
    });

    assert!(state.active_file_watches.is_empty());
}

#[test]
fn state_updates_active_utility_command_dimensions_after_resize() {
    let mut state = AgentState::default();
    state.handle_message(FromAgentMessage::UtilityCommandStarted {
        command_id: "cmd_pty".to_string(),
        command: "node app.js".to_string(),
        cwd: Some("/tmp/project".to_string()),
        shell_mode: UtilityCommandShellMode::Direct,
        terminal_mode: UtilityCommandTerminalMode::Pty,
        pid: Some(321),
        columns: Some(90),
        rows: Some(30),
        owner_connection_id: Some("conn_pty".to_string()),
    });

    state.handle_message(FromAgentMessage::UtilityCommandResized {
        command_id: "cmd_pty".to_string(),
        columns: 120,
        rows: 40,
    });

    let command = state
        .active_utility_commands
        .get("cmd_pty")
        .expect("active utility command");
    assert_eq!(command.terminal_mode, UtilityCommandTerminalMode::Pty);
    assert_eq!(command.columns, Some(120));
    assert_eq!(command.rows, Some(40));
    assert_eq!(command.owner_connection_id.as_deref(), Some("conn_pty"));
}

#[test]
fn state_caps_active_utility_command_output() {
    let mut state = AgentState::default();
    state.handle_message(FromAgentMessage::UtilityCommandStarted {
        command_id: "cmd_cap".to_string(),
        command: "node app.js".to_string(),
        cwd: Some("/tmp/project".to_string()),
        shell_mode: UtilityCommandShellMode::Direct,
        terminal_mode: UtilityCommandTerminalMode::Pipe,
        pid: Some(321),
        columns: None,
        rows: None,
        owner_connection_id: None,
    });

    state.handle_message(FromAgentMessage::UtilityCommandOutput {
        command_id: "cmd_cap".to_string(),
        stream: UtilityCommandStream::Stdout,
        content: "a".repeat(HEADLESS_OUTPUT_LIMIT),
    });
    state.handle_message(FromAgentMessage::UtilityCommandOutput {
        command_id: "cmd_cap".to_string(),
        stream: UtilityCommandStream::Stdout,
        content: "bcdef".to_string(),
    });

    let command = state
        .active_utility_commands
        .get("cmd_cap")
        .expect("active utility command");
    assert_eq!(command.output.len(), HEADLESS_OUTPUT_LIMIT);
    assert!(command.output.ends_with("bcdef"));
}

#[test]
fn state_handles_compaction_event() {
    let mut state = AgentState::default();
    let event = state.handle_message(FromAgentMessage::Compaction {
        summary: "## Conversation Summary".to_string(),
        first_kept_entry_index: 2,
        tokens_before: 7000,
        auto: false,
        custom_instructions: None,
        timestamp: "2026-03-31T12:00:00Z".to_string(),
    });

    assert!(matches!(
        event,
        Some(AgentEvent::Compaction {
            first_kept_entry_index,
            tokens_before,
            auto,
            ..
        }) if first_kept_entry_index == 2 && tokens_before == 7000 && !auto
    ));
}

#[test]
fn state_preserves_tool_name_for_nonapproval_runs() {
    let mut state = AgentState::default();

    let tool_call = state.handle_message(FromAgentMessage::ToolCall {
        call_id: "call_read".to_string(),
        tool_execution_id: None,
        tool: "read".to_string(),
        args: serde_json::json!({ "file_path": "package.json" }),
        requires_approval: false,
    });
    assert!(matches!(
        tool_call,
        Some(AgentEvent::ToolCall { ref tool, .. }) if tool == "read"
    ));

    let tool_start = state.handle_message(FromAgentMessage::ToolStart {
        call_id: "call_read".to_string(),
    });
    assert!(matches!(
        tool_start,
        Some(AgentEvent::ToolStart { ref tool, .. }) if tool == "read"
    ));
    assert_eq!(
        state
            .active_tools
            .get("call_read")
            .map(|tool| tool.tool.as_str()),
        Some("read")
    );
}

#[test]
fn state_tracks_and_clears_server_request_approvals() {
    let mut state = AgentState::default();

    let event = state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "call_approval".to_string(),
        request_type: ServerRequestType::Approval,
        call_id: "call_approval".to_string(),
        tool_execution_id: None,
        tool: "bash".to_string(),
        args: serde_json::json!({ "command": "git push --force" }),
        reason: "Force push requires approval".to_string(),
        started_at_ms: Some(1_771_000_000_000),
    });

    assert!(event.is_none());
    assert_eq!(state.pending_approvals.len(), 1);
    assert_eq!(state.pending_approvals[0].tool, "bash");
    assert!(state.tracked_tools.contains_key("call_approval"));

    let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
        request_id: "call_approval".to_string(),
        request_type: ServerRequestType::Approval,
        call_id: "call_approval".to_string(),
        resolution: ServerRequestResolutionStatus::Denied,
        reason: Some("Denied by user".to_string()),
        resolved_by: ServerRequestResolvedBy::User,
        started_at_ms: Some(1_771_000_000_000),
        resolved_at_ms: Some(1_771_000_000_123),
    });

    assert!(resolved.is_none());
    assert!(state.pending_approvals.is_empty());
    assert!(!state.tracked_tools.contains_key("call_approval"));
}

#[test]
fn state_tracks_connection_metadata_from_hello_and_connection_info() {
    let mut state = AgentState::default();

    state.handle_sent_message(&ToAgentMessage::Hello {
        protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: "maestro-tui-rs".to_string(),
            version: Some("0.1.0".to_string()),
        }),
        capabilities: Some(ClientCapabilities {
            server_requests: Some(vec![ServerRequestType::Approval]),
            utility_operations: Some(vec![UtilityOperation::CommandExec]),
            raw_agent_events: None,
        }),
        role: Some(ConnectionRole::Controller),
        opt_out_notifications: Some(vec!["status".to_string()]),
    });
    let event = state.handle_message(FromAgentMessage::ConnectionInfo {
        connection_id: Some("conn_remote".to_string()),
        client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
        client_info: Some(ClientInfo {
            name: "maestro-web".to_string(),
            version: Some("1.2.3".to_string()),
        }),
        capabilities: Some(ClientCapabilities {
            server_requests: Some(vec![
                ServerRequestType::Approval,
                ServerRequestType::ClientTool,
            ]),
            utility_operations: Some(vec![UtilityOperation::CommandExec]),
            raw_agent_events: Some(true),
        }),
        opt_out_notifications: Some(vec!["status".to_string(), "connection_info".to_string()]),
        role: Some(ConnectionRole::Viewer),
        connection_count: Some(1),
        controller_connection_id: Some("conn_remote".to_string()),
        lease_expires_at: None,
        connections: Some(vec![ConnectionState {
            connection_id: "conn_remote".to_string(),
            role: ConnectionRole::Viewer,
            client_protocol_version: Some(HEADLESS_PROTOCOL_VERSION.to_string()),
            client_info: Some(ClientInfo {
                name: "maestro-web".to_string(),
                version: Some("1.2.3".to_string()),
            }),
            capabilities: Some(ClientCapabilities {
                server_requests: Some(vec![
                    ServerRequestType::Approval,
                    ServerRequestType::ClientTool,
                ]),
                utility_operations: Some(vec![UtilityOperation::CommandExec]),
                raw_agent_events: Some(true),
            }),
            opt_out_notifications: Some(vec!["status".to_string(), "connection_info".to_string()]),
            subscription_count: 1,
            attached_subscription_count: 1,
            controller_lease_granted: false,
            lease_expires_at: None,
        }]),
    });

    assert!(event.is_none());
    assert_eq!(
        state.client_protocol_version.as_deref(),
        Some(HEADLESS_PROTOCOL_VERSION)
    );
    assert_eq!(
        state.client_info.as_ref().map(|info| info.name.as_str()),
        Some("maestro-web")
    );
    assert_eq!(state.connection_role, Some(ConnectionRole::Viewer));
    assert_eq!(state.connection_count, 1);
    assert_eq!(
        state
            .opt_out_notifications
            .as_ref()
            .map(|items| items.len()),
        Some(2)
    );
    assert_eq!(
        state.controller_connection_id.as_deref(),
        Some("conn_remote")
    );
    assert_eq!(state.connections.len(), 1);
    assert_eq!(
        state
            .capabilities
            .as_ref()
            .and_then(|caps| caps.server_requests.as_ref())
            .map(|caps| caps.len()),
        Some(2)
    );
}

#[test]
fn state_emits_raw_agent_events() {
    let mut state = AgentState::default();
    let event = state.handle_message(FromAgentMessage::RawAgentEvent {
        event_type: "status".to_string(),
        event: serde_json::json!({
            "type": "status",
            "status": "Working",
            "details": {},
        }),
    });

    match event {
        Some(AgentEvent::RawAgentEvent { event_type, event }) => {
            assert_eq!(event_type, "status");
            assert_eq!(event["status"], "Working");
        }
        _ => panic!("Expected raw agent event"),
    }
}

#[test]
fn state_tracks_protocol_version_from_hello_ok() {
    let mut state = AgentState::default();

    let event = state.handle_message(FromAgentMessage::HelloOk {
        protocol_version: HEADLESS_PROTOCOL_VERSION.to_string(),
        connection_id: Some("conn_remote".to_string()),
        client_protocol_version: Some("2026-04-02".to_string()),
        client_info: Some(ClientInfo {
            name: "maestro-web".to_string(),
            version: Some("1.2.3".to_string()),
        }),
        capabilities: Some(ClientCapabilities {
            server_requests: Some(vec![ServerRequestType::Approval]),
            utility_operations: Some(vec![UtilityOperation::FileRead]),
            raw_agent_events: None,
        }),
        opt_out_notifications: Some(vec!["connection_info".to_string()]),
        role: Some(ConnectionRole::Controller),
        controller_connection_id: Some("conn_remote".to_string()),
        lease_expires_at: None,
    });

    assert!(event.is_none());
    assert_eq!(
        state.protocol_version.as_deref(),
        Some(HEADLESS_PROTOCOL_VERSION)
    );
    assert_eq!(state.client_protocol_version.as_deref(), Some("2026-04-02"));
    assert_eq!(state.connection_role, Some(ConnectionRole::Controller));
    assert_eq!(
        state.controller_connection_id.as_deref(),
        Some("conn_remote")
    );
}

#[test]
fn state_tracks_and_clears_client_tool_requests() {
    let mut state = AgentState::default();

    let event = state.handle_message(FromAgentMessage::ClientToolRequest {
        call_id: "call_client".to_string(),
        tool_execution_id: None,
        tool: "artifacts".to_string(),
        args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
    });

    assert!(event.is_none());
    assert_eq!(state.pending_client_tools.len(), 1);
    assert_eq!(state.pending_client_tools[0].tool, "artifacts");
    assert!(state.tracked_tools.contains_key("call_client"));

    state.handle_sent_message(&ToAgentMessage::ClientToolResult {
        call_id: "call_client".to_string(),
        content: vec![ClientToolResultContent::Text {
            text: "created".to_string(),
        }],
        is_error: false,
    });

    assert!(state.pending_client_tools.is_empty());
    assert!(state.tracked_tools.contains_key("call_client"));
}

#[test]
fn state_tracks_and_clears_generic_client_tool_server_requests() {
    let mut state = AgentState::default();

    let event = state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "call_client".to_string(),
        request_type: ServerRequestType::ClientTool,
        call_id: "call_client".to_string(),
        tool_execution_id: None,
        tool: "artifacts".to_string(),
        args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
        reason: "Client tool artifacts requires local execution".to_string(),
        started_at_ms: Some(1_771_000_000_000),
    });

    assert!(event.is_none());
    assert_eq!(state.pending_client_tools.len(), 1);
    assert_eq!(state.pending_client_tools[0].tool, "artifacts");
    assert!(state.tracked_tools.contains_key("call_client"));

    let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
        request_id: "call_client".to_string(),
        request_type: ServerRequestType::ClientTool,
        call_id: "call_client".to_string(),
        resolution: ServerRequestResolutionStatus::Completed,
        reason: None,
        resolved_by: ServerRequestResolvedBy::Client,
        started_at_ms: Some(1_771_000_000_000),
        resolved_at_ms: Some(1_771_000_000_123),
    });

    assert!(resolved.is_none());
    assert!(state.pending_client_tools.is_empty());
    assert!(state.tracked_tools.contains_key("call_client"));
}

#[test]
fn state_tracks_and_clears_user_input_requests() {
    let mut state = AgentState::default();

    let event = state.handle_message(FromAgentMessage::ClientToolRequest {
        call_id: "call_user_input".to_string(),
        tool_execution_id: None,
        tool: "ask_user".to_string(),
        args: serde_json::json!({
            "questions": [{
                "header": "Stack",
                "question": "Which schema library should we use?",
                "options": [{
                    "label": "Zod",
                    "description": "Use Zod schemas"
                }]
            }]
        }),
    });

    assert!(event.is_none());
    assert_eq!(state.pending_user_inputs.len(), 1);
    assert_eq!(state.pending_user_inputs[0].tool, "ask_user");
    assert!(state.tracked_tools.contains_key("call_user_input"));

    let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
        request_id: "call_user_input".to_string(),
        request_type: ServerRequestType::UserInput,
        call_id: "call_user_input".to_string(),
        resolution: ServerRequestResolutionStatus::Answered,
        reason: None,
        resolved_by: ServerRequestResolvedBy::Client,
        started_at_ms: Some(1_771_000_000_000),
        resolved_at_ms: Some(1_771_000_000_123),
    });

    assert!(resolved.is_none());
    assert!(state.pending_user_inputs.is_empty());
    assert!(state.tracked_tools.contains_key("call_user_input"));
}

#[test]
fn state_clears_user_input_on_sent_generic_server_request_response() {
    let mut state = AgentState::default();

    state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "call_user_input".to_string(),
        request_type: ServerRequestType::UserInput,
        call_id: "call_user_input".to_string(),
        tool_execution_id: None,
        tool: "ask_user".to_string(),
        args: serde_json::json!({
            "questions": [{
                "header": "Stack",
                "question": "Which schema library should we use?",
                "options": [{
                    "label": "Zod",
                    "description": "Use Zod schemas"
                }]
            }]
        }),
        reason: "Agent requested structured user input".to_string(),
        started_at_ms: Some(1_771_000_000_000),
    });

    state.handle_sent_message(&ToAgentMessage::ServerRequestResponse {
        request_id: "call_user_input".to_string(),
        request_type: ServerRequestType::UserInput,
        approved: None,
        result: None,
        content: Some(vec![ClientToolResultContent::Text {
            text: "Use Zod".to_string(),
        }]),
        is_error: Some(false),
        decision_action: None,
        reason: None,
    });

    assert!(state.pending_user_inputs.is_empty());
    assert!(state.tracked_tools.contains_key("call_user_input"));
}

#[test]
fn state_tracks_and_clears_tool_retry_requests_by_request_id() {
    let mut state = AgentState::default();

    state.handle_message(FromAgentMessage::ToolCall {
        call_id: "call_bash".to_string(),
        tool_execution_id: None,
        tool: "bash".to_string(),
        args: serde_json::json!({ "command": "ls" }),
        requires_approval: false,
    });

    let event = state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "retry_1".to_string(),
        request_type: ServerRequestType::ToolRetry,
        call_id: "call_bash".to_string(),
        tool_execution_id: None,
        tool: "bash".to_string(),
        args: serde_json::json!({
            "tool_call_id": "call_bash",
            "args": { "command": "ls" },
            "error_message": "Command failed",
            "attempt": 1
        }),
        reason: "Retry bash command".to_string(),
        started_at_ms: Some(1_771_000_000_000),
    });

    assert!(event.is_none());
    assert_eq!(state.pending_tool_retries.len(), 1);
    assert_eq!(state.pending_tool_retries[0].call_id, "call_bash");
    assert_eq!(
        state.pending_tool_retries[0].request_id.as_deref(),
        Some("retry_1")
    );
    assert_eq!(
        state
            .tracked_tools
            .get("call_bash")
            .and_then(|tool| tool.args.get("command"))
            .and_then(serde_json::Value::as_str),
        Some("ls")
    );

    state.handle_sent_message(&ToAgentMessage::ServerRequestResponse {
        request_id: "retry_1".to_string(),
        request_type: ServerRequestType::ToolRetry,
        approved: None,
        result: None,
        content: None,
        is_error: None,
        decision_action: Some(ToolRetryDecisionAction::Retry),
        reason: Some("Try again".to_string()),
    });

    assert!(state.pending_tool_retries.is_empty());
    assert!(state.tracked_tools.contains_key("call_bash"));
}

#[test]
fn state_clears_tracked_client_tool_on_cancelled_server_request() {
    let mut state = AgentState::default();

    state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "call_client".to_string(),
        request_type: ServerRequestType::ClientTool,
        call_id: "call_client".to_string(),
        tool_execution_id: None,
        tool: "artifacts".to_string(),
        args: serde_json::json!({ "command": "create", "filename": "report.txt" }),
        reason: "Client tool artifacts requires local execution".to_string(),
        started_at_ms: Some(1_771_000_000_000),
    });

    let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
        request_id: "call_client".to_string(),
        request_type: ServerRequestType::ClientTool,
        call_id: "call_client".to_string(),
        resolution: ServerRequestResolutionStatus::Cancelled,
        reason: Some("Interrupted before request completed".to_string()),
        resolved_by: ServerRequestResolvedBy::Runtime,
        started_at_ms: Some(1_771_000_000_000),
        resolved_at_ms: Some(1_771_000_000_123),
    });

    assert!(resolved.is_none());
    assert!(state.pending_client_tools.is_empty());
    assert!(!state.tracked_tools.contains_key("call_client"));
}

#[test]
fn state_preserves_codex_subagent_edges_across_runtime_reset_messages() {
    let mut state = AgentState::default();
    let edge = CodexSubagentContinuityEdge {
        spawn_tool_call_id: Some("collab-spawn-reset".to_string()),
        spawn_tool_execution_id: None,
        wait_tool_call_id: None,
        wait_tool_execution_id: None,
        child_run_id: Some("agent-run-child-reset".to_string()),
        thread_id: Some("child-thread-reset".to_string()),
        operation: "spawn_agent".to_string(),
        status: "waiting_for_restore".to_string(),
    };
    state.codex_subagent_edges = vec![edge.clone()];

    state.clear_pending_request_state();
    assert_eq!(state.codex_subagent_edges, vec![edge.clone()]);

    state.handle_sent_message(&ToAgentMessage::Interrupt);
    assert_eq!(state.codex_subagent_edges, vec![edge.clone()]);

    state.handle_sent_message(&ToAgentMessage::Cancel);
    assert_eq!(state.codex_subagent_edges, vec![edge.clone()]);

    state.handle_sent_message(&ToAgentMessage::Shutdown);
    assert_eq!(state.codex_subagent_edges, vec![edge]);
}

#[test]
fn state_marks_denied_restored_codex_subagent_edges_failed_without_tracked_source() {
    let mut state = AgentState {
        codex_subagent_edges: vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-denied".to_string()),
            spawn_tool_execution_id: None,
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-denied".to_string()),
            thread_id: Some("child-thread-denied".to_string()),
            operation: "spawn_agent".to_string(),
            status: "waiting_for_restore".to_string(),
        }],
        ..Default::default()
    };

    let resolved = state.handle_message(FromAgentMessage::ServerRequestResolved {
        request_id: "approval-denied".to_string(),
        request_type: ServerRequestType::Approval,
        call_id: "collab-spawn-denied".to_string(),
        resolution: ServerRequestResolutionStatus::Denied,
        reason: Some("Denied by policy".to_string()),
        resolved_by: ServerRequestResolvedBy::Policy,
        started_at_ms: Some(1_771_000_000_000),
        resolved_at_ms: Some(1_771_000_000_123),
    });

    assert!(resolved.is_none());
    assert_eq!(
        state.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-denied".to_string()),
            spawn_tool_execution_id: None,
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-denied".to_string()),
            thread_id: Some("child-thread-denied".to_string()),
            operation: "spawn_agent".to_string(),
            status: "failed".to_string(),
        }]
    );
}

#[test]
fn state_uses_codex_subagent_tool_end_details_for_child_targets() {
    let mut state = AgentState::default();

    state.handle_message(FromAgentMessage::ToolCall {
        call_id: "collab-spawn-complete".to_string(),
        tool_execution_id: Some("texec-collab-spawn-complete".to_string()),
        tool: "codex.subagent.spawnAgent".to_string(),
        args: serde_json::json!({ "receiverThreadIds": [] }),
        requires_approval: false,
    });
    state.handle_message(FromAgentMessage::ToolEnd {
        call_id: "collab-spawn-complete".to_string(),
        tool_execution_id: None,
        success: true,
        tool: Some("codex.subagent.spawnAgent".to_string()),
        details: Some(serde_json::json!({
            "receiverThreadIds": ["child-thread-complete"],
            "childRunIds": ["agent-run-child-complete"],
            "codexWorkGraph": {
                "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
                "childRuns": [{
                    "threadId": "child-thread-complete",
                    "childRunId": "agent-run-child-complete",
                    "operation": "spawnAgent"
                }]
            },
            "prompt": "Sensitive child task prompt"
        })),
    });

    assert_eq!(
        state.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-complete".to_string()),
            spawn_tool_execution_id: Some("texec-collab-spawn-complete".to_string()),
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-complete".to_string()),
            thread_id: Some("child-thread-complete".to_string()),
            operation: "spawn_agent".to_string(),
            status: "spawned".to_string(),
        }]
    );
    let encoded = serde_json::to_string(&state.codex_subagent_edges).unwrap();
    assert!(!encoded.contains("Sensitive child task prompt"));
}

#[test]
fn state_keeps_governed_codex_subagent_id_on_partial_server_request_update() {
    let mut state = AgentState::default();
    let args = serde_json::json!({
        "codexWorkGraph": {
            "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
            "childRuns": [{
                "threadId": "child-thread-governed",
                "childRunId": "agent-run-child-governed",
                "operation": "spawnAgent"
            }]
        }
    });

    state.handle_message(FromAgentMessage::ToolCall {
        call_id: "collab-spawn-governed".to_string(),
        tool_execution_id: Some("texec-spawn-governed".to_string()),
        tool: "codex.subagent.spawnAgent".to_string(),
        args: args.clone(),
        requires_approval: false,
    });
    state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "approval-spawn-governed".to_string(),
        request_type: ServerRequestType::Approval,
        call_id: "collab-spawn-governed".to_string(),
        tool_execution_id: None,
        tool: "codex.subagent.spawnAgent".to_string(),
        args,
        reason: "Policy approval required".to_string(),
        started_at_ms: None,
    });

    assert_eq!(
        state.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-governed".to_string()),
            spawn_tool_execution_id: Some("texec-spawn-governed".to_string()),
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-governed".to_string()),
            thread_id: Some("child-thread-governed".to_string()),
            operation: "spawn_agent".to_string(),
            status: "waiting_for_restore".to_string(),
        }]
    );
    assert_eq!(
        state
            .pending_approvals
            .first()
            .and_then(|pending| pending.tool_execution_id.as_deref()),
        Some("texec-spawn-governed")
    );
}

#[test]
fn state_persists_governed_codex_subagent_id_from_retry_request() {
    let mut state = AgentState::default();
    let args = serde_json::json!({
        "codexWorkGraph": {
            "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
            "childRuns": [{
                "threadId": "child-thread-retry-governed",
                "childRunId": "agent-run-child-retry-governed",
                "operation": "spawnAgent"
            }]
        }
    });

    state.handle_message(FromAgentMessage::ToolCall {
        call_id: "collab-spawn-retry-governed".to_string(),
        tool_execution_id: None,
        tool: "codex.subagent.spawnAgent".to_string(),
        args: args.clone(),
        requires_approval: false,
    });
    state.handle_message(FromAgentMessage::ServerRequest {
        request_id: "retry-spawn-governed".to_string(),
        request_type: ServerRequestType::ToolRetry,
        call_id: "collab-spawn-retry-governed".to_string(),
        tool_execution_id: Some("texec-spawn-retry-governed".to_string()),
        tool: "codex.subagent.spawnAgent".to_string(),
        args,
        reason: "Retry governed spawn".to_string(),
        started_at_ms: None,
    });

    assert_eq!(
        state
            .tracked_tools
            .get("collab-spawn-retry-governed")
            .and_then(|pending| pending.tool_execution_id.as_deref()),
        Some("texec-spawn-retry-governed")
    );

    state.handle_message(FromAgentMessage::ToolEnd {
        call_id: "collab-spawn-retry-governed".to_string(),
        tool_execution_id: None,
        success: true,
        tool: None,
        details: None,
    });

    assert_eq!(
        state.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-retry-governed".to_string()),
            spawn_tool_execution_id: Some("texec-spawn-retry-governed".to_string()),
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-retry-governed".to_string()),
            thread_id: Some("child-thread-retry-governed".to_string()),
            operation: "spawn_agent".to_string(),
            status: "spawned".to_string(),
        }]
    );
}

#[test]
fn state_preserves_codex_subagent_child_target_status_from_work_graph_edges() {
    let mut state = AgentState::default();

    state.handle_message(FromAgentMessage::ToolCall {
        call_id: "collab-spawn-status".to_string(),
        tool_execution_id: None,
        tool: "codex.subagent.spawnAgent".to_string(),
        args: serde_json::json!({
            "codexWorkGraph": {
                "schemaVersion": CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
                "childRuns": [{
                    "edgeId": "collab-spawn-status:0:spawnAgent:agent-run-child-status",
                    "targetIndex": 0,
                    "threadId": "child-thread-status",
                    "childRunId": "agent-run-child-status",
                    "operation": "spawnAgent",
                    "status": "running"
                }]
            },
            "prompt": "Sensitive child task prompt"
        }),
        requires_approval: false,
    });

    assert_eq!(
        state.codex_subagent_edges,
        vec![CodexSubagentContinuityEdge {
            spawn_tool_call_id: Some("collab-spawn-status".to_string()),
            spawn_tool_execution_id: None,
            wait_tool_call_id: None,
            wait_tool_execution_id: None,
            child_run_id: Some("agent-run-child-status".to_string()),
            thread_id: Some("child-thread-status".to_string()),
            operation: "spawn_agent".to_string(),
            status: "running".to_string(),
        }]
    );
    let encoded = serde_json::to_string(&state.codex_subagent_edges).unwrap();
    assert!(!encoded.contains("Sensitive child task prompt"));
}

#[test]
fn codex_subagent_terminal_statuses_keep_spawned_and_resumed_active() {
    assert!(codex_subagent_status_is_terminal("acknowledged"));
    assert!(codex_subagent_status_is_terminal("Acknowledged"));
    assert!(codex_subagent_status_is_terminal("completed"));
    assert!(codex_subagent_status_is_terminal("closed"));
    assert!(!codex_subagent_status_is_terminal("spawned"));
    assert!(!codex_subagent_status_is_terminal("Spawned"));
    assert!(!codex_subagent_status_is_terminal("resumed"));
    assert!(!codex_subagent_status_is_terminal("reSumed"));
}
