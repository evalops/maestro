use super::*;

use crate::keybindings::keybindings_test_env_lock;
use tempfile::tempdir;

fn with_temp_keybindings_file<T>(body: impl FnOnce(&Path) -> T) -> T {
    let _guard = keybindings_test_env_lock().blocking_lock();
    let temp = tempdir().expect("tempdir");
    let path = temp.path().join("keybindings.json");
    let previous = std::env::var_os("MAESTRO_KEYBINDINGS_FILE");
    std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &path);
    let result = body(&path);
    match previous {
        Some(value) => std::env::set_var("MAESTRO_KEYBINDINGS_FILE", value),
        None => std::env::remove_var("MAESTRO_KEYBINDINGS_FILE"),
    }
    result
}

#[test]
fn registry_register_and_get() {
    let mut registry = CommandRegistry::new();
    registry.register(Command::new(
        "test",
        "A test command",
        CommandCategory::Diagnostics,
        Box::new(|_| Ok(CommandOutput::Silent)),
    ));

    assert!(registry.get("test").is_some());
    assert!(registry.get("unknown").is_none());
}

#[test]
fn registry_alias_lookup() {
    let mut registry = CommandRegistry::new();
    registry.register(
        Command::new(
            "help",
            "Help command",
            CommandCategory::Navigation,
            Box::new(|_| Ok(CommandOutput::Silent)),
        )
        .alias("h"),
    );

    assert!(registry.get("help").is_some());
    assert!(registry.get("h").is_some());
    assert_eq!(
        registry.get("h").unwrap().name,
        registry.get("help").unwrap().name
    );
}

#[test]
fn registry_execute() {
    let registry = build_command_registry();
    let result = registry.execute("/version", "/tmp", None, None);
    assert!(result.is_ok());
    match result.unwrap() {
        CommandOutput::Message(message) => {
            assert_eq!(
                message,
                format!("Maestro TUI v{}", env!("CARGO_PKG_VERSION"))
            );
        }
        other => panic!("expected version message, got {other:?}"),
    }
}

#[test]
fn registry_execute_unknown() {
    let registry = build_command_registry();
    let result = registry.execute("/unknowncommand", "/tmp", None, None);
    assert!(result.is_err());
}

#[test]
fn built_in_commands_exist() {
    let registry = build_command_registry();
    assert!(registry.get("help").is_some());
    assert!(registry.get("hotkeys").is_some());
    assert!(registry.get("keys").is_some());
    assert!(registry.get("shortcuts").is_some());
    assert!(registry.get("theme").is_some());
    assert!(registry.get("model").is_some());
    assert!(registry.get("quit").is_some());
    assert!(registry.get("limits").is_some());
    assert!(registry.get("status").is_some());
    assert!(registry.get("stats").is_some());
    assert!(registry.get("about").is_some());
    assert!(registry.get("context").is_some());
    assert!(registry.get("git").is_some());
    assert!(registry.get("diff").is_some());
    assert!(registry.get("review").is_some());
    assert!(registry.get("a2a").is_some());
}

