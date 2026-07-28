use super::*;

use crate::keybindings::{
    keybindings_test_env_lock, queued_follow_up_edit_binding_for_terminal_name,
};
use crate::state::QueueMode;
use tempfile::tempdir;

fn acquire_keybindings_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    keybindings_test_env_lock().blocking_lock()
}

async fn acquire_keybindings_test_lock_async() -> tokio::sync::MutexGuard<'static, ()> {
    keybindings_test_env_lock().lock().await
}

// ─────────────────────────────────────────────────────────────────────────
// ActiveModal Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_active_modal_default() {
    let modal = ActiveModal::None;
    assert_eq!(modal, ActiveModal::None);
}

#[test]
fn test_active_modal_equality() {
    assert_eq!(ActiveModal::FileSearch, ActiveModal::FileSearch);
    assert_ne!(ActiveModal::FileSearch, ActiveModal::CommandPalette);
}

#[test]
fn test_active_modal_copy() {
    let modal = ActiveModal::Approval;
    let copy = modal;
    assert_eq!(modal, copy);
}

// ─────────────────────────────────────────────────────────────────────────
// Key Event Filtering Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_should_handle_key_event_press_and_repeat() {
    // Kitty-protocol terminals report Press/Repeat/Release; repeats must be
    // handled so held keys auto-repeat, releases must be ignored.
    assert!(should_handle_key_event(KeyEventKind::Press));
    assert!(should_handle_key_event(KeyEventKind::Repeat));
    assert!(!should_handle_key_event(KeyEventKind::Release));
}

#[test]
fn uncurses_input_kill_switch_defaults_on_and_accepts_only_zero_as_off() {
    assert!(uncurses_input_enabled(None));
    assert!(uncurses_input_enabled(Some(std::ffi::OsStr::new("1"))));
    assert!(!uncurses_input_enabled(Some(std::ffi::OsStr::new("0"))));
}

#[test]
fn terminal_theme_query_requires_fallback_and_respects_throttle() {
    assert!(!terminal_theme_query_due(
        false,
        true,
        false,
        Some(Duration::from_secs(3))
    ));
    assert!(!terminal_theme_query_due(
        true,
        false,
        false,
        Some(Duration::from_secs(3))
    ));
    assert!(!terminal_theme_query_due(
        true,
        true,
        true,
        Some(Duration::from_secs(3))
    ));
    assert!(!terminal_theme_query_due(
        true,
        true,
        false,
        Some(Duration::from_millis(1999))
    ));
    assert!(terminal_theme_query_due(
        true,
        true,
        false,
        Some(Duration::from_secs(2))
    ));
    assert!(terminal_theme_query_due(true, true, false, None));
}

#[test]
fn terminal_theme_events_respect_theme_follow_opt_out() {
    let mut app = new_test_app();
    app.theme_follower = None;
    let scheme = if crate::themes::current_theme_name() == "light" {
        uncurses::event::ColorScheme::Light
    } else {
        uncurses::event::ColorScheme::Dark
    };

    assert!(!app.apply_terminal_theme_event(&AppTerminalEvent::ColorScheme(scheme)));
    assert!(app.theme_follower.is_none());
}

#[test]
fn terminal_theme_events_apply_typed_and_hysteretic_updates() {
    let original = crate::themes::current_theme_name();
    crate::themes::set_theme_by_name("dark").expect("built-in dark theme");
    let mut app = new_test_app();
    app.theme_follower = Some(crate::themes::osc11::AutoThemeFollower::new("dark"));

    assert!(
        app.apply_terminal_theme_event(&AppTerminalEvent::ColorScheme(
            uncurses::event::ColorScheme::Light
        ))
    );
    assert_eq!(crate::themes::current_theme_name(), "light");
    assert_eq!(
        app.theme_follower
            .as_ref()
            .map(|follower| follower.current()),
        Some("light")
    );

    crate::themes::set_theme_by_name("dark").expect("built-in dark theme");
    app.theme_follower = Some(crate::themes::osc11::AutoThemeFollower::new("dark"));
    let light_background = AppTerminalEvent::BackgroundColor {
        red: 255,
        green: 255,
        blue: 255,
    };
    assert!(!app.apply_terminal_theme_event(&light_background));
    assert!(app.apply_terminal_theme_event(&light_background));
    assert_eq!(crate::themes::current_theme_name(), "light");

    crate::themes::set_theme_by_name(&original).expect("restore original theme");
}

#[test]
fn test_active_modal_variants_exist() {
    // Ensure all modal variants are defined correctly
    let modals = [
        ActiveModal::None,
        ActiveModal::FileSearch,
        ActiveModal::SessionSwitcher,
        ActiveModal::Operations,
        ActiveModal::CommandPalette,
        ActiveModal::Approval,
        ActiveModal::ModelSelector,
        ActiveModal::ThemeSelector,
    ];
    assert_eq!(modals.len(), 8);
}

// ─────────────────────────────────────────────────────────────────────────
// CommandOutput Handling Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_command_output_message_variants() {
    // Test that CommandOutput variants can be constructed
    let msg = CommandOutput::Message("test".to_string());
    assert!(matches!(msg, CommandOutput::Message(_)));

    let help = CommandOutput::Help("help text".to_string());
    assert!(matches!(help, CommandOutput::Help(_)));

    let warn = CommandOutput::Warning("warning".to_string());
    assert!(matches!(warn, CommandOutput::Warning(_)));

    let silent = CommandOutput::Silent;
    assert!(matches!(silent, CommandOutput::Silent));
}

#[test]
fn test_command_output_multi() {
    let outputs = CommandOutput::Multi(vec![
        CommandOutput::Message("first".to_string()),
        CommandOutput::Warning("second".to_string()),
    ]);
    if let CommandOutput::Multi(items) = outputs {
        assert_eq!(items.len(), 2);
    } else {
        panic!("Expected Multi variant");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// CommandAction Handling Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_command_action_clear_messages() {
    let action = CommandAction::ClearMessages;
    assert!(matches!(action, CommandAction::ClearMessages));
}

#[test]
fn test_command_action_toggle_zen_mode() {
    let action = CommandAction::ToggleZenMode;
    assert!(matches!(action, CommandAction::ToggleZenMode));
}

#[test]
fn test_command_action_set_approval_mode() {
    let action = CommandAction::SetApprovalMode("yolo".to_string());
    if let CommandAction::SetApprovalMode(mode) = action {
        assert_eq!(mode, "yolo");
    } else {
        panic!("Expected SetApprovalMode");
    }
}

#[test]
fn test_command_action_set_thinking_level() {
    let action = CommandAction::SetThinkingLevel("high".to_string());
    if let CommandAction::SetThinkingLevel(level) = action {
        assert_eq!(level, "high");
    } else {
        panic!("Expected SetThinkingLevel");
    }
}

#[test]
fn test_command_action_quit() {
    let action = CommandAction::Quit;
    assert!(matches!(action, CommandAction::Quit));
}

#[test]
fn test_command_action_refresh_workspace() {
    let action = CommandAction::RefreshWorkspace;
    assert!(matches!(action, CommandAction::RefreshWorkspace));
}

#[test]
fn test_command_action_copy_last_message() {
    let action = CommandAction::CopyLastMessage;
    assert!(matches!(action, CommandAction::CopyLastMessage));
}

#[test]
fn test_command_action_compact_conversation() {
    let action = CommandAction::CompactConversation(Some("focus".to_string()));
    if let CommandAction::CompactConversation(instructions) = action {
        assert_eq!(instructions, Some("focus".to_string()));
    } else {
        panic!("Expected CompactConversation");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// ModalType Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_modal_type_variants() {
    let types = [
        ModalType::ThemeSelector,
        ModalType::ModelSelector,
        ModalType::SessionList,
        ModalType::Operations,
        ModalType::FileSearch,
        ModalType::CommandPalette,
        ModalType::Help,
    ];
    assert_eq!(types.len(), 7);
}

// ─────────────────────────────────────────────────────────────────────────
// ApprovalMode Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_approval_mode_parse() {
    assert_eq!(ApprovalMode::parse("yolo"), Some(ApprovalMode::Yolo));
    assert_eq!(ApprovalMode::parse("safe"), Some(ApprovalMode::Safe));
    assert_eq!(
        ApprovalMode::parse("selective"),
        Some(ApprovalMode::Selective)
    );
    assert_eq!(ApprovalMode::parse("invalid"), None);
}

#[test]
fn test_approval_mode_next() {
    assert_eq!(ApprovalMode::Yolo.next(), ApprovalMode::Selective);
    assert_eq!(ApprovalMode::Selective.next(), ApprovalMode::Safe);
    assert_eq!(ApprovalMode::Safe.next(), ApprovalMode::Yolo);
}

#[test]
fn test_approval_mode_label() {
    assert!(!ApprovalMode::Yolo.label().is_empty());
    assert!(!ApprovalMode::Safe.label().is_empty());
    assert!(!ApprovalMode::Selective.label().is_empty());
}

// ─────────────────────────────────────────────────────────────────────────
// ThinkingLevel Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_thinking_level_parse() {
    assert!(ThinkingLevel::parse("off").is_some());
    assert!(ThinkingLevel::parse("minimal").is_some());
    assert!(ThinkingLevel::parse("low").is_some());
    assert!(ThinkingLevel::parse("medium").is_some());
    assert!(ThinkingLevel::parse("high").is_some());
    assert!(ThinkingLevel::parse("max").is_some());
    assert!(ThinkingLevel::parse("invalid").is_none());
}

#[test]
fn test_thinking_level_to_config() {
    let off = ThinkingLevel::parse("off").unwrap();
    let (enabled, _budget) = off.to_config();
    assert!(!enabled);

    let high = ThinkingLevel::parse("high").unwrap();
    let (enabled, budget) = high.to_config();
    assert!(enabled);
    assert!(budget > 0);
}

#[test]
fn test_thinking_level_label() {
    let medium = ThinkingLevel::parse("medium").unwrap();
    assert!(!medium.label().is_empty());
}

// ─────────────────────────────────────────────────────────────────────────
// AppState Tests (Integration with app.rs logic)
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_app_state_message_operations() {
    let mut state = AppState::new();
    assert!(state.messages.is_empty());

    state.add_user_message("Hello".to_string());
    assert_eq!(state.messages.len(), 1);
    assert_eq!(state.messages[0].role, MessageRole::User);
    assert_eq!(state.messages[0].content, "Hello");

    state.add_system_message("System response".to_string());
    assert_eq!(state.messages.len(), 2);
}

#[test]
fn test_app_state_input_operations() {
    let mut state = AppState::new();
    assert!(state.input().is_empty());

    state.insert_char('H');
    state.insert_char('i');
    assert_eq!(state.input(), "Hi");

    state.backspace();
    assert_eq!(state.input(), "H");

    state.set_input("New input");
    assert_eq!(state.input(), "New input");

    let taken = state.take_input();
    assert_eq!(taken, "New input");
    assert!(state.input().is_empty());
}

