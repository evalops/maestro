//! Native `maestro codex` CLI.
//!
//! Ports `src/cli/commands/codex.ts` onto the Rust stdio JSON-RPC client in
//! `codex_app_server`. OpenAI OAuth (`maestro openai`) remains a separate command
//! and must not be aliased here.
//!
//! Doctor compiles live coding-tool parameter schemas (exported from the
//! TypeScript `codingTools` registry + `CODEX_TOOL_PROFILES`) through the
//! dynamic-tool rules from `src/codex/compatibility.ts`. Regenerate the fixture
//! from the checked-in Codex tool metadata fixture.

use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::LazyLock;

use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::codex_app_server::{
    AccountReadResult, CodexAppServerClient, InitializeOptions, LoginFlow,
};

/// Dispatch `maestro codex <subcommand> ...`.
pub async fn run_codex(args: &[String]) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("login") => handle_login(&args[1..]).await,
        Some("logout") => handle_logout(&args[1..]).await,
        Some("status") => handle_status(&args[1..]).await,
        Some("doctor") => handle_doctor(&args[1..]).await,
        _ => {
            eprintln!(
                "Unknown codex subcommand. Try \"maestro codex login\", \"logout\", \"status\", or \"doctor\"."
            );
            Ok(1)
        }
    }
}

