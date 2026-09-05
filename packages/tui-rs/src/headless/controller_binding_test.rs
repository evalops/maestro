use serde_json::json;

use super::controller_binding::{
    CONTROLLER_BINDING_VERSION, CONTROLLER_CONTEXT_SCHEMA_VERSION, ControllerContext,
    ControllerLifetimeProfile, ControllerScopeExpectation, controller_binding_from_hello_json,
    controller_binding_sha256,
};

fn context() -> ControllerContext {
    ControllerContext {
        schema_version: CONTROLLER_CONTEXT_SCHEMA_VERSION.to_string(),
        controller_id: "evalops.platform".to_string(),
        organization_id: "org-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        thread_id: "thread-1".to_string(),
        channel_id: Some("channel-1".to_string()),
        request_id: Some("request-1".to_string()),
        lifetime_profile: ControllerLifetimeProfile::Ephemeral,
        runtime_generation: None,
    }
}

fn manifest() -> serde_json::Value {
    json!({
        "schema_version": "evalops.maestro.capability-manifest.v1",
        "engine_kind": "maestro",
        "protocol_version": "2026-08-08",
        "tool_protocol_version": "evalops.maestro.tool-bridge.v1",
        "supported_tools": [
            "artifact.create_document",
            "artifact.create_presentation",
            "dex.search_coding_sessions",
            "dex.read_coding_session"
        ],
        "native_tool_calls": true,
        "approvals": true,
        "continuation": false,
        "cancellation": true,
        "idempotent_replay": true,
        "streaming": true
    })
}

#[test]
fn controller_binding_matches_the_cross_repository_digest_vector() {
    assert_eq!(
        controller_binding_sha256(CONTROLLER_BINDING_VERSION, &context(), &manifest())
            .expect("binding digest"),
        "sha256:d68e8538816cfcdc7a7622c8aaae8ab98d53e422417fb4cf819eede6d54e2d52"
    );
}

#[test]
fn controller_binding_requires_complete_scope_and_matching_runtime_identity() {
    let raw = json!({
        "type": "hello",
        "protocol_version": "2026-08-08",
        "controller_binding_version": CONTROLLER_BINDING_VERSION,
        "controller_context": context(),
        "capability_manifest": manifest()
    })
    .to_string();
    let expected = ControllerScopeExpectation {
        organization_id: Some("org-1".to_string()),
        workspace_id: Some("workspace-1".to_string()),
        thread_id: Some("thread-1".to_string()),
        channel_id: Some("channel-1".to_string()),
        request_id: Some("request-1".to_string()),
    };
    let receipt = controller_binding_from_hello_json(&raw, "2026-08-08", &expected)
        .expect("valid binding")
        .expect("binding present");
    assert_eq!(receipt.binding_version, CONTROLLER_BINDING_VERSION);
    assert_eq!(
        receipt.binding_sha256,
        "sha256:d68e8538816cfcdc7a7622c8aaae8ab98d53e422417fb4cf819eede6d54e2d52"
    );

    let wrong_scope = ControllerScopeExpectation {
        organization_id: Some("org-2".to_string()),
        ..expected
    };
    assert!(controller_binding_from_hello_json(&raw, "2026-08-08", &wrong_scope).is_err());
}

#[test]
fn controller_binding_is_optional_but_partial_or_late_generation_shapes_fail_closed() {
    assert!(
        controller_binding_from_hello_json(
            r#"{"type":"hello","protocol_version":"2026-08-08"}"#,
            "2026-08-08",
            &ControllerScopeExpectation::default(),
        )
        .expect("legacy hello")
        .is_none()
    );

    let partial = json!({
        "type": "hello",
        "controller_binding_version": CONTROLLER_BINDING_VERSION,
        "controller_context": context()
    })
    .to_string();
    assert!(
        controller_binding_from_hello_json(
            &partial,
            "2026-08-08",
            &ControllerScopeExpectation::default(),
        )
        .is_err()
    );

    let mut resident = context();
    resident.lifetime_profile = ControllerLifetimeProfile::Resident;
    resident.runtime_generation = Some(0);
    let invalid_generation = json!({
        "type": "hello",
        "controller_binding_version": CONTROLLER_BINDING_VERSION,
        "controller_context": resident,
        "capability_manifest": manifest()
    })
    .to_string();
    assert!(
        controller_binding_from_hello_json(
            &invalid_generation,
            "2026-08-08",
            &ControllerScopeExpectation::default(),
        )
        .is_err()
    );
}