#[test]
fn test_app_state_scroll_operations() {
    let mut state = AppState::new();
    assert_eq!(state.scroll_offset, 0);

    // scroll_down increases offset (scrolls toward older messages)
    state.scroll_down(5);
    assert_eq!(state.scroll_offset, 5);

    // scroll_up decreases offset (scrolls toward newer messages)
    state.scroll_up(3);
    assert_eq!(state.scroll_offset, 2);

    // scroll_up with larger amount clamps to 0
    state.scroll_up(10);
    assert_eq!(state.scroll_offset, 0);
}

#[test]
fn test_app_state_zen_mode() {
    let mut state = AppState::new();
    assert!(!state.zen_mode);

    state.zen_mode = true;
    assert!(state.zen_mode);
}

#[test]
fn test_app_state_busy_flag() {
    let mut state = AppState::new();
    assert!(!state.busy);

    state.busy = true;
    assert!(state.busy);
}

// ─────────────────────────────────────────────────────────────────────────
// Slash Command State Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_slash_cycle_state_new() {
    let state = SlashCycleState::new();
    assert!(!state.has_completions());
    assert!(state.current().is_none());
}

#[test]
fn test_slash_cycle_state_reset() {
    let mut state = SlashCycleState::new();
    state.reset();
    assert!(!state.has_completions());
}

#[test]
fn test_normalize_slash_completion_never_doubles() {
    use super::command_handlers::normalize_slash_completion;

    assert_eq!(normalize_slash_completion("/help"), "/help");
    assert_eq!(normalize_slash_completion("help"), "/help");
    assert_eq!(normalize_slash_completion("//help"), "/help");
    assert_eq!(normalize_slash_completion("///plan"), "/plan");
    assert_eq!(normalize_slash_completion("  /theme  "), "/theme");
    assert_eq!(normalize_slash_completion("/"), "/");
    assert_eq!(normalize_slash_completion("//"), "/");
    assert_eq!(normalize_slash_completion(""), "/");
}

#[test]
fn test_slash_cycle_apply_path_no_double_slash() {
    use super::command_handlers::normalize_slash_completion;
    use crate::commands::{build_command_registry, SlashCommandMatcher, SlashCycleState};
    use std::sync::Arc;

    let registry = Arc::new(build_command_registry());
    let matcher = SlashCommandMatcher::new(registry);
    let mut cycle = SlashCycleState::new();
    cycle.set_query("he", &matcher);
    assert!(cycle.has_completions());
    let applied = normalize_slash_completion(cycle.current().unwrap());
    assert!(applied.starts_with('/'), "{applied}");
    assert!(!applied.starts_with("//"), "double slash bug: {applied}");
    // Simulate the old buggy path for documentation:
    let buggy = format!("/{}", cycle.current().unwrap());
    assert!(
        buggy.starts_with("//"),
        "expected old path to double-slash when completion already has /"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Usage Action Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_usage_action_variants() {
    use crate::commands::UsageAction;

    let summary = UsageAction::Summary;
    assert!(matches!(summary, UsageAction::Summary));

    let detailed = UsageAction::Detailed;
    assert!(matches!(detailed, UsageAction::Detailed));

    let reset = UsageAction::Reset;
    assert!(matches!(reset, UsageAction::Reset));
}

// ─────────────────────────────────────────────────────────────────────────
// Export Action Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_export_action_variants() {
    use crate::commands::ExportAction;

    let md = ExportAction::Markdown(None);
    assert!(matches!(md, ExportAction::Markdown(None)));

    let html = ExportAction::Html(Some("test.html".to_string()));
    if let ExportAction::Html(path) = html {
        assert_eq!(path, Some("test.html".to_string()));
    }

    let json = ExportAction::Json(None);
    assert!(matches!(json, ExportAction::Json(_)));

    let txt = ExportAction::PlainText(None);
    assert!(matches!(txt, ExportAction::PlainText(_)));
}

// ─────────────────────────────────────────────────────────────────────────
// History Action Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_history_action_variants() {
    use crate::commands::HistoryAction;

    let recent = HistoryAction::Recent(10);
    if let HistoryAction::Recent(count) = recent {
        assert_eq!(count, 10);
    }

    let search = HistoryAction::Search("query".to_string());
    if let HistoryAction::Search(q) = search {
        assert_eq!(q, "query");
    }

    let clear = HistoryAction::Clear;
    assert!(matches!(clear, HistoryAction::Clear));
}

// ─────────────────────────────────────────────────────────────────────────
// Tool History Action Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_tool_history_action_variants() {
    use crate::commands::ToolHistoryAction;

    let recent = ToolHistoryAction::Recent(5);
    if let ToolHistoryAction::Recent(count) = recent {
        assert_eq!(count, 5);
    }

    let stats = ToolHistoryAction::Stats;
    assert!(matches!(stats, ToolHistoryAction::Stats));

    let for_tool = ToolHistoryAction::ForTool("bash".to_string());
    if let ToolHistoryAction::ForTool(name) = for_tool {
        assert_eq!(name, "bash");
    }

    let clear = ToolHistoryAction::Clear;
    assert!(matches!(clear, ToolHistoryAction::Clear));
}

// ─────────────────────────────────────────────────────────────────────────
// Hooks Action Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_hooks_action_variants() {
    use crate::commands::HooksAction;

    let actions = [
        HooksAction::List,
        HooksAction::Toggle,
        HooksAction::Reload,
        HooksAction::Metrics,
        HooksAction::Enable,
        HooksAction::Disable,
    ];
    assert_eq!(actions.len(), 6);
}

// ─────────────────────────────────────────────────────────────────────────
// Message Role Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_message_role_equality() {
    assert_eq!(MessageRole::User, MessageRole::User);
    assert_eq!(MessageRole::Assistant, MessageRole::Assistant);
    assert_ne!(MessageRole::User, MessageRole::Assistant);
}

// ─────────────────────────────────────────────────────────────────────────
// Integration Tests for State Transitions
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_message_content_preview() {
    let long_content = "a".repeat(200);
    let chars: Vec<char> = long_content.chars().collect();
    let preview = if chars.len() > 100 {
        format!("{}...", chars[..97].iter().collect::<String>())
    } else {
        long_content.clone()
    };
    assert_eq!(preview.len(), 100); // 97 chars + "..."
}

#[test]
fn test_compact_conversation_logic() {
    // Test the logic used in CompactConversation action
    let msg_count = 10;
    let keep_count = 2;

    if msg_count > 4 {
        let to_summarize = msg_count - keep_count;
        assert_eq!(to_summarize, 8);
    }

    // Edge case: exactly 4 messages shouldn't compact
    let msg_count_small = 4;
    assert!(msg_count_small <= 4);
}

#[test]
fn test_restore_visible_session_messages_applies_compactions() {
    let mut state = AppState::new();
    let session = ParsedSession {
        header: SessionHeader {
            version: Some(2),
            id: "session-1".to_string(),
            timestamp: "2026-03-31T12:00:00Z".to_string(),
            cwd: "/tmp".to_string(),
            model: "anthropic/claude-sonnet-4-5".to_string(),
            subject: None,
            model_metadata: None,
            thinking_level: ThinkingLevel::Medium,
            system_prompt: None,
            prompt_metadata: None,
            prompt_context_manifest: None,
            unified_context_manifest: None,
            tools: Vec::new(),
            branched_from: None,
            parent_session: None,
        },
        messages: vec![
            AppMessage::User {
                content: MessageContent::Text("User one".to_string()),
                attachments: None,
                timestamp: 1,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant one".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 2,
            },
            AppMessage::User {
                content: MessageContent::Text("User two".to_string()),
                attachments: None,
                timestamp: 3,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant two".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 4,
            },
            AppMessage::User {
                content: MessageContent::Text("User three".to_string()),
                attachments: None,
                timestamp: 5,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant three".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 6,
            },
        ],
        meta: None,
        stats: Default::default(),
        thinking_level_changes: Vec::new(),
        model_changes: Vec::new(),
        compactions: vec![CompactionEntry {
            id: None,
            parent_id: None,
            timestamp: "2026-03-31T12:05:00Z".to_string(),
            summary: "## Conversation Summary".to_string(),
            first_kept_entry_id: None,
            first_kept_entry_index: Some(4),
            tokens_before: 1000,
            auto: true,
            custom_instructions: None,
        }],
        side_questions: Vec::new(),
        plan_review_events: Vec::new(),
        usage_entries: Vec::new(),
        file_path: "/tmp/session-1.jsonl".to_string(),
    };

    restore_visible_session_messages(&mut state, &session);

    assert_eq!(state.messages.len(), 3);
    assert!(state.messages[0].is_compaction_boundary());
    assert_eq!(state.messages[0].content, "## Conversation Summary");
    assert_eq!(
        state.messages[0].timestamp,
        parse_rfc3339_system_time("2026-03-31T12:05:00Z").unwrap()
    );
    assert_eq!(state.messages[1].content, "User three");
    assert_eq!(state.messages[2].content, "Assistant three");
}