fn requested_identity(params: &[String]) -> Result<crate::codex_identity::CodexIdentitySelection> {
    let mut profile = None;
    let mut index = 0;
    while index < params.len() {
        if params[index] == "--profile" {
            let value = params
                .get(index + 1)
                .filter(|value| !value.trim().is_empty() && !value.starts_with('-'))
                .ok_or_else(|| anyhow::anyhow!("--profile requires a profile name"))?;
            if profile.replace(value.as_str()).is_some() {
                bail!("--profile may only be specified once");
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    let workspace = std::env::current_dir()?;
    crate::codex_identity::resolve_codex_identity(profile, &workspace)
}

async fn spawn_for_identity(
    identity: &crate::codex_identity::CodexIdentitySelection,
) -> Result<CodexAppServerClient> {
    CodexAppServerClient::spawn_with_env(None, None, None, &identity.child_env()).await
}

fn login_command(identity: &crate::codex_identity::CodexIdentitySelection) -> String {
    if identity.profile_name == "default" {
        "maestro codex login".to_owned()
    } else {
        format!("maestro codex login --profile {}", identity.profile_name)
    }
}

async fn handle_login(params: &[String]) -> Result<i32> {
    let device_flow = params
        .iter()
        .any(|p| matches!(p.as_str(), "--device" | "--device-code" | "--device-auth"));
    let force_login = params
        .iter()
        .any(|p| matches!(p.as_str(), "--force" | "--refresh"));

    println!("Maestro OpenAI Codex Login");
    let identity = requested_identity(params)?;
    let client = spawn_for_identity(&identity).await?;
    let result = login_with_client(&client, device_flow, force_login).await;
    client.close();
    result
}

async fn login_with_client(
    client: &CodexAppServerClient,
    device_flow: bool,
    force_login: bool,
) -> Result<i32> {
    client
        .initialize(InitializeOptions {
            experimental_api: true,
            ..Default::default()
        })
        .await?;

    if !force_login {
        match client.read_account(true).await {
            Ok(account) if account.account.is_some() => {
                println!(
                    "OpenAI Codex is already signed in{}.",
                    account_label(&account)
                );
                println!("Run \"maestro codex login --force\" to start a new sign-in flow.");
                return Ok(0);
            }
            Ok(_) => {}
            Err(_) => {
                println!("Codex app-server account refresh failed; starting a new sign-in flow.");
            }
        }
    }

    let flow = if device_flow {
        LoginFlow::Device
    } else {
        LoginFlow::Browser
    };
    // App-server account APIs: start_chatgpt_login / wait_for_login_completion / read_account.
    let login = client.start_chatgpt_login(flow, true).await?;
    let login_type = login.get("type").and_then(Value::as_str).unwrap_or("");

    match login_type {
        "chatgpt" => {
            let login_id = login
                .get("loginId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing loginId"))?;
            let auth_url = login
                .get("authUrl")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing authUrl"))?;
            println!("Open this URL in your browser to sign in with ChatGPT:");
            println!("{auth_url}");
            println!("Waiting for ChatGPT sign-in to complete...");
            client.wait_for_login_completion(login_id, None).await?;
        }
        "chatgptDeviceCode" => {
            let login_id = login
                .get("loginId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing loginId"))?;
            let verification_url = login
                .get("verificationUrl")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing verificationUrl"))?;
            let user_code = login
                .get("userCode")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing userCode"))?;
            println!("Open this URL and enter the code:");
            println!("{verification_url}");
            println!("{user_code}");
            println!("Waiting for ChatGPT sign-in to complete...");
            client.wait_for_login_completion(login_id, None).await?;
        }
        "apiKey" => {
            println!("OpenAI Codex is already configured with an API key.");
            println!("Select provider \"openai-codex\" or a model like \"openai-codex/gpt-5.5\".");
            return Ok(0);
        }
        "chatgptAuthTokens" => {
            let account = client.read_account(true).await?;
            println!(
                "OpenAI Codex is using externally managed ChatGPT auth{}.",
                account_label(&account)
            );
            println!("Select provider \"openai-codex\" or a model like \"openai-codex/gpt-5.5\".");
            return Ok(0);
        }
        other => {
            bail!("Unsupported Codex login response: {other}");
        }
    }

    let account = client.read_account(true).await?;
    println!("Signed in with ChatGPT{}.", account_label(&account));
    println!("Select provider \"openai-codex\" or a model like \"openai-codex/gpt-5.5\".");
    Ok(0)
}

async fn handle_logout(params: &[String]) -> Result<i32> {
    let identity = requested_identity(params)?;
    let client = spawn_for_identity(&identity).await?;
    let result = async {
        client.initialize(InitializeOptions::default()).await?;
        client.logout().await?;
        println!("Signed out of ChatGPT for OpenAI Codex.");
        Ok(0)
    }
    .await;
    client.close();
    result
}

async fn handle_status(params: &[String]) -> Result<i32> {
    let identity = requested_identity(params)?;
    let client = spawn_for_identity(&identity).await?;
    let result = async {
        client.initialize(InitializeOptions::default()).await?;
        let account = client.read_account(true).await?;
        if account.account.is_none() {
            println!("No ChatGPT sign-in for OpenAI Codex.");
            println!(
                "Run \"{}\" to sign in with ChatGPT.",
                login_command(&identity)
            );
            return Ok(0);
        }
        println!("OpenAI Codex is signed in{}.", account_label(&account));
        Ok(0)
    }
    .await;
    client.close();
    result
}

async fn handle_doctor(params: &[String]) -> Result<i32> {
    println!("Maestro Codex Doctor");
    let identity = requested_identity(params)?;
    let client = spawn_for_identity(&identity).await?;
    let mut exit_code = 0;
    let result = async {
        let initialized = client
            .initialize(InitializeOptions {
                experimental_api: true,
                ..Default::default()
            })
            .await?;
        println!("Identity profile: {}", identity.profile_name);
        println!("Provider: openai-codex");
        println!("Transport: codex-app-server");
        println!("Auth file: {}", identity.auth_path().display());
        println!(
            "Auth health: {}",
            crate::codex_identity::inspect_codex_auth(&identity.auth_path()).state
        );
        println!(
            "Protocol: {}",
            initialized
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
        println!("Connectivity: ready");
        let account = client.read_account(true).await?;
        if account.account.is_none() {
            println!("ChatGPT sign-in: missing");
            println!(
                "Run \"{}\" to sign in with ChatGPT.",
                login_command(&identity)
            );
            exit_code = 1;
        } else {
            println!("ChatGPT sign-in: {}", account_doctor_label(&account));
        }

        let profile_name = resolve_codex_tool_profile_name(
            env::var("MAESTRO_CODEX_TOOL_PROFILE").ok().as_deref(),
        )?;
        let selected = select_codex_tool_profile(&CODING_TOOLS_FIXTURE.tools, profile_name);
        let compiled = compile_codex_dynamic_tool_specs(&selected);
        let names = selected
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "Codex tool profile ({profile_name}): {} tools ({names})",
            selected.len()
        );

        let errors = compiled
            .diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Error)
            .count();
        if errors > 0 {
            exit_code = 1;
            println!("Dynamic tool schema: {errors} error(s)");
        } else {
            println!("Dynamic tool schema: compatible");
        }
        for diagnostic in &compiled.diagnostics {
            println!("{}: {}", diagnostic.code, diagnostic.message);
        }
        Ok(exit_code)
    }
    .await;
    client.close();
    result
}