#[test]
fn a2a_command_parses_peer_actions() {
    let registry = build_command_registry();

    assert!(registry.execute("/a2a fleet", "/tmp", None, None).is_ok());
    assert!(registry.execute("/a2a tasks", "/tmp", None, None).is_ok());
    assert!(registry
        .execute("/a2a tasks --work-graph mac-mini", "/tmp", None, None)
        .is_ok());
    assert!(registry
        .execute("/a2a coordinate", "/tmp", None, None)
        .is_ok());
    assert!(registry
        .execute(
            "/a2a delegate mac-mini run workspace smoke",
            "/tmp",
            None,
            None,
        )
        .is_ok());

    match registry
        .execute("/a2a peers", "/tmp", None, None)
        .expect("a2a peers should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Peers)) => {}
        other => panic!("expected a2a peers action, got {other:?}"),
    }

    match registry
        .execute("/a2a tasks --work-graph mac-mini", "/tmp", None, None)
        .expect("a2a task work graph view should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Tasks {
            peer,
            include_work_graph,
        })) => {
            assert_eq!(peer.as_deref(), Some("mac-mini"));
            assert!(include_work_graph);
        }
        other => panic!("expected a2a tasks action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a accept maestro-pair-v1.payload.checksum",
            "/tmp",
            None,
            None,
        )
        .expect("a2a accept should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Accept { code })) => {
            assert_eq!(code, "maestro-pair-v1.payload.checksum");
        }
        other => panic!("expected a2a accept action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a register --agent-id maestro-peer-1 --url https://maestro.example/a2a",
            "/tmp",
            None,
            None,
        )
        .expect("a2a register should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Register {
            agent_id,
            public_url,
            heartbeat_only,
        })) => {
            assert_eq!(agent_id.as_deref(), Some("maestro-peer-1"));
            assert_eq!(public_url.as_deref(), Some("https://maestro.example/a2a"));
            assert!(!heartbeat_only);
        }
        other => panic!("expected a2a register action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a publish --heartbeat-only --agent-id maestro-peer-1",
            "/tmp",
            None,
            None,
        )
        .expect("a2a heartbeat-only publish should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Register {
            agent_id,
            public_url,
            heartbeat_only,
        })) => {
            assert_eq!(agent_id.as_deref(), Some("maestro-peer-1"));
            assert!(public_url.is_none());
            assert!(heartbeat_only);
        }
        other => panic!("expected a2a register heartbeat action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a reply mac-mini task-1 use the short smoke",
            "/tmp",
            None,
            None,
        )
        .expect("a2a reply should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Reply {
            peer,
            task_id,
            text,
        })) => {
            assert_eq!(peer, "mac-mini");
            assert_eq!(task_id, "task-1");
            assert_eq!(text, "use the short smoke");
        }
        other => panic!("expected a2a reply action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a coordinate mac-mini --work-graph --reply use the short smoke",
            "/tmp",
            None,
            None,
        )
        .expect("a2a coordinate should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Coordinate {
            peer,
            reply,
            include_work_graph,
        })) => {
            assert_eq!(peer.as_deref(), Some("mac-mini"));
            assert_eq!(reply.as_deref(), Some("use the short smoke"));
            assert!(include_work_graph);
        }
        other => panic!("expected a2a coordinate action, got {other:?}"),
    }

    match registry
        .execute(
            "/a2a coordinate --work-graph mac-mini --reply use the short smoke",
            "/tmp",
            None,
            None,
        )
        .expect("a2a coordinate should parse work-graph before peer")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Coordinate {
            peer,
            reply,
            include_work_graph,
        })) => {
            assert_eq!(peer.as_deref(), Some("mac-mini"));
            assert_eq!(reply.as_deref(), Some("use the short smoke"));
            assert!(include_work_graph);
        }
        other => panic!("expected a2a coordinate action, got {other:?}"),
    }

    match registry
        .execute("/a2a send mac-mini review this branch", "/tmp", None, None)
        .expect("a2a send should parse")
    {
        CommandOutput::Action(CommandAction::A2a(A2aAction::Send { peer, text })) => {
            assert_eq!(peer, "mac-mini");
            assert_eq!(text, "review this branch");
        }
        other => panic!("expected a2a send action, got {other:?}"),
    }
}

#[test]
fn hotkeys_command_opens_shortcuts_help_modal() {
    let registry = build_command_registry();
    let result = registry.execute("/hotkeys", "/tmp", None, None);

    match result.expect("hotkeys command should succeed") {
        CommandOutput::OpenModal(ModalType::ShortcutsHelp) => {}
        other => panic!("expected shortcuts help modal, got {other:?}"),
    }
}

#[test]
fn hotkeys_command_can_init_and_validate_keybindings_config() {
    with_temp_keybindings_file(|path| {
        let registry = build_command_registry();
        let init_result = registry
            .execute("/hotkeys init", "/tmp", None, None)
            .expect("hotkeys init should succeed");
        match init_result {
            CommandOutput::Message(message) => {
                assert!(message.contains("Created keyboard shortcuts config at"));
            }
            other => panic!("expected init message, got {other:?}"),
        }
        assert!(path.exists(), "hotkeys init should create the config file");

        let validate_result = registry
            .execute("/hotkeys validate", "/tmp", None, None)
            .expect("hotkeys validate should succeed");
        match validate_result {
            CommandOutput::Message(message) => {
                assert!(message.contains("Keyboard Shortcuts Config:"));
                assert!(message.contains("Status: present"));
                assert!(message.contains("Rust TUI overrides:"));
            }
            other => panic!("expected validation message, got {other:?}"),
        }
    });
}

