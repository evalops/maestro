//! TUI compatibility facade for the runtime Codex app-server transport.

pub use maestro_runtime::agent::codex_app_server_turns::{
    CodexAppServerTurnResult, CodexAppServerTurnSession, CodexCompatibilityReport,
    CodexPersistentThreadOpen, CodexThreadPayload, DynamicToolSpec, TurnWaitEvent,
    approval_decision, codex_compatibility_from_initialize, codex_thread_model_id,
    dynamic_tools_from_native, is_supported_codex_notification, is_thread_not_found_error,
    model_should_use_app_server_turns, parse_tool_call_params, tool_call_error_result,
    tool_call_success_result,
};

use anyhow::{Context, Result};
use maestro_runtime::agent::NativeCodexAuth;

/// Retire the TUI-selected Codex thread binding after resolving the active
/// profile in the composing host.
///
/// The runtime transport deliberately refuses to read auth files. Existing
/// TUI/headless callers retain this helper so profile selection and auth
/// resolution remain in the TUI crate.
pub fn retire_persistent_thread_for_prompt_change(
    model: &str,
    cwd: &str,
    session_id: Option<&str>,
) -> Result<bool> {
    let requested_profile =
        crate::service_connections::selected_delegated_profile_from_env("openai-codex")
            .context("Codex managed connection selection failed")?;
    let identity = crate::codex_identity::resolve_codex_identity(
        requested_profile.as_deref(),
        std::path::Path::new(cwd),
    )
    .context("Codex identity selection failed")?;
    let state_root = crate::path_utils::maestro_home_dir()
        .context("Maestro home is unavailable for Codex thread bindings")?;
    let auth = NativeCodexAuth {
        profile_name: identity.profile_name.clone(),
        child_env: identity.child_env(),
        auth_path: identity.auth_path(),
        state_root,
    };
    maestro_runtime::agent::codex_app_server_turns::
        retire_persistent_thread_for_prompt_change_with_auth(model, cwd, session_id, &auth)
}