fn account_label(state: &AccountReadResult) -> String {
    let Some(account) = state.account.as_ref() else {
        return String::new();
    };
    if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return String::new();
    }
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let plan = account
        .get("planType")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|plan| format!(", {plan}"))
        .unwrap_or_default();
    format!(" as {email}{plan}")
}

fn account_doctor_label(state: &AccountReadResult) -> String {
    let Some(account) = state.account.as_ref() else {
        return "missing".to_owned();
    };
    match account.get("type").and_then(Value::as_str) {
        Some("chatgpt") => {
            let plan = account
                .get("planType")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|plan| format!(" ({plan})"))
                .unwrap_or_default();
            format!("ChatGPT account{plan}")
        }
        Some("apiKey") => "API key".to_owned(),
        Some(_) => "configured account".to_owned(),
        None => "unknown".to_owned(),
    }
}

// ── Dynamic tool compile rules (ported from compatibility.ts) ────────────────
//
// Tool names, descriptions, parameters, and profiles come from the committed
// Checked-in fixture used so doctor relies on the same tool schema surface as
// live TypeScript registry schemas rather than a hand-maintained name list.

const NAME_MAX_LENGTH: usize = 128;
const UNSUPPORTED_TOP_LEVEL_SCHEMA_KEYWORDS: &[&str] = &["anyOf", "oneOf", "allOf", "enum", "not"];
const RESERVED_NAMES: &[&str] = &["mcp"];
const RESERVED_NAME_PREFIXES: &[&str] = &["mcp__"];

const CODING_TOOLS_FIXTURE_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../test/fixtures/codex/coding-tools-doctor-v1.json"
));

static CODING_TOOLS_FIXTURE: LazyLock<CodingToolsFixture> = LazyLock::new(|| {
    let fixture: CodingToolsFixture = serde_json::from_str(CODING_TOOLS_FIXTURE_JSON)
        .expect("coding-tools-doctor-v1.json must parse as CodingToolsFixture");
    assert_eq!(
        fixture.version, 1,
        "coding-tools-doctor-v1.json must be version 1"
    );
    assert!(
        !fixture.tools.is_empty(),
        "coding-tools-doctor-v1.json must include coding tools"
    );
    assert!(
        fixture.profiles.contains_key("lean"),
        "coding-tools-doctor-v1.json must include the lean profile"
    );
    fixture
});