#[test]
fn hotkeys_command_requires_force_to_overwrite_existing_config() {
    with_temp_keybindings_file(|path| {
        std::fs::write(path, r#"{"version":1,"bindings":{}}"#).expect("write keybindings config");
        let registry = build_command_registry();
        let err = registry
            .execute("/hotkeys init", "/tmp", None, None)
            .expect_err("init without force should fail when config exists");

        assert_eq!(
            err.message,
            format!("Keybindings config already exists at {}.", path.display())
        );
        assert_eq!(
            err.hint,
            Some("Re-run with /hotkeys init --force to overwrite it.".to_string())
        );
    });
}

#[test]
fn cost_command_exists() {
    let registry = build_command_registry();
    assert!(registry.get("cost").is_some());
    assert!(registry.get("usage").is_some()); // alias
    assert!(registry.get("tokens").is_some()); // alias
}

#[test]
fn cost_command_actions() {
    let registry = build_command_registry();

    // Summary (default)
    let result = registry.execute("/cost", "/tmp", None, None);
    assert!(result.is_ok());

    // Detailed
    let result = registry.execute("/cost detailed", "/tmp", None, None);
    assert!(result.is_ok());

    // Reset
    let result = registry.execute("/cost reset", "/tmp", None, None);
    assert!(result.is_ok());

    // Invalid
    let result = registry.execute("/cost invalid", "/tmp", None, None);
    assert!(result.is_err());
}

#[test]
fn export_command_exists() {
    let registry = build_command_registry();
    assert!(registry.get("export").is_some());
}

#[test]
fn export_command_formats() {
    let registry = build_command_registry();

    // No args (show options)
    let result = registry.execute("/export", "/tmp", None, None);
    assert!(result.is_ok());

    // Markdown
    let result = registry.execute("/export markdown", "/tmp", None, None);
    assert!(result.is_ok());

    // HTML with path
    let result = registry.execute("/export html output.html", "/tmp", None, None);
    assert!(result.is_ok());

    // Invalid format
    let result = registry.execute("/export invalid", "/tmp", None, None);
    assert!(result.is_err());
}

#[test]
fn history_command_exists() {
    let registry = build_command_registry();
    assert!(registry.get("history").is_some());
    assert!(registry.get("hist").is_some()); // alias
}

#[test]
fn history_command_actions() {
    let registry = build_command_registry();

    // Default (recent 20)
    let result = registry.execute("/history", "/tmp", None, None);
    assert!(result.is_ok());

    // With count
    let result = registry.execute("/history 10", "/tmp", None, None);
    assert!(result.is_ok());

    // Search
    let result = registry.execute("/history git status", "/tmp", None, None);
    assert!(result.is_ok());

    // Clear
    let result = registry.execute("/history clear", "/tmp", None, None);
    assert!(result.is_ok());
}

#[test]
fn toolhistory_command_exists() {
    let registry = build_command_registry();
    assert!(registry.get("toolhistory").is_some());
    assert!(registry.get("th").is_some()); // alias
}

#[test]
fn toolhistory_command_actions() {
    let registry = build_command_registry();

    // Default
    let result = registry.execute("/toolhistory", "/tmp", None, None);
    assert!(result.is_ok());

    // Stats
    let result = registry.execute("/toolhistory stats", "/tmp", None, None);
    assert!(result.is_ok());

    // For specific tool
    let result = registry.execute("/toolhistory read", "/tmp", None, None);
    assert!(result.is_ok());

    // Clear
    let result = registry.execute("/toolhistory clear", "/tmp", None, None);
    assert!(result.is_ok());
}

#[test]
fn mcp_prompts_command_parses_prompt_arguments() {
    let registry = build_command_registry();
    let result = registry.execute(
        r#"/mcp prompts docs summarize topic="MCP auth flow" format=brief"#,
        "/tmp",
        None,
        None,
    );

    match result.expect("mcp prompt args should parse") {
        CommandOutput::Action(CommandAction::Mcp(McpAction::Prompts {
            server,
            name,
            arguments,
        })) => {
            assert_eq!(server.as_deref(), Some("docs"));
            assert_eq!(name.as_deref(), Some("summarize"));
            assert_eq!(
                arguments.get("topic").map(std::string::String::as_str),
                Some("MCP auth flow")
            );
            assert_eq!(
                arguments.get("format").map(std::string::String::as_str),
                Some("brief")
            );
        }
        other => panic!("expected MCP prompts action, got {other:?}"),
    }
}

#[test]
fn mcp_prompts_command_rejects_invalid_prompt_arguments() {
    let registry = build_command_registry();
    let result = registry.execute(
        "/mcp prompts docs summarize invalid-arg",
        "/tmp",
        None,
        None,
    );

    let err = result.expect_err("invalid MCP prompt args should fail");
    assert_eq!(
        err.message,
        "Invalid MCP prompt argument. Use KEY=value after the prompt name."
    );
}