#[test]
fn test_restore_visible_session_messages_applies_multiple_compactions_in_order() {
    let mut state = AppState::new();
    let session = ParsedSession {
        header: SessionHeader {
            version: Some(2),
            id: "session-2".to_string(),
            timestamp: "2026-03-31T12:00:00Z".to_string(),
            cwd: "/tmp".to_string(),
            model: "anthropic/claude-sonnet-4-5".to_string(),
            subject: None,
            model_metadata: None,
            thinking_level: ThinkingLevel::Medium,
            system_prompt: None,
            prompt_metadata: None,
            prompt_context_manifest: None,
            unified_context_manifest: None,
            tools: Vec::new(),
            branched_from: None,
            parent_session: None,
        },
        messages: vec![
            AppMessage::User {
                content: MessageContent::Text("User one".to_string()),
                attachments: None,
                timestamp: 1,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant one".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 2,
            },
            AppMessage::User {
                content: MessageContent::Text("User two".to_string()),
                attachments: None,
                timestamp: 3,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant two".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 4,
            },
            AppMessage::User {
                content: MessageContent::Text("User three".to_string()),
                attachments: None,
                timestamp: 5,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant three".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 6,
            },
            AppMessage::User {
                content: MessageContent::Text("User four".to_string()),
                attachments: None,
                timestamp: 7,
            },
            AppMessage::Assistant {
                content: vec![SessionContentBlock::Text {
                    text: "Assistant four".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 8,
            },
        ],
        meta: None,
        stats: Default::default(),
        thinking_level_changes: Vec::new(),
        model_changes: Vec::new(),
        compactions: vec![
            CompactionEntry {
                id: None,
                parent_id: None,
                timestamp: "2026-03-31T12:05:00Z".to_string(),
                summary: "## First Summary".to_string(),
                first_kept_entry_id: None,
                first_kept_entry_index: Some(4),
                tokens_before: 1000,
                auto: true,
                custom_instructions: None,
            },
            CompactionEntry {
                id: None,
                parent_id: None,
                timestamp: "2026-03-31T12:10:00Z".to_string(),
                summary: "## Second Summary".to_string(),
                first_kept_entry_id: None,
                first_kept_entry_index: Some(2),
                tokens_before: 1200,
                auto: true,
                custom_instructions: None,
            },
        ],
        side_questions: Vec::new(),
        plan_review_events: Vec::new(),
        usage_entries: Vec::new(),
        file_path: "/tmp/session-2.jsonl".to_string(),
    };

    restore_visible_session_messages(&mut state, &session);

    assert_eq!(state.messages.len(), 3);
    assert!(state.messages[0].is_compaction_boundary());
    assert_eq!(state.messages[0].content, "## Second Summary");
    assert_eq!(state.messages[1].content, "User four");
    assert_eq!(state.messages[2].content, "Assistant four");
}

#[test]
fn test_scroll_boundary_handling() {
    let mut state = AppState::new();

    // scroll_up at 0 should stay at 0 (can't go below 0)
    state.scroll_up(100);
    assert_eq!(state.scroll_offset, 0);

    // scroll_down increases offset (scroll toward history)
    state.scroll_down(50);
    assert_eq!(state.scroll_offset, 50);

    // scroll_up decreases offset (scroll toward recent)
    state.scroll_up(30);
    assert_eq!(state.scroll_offset, 20);

    // scroll_up by more than current clamps to 0
    state.scroll_up(100);
    assert_eq!(state.scroll_offset, 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Queue State Tests
// ─────────────────────────────────────────────────────────────────────────

fn new_test_app() -> App {
    let fallback_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fallback_path)
        .expect("open fallback terminal");
    let viewport_height = 24;
    let viewport_top = 1;
    let backend = ratatui::backend::CrosstermBackend::new(file);
    let terminal = ratatui::Terminal::with_options(
        backend,
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Fixed(ratatui::layout::Rect::new(
                0,
                0,
                80,
                viewport_height,
            )),
        },
    )
    .expect("create fallback terminal");
    let capabilities = crate::terminal::TerminalCapabilities {
        enhanced_keys: false,
        viewport_top,
        viewport_height,
    };
    let mut app = App::new_with_terminal_with_history(
        terminal,
        capabilities,
        crate::history::PromptHistory::default(),
        None,
        None,
    );
    app.state.steering_mode = QueueMode::default();
    app.state.follow_up_mode = QueueMode::default();
    app
}

#[tokio::test]
async fn operations_modal_routes_page_keys_to_the_focused_pane() {
    let mut app = new_test_app();
    app.active_modal = ActiveModal::Operations;
    app.operations.focus_next();

    app.handle_key(KeyCode::PageDown, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert_eq!(app.operations.scroll_offsets(), (3, 0));

    app.operations.focus_next();
    app.handle_key(KeyCode::PageDown, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert_eq!(app.operations.scroll_offsets(), (3, 3));

    app.handle_key(KeyCode::PageUp, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert_eq!(app.operations.scroll_offsets(), (3, 0));
}

#[test]
fn test_poll_workspace_scan_applies_results_and_confirms_refresh() {
    let mut app = new_test_app();
    let (tx, rx) = std::sync::mpsc::channel();
    app.workspace_scan_rx = Some(rx);

    // Nothing yet: poll is a no-op and keeps the receiver.
    assert!(!app.poll_workspace_scan());
    assert!(app.workspace_scan_rx.is_some());

    let files = vec![crate::files::WorkspaceFile {
        path: std::path::PathBuf::from("/ws/src/main.rs"),
        relative_path: "src/main.rs".to_string(),
        name: "main.rs".to_string(),
        extension: Some("rs".to_string()),
        is_dir: false,
    }];
    tx.send(files).unwrap();

    // Startup-style scan: applies files silently.
    assert!(app.poll_workspace_scan());
    assert_eq!(app.workspace_files.len(), 1);
    assert_eq!(app.workspace_files[0].relative_path, "src/main.rs");
    assert!(app.workspace_scan_rx.is_none());
    assert!(app.state.status.is_none());

    // /refresh-workspace scan: completion confirms in the status line.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<crate::files::WorkspaceFile>>();
    app.workspace_scan_rx = Some(rx);
    app.workspace_refresh_pending = true;
    tx.send(Vec::new()).unwrap();
    assert!(app.poll_workspace_scan());
    assert!(app.workspace_files.is_empty());
    assert_eq!(
        app.state.status.as_deref(),
        Some("Workspace files refreshed")
    );

    // A dead scan thread (sender dropped) clears the pending refresh flag.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<crate::files::WorkspaceFile>>();
    app.workspace_scan_rx = Some(rx);
    app.workspace_refresh_pending = true;
    drop(tx);
    assert!(!app.poll_workspace_scan());
    assert!(app.workspace_scan_rx.is_none());
    assert!(!app.workspace_refresh_pending);
}

// ─────────────────────────────────────────────────────────────────────────
// Spawned Tool Execution Tests
// ─────────────────────────────────────────────────────────────────────────

/// Poll until a spawned tool completion lands, failing after `secs`.
async fn await_tool_completion(app: &mut App, secs: u64) {
    let completed = tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            if app.poll_tool_completions() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(completed.is_ok(), "tool completion timed out");
}

#[tokio::test]
async fn test_tool_execution_runs_on_spawned_task_and_responds() {
    let mut app = new_test_app();
    // Skip session-file writes from record_tool_result in the test.
    app.session_resume_failed = true;
    let (tx, mut rx) = mpsc::unbounded_channel();
    app.tool_response_tx = Some(tx);

    app.execute_tool_and_respond(
        "call-1".to_string(),
        "bash".to_string(),
        serde_json::json!({"command": "echo hello-from-tool"}),
    );
    // The call returns immediately; execution is in flight, not awaited inline.
    assert!(app.running_tools.contains_key("call-1"));

    await_tool_completion(&mut app, 10).await;
    assert!(app.running_tools.is_empty());

    let (call_id, success, result) = rx.try_recv().expect("tool response sent");
    assert_eq!(call_id, "call-1");
    assert!(success);
    assert!(result.unwrap().output.contains("hello-from-tool"));
}

#[tokio::test]
async fn test_cancel_running_tools_kills_long_command() {
    let mut app = new_test_app();
    app.session_resume_failed = true;
    let (tx, mut rx) = mpsc::unbounded_channel();
    app.tool_response_tx = Some(tx);

    app.execute_tool_and_respond(
        "call-2".to_string(),
        "bash".to_string(),
        serde_json::json!({"command": "sleep 60", "timeout": 60_000}),
    );
    // Let the task spawn the child, then interrupt (the Ctrl+C path).
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.cancel_running_tools();
    assert!(app.running_tools.is_empty());

    // The 60s command must finish promptly once cancelled.
    await_tool_completion(&mut app, 10).await;

    // The tuple bool is the "executed (not denied)" flag; the tool result
    // itself must report the cancellation failure.
    let (call_id, answered, result) = rx.try_recv().expect("tool response sent");
    assert_eq!(call_id, "call-2");
    assert!(answered);
    let result = result.unwrap();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Command cancelled"));
}

#[test]
fn test_update_viewport_capabilities_on_resize() {
    let mut app = new_test_app();
    // new_test_app starts with viewport_top 1, viewport_height 24.

    // Growing the terminal recomputes both fields.
    assert!(app.update_viewport_capabilities(40));
    assert_eq!(app.capabilities.viewport_height, 38);
    assert_eq!(app.capabilities.viewport_top, 3);

    // Same height again: no change (the caller skips terminal recreation).
    assert!(!app.update_viewport_capabilities(40));

    // Very small terminals clamp to the 10-row minimum.
    assert!(app.update_viewport_capabilities(8));
    assert_eq!(app.capabilities.viewport_height, 10);
    assert_eq!(app.capabilities.viewport_top, 1);
}

#[test]
fn test_handle_paste_routes_to_modal_or_main_input() {
    let mut app = new_test_app();

    // No modal: paste goes to the main input and strips carriage returns.
    app.handle_paste("hello\r\nworld");
    assert_eq!(app.state.input(), "hello\nworld");

    // A modal with a text input consumes the paste; the main input is
    // left untouched (previously the paste vanished into the catch-all).
    for modal in [
        ActiveModal::FileSearch,
        ActiveModal::SessionSwitcher,
        ActiveModal::CommandPalette,
        ActiveModal::ModelSelector,
        ActiveModal::ThemeSelector,
    ] {
        app.active_modal = modal;
        app.handle_paste("query text");
        assert_eq!(
            app.state.input(),
            "hello\nworld",
            "paste leaked into main input while {modal:?} was open"
        );
    }

    // A modal without a text input ignores pastes entirely.
    app.active_modal = ActiveModal::ShortcutsHelp;
    app.handle_paste("ignored");
    assert_eq!(app.state.input(), "hello\nworld");
}

#[tokio::test]
async fn test_queue_counts_sync_on_response_start() {
    let mut app = new_test_app();

    let follow_up_id = app.reserve_queue_id();
    let steer_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(
        follow_up_id,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.enqueue_pending_prompt(steer_id, "steer".to_string(), PromptKind::Steer, false);
    assert_eq!(app.state.queued_prompt_count, 2);
    assert_eq!(app.state.queued_follow_up_count, 1);
    assert_eq!(app.state.queued_steering_count, 1);

    app.state.busy = false;
    app.handle_agent_message(FromAgent::ResponseStart {
        response_id: "resp-1".to_string(),
    })
    .await
    .expect("handle response start");

    assert_eq!(app.state.queued_prompt_count, 1);
    assert_eq!(app.state.queued_follow_up_count, 0);
    assert_eq!(app.state.queued_steering_count, 1);
}

#[tokio::test]
async fn test_queue_response_start_drains_all_leading_steers_in_all_mode() {
    let mut app = new_test_app();

    let steer_one = app.reserve_queue_id();
    let steer_two = app.reserve_queue_id();
    let follow_up = app.reserve_queue_id();
    app.enqueue_pending_prompt(steer_one, "steer one".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(steer_two, "steer two".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(
        follow_up,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );

    app.handle_agent_message(FromAgent::ResponseStart {
        response_id: "resp-batch".to_string(),
    })
    .await
    .expect("handle response start");

    assert_eq!(app.state.queued_prompt_count, 1);
    assert_eq!(app.state.queued_steering_count, 0);
    assert_eq!(app.state.queued_follow_up_count, 1);
    assert_eq!(
        app.queued_prompt_active.as_ref().map(|prompt| prompt.id),
        Some(steer_one)
    );
}

#[test]
fn test_queue_enqueue_pending_prompt_preserves_steer_fifo() {
    let mut app = new_test_app();

    let steer_one = app.reserve_queue_id();
    let follow_up = app.reserve_queue_id();
    let steer_two = app.reserve_queue_id();
    app.enqueue_pending_prompt(steer_one, "steer one".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(
        follow_up,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.enqueue_pending_prompt(steer_two, "steer two".to_string(), PromptKind::Steer, true);

    let ordered: Vec<(u64, PromptKind)> = app
        .queued_prompts
        .iter()
        .map(|prompt| (prompt.id, prompt.kind))
        .collect();
    assert_eq!(
        ordered,
        vec![
            (steer_one, PromptKind::Steer),
            (steer_two, PromptKind::Steer),
            (follow_up, PromptKind::FollowUp),
        ]
    );
}

#[test]
fn test_describe_next_queue_batch_is_mode_aware() {
    assert_eq!(
        App::describe_next_queue_batch(0, QueueMode::All, "after turn end"),
        None
    );
    assert_eq!(
        App::describe_next_queue_batch(1, QueueMode::All, "after turn end"),
        Some("1 message after turn end".to_string())
    );
    assert_eq!(
        App::describe_next_queue_batch(3, QueueMode::All, "after turn end"),
        Some("all 3 messages after turn end".to_string())
    );
    assert_eq!(
        App::describe_next_queue_batch(3, QueueMode::One, "at the next tool boundary"),
        Some("1 of 3 messages at the next tool boundary".to_string())
    );
}

#[test]
fn test_merge_queued_prompt_batch_joins_non_empty_segments() {
    let merged = App::merge_queued_prompt_batch(&[
        QueuedPrompt {
            id: 1,
            content: "steer first".to_string(),
            kind: PromptKind::Steer,
        },
        QueuedPrompt {
            id: 2,
            content: "   ".to_string(),
            kind: PromptKind::Steer,
        },
        QueuedPrompt {
            id: 3,
            content: "steer second".to_string(),
            kind: PromptKind::Steer,
        },
    ]);

    assert_eq!(merged, "steer first\n\nsteer second");
}

#[test]
fn test_drain_queued_steering_batch_for_interrupt_respects_mode() {
    let mut app = new_test_app();
    let steer_one = app.reserve_queue_id();
    let steer_two = app.reserve_queue_id();
    let follow_up = app.reserve_queue_id();
    app.enqueue_pending_prompt(steer_one, "steer one".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(steer_two, "steer two".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(
        follow_up,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );

    let drained_all = app.drain_queued_steering_batch_for_interrupt();
    assert_eq!(drained_all.len(), 2);
    assert_eq!(app.queued_prompts.len(), 1);
    assert_eq!(app.queued_prompts.front().unwrap().id, follow_up);

    let mut app = new_test_app();
    app.state.steering_mode = QueueMode::One;
    let steer_one = app.reserve_queue_id();
    let steer_two = app.reserve_queue_id();
    app.enqueue_pending_prompt(steer_one, "steer one".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(steer_two, "steer two".to_string(), PromptKind::Steer, true);

    let drained_one = app.drain_queued_steering_batch_for_interrupt();
    assert_eq!(drained_one.len(), 1);
    assert_eq!(drained_one[0].id, steer_one);
    assert_eq!(app.queued_prompts.front().unwrap().id, steer_two);
}

#[tokio::test]
async fn test_queue_counts_clear_on_interrupt() {
    let mut app = new_test_app();

    let follow_up_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(
        follow_up_id,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.state.busy = true;

    app.handle_key(KeyCode::Char('c'), CrosstermModifiers::CONTROL)
        .await
        .expect("interrupt");

    assert_eq!(app.state.input(), "follow-up");
    assert_eq!(app.state.queued_prompt_count, 0);
    assert!(app.queued_prompts.is_empty());
}

#[tokio::test]
async fn test_interrupt_restore_merges_existing_input_after_queued_prompts() {
    let mut app = new_test_app();

    let follow_up_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(
        follow_up_id,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.state.set_input("existing draft");
    app.state.busy = true;

    app.handle_key(KeyCode::Char('c'), CrosstermModifiers::CONTROL)
        .await
        .expect("interrupt");

    assert_eq!(app.state.input(), "follow-up\n\nexisting draft");
    assert_eq!(app.state.queued_prompt_count, 0);
    assert!(app.queued_prompts.is_empty());
}

#[tokio::test]
async fn test_interrupt_with_queued_steer_restores_steering_batch_without_agent() {
    let mut app = new_test_app();

    let steer_id = app.reserve_queue_id();
    let follow_up_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(steer_id, "steer".to_string(), PromptKind::Steer, true);
    app.enqueue_pending_prompt(
        follow_up_id,
        "follow-up".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.state.busy = true;

    app.handle_key(KeyCode::Char('c'), CrosstermModifiers::CONTROL)
        .await
        .expect("interrupt");

    assert_eq!(app.state.input(), "steer");
    assert_eq!(app.state.queued_prompt_count, 1);
    assert_eq!(app.state.queued_follow_up_count, 1);
    assert_eq!(app.queued_prompts.front().unwrap().id, follow_up_id);
}

#[tokio::test]
async fn test_queue_overflow_with_inflight_does_not_drop() {
    let mut app = new_test_app();

    for _ in 0..MAX_PENDING_MESSAGES {
        let id = app.reserve_queue_id();
        app.enqueue_pending_prompt(id, "follow-up".to_string(), PromptKind::FollowUp, false);
    }

    let inflight_id = app.queued_prompts.front().unwrap().id;
    app.queued_prompt_inflight = Some(QueuedPromptCursor { id: inflight_id });
    app.sync_queue_prompt_count();

    let new_id = app.reserve_queue_id();
    let dropped =
        app.enqueue_pending_prompt(new_id, "extra".to_string(), PromptKind::FollowUp, false);

    assert!(dropped.is_none());
    assert_eq!(app.queued_prompts.len(), MAX_PENDING_MESSAGES + 1);
    assert_eq!(app.state.queued_prompt_count, MAX_PENDING_MESSAGES);
}

#[test]
fn test_queue_cancel_by_id() {
    let mut app = new_test_app();

    let first_id = app.reserve_queue_id();
    let second_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(first_id, "first".to_string(), PromptKind::FollowUp, false);
    app.enqueue_pending_prompt(second_id, "second".to_string(), PromptKind::Steer, false);

    app.handle_queue_action(QueueAction::Cancel { id: first_id });

    assert_eq!(app.queued_prompts.len(), 1);
    assert_eq!(app.queued_prompts.front().unwrap().id, second_id);
    assert_eq!(app.state.queued_prompt_count, 1);
}

#[tokio::test]
async fn test_alt_up_restores_most_recent_queued_follow_up() {
    let mut app = new_test_app();
    app.queued_follow_up_edit_binding = crate::key_hints::alt(KeyCode::Up);
    app.state.queued_follow_up_edit_binding_label = "Alt+Up".to_string();

    let follow_up_id = app.reserve_queue_id();
    let steer_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(
        follow_up_id,
        "follow-up draft".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.enqueue_pending_prompt(
        steer_id,
        "pending steer".to_string(),
        PromptKind::Steer,
        true,
    );

    app.handle_key(KeyCode::Up, CrosstermModifiers::ALT)
        .await
        .expect("restore queued follow-up");

    assert_eq!(app.state.input(), "follow-up draft");
    assert_eq!(app.state.queued_follow_up_count, 0);
    assert_eq!(app.state.queued_steering_count, 1);
    assert_eq!(app.queued_prompts.len(), 1);
    assert_eq!(app.queued_prompts.front().unwrap().id, steer_id);
}

#[tokio::test]
async fn test_alt_up_cycles_to_older_queued_follow_up_without_losing_current_draft() {
    let mut app = new_test_app();
    app.queued_follow_up_edit_binding = crate::key_hints::alt(KeyCode::Up);
    app.state.queued_follow_up_edit_binding_label = "Alt+Up".to_string();

    let first_id = app.reserve_queue_id();
    let second_id = app.reserve_queue_id();
    app.enqueue_pending_prompt(
        first_id,
        "follow-up first".to_string(),
        PromptKind::FollowUp,
        false,
    );
    app.enqueue_pending_prompt(
        second_id,
        "follow-up second".to_string(),
        PromptKind::FollowUp,
        false,
    );

    app.handle_key(KeyCode::Up, CrosstermModifiers::ALT)
        .await
        .expect("restore newest queued follow-up");
    assert_eq!(app.state.input(), "follow-up second");

    app.state.set_input("follow-up second edited");

    app.handle_key(KeyCode::Up, CrosstermModifiers::ALT)
        .await
        .expect("cycle to older queued follow-up");

    assert_eq!(app.state.input(), "follow-up first");
    let queued: Vec<(u64, String)> = app
        .queued_prompts
        .iter()
        .map(|prompt| (prompt.id, prompt.content.clone()))
        .collect();
    assert_eq!(
        queued,
        vec![(second_id, "follow-up second edited".to_string())]
    );
}

#[test]
fn test_queued_follow_up_edit_binding_prefers_shift_left_for_special_terminals() {
    assert_eq!(
        queued_follow_up_edit_binding_for_terminal_name("Apple_Terminal", false),
        crate::key_hints::shift(KeyCode::Left)
    );
    assert_eq!(
        queued_follow_up_edit_binding_for_terminal_name("WarpTerminal", false),
        crate::key_hints::shift(KeyCode::Left)
    );
    assert_eq!(
        queued_follow_up_edit_binding_for_terminal_name("vscode", false),
        crate::key_hints::shift(KeyCode::Left)
    );
    assert_eq!(
        queued_follow_up_edit_binding_for_terminal_name("WezTerm", false),
        crate::key_hints::alt(KeyCode::Up)
    );
    assert_eq!(
        queued_follow_up_edit_binding_for_terminal_name("iTerm.app", true),
        crate::key_hints::shift(KeyCode::Left)
    );
}

#[test]
fn test_should_queue_follow_up_on_tab_only_when_busy_with_non_command_input() {
    let mut app = new_test_app();
    assert!(!app.should_queue_follow_up_on_tab());

    app.state.busy = true;
    app.state.follow_up_mode = QueueMode::One;
    app.state.set_input("follow-up");
    assert!(!app.should_queue_follow_up_on_tab());

    app.state.follow_up_mode = QueueMode::All;
    app.state.set_input("");
    assert!(!app.should_queue_follow_up_on_tab());

    app.state.set_input("/help");
    assert!(!app.should_queue_follow_up_on_tab());

    app.state.set_input("!ls");
    assert!(!app.should_queue_follow_up_on_tab());

    app.state.set_input("follow-up");
    assert!(app.should_queue_follow_up_on_tab());
}

#[test]
fn test_should_submit_on_tab_only_when_idle_with_non_blocked_input() {
    let mut app = new_test_app();
    assert!(!app.should_submit_on_tab());

    app.state.busy = true;
    app.state.set_input("submit me");
    assert!(!app.should_submit_on_tab());

    app.state.busy = false;
    app.state.set_input("");
    assert!(!app.should_submit_on_tab());

    app.state.set_input("   ");
    assert!(!app.should_submit_on_tab());

    app.state.set_input("!ls");
    assert!(!app.should_submit_on_tab());

    app.state.set_input("/help");
    assert!(!app.should_submit_on_tab());

    app.state.set_input(" /help");
    assert!(!app.should_submit_on_tab());

    app.state.set_input("submit me");
    assert!(app.should_submit_on_tab());
}

#[test]
fn test_show_help_uses_maestro_branding() {
    let mut app = new_test_app();
    app.show_help();

    let last = app.state.messages.last().expect("help message");
    assert!(last.content.contains("Maestro TUI - Keyboard Shortcuts"));
    assert!(!last.content.contains("Composer TUI - Keyboard Shortcuts"));
}

#[test]
fn test_show_help_uses_rebound_shortcut_labels() {
    let _guard = acquire_keybindings_test_lock();
    let temp = tempdir().expect("tempdir");
    let config_path = temp.path().join("keybindings.json");
    std::fs::write(
        &config_path,
        r#"{
  "version": 1,
  "rustBindings": {
"command-palette": "Ctrl+O",
"file-search": "Ctrl+P",
"toggle-tool-outputs": "Shift+Left"
  }
}"#,
    )
    .expect("write keybindings");

    std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &config_path);
    let mut app = new_test_app();
    app.show_help();
    std::env::remove_var("MAESTRO_KEYBINDINGS_FILE");

    let last = app.state.messages.last().expect("help message");
    assert!(last
        .content
        .lines()
        .any(|line| line.contains("Open command palette") && !line.contains("Ctrl+P")));
    assert!(last
        .content
        .lines()
        .any(|line| line.contains("Open file search") && !line.contains("Ctrl+O")));
    assert!(last
        .content
        .lines()
        .any(|line| { line.contains("Toggle tool call expansion") && !line.contains("Ctrl+T") }));
}

#[test]
fn test_invalid_keybindings_config_surfaces_startup_warning() {
    let _guard = acquire_keybindings_test_lock();
    let temp = tempdir().expect("tempdir");
    let config_path = temp.path().join("keybindings.json");
    std::fs::write(
        &config_path,
        r#"{
  "version": 1,
  "rustBindings": {
"command-palette": "Ctrl+O",
"file-search": "Ctrl+O"
  }
}"#,
    )
    .expect("write keybindings");

    std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &config_path);
    let app = new_test_app();
    std::env::remove_var("MAESTRO_KEYBINDINGS_FILE");

    let first = app.state.messages.first().expect("startup warning");
    assert!(first
        .content
        .contains("Keyboard shortcuts config has 1 issue. Run /hotkeys validate."));
}

#[tokio::test]
async fn test_rebound_shortcuts_open_expected_modals() {
    let _guard = acquire_keybindings_test_lock_async().await;
    let temp = tempdir().expect("tempdir");
    let config_path = temp.path().join("keybindings.json");
    std::fs::write(
        &config_path,
        r#"{
  "version": 1,
  "rustBindings": {
"command-palette": "Ctrl+O",
"file-search": "Ctrl+P"
  }
}"#,
    )
    .expect("write keybindings");

    std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &config_path);
    let mut app = new_test_app();
    std::env::remove_var("MAESTRO_KEYBINDINGS_FILE");

    app.handle_key(KeyCode::Char('o'), CrosstermModifiers::CONTROL)
        .await
        .expect("open command palette");
    assert_eq!(app.active_modal, ActiveModal::CommandPalette);

    app.active_modal = ActiveModal::None;
    app.handle_key(KeyCode::Char('p'), CrosstermModifiers::CONTROL)
        .await
        .expect("open file search");
    assert_eq!(app.active_modal, ActiveModal::FileSearch);
}

#[tokio::test]
async fn test_handle_config_event_reloads_keybindings() {
    let _guard = acquire_keybindings_test_lock_async().await;
    let temp = tempdir().expect("tempdir");
    let config_path = temp.path().join("keybindings.json");
    std::fs::write(
        &config_path,
        r#"{
  "version": 1,
  "rustBindings": {
"command-palette": "Ctrl+O",
"file-search": "Ctrl+P",
"toggle-tool-outputs": "Shift+Left"
  }
}"#,
    )
    .expect("write keybindings");

    std::env::set_var("MAESTRO_KEYBINDINGS_FILE", &config_path);
    let mut app = new_test_app();

    std::fs::write(
        &config_path,
        r#"{
  "version": 1,
  "rustBindings": {
"command-palette": "Ctrl+P",
"file-search": "Ctrl+O",
"toggle-tool-outputs": "Ctrl+T",
"edit-last-follow-up": "Shift+Left"
  }
}"#,
    )
    .expect("rewrite keybindings");

    app.handle_config_event(ConfigEvent::Changed(config_path.clone()))
        .await;
    std::env::remove_var("MAESTRO_KEYBINDINGS_FILE");

    let expected_command_palette = crate::key_hints::ctrl(KeyCode::Char('p')).display();
    let expected_file_search = crate::key_hints::ctrl(KeyCode::Char('o')).display();
    let expected_toggle_tool_outputs = crate::key_hints::ctrl(KeyCode::Char('t')).display();
    let expected_edit_last_follow_up = crate::key_hints::shift(KeyCode::Left).display();

    assert_eq!(
        app.command_palette_binding.display(),
        expected_command_palette
    );
    assert_eq!(app.file_search_binding.display(), expected_file_search);
    assert_eq!(
        app.toggle_tool_outputs_binding.display(),
        expected_toggle_tool_outputs
    );
    assert_eq!(
        app.state.queued_follow_up_edit_binding_label,
        expected_edit_last_follow_up
    );

    app.show_help();
    let last = app.state.messages.last().expect("help message");
    assert!(last
        .content
        .lines()
        .any(|line| line.contains("Open command palette")
            && line.contains(expected_command_palette.as_str())));
    assert!(last
        .content
        .lines()
        .any(|line| line.contains("Open file search")
            && line.contains(expected_file_search.as_str())));
}

#[tokio::test]
async fn test_tab_submits_when_idle_with_non_shell_input() {
    let mut app = new_test_app();
    app.state.set_input("ship it");

    app.handle_key(KeyCode::Tab, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert_eq!(app.state.input(), "");
    let last = app.state.messages.last().expect("user message");
    assert_eq!(last.role, MessageRole::User);
    assert_eq!(last.content, "ship it");
}

#[tokio::test]
async fn test_tab_does_not_submit_idle_shell_draft() {
    let mut app = new_test_app();
    let initial_message_count = app.state.messages.len();
    app.state.set_input("!ls");

    app.handle_key(KeyCode::Tab, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert_eq!(app.state.input(), "!ls");
    assert_eq!(app.state.messages.len(), initial_message_count);
}

#[tokio::test]
async fn test_tab_does_not_submit_idle_slash_draft_with_leading_space() {
    let mut app = new_test_app();
    let initial_message_count = app.state.messages.len();
    app.state.set_input(" /help");

    app.handle_key(KeyCode::Tab, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert_eq!(app.state.input(), " /help");
    assert_eq!(app.state.messages.len(), initial_message_count);
}

#[tokio::test]
async fn test_alt_enter_inserts_newline_when_idle() {
    let mut app = new_test_app();
    app.state.set_input("hello");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::ALT)
        .await
        .unwrap();

    assert_eq!(app.state.input(), "hello\n");
}

#[tokio::test]
async fn test_alt_enter_inserts_newline_for_busy_shell_draft() {
    let mut app = new_test_app();
    app.state.busy = true;
    app.state.set_input("!ls");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::ALT)
        .await
        .unwrap();

    assert_eq!(app.state.input(), "!ls\n");
    assert_eq!(app.state.queued_prompt_count, 0);
}

#[tokio::test]
async fn test_queue_counts_clear_on_error() {
    let mut app = new_test_app();

    let id = app.reserve_queue_id();
    app.enqueue_pending_prompt(id, "follow-up".to_string(), PromptKind::FollowUp, false);
    app.queued_prompt_inflight = Some(QueuedPromptCursor { id });
    app.sync_queue_prompt_count();

    app.state.busy = true;
    app.handle_agent_message(FromAgent::Error {
        message: "oops".to_string(),
        fatal: false,
    })
    .await
    .expect("handle error");

    assert!(!app.state.busy);
    assert!(app.queued_prompt_inflight.is_none());
    assert_eq!(app.state.queued_prompt_count, 1);
}

#[tokio::test]
async fn test_alerts_command_lists_recorded_alerts() {
    use crate::commands::CommandAction;

    let mut app = new_test_app();
    app.handle_agent_message(FromAgent::Error {
        message: "API error 400 Bad Request: invalid_request_error: messages.0: empty".to_string(),
        fatal: false,
    })
    .await
    .expect("handle error");
    app.handle_agent_message(FromAgent::Error {
        message: "API error 429 Too Many Requests: rate_limit_error: slow down".to_string(),
        fatal: false,
    })
    .await
    .expect("handle error");
    assert_eq!(app.state.unseen_alerts, 2);

    app.handle_command_action(CommandAction::ShowAlerts).await;

    let listing = &app
        .state
        .messages
        .last()
        .expect("alerts listing message")
        .content;
    assert!(listing.contains("2 recorded"), "listing: {listing}");
    assert!(
        listing.contains("invalid_request_error: messages.0: empty"),
        "listing: {listing}"
    );
    assert!(
        listing.contains("rate_limit_error: slow down"),
        "listing: {listing}"
    );
    assert_eq!(app.state.unseen_alerts, 0);
}

#[tokio::test]
async fn test_alerts_command_without_alerts() {
    use crate::commands::CommandAction;

    let mut app = new_test_app();
    app.handle_command_action(CommandAction::ShowAlerts).await;

    let listing = &app
        .state
        .messages
        .last()
        .expect("alerts listing message")
        .content;
    assert!(listing.contains("No alerts recorded"), "listing: {listing}");
}

#[tokio::test]
async fn test_new_session_clears_error_surface_and_alerts() {
    use crate::commands::{CommandAction, SessionAction};

    let mut app = new_test_app();
    app.state.error = Some("stale API error".to_string());
    app.state.record_alert("stale API error".to_string());
    app.state
        .add_system_message("old transcript line".to_string());

    app.handle_command_action(CommandAction::Session(SessionAction::New))
        .await;

    assert!(app.state.error.is_none(), "error surface must be cleared");
    assert!(app.state.alerts.is_empty(), "alert history resets");
    assert_eq!(app.state.unseen_alerts, 0);
    assert!(
        !app.state
            .messages
            .iter()
            .any(|m| m.content.contains("old transcript line")),
        "old transcript must not survive /clear"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Input Cursor Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_cursor_movement() {
    let mut state = AppState::new();
    state.set_input("Hello World");

    // Cursor starts at end
    let initial_cursor = state.cursor();

    state.move_left();
    assert!(state.cursor() < initial_cursor || initial_cursor == 0);

    state.move_right();
    // Cursor should move right (or stay at end)

    state.move_home();
    assert_eq!(state.cursor(), 0);

    state.move_end();
    assert_eq!(state.cursor(), state.input().len());
}

#[test]
fn test_delete_operation() {
    let mut state = AppState::new();
    state.set_input("Hello");
    state.move_home();
    state.delete(); // Delete 'H'
    assert_eq!(state.input(), "ello");
}

// ─────────────────────────────────────────────────────────────────────────
// Error and Status Message Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_error_and_status_fields() {
    let mut state = AppState::new();

    assert!(state.error.is_none());
    assert!(state.status.is_none());

    state.error = Some("Test error".to_string());
    assert_eq!(state.error, Some("Test error".to_string()));

    state.status = Some("Connected".to_string());
    assert_eq!(state.status, Some("Connected".to_string()));
}

#[test]
fn test_render_mcp_status_lines_include_source_transport_and_error() {
    let lines = render_mcp_status_lines(&[crate::tools::McpServerStatus {
        name: "remote".to_string(),
        connected: false,
        scope: McpConfigScope::Project,
        transport: McpTransport::Sse,
        error: Some("Connection refused".to_string()),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
    }]);

    let rendered = lines.join("\n");
    assert!(rendered.contains("- remote (disconnected)"));
    assert!(rendered.contains("Source: Project config"));
    assert!(rendered.contains("Transport: SSE"));
    assert!(rendered.contains("Error: Connection refused"));
}

#[test]
fn test_render_mcp_status_lines_use_blank_error_fallback() {
    let lines = render_mcp_status_lines(&[crate::tools::McpServerStatus {
        name: "offline".to_string(),
        connected: false,
        scope: McpConfigScope::User,
        transport: McpTransport::Stdio,
        error: Some("   ".to_string()),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
    }]);

    let rendered = lines.join("\n");
    assert!(rendered.contains("Error: Connection failed."));
}

#[test]
fn test_render_mcp_prompt_lines_include_metadata_and_argument_summaries() {
    let lines = render_mcp_prompt_lines(
        &[(
            "docs".to_string(),
            vec![McpPrompt {
                name: "summarize".to_string(),
                title: Some("Summarize Docs".to_string()),
                description: Some("Summarize the selected documentation.".to_string()),
                arguments: Some(vec![crate::mcp::McpPromptArgument {
                    name: "topic".to_string(),
                    description: Some("Topic to summarize".to_string()),
                    required: true,
                }]),
            }],
        )],
        None,
    );

    let rendered = lines.join("\n");
    assert!(rendered.contains("docs:"));
    assert!(rendered.contains("  summarize"));
    assert!(rendered.contains("    title: Summarize Docs"));
    assert!(rendered.contains("    description: Summarize the selected documentation."));
    assert!(rendered.contains("    args: topic (required): Topic to summarize"));
    assert!(rendered.contains("Usage: /mcp prompts <server> <name> [KEY=value ...]"));
}

#[test]
fn test_render_mcp_prompt_lines_show_server_specific_empty_state() {
    let lines = render_mcp_prompt_lines(&[], Some("docs"));
    let rendered = lines.join("\n");
    assert!(rendered.contains("Server 'docs' does not expose prompts."));
}

#[test]
fn test_is_mcp_config_path_matches_supported_files() {
    assert!(is_mcp_config_path(std::path::Path::new(
        ".composer/mcp.json"
    )));
    assert!(is_mcp_config_path(std::path::Path::new(
        ".composer/mcp.local.json"
    )));
    assert!(is_mcp_config_path(std::path::Path::new(
        "/tmp/home/.composer/enterprise/mcp.json"
    )));
    assert!(!is_mcp_config_path(std::path::Path::new(
        ".composer/config.toml"
    )));
}

#[test]
fn test_update_mcp_badge_counts_tracks_failures() {
    let mut app = new_test_app();
    app.update_mcp_badge_counts(&[
        crate::tools::McpServerStatus {
            name: "connected".to_string(),
            connected: true,
            scope: McpConfigScope::Project,
            transport: McpTransport::Stdio,
            error: None,
            tools: vec!["read".to_string(), "write".to_string()],
            resources: Vec::new(),
            prompts: Vec::new(),
        },
        crate::tools::McpServerStatus {
            name: "failed".to_string(),
            connected: false,
            scope: McpConfigScope::User,
            transport: McpTransport::Http,
            error: Some("timed out".to_string()),
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
        },
    ]);

    assert_eq!(app.state.mcp_connected, 1);
    assert_eq!(app.state.mcp_tool_count, 2);
    assert_eq!(app.state.mcp_failed, 1);
}

#[test]
fn test_format_mcp_server_transition_status_for_connection() {
    let status = format_mcp_server_transition_status(
        None,
        Some(&crate::tools::McpServerStatus {
            name: "docs".to_string(),
            connected: true,
            scope: McpConfigScope::Project,
            transport: McpTransport::Stdio,
            error: None,
            tools: vec!["read".to_string(), "write".to_string()],
            resources: Vec::new(),
            prompts: Vec::new(),
        }),
    );

    assert_eq!(
        status.as_deref(),
        Some("MCP server \"docs\" connected (2 tools)")
    );
}

#[test]
fn test_format_mcp_server_transition_status_for_disconnection() {
    let previous = crate::tools::McpServerStatus {
        name: "docs".to_string(),
        connected: true,
        scope: McpConfigScope::Project,
        transport: McpTransport::Stdio,
        error: None,
        tools: vec!["read".to_string()],
        resources: Vec::new(),
        prompts: Vec::new(),
    };

    let status = format_mcp_server_transition_status(Some(&previous), None);

    assert_eq!(status.as_deref(), Some("MCP server \"docs\" disconnected"));
}

#[test]
fn test_format_mcp_server_transition_status_for_error_change() {
    let previous = crate::tools::McpServerStatus {
        name: "docs".to_string(),
        connected: false,
        scope: McpConfigScope::Project,
        transport: McpTransport::Stdio,
        error: Some("timed out".to_string()),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
    };
    let current = crate::tools::McpServerStatus {
        name: "docs".to_string(),
        connected: false,
        scope: McpConfigScope::Project,
        transport: McpTransport::Stdio,
        error: Some(String::new()),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
    };

    let status = format_mcp_server_transition_status(Some(&previous), Some(&current));

    assert_eq!(
        status.as_deref(),
        Some("MCP server \"docs\" error: Connection failed.")
    );
}

#[tokio::test]
async fn test_handle_config_event_forces_mcp_badge_refresh() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(temp.path().join(".composer")).expect("create config dir");

    let mut app = new_test_app();
    app.tool_executor = Arc::new(ToolExecutor::new(temp.path().display().to_string()));
    app.last_mcp_status_refresh = Some(Instant::now());
    app.state.mcp_connected = 7;
    app.state.mcp_tool_count = 9;
    app.state.mcp_failed = 2;

    app.handle_config_event(ConfigEvent::Changed(std::path::PathBuf::from(
        ".composer/mcp.json",
    )))
    .await;

    assert_eq!(app.state.mcp_connected, 0);
    assert_eq!(app.state.mcp_tool_count, 0);
    assert_eq!(app.state.mcp_failed, 0);
    assert!(app.last_mcp_status_refresh.is_some());
}

#[tokio::test]
async fn test_handle_config_event_reports_watcher_errors() {
    let mut app = new_test_app();

    app.handle_config_event(ConfigEvent::Error("watch failed".to_string()))
        .await;

    assert_eq!(
        app.state.status.as_deref(),
        Some("Config watcher error: watch failed")
    );
}

#[test]
fn test_format_mcp_runtime_event_status_for_progress() {
    let status = format_mcp_runtime_event_status(&McpRuntimeEvent::Progress {
        server: "docs".to_string(),
        progress: 5.0,
        total: Some(8.0),
        message: Some("Indexing".to_string()),
    });

    assert_eq!(status.as_deref(), Some("MCP docs: Indexing (63%)"));
}

#[test]
fn test_format_mcp_runtime_event_status_for_warning_logs() {
    let status = format_mcp_runtime_event_status(&McpRuntimeEvent::Log {
        server: "docs".to_string(),
        level: "warning".to_string(),
        logger: Some("mcp".to_string()),
        data: serde_json::json!({"detail":"slow response"}),
    });

    assert_eq!(
        status.as_deref(),
        Some(r#"[docs] {"detail":"slow response"}"#)
    );
}

#[test]
fn test_format_mcp_runtime_event_status_ignores_info_logs() {
    let status = format_mcp_runtime_event_status(&McpRuntimeEvent::Log {
        server: "docs".to_string(),
        level: "info".to_string(),
        logger: None,
        data: serde_json::Value::String("ready".to_string()),
    });

    assert!(status.is_none());
}

// ─────────────────────────────────────────────────────────────────────────
// Session ID Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_session_id_handling() {
    let mut state = AppState::new();
    assert!(state.session_id.is_none());

    state.session_id = Some("session-123".to_string());
    assert_eq!(state.session_id, Some("session-123".to_string()));
}

// ─────────────────────────────────────────────────────────────────────────
// Tool Call Toggle Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_tool_call_toggle() {
    let mut state = AppState::new();
    let call_id = "call-123";

    // Default: expanded when compact mode is off
    assert!(state.is_tool_call_expanded(call_id));

    // Toggle off
    state.toggle_tool_call(call_id);
    assert!(!state.is_tool_call_expanded(call_id));

    // Toggle on
    state.toggle_tool_call(call_id);
    assert!(state.is_tool_call_expanded(call_id));
}

#[test]
fn test_multiple_tool_calls_expansion() {
    let mut state = AppState::new();
    state.compact_tool_outputs = true;

    state.toggle_tool_call("call-1");
    state.toggle_tool_call("call-2");

    assert!(state.is_tool_call_expanded("call-1"));
    assert!(state.is_tool_call_expanded("call-2"));
    assert!(!state.is_tool_call_expanded("call-3"));
}

// ─────────────────────────────────────────────────────────────────────────
// Thinking Toggle Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_thinking_toggle() {
    let mut state = AppState::new();

    // Add a user message and get its ID
    let msg_id = state.add_user_message("test".to_string());

    // Initially not expanded
    let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
    assert!(!msg.thinking_expanded);

    // Toggle on
    state.toggle_thinking(&msg_id);
    let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
    assert!(msg.thinking_expanded);

    // Toggle off
    state.toggle_thinking(&msg_id);
    let msg = state.messages.iter().find(|m| m.id == msg_id).unwrap();
    assert!(!msg.thinking_expanded);
}

#[test]
fn test_thinking_toggle_nonexistent() {
    let mut state = AppState::new();
    state.add_user_message("test".to_string());

    // Should not panic on nonexistent ID
    state.toggle_thinking("nonexistent-id");
}

// ─────────────────────────────────────────────────────────────────────────
// System Prompt Building Tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_system_prompt_contains_tools() {
    // Test that system prompts mention available tools
    let prompt_template = App::build_base_system_prompt("/tmp");

    assert!(prompt_template.contains("bash"));
    assert!(prompt_template.contains("read"));
    assert!(prompt_template.contains("write"));
    assert!(prompt_template.contains("glob"));
    assert!(prompt_template.contains("grep"));
}

#[test]
fn test_system_prompt_includes_year_hint() {
    let prompt = App::build_system_prompt_with_context("/tmp", 2026, None, "");

    assert!(prompt.contains("websearch/codesearch"));
    assert!(prompt.contains("current year (2026)"));
}

#[test]
fn side_messages_do_not_count_toward_compaction() {
    let mut state = AppState::new();
    state.add_side_question("side-1".into(), "Question".into());
    state.add_side_answer("side-1-answer".into(), "Answer".into(), false);
    assert!(state
        .messages
        .iter()
        .all(|message| !message.counts_toward_compaction_index()));
}

#[test]
fn open_plan_comments_block_approval() {
    let mut app = new_test_app();
    app.plan_review_comments.push(PlanReviewComment {
        id: 1,
        start_line: 1,
        end_line: 1,
        text: "Needs work".into(),
        revision: "revision".into(),
        excerpt: "line".into(),
        resolved: false,
    });
    app.approve_plan();
    assert!(app
        .state
        .error
        .as_deref()
        .is_some_and(|error| error.contains("1 open review comment")));
}

#[test]
fn rewind_is_blocked_while_busy() {
    let mut app = new_test_app();
    app.state.add_user_message("keep me".into());
    app.state.busy = true;
    app.rewind_turns(1, false);
    assert_eq!(app.state.messages.len(), 1);
    assert_eq!(
        app.state.status.as_deref(),
        Some("Wait for the active response to finish before rewinding.")
    );
}

#[test]
fn restore_side_questions_by_timestamp_without_model_history_entries() {
    let mut state = AppState::new();
    let session = ParsedSession {
        header: SessionHeader {
            version: Some(2),
            id: "ordered-side-questions".into(),
            timestamp: "2026-07-23T12:00:00Z".into(),
            cwd: "/tmp".into(),
            model: "openai/gpt-5.2".into(),
            subject: None,
            model_metadata: None,
            thinking_level: ThinkingLevel::Medium,
            system_prompt: None,
            prompt_metadata: None,
            prompt_context_manifest: None,
            unified_context_manifest: None,
            tools: Vec::new(),
            branched_from: None,
            parent_session: None,
        },
        messages: vec![
            AppMessage::User {
                content: MessageContent::Text("before".into()),
                attachments: None,
                timestamp: 1_000,
            },
            AppMessage::User {
                content: MessageContent::Text("after".into()),
                attachments: None,
                timestamp: 3_000,
            },
        ],
        meta: None,
        stats: Default::default(),
        thinking_level_changes: Vec::new(),
        model_changes: Vec::new(),
        compactions: Vec::new(),
        side_questions: vec![SideQuestionEntry {
            id: "side-1".into(),
            timestamp: "1970-01-01T00:00:02Z".into(),
            question: "side".into(),
            answer: String::new(),
            error: Some("provider unavailable".into()),
        }],
        plan_review_events: Vec::new(),
        usage_entries: Vec::new(),
        file_path: "/tmp/ordered-side-questions.jsonl".into(),
    };

    restore_visible_session_messages(&mut state, &session);

    assert_eq!(
        state
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        vec![
            "before",
            "side",
            "Side question failed: provider unavailable",
            "after"
        ]
    );
    assert_eq!(state.messages[1].kind, MessageKind::SideQuestion);
    assert_eq!(state.messages[2].kind, MessageKind::SideAnswer);
}

#[test]
fn stale_plan_comments_cannot_be_resolved_or_approved() {
    let dir = tempdir().unwrap();
    let plan_dir = dir.path().join(".maestro");
    std::fs::create_dir_all(&plan_dir).unwrap();
    let plan_path = plan_dir.join("plan.md");
    std::fs::write(&plan_path, "first\nselected\nlast\n").unwrap();

    let mut app = new_test_app();
    app.state.cwd = Some(dir.path().to_string_lossy().to_string());
    crate::plan_mode::set_active_session_id(None);
    app.handle_plan_review(PlanReviewAction::Comment {
        start_line: 2,
        end_line: 2,
        text: "review this".into(),
    });
    assert_eq!(app.plan_review_comments[0].excerpt, "selected");
    assert_eq!(
        app.plan_review_comments[0].revision,
        crate::plan_mode::plan_revision("first\nselected\nlast\n")
    );

    std::fs::write(&plan_path, "first\nchanged\nlast\n").unwrap();
    app.handle_plan_review(PlanReviewAction::Resolve { id: 1 });
    assert!(!app.plan_review_comments[0].resolved);
    assert!(app
        .state
        .error
        .as_deref()
        .is_some_and(|error| error.contains("stale")));

    app.plan_review_comments[0].resolved = true;
    app.state.error = None;
    app.approve_plan();
    assert!(app
        .state
        .error
        .as_deref()
        .is_some_and(|error| error.contains("Plan changed")));

    app.handle_plan_review(PlanReviewAction::List);
    assert!(app
        .state
        .messages
        .last()
        .is_some_and(|message| message.content.contains("[stale]")));
    crate::plan_mode::set_active_session_id(None);
}

#[test]
fn open_plan_comments_block_off_cycle_and_approval() {
    let mut app = new_test_app();
    app.plan_review_comments.push(PlanReviewComment {
        id: 1,
        start_line: 1,
        end_line: 1,
        text: "Needs work".into(),
        revision: "revision".into(),
        excerpt: "line".into(),
        resolved: false,
    });
    crate::safety::set_plan_mode(true);
    app.state.interaction_mode = crate::state::InteractionMode::Plan;

    app.apply_plan_mode(false);
    assert!(crate::safety::is_plan_mode());
    app.cycle_interaction_mode();
    assert!(crate::safety::is_plan_mode());
    app.approve_plan();
    assert!(crate::safety::is_plan_mode());

    crate::safety::set_plan_mode(false);
    crate::safety::set_plan_satisfied(true);
}

#[test]
fn fork_clears_plan_review_state_and_plan_session_identity() {
    let mut app = new_test_app();
    app.plan_review_comments.push(PlanReviewComment {
        id: 1,
        start_line: 1,
        end_line: 1,
        text: "Needs work".into(),
        revision: "revision".into(),
        excerpt: "line".into(),
        resolved: false,
    });
    crate::plan_mode::set_active_session_id(Some("old-session".into()));

    app.fork_session();

    assert!(app.plan_review_comments.is_empty());
    assert_eq!(crate::plan_mode::active_session_id(), None);
}

#[tokio::test]
async fn slash_unique_prefix_expands_and_executes() {
    let mut app = new_test_app();
    app.state.set_input("/qui");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert!(app.should_quit);
    assert_eq!(app.state.status.as_deref(), Some("Expanded /qui → /quit"));
}

#[tokio::test]
async fn slash_typo_rescue_expands_and_executes() {
    let mut app = new_test_app();
    app.state.set_input("/quti");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert!(app.should_quit);
    assert_eq!(
        app.state.status.as_deref(),
        Some("Interpreted /quti as /quit")
    );
}

#[tokio::test]
async fn slash_ambiguous_prefix_restores_input_and_opens_dropdown() {
    let mut app = new_test_app();
    app.state.set_input("/qu");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert!(!app.should_quit);
    assert_eq!(app.state.input(), "/qu");
    let error = app.state.error.as_deref().expect("ambiguity error");
    assert!(error.contains("Ambiguous command: /qu"));
    assert!(error.contains("/queue"));
    assert!(error.contains("/quit"));
    // The completion dropdown stays open so the user can pick a candidate.
    assert!(app.slash_state.has_completions());
}

#[tokio::test]
async fn slash_unknown_command_fallback_disabled_shows_error() {
    let mut app = new_test_app();
    app.state.unknown_slash_command_fallback = false;
    app.state.set_input("/zzznotacommand");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert!(!app.state.busy);
    let error = app.state.error.as_deref().expect("unknown command error");
    assert!(error.contains("Unknown command"));
}

#[tokio::test]
async fn slash_ghost_completion_accepted_with_right_arrow() {
    let mut app = new_test_app();
    app.state.set_input("/qui");
    app.update_slash_state();
    assert_eq!(app.state.ghost_completion.as_deref(), Some("t"));

    app.handle_key(KeyCode::Right, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert_eq!(app.state.input(), "/quit");
    assert!(app.state.ghost_completion.is_none());
}

#[tokio::test]
async fn slash_ghost_completion_hidden_when_cursor_not_at_end() {
    let mut app = new_test_app();
    app.state.set_input("/qui");
    app.update_slash_state();
    assert!(app.state.ghost_completion.is_some());

    app.handle_key(KeyCode::Left, CrosstermModifiers::NONE)
        .await
        .unwrap();
    app.update_slash_state();

    assert!(app.state.ghost_completion.is_none());
}

#[tokio::test]
async fn double_esc_clears_input() {
    let mut app = new_test_app();
    app.state.set_input("draft text");

    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .unwrap();
    // First Esc: draft kept, hint shown.
    assert_eq!(app.state.input(), "draft text");

    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert_eq!(app.state.input(), "");
}

#[tokio::test]
async fn esc_with_completions_only_dismisses_menu() {
    let mut app = new_test_app();
    app.state.set_input("/qu");
    app.update_slash_state();
    assert!(app.slash_state.has_completions());

    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert!(!app.slash_state.has_completions());
    assert_eq!(app.state.input(), "/qu");
}

#[tokio::test]
async fn loop_command_start_and_stop_via_handler() {
    let mut app = new_test_app();
    app.state.set_input("/loop 10m check the build");

    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert!(app.loop_schedule.is_some());
    assert_eq!(
        app.loop_schedule.as_ref().map(|s| s.interval.as_secs()),
        Some(600)
    );

    app.state.set_input("/loop stop");
    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();
    assert!(app.loop_schedule.is_none());
}

// ─────────────────────────────────────────────────────────────────────────
// Rewind Picker Tests (double-Esc on empty input)
// ─────────────────────────────────────────────────────────────────────────

/// Point the app's session manager at a temp sessions dir and give it a
/// session id so file checkpoints resolve to the fixture, not `$HOME`.
fn setup_rewind_session(app: &mut App) -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let sessions = tmp.path().join("sessions");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    app.session_manager = SessionManager::with_sessions_dir(
        repo.to_string_lossy().to_string(),
        sessions.to_string_lossy().to_string(),
    );
    app.state.session_id = Some("rewind-test".to_string());
    (tmp, repo)
}

/// Write a one-file checkpoint manifest (plus its pre-turn blob) directly
/// into the session's checkpoint store and set the file's current content.
fn write_rewind_checkpoint(
    app: &App,
    repo: &std::path::Path,
    id: &str,
    created_at: &str,
    pre: &str,
    post: &str,
) {
    use sha2::{Digest, Sha256};
    let hash = |content: &str| format!("{:x}", Sha256::digest(content.as_bytes()));

    let store =
        crate::checkpoints::CheckpointStore::new(app.session_manager.sessions_dir(), "rewind-test");
    let dir = store.root().join(id);
    std::fs::create_dir_all(dir.join("blobs")).unwrap();
    std::fs::write(dir.join("blobs").join(hash(pre)), pre).unwrap();
    std::fs::write(repo.join("a.rs"), post).unwrap();

    let checkpoint = crate::checkpoints::Checkpoint {
        id: id.to_string(),
        created_at: created_at.to_string(),
        prompt: format!("prompt for {id}"),
        repo_root: repo.to_path_buf(),
        head: None,
        entries: vec![crate::checkpoints::FileEntry {
            path: "a.rs".to_string(),
            kind: crate::checkpoints::EntryKind::Modified,
            pre_blob: Some(hash(pre)),
            post_hash: Some(hash(post)),
        }],
    };
    let bytes = serde_json::to_vec_pretty(&checkpoint).unwrap();
    std::fs::write(dir.join("checkpoint.json"), bytes).unwrap();
}

async fn press_esc(app: &mut App) {
    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .unwrap();
}

#[tokio::test]
async fn double_esc_on_empty_input_opens_rewind_picker() {
    let mut app = new_test_app();
    let (_tmp, repo) = setup_rewind_session(&mut app);
    write_rewind_checkpoint(
        &app,
        &repo,
        "cp-1",
        "2026-07-24T00:00:00Z",
        "original\n",
        "edit\n",
    );

    press_esc(&mut app).await;
    assert_eq!(app.active_modal, ActiveModal::None);
    assert_eq!(
        app.state.status.as_deref(),
        Some("Press Esc again to rewind files")
    );

    press_esc(&mut app).await;
    assert_eq!(app.active_modal, ActiveModal::RewindPicker);
    assert!(app.rewind_picker.is_visible());
}

#[tokio::test]
async fn rewind_picker_enter_restores_selected_checkpoint() {
    let mut app = new_test_app();
    let (_tmp, repo) = setup_rewind_session(&mut app);
    write_rewind_checkpoint(&app, &repo, "cp-1", "2026-07-24T00:00:00Z", "v0\n", "v1\n");
    write_rewind_checkpoint(&app, &repo, "cp-2", "2026-07-24T01:00:00Z", "v1\n", "v2\n");

    press_esc(&mut app).await;
    press_esc(&mut app).await;
    assert_eq!(app.active_modal, ActiveModal::RewindPicker);

    // Newest checkpoint is selected by default; Enter restores it.
    app.handle_key(KeyCode::Enter, CrosstermModifiers::NONE)
        .await
        .unwrap();

    assert_eq!(app.active_modal, ActiveModal::None);
    assert!(!app.rewind_picker.is_visible());
    assert_eq!(std::fs::read_to_string(repo.join("a.rs")).unwrap(), "v1\n");
    assert_eq!(
        app.state.status.as_deref(),
        Some("Files restored from checkpoint.")
    );

    // Only the applied checkpoint was consumed; the older one remains.
    let store =
        crate::checkpoints::CheckpointStore::new(app.session_manager.sessions_dir(), "rewind-test");
    let remaining = store.list();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "cp-1");
}

#[tokio::test]
async fn rewind_picker_esc_dismisses_without_restoring() {
    let mut app = new_test_app();
    let (_tmp, repo) = setup_rewind_session(&mut app);
    write_rewind_checkpoint(
        &app,
        &repo,
        "cp-1",
        "2026-07-24T00:00:00Z",
        "original\n",
        "edit\n",
    );

    press_esc(&mut app).await;
    press_esc(&mut app).await;
    assert_eq!(app.active_modal, ActiveModal::RewindPicker);

    press_esc(&mut app).await;
    assert_eq!(app.active_modal, ActiveModal::None);
    assert!(!app.rewind_picker.is_visible());
    // Nothing was restored and the checkpoint was not consumed.
    assert_eq!(
        std::fs::read_to_string(repo.join("a.rs")).unwrap(),
        "edit\n"
    );
    let store =
        crate::checkpoints::CheckpointStore::new(app.session_manager.sessions_dir(), "rewind-test");
    assert_eq!(store.list().len(), 1);
}

#[tokio::test]
async fn double_esc_without_checkpoints_shows_status() {
    let mut app = new_test_app();
    let (_tmp, _repo) = setup_rewind_session(&mut app);

    press_esc(&mut app).await;
    press_esc(&mut app).await;

    assert_eq!(app.active_modal, ActiveModal::None);
    assert_eq!(
        app.state.status.as_deref(),
        Some("No file checkpoints recorded for this session.")
    );
}

#[tokio::test]
async fn double_esc_rewind_picker_blocked_while_busy() {
    let mut app = new_test_app();
    let (_tmp, repo) = setup_rewind_session(&mut app);
    write_rewind_checkpoint(
        &app,
        &repo,
        "cp-1",
        "2026-07-24T00:00:00Z",
        "original\n",
        "edit\n",
    );
    app.state.busy = true;

    press_esc(&mut app).await;
    press_esc(&mut app).await;

    assert_eq!(app.active_modal, ActiveModal::None);
    assert_eq!(
        app.state.status.as_deref(),
        Some("Wait for the active response to finish before rewinding.")
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Detail View Tests (Ctrl+E)
// ─────────────────────────────────────────────────────────────────────────

fn push_tool_call_message(app: &mut App, output: String) {
    app.state.messages.push(Message {
        id: "m-detail".to_string(),
        role: MessageRole::Assistant,
        kind: MessageKind::Regular,
        content: String::new(),
        thinking: String::new(),
        streaming: false,
        tool_calls: vec![crate::state::ToolCallState {
            call_id: "call-detail".to_string(),
            tool: "bash".to_string(),
            args: serde_json::json!({"command": "seq 1 120"}),
            status: crate::state::ToolCallStatus::Completed,
            output,
        }],
        usage: None,
        timestamp: SystemTime::now(),
        thinking_expanded: false,
    });
}

#[tokio::test]
async fn test_detail_view_opens_with_full_untruncated_tool_output() {
    let mut app = new_test_app();
    // The inline transcript caps tool output at 50 lines even when expanded;
    // the detail view must show every line.
    let output = (1..=120)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    push_tool_call_message(&mut app, output);

    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("open detail view");

    assert_eq!(app.active_modal, ActiveModal::DetailView);
    let detail = app.detail_view.as_ref().expect("detail view open");
    assert_eq!(detail.title(), "Tool: bash");
    assert!(detail.content().contains("\"command\": \"seq 1 120\""));
    assert!(detail.content().contains("line 1\n"));
    assert!(detail.content().contains("line 120"));
}

#[tokio::test]
async fn test_detail_view_esc_restores_transcript_view() {
    let mut app = new_test_app();
    push_tool_call_message(&mut app, "full output".to_string());

    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("open detail view");
    assert_eq!(app.active_modal, ActiveModal::DetailView);

    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .expect("close detail view");
    assert_eq!(app.active_modal, ActiveModal::None);
    assert!(app.detail_view.is_none());
}

#[tokio::test]
async fn test_detail_view_scrolls_with_paging_keys() {
    let mut app = new_test_app();
    let output = (1..=120)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    push_tool_call_message(&mut app, output);

    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("open detail view");
    assert_eq!(app.detail_view.as_ref().expect("open").scroll_position(), 0);

    app.handle_key(KeyCode::PageDown, CrosstermModifiers::NONE)
        .await
        .expect("page down");
    let scrolled = app.detail_view.as_ref().expect("open").scroll_position();
    assert!(scrolled > 0, "PageDown should scroll the detail view");

    app.handle_key(KeyCode::Up, CrosstermModifiers::NONE)
        .await
        .expect("scroll up");
    assert_eq!(
        app.detail_view.as_ref().expect("open").scroll_position(),
        scrolled - 1
    );
}

#[tokio::test]
async fn test_detail_view_falls_back_to_latest_message_text() {
    let mut app = new_test_app();
    app.state.messages.clear();
    app.state
        .add_system_message("full system body that was clipped inline".to_string());

    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("open detail view");

    assert_eq!(app.active_modal, ActiveModal::DetailView);
    let detail = app.detail_view.as_ref().expect("detail view open");
    assert_eq!(detail.title(), "System message");
    assert_eq!(detail.content(), "full system body that was clipped inline");
}

#[tokio::test]
async fn test_detail_view_nothing_to_expand_sets_status() {
    let mut app = new_test_app();
    app.state.messages.clear();
    app.state.error = None;

    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("handle key");

    assert_eq!(app.active_modal, ActiveModal::None);
    assert_eq!(app.state.status.as_deref(), Some("Nothing to expand"));
}

#[tokio::test]
async fn test_detail_view_from_approval_modal_expands_and_restores() {
    let mut app = new_test_app();
    let long_command = format!("run --flag {}", "x".repeat(400));
    app.approval_controller.enqueue(
        ApprovalRequest::new(
            "call-approve",
            "bash",
            serde_json::json!({"command": long_command.clone()}),
        )
        .with_reason("Needs a very long command reviewed"),
    );
    app.active_modal = ActiveModal::Approval;

    // Ctrl+E on the approval prompt expands the full command/args.
    app.handle_key(KeyCode::Char('e'), CrosstermModifiers::CONTROL)
        .await
        .expect("expand approval");

    assert_eq!(app.active_modal, ActiveModal::DetailView);
    let detail = app.detail_view.as_ref().expect("detail view open");
    assert_eq!(detail.title(), "Approval: bash");
    assert!(detail
        .content()
        .contains("Needs a very long command reviewed"));
    assert!(detail.content().contains(&long_command));
    // The approval is still pending: expanding must not decide anything.
    assert!(app.approval_controller.current().is_some());

    // Esc returns to the approval modal, not the plain transcript.
    app.handle_key(KeyCode::Esc, CrosstermModifiers::NONE)
        .await
        .expect("close detail view");
    assert_eq!(app.active_modal, ActiveModal::Approval);
    assert!(app.detail_view.is_none());
    assert!(app.approval_controller.current().is_some());
}