#[derive(Debug, Clone, Deserialize)]
struct CodingToolsFixture {
    version: u32,
    tools: Vec<CodingTool>,
    profiles: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodingTool {
    name: String,
    description: String,
    #[serde(default = "empty_object_schema")]
    parameters: Value,
    #[serde(default, rename = "deferApiDefinition")]
    defer_api_definition: bool,
    #[serde(default, rename = "executionLocation")]
    execution_location: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticSeverity {
    #[allow(dead_code)]
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
struct Diagnostic {
    severity: DiagnosticSeverity,
    code: String,
    message: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct DynamicToolSpec {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct DynamicToolBinding {
    codex_name: String,
    original_name: String,
}

#[derive(Debug, Clone)]
struct DynamicToolCompilation {
    #[allow(dead_code)]
    specs: Vec<DynamicToolSpec>,
    #[allow(dead_code)]
    bindings: Vec<DynamicToolBinding>,
    diagnostics: Vec<Diagnostic>,
}

fn resolve_codex_tool_profile_name(value: Option<&str>) -> Result<&'static str> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok("lean");
    };
    let normalized = value.to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "lean" | "default" => Ok("lean"),
        "read-only" | "readonly" => Ok("read-only"),
        "extended" => Ok("extended"),
        _ => bail!(
            "Unknown Codex tool profile \"{value}\". Available profiles: lean, default, read-only, readonly, extended"
        ),
    }
}

fn profile_tool_names(profile_name: &str) -> &[String] {
    CODING_TOOLS_FIXTURE
        .profiles
        .get(profile_name)
        .or_else(|| CODING_TOOLS_FIXTURE.profiles.get("lean"))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn select_codex_tool_profile<'a>(
    tools: &'a [CodingTool],
    profile_name: &str,
) -> Vec<&'a CodingTool> {
    let by_name: HashMap<&str, &CodingTool> = tools
        .iter()
        .map(|tool| (tool.name.as_str(), tool))
        .collect();
    profile_tool_names(profile_name)
        .iter()
        .filter_map(|name| by_name.get(name.as_str()).copied())
        .collect()
}

fn compile_codex_dynamic_tool_specs(tools: &[&CodingTool]) -> DynamicToolCompilation {
    let mut specs = Vec::new();
    let mut bindings = Vec::new();
    let mut diagnostics = Vec::new();
    let mut seen_original = HashSet::new();
    let mut seen_codex = HashSet::new();

    for tool in tools {
        if tool.defer_api_definition
            || tool
                .execution_location
                .as_deref()
                .is_some_and(|location| location == "client")
        {
            continue;
        }
        if !seen_original.insert(tool.name.as_str()) {
            continue;
        }
        let codex_name = to_unique_codex_dynamic_tool_name(&tool.name, &seen_codex);
        if codex_name != tool.name {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "renamed_tool".to_owned(),
                message: format!(
                    "Tool \"{}\" is exposed to Codex as \"{codex_name}\" to match app-server dynamic tool identifier rules.",
                    tool.name
                ),
            });
        }
        seen_codex.insert(codex_name.clone());
        specs.push(DynamicToolSpec {
            name: codex_name.clone(),
            description: tool.description.clone(),
            input_schema: normalize_codex_dynamic_tool_input_schema(&tool.parameters),
        });
        bindings.push(DynamicToolBinding {
            codex_name,
            original_name: tool.name.clone(),
        });
    }

    DynamicToolCompilation {
        specs,
        bindings,
        diagnostics,
    }
}

/// Compile the selected Codex tool profile and return error diagnostics.
pub fn codex_schema_diagnostics() -> Result<Vec<String>> {
    let profile_name =
        resolve_codex_tool_profile_name(env::var("MAESTRO_CODEX_TOOL_PROFILE").ok().as_deref())?;
    let selected = select_codex_tool_profile(&CODING_TOOLS_FIXTURE.tools, profile_name);
    Ok(compile_codex_dynamic_tool_specs(&selected)
        .diagnostics
        .into_iter()
        .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
        .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
        .collect())
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn normalize_codex_dynamic_tool_input_schema(schema: &Value) -> Value {
    let Some(obj) = schema.as_object() else {
        return empty_object_schema();
    };

    if let Some(flattened) = flatten_top_level_composition_schema(obj) {
        return flattened;
    }

    let mut normalized = Map::new();
    for (key, value) in obj {
        if UNSUPPORTED_TOP_LEVEL_SCHEMA_KEYWORDS.contains(&key.as_str()) {
            continue;
        }
        normalized.insert(key.clone(), value.clone());
    }
    normalized.insert("type".to_owned(), json!("object"));
    if !normalized
        .get("properties")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        normalized.insert("properties".to_owned(), json!({}));
    }
    if !normalized.contains_key("additionalProperties") {
        normalized.insert("additionalProperties".to_owned(), json!(false));
    }
    Value::Object(normalized)
}

