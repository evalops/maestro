//! Integration tests for the tool system
//!
//! These tests verify the tool registry and related functionality work correctly.

use maestro_tui::tools::ToolRegistry;

// ============================================================================
// Tool Registry Tests
// ============================================================================

#[test]
fn test_registry_has_core_tools() {
    let registry = ToolRegistry::new();

    // Check core tools are registered (lowercase names)
    assert!(
        registry.get("read").is_some(),
        "read tool should be registered"
    );
    assert!(
        registry.get("write").is_some(),
        "write tool should be registered"
    );
    assert!(
        registry.get("edit").is_some(),
        "edit tool should be registered"
    );
    assert!(
        registry.get("bash").is_some(),
        "bash tool should be registered"
    );
    assert!(
        registry.get("glob").is_some(),
        "glob tool should be registered"
    );
    assert!(
        registry.get("grep").is_some(),
        "grep tool should be registered"
    );
}

#[test]
fn test_registry_tool_count() {
    let registry = ToolRegistry::new();
    let count = registry.tools().count();

    // Should have multiple tools registered
    assert!(count >= 10, "Expected at least 10 tools, got {}", count);
}

#[test]
fn test_registry_get_tool() {
    let registry = ToolRegistry::new();

    let read_tool = registry.get("read");
    assert!(read_tool.is_some(), "Should find read tool");

    let nonexistent = registry.get("NonExistentTool");
    assert!(nonexistent.is_none(), "Should not find nonexistent tool");
}

#[test]
fn test_registry_tools_have_descriptions() {
    let registry = ToolRegistry::new();

    for tool_def in registry.tools() {
        assert!(
            !tool_def.tool.description.is_empty(),
            "Tool {} should have a description",
            tool_def.tool.name
        );
    }
}

#[test]
fn test_registry_tools_have_schemas() {
    let registry = ToolRegistry::new();

    for tool_def in registry.tools() {
        // All tools should have an input schema with type "object"
        let schema = &tool_def.tool.input_schema;
        assert_eq!(
            schema.get("type").and_then(|v| v.as_str()),
            Some("object"),
            "Tool {} should have object schema",
            tool_def.tool.name
        );
    }
}

#[test]
fn test_registry_requires_approval_for_dangerous_bash() {
    let registry = ToolRegistry::new();

    // Dangerous bash commands should require approval
    let dangerous_commands = vec![
        serde_json::json!({"command": "rm -rf /"}),
        serde_json::json!({"command": "sudo rm -rf /"}),
        serde_json::json!({"command": "chmod -R 777 /"}),
    ];

    for cmd in dangerous_commands {
        let approval = registry.requires_approval("bash", &cmd);
        assert!(
            approval,
            "Dangerous command {:?} should require approval",
            cmd
        );
    }
}

#[test]
fn test_registry_read_no_approval_needed() {
    let registry = ToolRegistry::new();

    // Read operations typically don't require approval
    let read_input = serde_json::json!({
        "file_path": "/tmp/test.txt"
    });

    let approval = registry.requires_approval("read", &read_input);
    assert!(!approval, "Read should not require approval");
}

#[test]
fn test_registry_glob_no_approval_needed() {
    let registry = ToolRegistry::new();

    let glob_input = serde_json::json!({
        "pattern": "*.rs",
        "path": "/tmp"
    });

    let approval = registry.requires_approval("glob", &glob_input);
    assert!(!approval, "Glob should not require approval");
}

#[test]
fn test_registry_grep_no_approval_needed() {
    let registry = ToolRegistry::new();

    let grep_input = serde_json::json!({
        "pattern": "TODO",
        "path": "/tmp"
    });

    let approval = registry.requires_approval("grep", &grep_input);
    assert!(!approval, "Grep should not require approval");
}

// ============================================================================
// Missing Required Fields Tests
// ============================================================================

#[test]
fn test_registry_missing_required_read() {
    let registry = ToolRegistry::new();

    // Read requires file_path or path
    let incomplete = serde_json::json!({});
    let missing = registry.missing_required("read", &incomplete);

    assert!(
        !missing.is_empty(),
        "Should detect missing required fields for Read"
    );
}

#[test]
fn test_registry_missing_required_write() {
    let registry = ToolRegistry::new();

    // Write requires path (or file_path alias)
    let incomplete = serde_json::json!({});
    let missing = registry.missing_required("write", &incomplete);

    assert!(
        !missing.is_empty(),
        "Should detect missing required fields for Write"
    );
    assert!(
        missing.contains(&"path".to_string()),
        "Should include path in missing fields: {:?}",
        missing
    );
}

#[test]
fn test_registry_missing_required_edit() {
    let registry = ToolRegistry::new();

    // Edit requires path (or file_path alias)
    let incomplete = serde_json::json!({});
    let missing = registry.missing_required("edit", &incomplete);

    assert!(
        !missing.is_empty(),
        "Should detect missing required fields for Edit"
    );
    assert!(
        missing.contains(&"path".to_string()),
        "Should include path in missing fields: {:?}",
        missing
    );
}

#[test]
fn test_registry_complete_input_no_missing() {
    let registry = ToolRegistry::new();

    // Complete Read input
    let complete = serde_json::json!({
        "file_path": "/tmp/test.txt"
    });
    let missing = registry.missing_required("read", &complete);

    assert!(
        missing.is_empty(),
        "Complete input should have no missing fields: {:?}",
        missing
    );
}

// ============================================================================
// Tool Lookup Tests
// ============================================================================

#[test]
fn test_registry_iteration() {
    let registry = ToolRegistry::new();
    let tool_names: Vec<String> = registry.tools().map(|t| t.tool.name.clone()).collect();

    // Check for expected tools
    assert!(tool_names.contains(&"read".to_string()));
    assert!(tool_names.contains(&"write".to_string()));
    assert!(tool_names.contains(&"bash".to_string()));
}

#[test]
fn test_registry_no_duplicate_tools() {
    let registry = ToolRegistry::new();

    let mut seen = std::collections::HashSet::new();
    for tool_def in registry.tools() {
        assert!(
            seen.insert(&tool_def.tool.name),
            "Tool {} appears multiple times in registry",
            tool_def.tool.name
        );
    }
}

#[test]
fn test_registry_register_and_unregister() {
    let mut registry = ToolRegistry::new();

    // Check initial state
    assert!(registry.get("custom_tool").is_none());

    // Register a custom tool
    let custom_tool = maestro_tui::ai::Tool::new("custom_tool", "A custom test tool");
    registry.register(
        "custom_tool",
        maestro_tui::ToolDefinition {
            tool: custom_tool,
            requires_approval: false,
        },
    );

    // Should now be found
    assert!(registry.get("custom_tool").is_some());

    // Unregister
    let removed = registry.unregister("custom_tool");
    assert!(removed, "Should have removed the tool");

    // Should no longer be found
    assert!(registry.get("custom_tool").is_none());
}