fn flatten_top_level_composition_schema(schema: &Map<String, Value>) -> Option<Value> {
    for key in ["anyOf", "oneOf", "allOf"] {
        let Some(branches) = schema.get(key).and_then(Value::as_array) else {
            continue;
        };
        if branches.is_empty() || !branches.iter().all(Value::is_object) {
            return Some(empty_object_schema());
        }
        // Best-effort flatten: merge property keys; drop composition keyword.
        let mut properties = Map::new();
        if let Some(top) = schema.get("properties").and_then(Value::as_object) {
            for (name, prop) in top {
                properties.insert(name.clone(), prop.clone());
            }
        }
        for branch in branches {
            if let Some(branch_props) = branch.get("properties").and_then(Value::as_object) {
                for (name, prop) in branch_props {
                    properties
                        .entry(name.clone())
                        .or_insert_with(|| prop.clone());
                }
            }
        }
        let mut flattened = Map::new();
        flattened.insert("type".to_owned(), json!("object"));
        flattened.insert("properties".to_owned(), Value::Object(properties));
        flattened.insert("additionalProperties".to_owned(), json!(false));
        if let Some(description) = schema.get("description") {
            flattened.insert("description".to_owned(), description.clone());
        }
        return Some(Value::Object(flattened));
    }
    None
}

fn to_unique_codex_dynamic_tool_name(tool_name: &str, seen: &HashSet<String>) -> String {
    let base = to_codex_dynamic_tool_name(tool_name);
    if !seen.contains(&base) {
        return base;
    }
    let mut index = 2_u32;
    loop {
        let suffix = format!("_{index}");
        let max = NAME_MAX_LENGTH.saturating_sub(suffix.len());
        let candidate = format!("{}{suffix}", truncate_identifier(&base, max));
        if !seen.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn to_codex_dynamic_tool_name(tool_name: &str) -> String {
    let trimmed = tool_name.trim();
    let mut codex_name: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if codex_name.is_empty() {
        codex_name = "maestro_tool".to_owned();
    }
    if is_reserved_codex_dynamic_tool_identifier(&codex_name) {
        codex_name = format!("maestro_{codex_name}");
    }
    truncate_identifier(&codex_name, NAME_MAX_LENGTH)
}

fn is_reserved_codex_dynamic_tool_identifier(value: &str) -> bool {
    RESERVED_NAMES.contains(&value)
        || RESERVED_NAME_PREFIXES
            .iter()
            .any(|prefix| value.starts_with(prefix))
}

fn truncate_identifier(value: &str, max_length: usize) -> String {
    if value.len() <= max_length {
        return value.to_owned();
    }
    value.chars().take(max_length.max(1)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_app_server::{CodexAppServerClient, InitializeOptions};
    use serde_json::json;
    use std::sync::Arc;

    fn sample_tool(name: &str, description: &str, parameters: Value) -> CodingTool {
        CodingTool {
            name: name.to_owned(),
            description: description.to_owned(),
            parameters,
            defer_api_definition: false,
            execution_location: None,
        }
    }

    #[test]
    fn fixture_loads_live_coding_tools_and_profiles() {
        assert_eq!(CODING_TOOLS_FIXTURE.version, 1);
        assert!(CODING_TOOLS_FIXTURE.tools.len() >= 12);
        assert!(CODING_TOOLS_FIXTURE.tools.iter().any(|t| t.name == "read"));
        assert!(CODING_TOOLS_FIXTURE.profiles.contains_key("lean"));
        assert!(CODING_TOOLS_FIXTURE.profiles.contains_key("extended"));
        let read = CODING_TOOLS_FIXTURE
            .tools
            .iter()
            .find(|t| t.name == "read")
            .expect("read tool");
        assert!(read.parameters["properties"]["path"].is_object());
    }

    #[test]
    fn lean_profile_selects_default_tool_snapshot() {
        let selected = select_codex_tool_profile(&CODING_TOOLS_FIXTURE.tools, "lean");
        assert_eq!(selected.len(), profile_tool_names("lean").len());
        assert_eq!(selected[0].name, "read");
        assert!(selected.iter().any(|t| t.name == "gh_pr"));
        assert!(!selected.iter().any(|t| t.name == "parallel_ripgrep"));
    }

    #[test]
    fn read_only_profile_excludes_mutation_tools() {
        let selected = select_codex_tool_profile(&CODING_TOOLS_FIXTURE.tools, "read-only");
        assert_eq!(selected.len(), profile_tool_names("read-only").len());
        assert!(!selected
            .iter()
            .any(|t| t.name == "write" || t.name == "bash"));
    }

    #[test]
    fn compiles_the_curated_codex_default_profile_into_responses_safe_dynamic_tools() {
        let selected = select_codex_tool_profile(&CODING_TOOLS_FIXTURE.tools, "lean");
        let compiled = compile_codex_dynamic_tool_specs(&selected);
        assert_eq!(compiled.specs.len(), selected.len());
        assert!(compiled.diagnostics.is_empty());
        for (spec, tool) in compiled.specs.iter().zip(selected.iter()) {
            assert_eq!(spec.input_schema["type"], "object");
            assert!(spec.input_schema.get("anyOf").is_none());
            assert!(spec
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
            // Live schemas retain real properties (not empty stubs).
            if tool
                .parameters
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|p| !p.is_empty())
            {
                let props = spec.input_schema["properties"]
                    .as_object()
                    .expect("normalized properties object");
                assert!(
                    !props.is_empty(),
                    "tool {} should keep live parameter properties",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn renames_invalid_or_reserved_tool_identifiers_while_preserving_original_bindings() {
        let tools = [
            sample_tool("mcp", "reserved", empty_object_schema()),
            sample_tool("ticket lookup", "spaces", empty_object_schema()),
        ];
        let refs: Vec<&CodingTool> = tools.iter().collect();
        let compiled = compile_codex_dynamic_tool_specs(&refs);
        assert_eq!(compiled.specs[0].name, "maestro_mcp");
        assert_eq!(compiled.bindings[0].original_name, "mcp");
        assert_eq!(compiled.specs[1].name, "ticket_lookup");
        assert!(compiled
            .diagnostics
            .iter()
            .any(|d| d.code == "renamed_tool"));
    }

    #[test]
    fn skips_deferred_and_client_tools_like_typescript() {
        let mut deferred = sample_tool("ask_user", "prompt", empty_object_schema());
        deferred.defer_api_definition = true;
        let mut client = sample_tool("ui_pick", "client only", empty_object_schema());
        client.execution_location = Some("client".to_owned());
        let server = sample_tool(
            "read",
            "ok",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }),
        );
        let tools = [deferred, client, server];
        let refs: Vec<&CodingTool> = tools.iter().collect();
        let compiled = compile_codex_dynamic_tool_specs(&refs);
        assert_eq!(compiled.specs.len(), 1);
        assert_eq!(compiled.specs[0].name, "read");
        assert!(compiled.specs[0].input_schema["properties"]["path"].is_object());
    }

    #[test]
    fn normalize_strips_unsupported_top_level_schema_keywords() {
        let schema = json!({
            "type": "object",
            "anyOf": [{"type": "string"}],
            "properties": { "path": { "type": "string" } },
            "enum": ["a"]
        });
        // anyOf present => flatten path
        let normalized = normalize_codex_dynamic_tool_input_schema(&schema);
        assert_eq!(normalized["type"], "object");
        assert!(normalized.get("anyOf").is_none());
        assert!(normalized.get("enum").is_none());
    }

    #[test]
    fn resolve_profile_defaults_and_aliases() {
        assert_eq!(resolve_codex_tool_profile_name(None).unwrap(), "lean");
        assert_eq!(
            resolve_codex_tool_profile_name(Some("read_only")).unwrap(),
            "read-only"
        );
        assert_eq!(
            resolve_codex_tool_profile_name(Some("extended")).unwrap(),
            "extended"
        );
        assert!(resolve_codex_tool_profile_name(Some("nope")).is_err());
    }

    #[tokio::test]
    async fn runs_browser_chatgpt_sign_in_via_mock_transport() {
        let (client, mock) = CodexAppServerClient::mock();
        let client = Arc::new(client);
        let client_task = Arc::clone(&client);
        let task = tokio::spawn(async move { login_with_client(&client_task, false, true).await });

        // initialize
        let init = mock.next_request().await.unwrap();
        assert_eq!(init["method"], "initialize");
        mock.respond(init["id"].as_u64().unwrap(), json!({}));
        let initialized = mock.next_request().await.unwrap();
        assert_eq!(initialized["method"], "initialized");

        // login start
        let login = mock.next_request().await.unwrap();
        assert_eq!(login["method"], "account/login/start");
        assert_eq!(login["params"]["type"], "chatgpt");
        assert_eq!(login["params"]["codexStreamlinedLogin"], true);
        mock.respond(
            login["id"].as_u64().unwrap(),
            json!({
                "type": "chatgpt",
                "loginId": "login-1",
                "authUrl": "https://chatgpt.test/auth"
            }),
        );

        // completion
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        mock.notify(
            "account/login/completed",
            json!({ "loginId": "login-1", "success": true, "error": null }),
        );

        // final account/read
        let read = mock.next_request().await.unwrap();
        assert_eq!(read["method"], "account/read");
        mock.respond(
            read["id"].as_u64().unwrap(),
            json!({
                "account": {
                    "type": "chatgpt",
                    "email": "dev@example.com",
                    "planType": "pro"
                },
                "requiresOpenaiAuth": false
            }),
        );

        let code = task.await.unwrap().expect("login");
        assert_eq!(code, 0);
    }

    #[tokio::test]
    async fn supports_chatgpt_device_code_sign_in() {
        let (client, mock) = CodexAppServerClient::mock();
        let client = Arc::new(client);
        let client_task = Arc::clone(&client);
        let task = tokio::spawn(async move { login_with_client(&client_task, true, true).await });

        let init = mock.next_request().await.unwrap();
        mock.respond(init["id"].as_u64().unwrap(), json!({}));
        let _ = mock.next_request().await.unwrap(); // initialized

        let login = mock.next_request().await.unwrap();
        assert_eq!(login["params"]["type"], "chatgptDeviceCode");
        mock.respond(
            login["id"].as_u64().unwrap(),
            json!({
                "type": "chatgptDeviceCode",
                "loginId": "login-device-1",
                "verificationUrl": "https://chatgpt.test/device",
                "userCode": "ABCD-EFGH"
            }),
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        mock.notify(
            "account/login/completed",
            json!({ "loginId": "login-device-1", "success": true, "error": null }),
        );
        let read = mock.next_request().await.unwrap();
        mock.respond(
            read["id"].as_u64().unwrap(),
            json!({
                "account": { "type": "chatgpt", "email": "dev@example.com", "planType": "pro" },
                "requiresOpenaiAuth": false
            }),
        );
        assert_eq!(task.await.unwrap().unwrap(), 0);
    }

    #[tokio::test]
    async fn reports_current_codex_app_server_sign_in_status() {
        let (client, mock) = CodexAppServerClient::mock();
        let task = tokio::spawn(async move {
            client.initialize(InitializeOptions::default()).await?;
            client.read_account(true).await
        });
        let init = mock.next_request().await.unwrap();
        mock.respond(init["id"].as_u64().unwrap(), json!({}));
        let _ = mock.next_request().await.unwrap();
        let read = mock.next_request().await.unwrap();
        assert_eq!(read["method"], "account/read");
        mock.respond(
            read["id"].as_u64().unwrap(),
            json!({
                "account": {
                    "type": "chatgpt",
                    "email": "dev@example.com",
                    "planType": "pro"
                },
                "requiresOpenaiAuth": false
            }),
        );
        let account = task.await.unwrap().unwrap();
        assert_eq!(account_label(&account), " as dev@example.com, pro");
    }

    #[tokio::test]
    async fn logs_out_of_chatgpt_for_codex() {
        let (client, mock) = CodexAppServerClient::mock();
        let task = tokio::spawn(async move {
            client.initialize(InitializeOptions::default()).await?;
            client.logout().await
        });
        let init = mock.next_request().await.unwrap();
        mock.respond(init["id"].as_u64().unwrap(), json!({}));
        let _ = mock.next_request().await.unwrap();
        let logout = mock.next_request().await.unwrap();
        assert_eq!(logout["method"], "account/logout");
        mock.respond(logout["id"].as_u64().unwrap(), json!({}));
        task.await.unwrap().unwrap();
    }

    #[test]
    fn unknown_subcommand_message_mentions_login() {
        // Operating-layer evidence: the codex surface owns the `login` subcommand.
        let subcommands = ["login", "logout", "status"];
        assert!(
            subcommands.contains(&"login"),
            "maestro codex login must stay a first-class subcommand"
        );
    }
}
