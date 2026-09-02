//! Hook configuration loading from TOML files
//!
//! Loads hook configuration from:
//! - `~/.composer/hooks.toml` (global)
//! - `.composer/hooks.toml` (project-local)
//!
//! # Configuration Format
//!
//! ```toml
//! # Global settings
//! [settings]
//! enabled = true
//! timeout_ms = 30000
//!
//! # Shell command hooks
//! [[hooks]]
//! event = "PreToolUse"
//! tools = ["Bash", "Write"]
//! command = "echo 'Tool: $TOOL_NAME'"
//!
//! # Lua script hooks
//! [[hooks]]
//! event = "PreToolUse"
//! lua = """
//! if tool_name == "Bash" and input.command:match("rm %-rf") then
//!     return { block = true, reason = "Dangerous command" }
//! end
//! """
//!
//! # WASM plugin hooks
//! [[hooks]]
//! event = "PreToolUse"
//! wasm = "~/.composer/plugins/safety.wasm"
//! # required = false  # explicit advisory behavior
//! ```

use super::types::HookEventType;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Hook configuration file structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookConfig {
    /// Schema version of this config file.
    ///
    /// Must be a positive integer. A config whose `version` is missing,
    /// non-integer, or below 1 is refused. Maestro defaults it to
    /// [`CURRENT_HOOK_CONFIG_VERSION`] so files written before the field
    /// existed keep loading, but an explicit `version = 0` is an error.
    #[serde(default = "default_config_version")]
    pub version: u32,

    /// Global settings
    #[serde(default)]
    pub settings: HookSettings,

    /// Hook definitions
    #[serde(default)]
    pub hooks: Vec<HookDefinition>,
}

/// The hook config schema version this build writes and understands.
pub const CURRENT_HOOK_CONFIG_VERSION: u32 = 1;

fn default_config_version() -> u32 {
    CURRENT_HOOK_CONFIG_VERSION
}

impl Default for HookConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_HOOK_CONFIG_VERSION,
            settings: HookSettings::default(),
            hooks: Vec::new(),
        }
    }
}

/// Global hook settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookSettings {
    /// Whether hooks are enabled
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Default timeout in milliseconds
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,

    /// Log hook executions
    #[serde(default)]
    pub log_executions: bool,

    /// Path to log file
    #[serde(default)]
    pub log_file: Option<String>,
}

fn default_enabled() -> bool {
    true
}

fn default_timeout() -> u64 {
    30000
}

impl Default for HookSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            timeout_ms: 30000,
            log_executions: false,
            log_file: None,
        }
    }
}

/// A single hook definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDefinition {
    /// Event type to hook
    pub event: HookEventType,

    /// Tool names to match (empty = all tools)
    #[serde(default)]
    pub tools: Vec<String>,

    /// Shell command to execute
    #[serde(default)]
    pub command: Option<String>,

    /// HTTP endpoint to POST hook input to
    #[serde(default)]
    pub http: Option<String>,

    /// Prompt template (static context)
    #[serde(default)]
    pub prompt: Option<String>,

    /// Inline Lua script
    #[serde(default)]
    pub lua: Option<String>,

    /// Path to Lua script file
    #[serde(default)]
    pub lua_file: Option<String>,

    /// Path to WASM plugin
    #[serde(default)]
    pub wasm: Option<String>,

    /// Hook timeout override
    #[serde(default)]
    pub timeout_ms: Option<u64>,

    /// Whether this hook is enabled
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Whether failures in this hook must block the protected operation.
    ///
    /// A `PreToolUse` WASM hook is fail-closed by default because it can be a
    /// tool policy boundary. Set `required = false` explicitly for an
    /// advisory hook whose unavailability or failure should only be logged.
    /// Other hook events remain advisory unless their execution path has an
    /// explicit enforcement contract.
    #[serde(default)]
    pub required: Option<bool>,

    /// Hook description
    #[serde(default)]
    pub description: Option<String>,

    /// Working directory for package-owned external hooks.
    #[serde(skip)]
    #[serde(default)]
    pub(crate) working_dir: Option<PathBuf>,
}

/// Raw JSON hooks configuration
#[derive(Debug, Clone, Default, Deserialize)]
struct RawHooksConfig {
    #[serde(default = "default_config_version")]
    version: u32,
    #[serde(default)]
    extends: Option<RawExtends>,
    #[serde(default)]
    hooks: Option<HashMap<String, Vec<RawHookMatcher>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum RawExtends {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize)]
struct RawHookMatcher {
    #[serde(default)]
    matcher: Option<String>,
    hooks: Vec<RawHookDef>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawHookDef {
    #[serde(rename = "type", default)]
    hook_type: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    http: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    required: Option<bool>,
}

/// Loaded and validated hook configuration
#[derive(Debug)]
pub struct LoadedHookConfig {
    pub settings: HookSettings,
    pub hooks: Vec<LoadedHook>,
    pub source_paths: Vec<PathBuf>,
    /// Project-local hook config files that existed but were skipped
    /// because the workspace isn't trusted (see [`load_hook_config`]).
    pub skipped_untrusted_paths: Vec<PathBuf>,
}

/// A loaded hook ready for execution
#[derive(Debug)]
pub struct LoadedHook {
    pub definition: HookDefinition,
    pub source: HookSource,
}

/// Source type for a hook
#[derive(Debug)]
pub enum HookSource {
    /// Shell command
    Command(String),
    /// HTTP endpoint
    Http(String),
    /// Prompt template
    Prompt(String),
    /// Inline Lua script
    LuaInline(String),
    /// Lua script file
    LuaFile(PathBuf),
    /// WASM plugin
    Wasm(PathBuf),
}

/// Returns `true` when a project-local `.composer/hooks.toml` or
/// `.composer/hooks.json` exists under `cwd`.
///
/// Used to decide whether an "untrusted workspace" notice is worth
/// showing; does not itself gate loading (see [`load_hook_config`]).
#[must_use]
pub fn has_project_hook_config(cwd: &Path) -> bool {
    cwd.join(".composer").join("hooks.json").exists()
        || cwd.join(".composer").join("hooks.toml").exists()
}

/// Load hook configuration from standard locations.
///
/// Project-local `.composer/hooks.{toml,json}` is repository-controlled and
/// can define Lua/WASM/prompt hooks that run on every prompt and tool call.
/// It is only merged in when the workspace is marked trusted in *global*
/// config, so a repository cannot grant itself trust (see
/// `crate::config::workspace_trusted_in_global_config`). User-level
/// `~/.composer/hooks.{toml,json}` is always trusted since it isn't
/// repository-controlled.
pub fn load_hook_config(cwd: &Path) -> Result<LoadedHookConfig> {
    let workspace_trusted = crate::config::workspace_trusted_in_global_config(cwd);
    let plugin_paths = crate::plugins::PluginRegistry::discover_for_workspace(cwd).hook_configs();
    load_hook_config_with_trust_and_plugins(cwd, workspace_trusted, &plugin_paths)
}

/// Core of [`load_hook_config`] with the trust decision injected.
///
/// Split out so tests can exercise both the trusted and untrusted paths
/// deterministically without mutating the real process `$HOME`.
#[cfg(test)]
fn load_hook_config_with_trust(cwd: &Path, workspace_trusted: bool) -> Result<LoadedHookConfig> {
    load_hook_config_with_trust_and_plugins(cwd, workspace_trusted, &[])
}

fn load_hook_config_with_trust_and_plugins(
    cwd: &Path,
    workspace_trusted: bool,
    plugin_paths: &[PathBuf],
) -> Result<LoadedHookConfig> {
    let mut config = HookConfig::default();
    let mut source_paths = Vec::new();
    let mut skipped_untrusted_paths = Vec::new();

    // Load JSON config files
    if let Some(home) = dirs::home_dir() {
        let global_json = home.join(".composer").join("hooks.json");
        if global_json.exists() {
            let json_config = load_json_config_file(&global_json)?;
            merge_config(&mut config, json_config);
            source_paths.push(global_json);
        }
    }

    let local_json = cwd.join(".composer").join("hooks.json");
    if local_json.exists() {
        if workspace_trusted {
            let json_config = load_json_config_file(&local_json)?;
            merge_config(&mut config, json_config);
            source_paths.push(local_json);
        } else {
            skipped_untrusted_paths.push(local_json);
        }
    }

    // Load global config
    if let Some(home) = dirs::home_dir() {
        let global_config = home.join(".composer").join("hooks.toml");
        if global_config.exists() {
            let global = load_config_file(&global_config)?;
            merge_config(&mut config, global);
            source_paths.push(global_config);
        }
    }

    // Load project-local config
    let local_config = cwd.join(".composer").join("hooks.toml");
    if local_config.exists() {
        if workspace_trusted {
            let local = load_config_file(&local_config)?;
            merge_config(&mut config, local);
            source_paths.push(local_config);
        } else {
            skipped_untrusted_paths.push(local_config);
        }
    }

    if !skipped_untrusted_paths.is_empty() {
        eprintln!(
            "[hooks] Skipped untrusted project hook config(s) {}: set \
             projects.\"<workspace>\".trust_level = \"trusted\" in global config \
             (~/.composer/config.toml) to enable them",
            skipped_untrusted_paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // Plugin discovery has already enforced workspace trust, install trust,
    // the enabled bit, and the Hooks capability bit. Resolve file-backed hook
    // payloads relative to the plugin config rather than the workspace.
    for plugin_path in plugin_paths {
        let loaded = match plugin_path.extension().and_then(|value| value.to_str()) {
            Some("json") => load_json_config_file(plugin_path),
            _ => load_config_file(plugin_path),
        };
        let mut plugin_config = match loaded {
            Ok(config) => config,
            Err(error) => {
                eprintln!(
                    "[hooks] Skipping invalid plugin hook config {}: {error:#}",
                    plugin_path.display()
                );
                continue;
            }
        };
        let plugin_root = plugin_path.parent().unwrap_or(Path::new("."));
        for hook in &mut plugin_config.hooks {
            hook.working_dir = Some(plugin_root.to_path_buf());
        }
        absolutize_hook_payload_paths(&mut plugin_config, plugin_root);
        plugin_config.settings = HookSettings::default();
        merge_config(&mut config, plugin_config);
        source_paths.push(plugin_path.clone());
    }

    // Convert to loaded hooks
    let hooks = config
        .hooks
        .into_iter()
        .filter(|h| h.enabled)
        .filter_map(|def| {
            let source = determine_hook_source(&def, cwd)?;
            Some(LoadedHook {
                definition: def,
                source,
            })
        })
        .collect();

    Ok(LoadedHookConfig {
        settings: config.settings,
        hooks,
        source_paths,
        skipped_untrusted_paths,
    })
}

fn absolutize_hook_payload_paths(config: &mut HookConfig, base_dir: &Path) {
    for hook in &mut config.hooks {
        for value in [&mut hook.lua_file, &mut hook.wasm] {
            let Some(path) = value.as_deref() else {
                continue;
            };
            if Path::new(path).is_relative() {
                *value = Some(base_dir.join(path).to_string_lossy().into_owned());
            }
        }
    }
}

/// Load a single config file
fn load_config_file(path: &Path) -> Result<HookConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read hook config: {}", path.display()))?;

    let config: HookConfig = toml::from_str(&content)
        .with_context(|| format!("Failed to parse hook config: {}", path.display()))?;
    validate_hook_config(&config, path)?;
    Ok(config)
}

/// Reject a config whose version or tool matchers are unusable.
///
/// Both checks run at load so the failure names the file. A matcher that does
/// not compile used to be stored verbatim and compared literally, so the hook
/// silently never fired.
fn validate_hook_config(config: &HookConfig, path: &Path) -> Result<()> {
    anyhow::ensure!(
        config.version >= 1,
        "Hook config {} has version {}; version must be a positive integer",
        path.display(),
        config.version
    );
    for hook in &config.hooks {
        crate::hooks::matcher::ToolMatcher::compile(&hook.tools).with_context(|| {
            format!(
                "Hook config {} has an invalid {:?} tool matcher",
                path.display(),
                hook.event
            )
        })?;
    }
    Ok(())
}

/// Merge two configs (later config takes precedence)
fn merge_config(base: &mut HookConfig, other: HookConfig) {
    base.version = base.version.max(other.version);

    // Merge settings (other overrides)
    if other.settings.enabled != default_enabled() {
        base.settings.enabled = other.settings.enabled;
    }
    if other.settings.timeout_ms != default_timeout() {
        base.settings.timeout_ms = other.settings.timeout_ms;
    }
    if other.settings.log_executions {
        base.settings.log_executions = true;
    }
    if other.settings.log_file.is_some() {
        base.settings.log_file = other.settings.log_file;
    }

    // Append hooks
    base.hooks.extend(other.hooks);
}

fn load_json_config_file(path: &Path) -> Result<HookConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read hook config: {}", path.display()))?;
    let raw: RawHooksConfig = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse hook config: {}", path.display()))?;
    let base_dir = path.parent().unwrap_or(Path::new("."));
    let config = parse_raw_hooks_config(raw, base_dir)
        .with_context(|| format!("Invalid hook config: {}", path.display()))?;
    validate_hook_config(&config, path)?;
    Ok(config)
}

fn parse_raw_hooks_config(raw: RawHooksConfig, base_dir: &Path) -> Result<HookConfig> {
    let mut config = HookConfig {
        version: raw.version,
        ..HookConfig::default()
    };

    if let Some(extends) = raw.extends {
        let paths = match extends {
            RawExtends::One(value) => vec![value],
            RawExtends::Many(values) => values,
        };
        for entry in paths {
            let resolved = if entry.starts_with("~/") {
                if let Some(home) = dirs::home_dir() {
                    home.join(entry.trim_start_matches("~/"))
                } else {
                    PathBuf::from(entry)
                }
            } else if Path::new(&entry).is_absolute() {
                PathBuf::from(entry)
            } else {
                base_dir.join(entry)
            };
            if resolved.exists() {
                let extended = load_json_config_file(&resolved)?;
                merge_config(&mut config, extended);
            }
        }
    }

    if let Some(hooks) = raw.hooks {
        for (event_name, matchers) in hooks {
            // Reject an unknown hook name instead of dropping the entry. A
            // dropped entry looks like a configured hook that never runs.
            let Some(event) = parse_event_type(&event_name) else {
                anyhow::bail!("Unknown hook event type: {event_name}");
            };

            for matcher in matchers {
                let tools = parse_matcher_tools(matcher.matcher.as_deref())?;
                for hook in matcher.hooks {
                    if hook.hook_type.as_deref() == Some("agent") {
                        continue;
                    }
                    if hook.hook_type.as_deref() == Some("prompt") || hook.prompt.is_some() {
                        let prompt = match hook.prompt {
                            Some(prompt) if !prompt.trim().is_empty() => prompt,
                            _ => {
                                eprintln!("[hooks] Prompt hook missing prompt field");
                                continue;
                            }
                        };
                        config.hooks.push(HookDefinition {
                            event,
                            tools: tools.clone(),
                            command: None,
                            http: None,
                            prompt: Some(prompt),
                            lua: None,
                            lua_file: None,
                            wasm: None,
                            timeout_ms: hook.timeout,
                            enabled: true,
                            required: hook.required,
                            description: None,
                            working_dir: None,
                        });
                        continue;
                    }
                    let hook_type = hook.hook_type.as_deref();
                    let http = hook.http.or(hook.url);
                    if hook_type == Some("http") || http.is_some() {
                        let Some(http) = http else {
                            eprintln!("[hooks] HTTP hook missing URL");
                            continue;
                        };
                        config.hooks.push(HookDefinition {
                            event,
                            tools: tools.clone(),
                            command: None,
                            http: Some(http),
                            prompt: None,
                            lua: None,
                            lua_file: None,
                            wasm: None,
                            timeout_ms: hook.timeout,
                            enabled: true,
                            required: hook.required,
                            description: None,
                            working_dir: None,
                        });
                        continue;
                    }
                    let command = if let Some(cmd) = hook.command {
                        cmd
                    } else {
                        eprintln!("[hooks] Command hook missing command field");
                        continue;
                    };
                    config.hooks.push(HookDefinition {
                        event,
                        tools: tools.clone(),
                        command: Some(command),
                        http: None,
                        prompt: None,
                        lua: None,
                        lua_file: None,
                        wasm: None,
                        timeout_ms: hook.timeout,
                        enabled: true,
                        required: hook.required,
                        description: None,
                        working_dir: None,
                    });
                }
            }
        }
    }

    Ok(config)
}

/// Turn a `matcher` string into a hook's `tools` list.
///
/// The matcher is one regular expression, not a `|`-separated list of literal
/// names: splitting it turned `Write.*` into the literal name `Write.*`, which
/// then matched no tool and reported nothing. Alternation still works because
/// `|` is regex alternation.
///
/// # Errors
///
/// Returns an error when the matcher is not a valid regular expression, so the
/// failure surfaces at config load instead of as a hook that never fires.
fn parse_matcher_tools(matcher: Option<&str>) -> Result<Vec<String>> {
    let pattern = match matcher {
        None | Some("*") => return Ok(Vec::new()),
        Some(value) => value.trim(),
    };
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    crate::hooks::matcher::compile_tool_pattern(pattern)?;
    Ok(vec![pattern.to_string()])
}

fn parse_event_type(name: &str) -> Option<HookEventType> {
    match name {
        "PreToolUse" => Some(HookEventType::PreToolUse),
        "PostToolUse" => Some(HookEventType::PostToolUse),
        "PostToolUseFailure" => Some(HookEventType::PostToolUseFailure),
        "SessionStart" => Some(HookEventType::SessionStart),
        "SessionEnd" => Some(HookEventType::SessionEnd),
        "SessionSwitch" => Some(HookEventType::SessionSwitch),
        "SessionBeforeTree" => Some(HookEventType::SessionBeforeTree),
        "SessionTree" => Some(HookEventType::SessionTree),
        "UserPromptSubmit" => Some(HookEventType::UserPromptSubmit),
        "PreCompact" => Some(HookEventType::PreCompact),
        "PostCompact" => Some(HookEventType::PostCompact),
        "Notification" => Some(HookEventType::Notification),
        "Overflow" => Some(HookEventType::Overflow),
        "StopFailure" => Some(HookEventType::StopFailure),
        "PreMessage" => Some(HookEventType::PreMessage),
        "PostMessage" => Some(HookEventType::PostMessage),
        "OnError" => Some(HookEventType::OnError),
        "EvalGate" => Some(HookEventType::EvalGate),
        "SubagentStart" => Some(HookEventType::SubagentStart),
        "SubagentStop" => Some(HookEventType::SubagentStop),
        "PermissionRequest" => Some(HookEventType::PermissionRequest),
        "Branch" => Some(HookEventType::Branch),
        _ => None,
    }
}

/// Determine the source type for a hook definition
fn determine_hook_source(def: &HookDefinition, cwd: &Path) -> Option<HookSource> {
    if let Some(ref prompt) = def.prompt {
        return Some(HookSource::Prompt(prompt.clone()));
    }

    if let Some(ref cmd) = def.command {
        return Some(HookSource::Command(cmd.clone()));
    }

    if let Some(ref http) = def.http {
        return Some(HookSource::Http(http.clone()));
    }

    if let Some(ref lua) = def.lua {
        return Some(HookSource::LuaInline(lua.clone()));
    }

    if let Some(ref lua_file) = def.lua_file {
        let path = resolve_path(lua_file, cwd);
        if path.exists() {
            return Some(HookSource::LuaFile(path));
        }
    }

    if let Some(ref wasm) = def.wasm {
        let path = resolve_path(wasm, cwd);
        // Preserve missing WASM paths so the integration layer can surface a
        // required policy as unavailable and fail closed. Dropping the source
        // here made a configured policy indistinguishable from no hook.
        return Some(HookSource::Wasm(path));
    }

    None
}

impl HookDefinition {
    /// Whether this hook must prevent a tool call when its WASM backend is
    /// unavailable or fails to produce a valid result.
    #[must_use]
    pub fn fail_closed(&self) -> bool {
        self.required
            .unwrap_or(matches!(self.event, HookEventType::PreToolUse))
    }
}

/// Resolve a path, expanding ~ to home directory
fn resolve_path(path: &str, cwd: &Path) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    if let Some(stripped) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }

    let p = PathBuf::from(path);
    if p.is_absolute() { p } else { cwd.join(p) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_hook_config_is_loaded_and_resolves_payloads_from_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_dir = temp.path().join("plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("guard.lua"), "return {}").unwrap();
        let plugin_config = plugin_dir.join("hooks.toml");
        std::fs::write(
            &plugin_config,
            r#"
[[hooks]]
event = "PreToolUse"
lua_file = "guard.lua"
"#,
        )
        .unwrap();

        let loaded = load_hook_config_with_trust_and_plugins(
            temp.path(),
            false,
            std::slice::from_ref(&plugin_config),
        )
        .unwrap();
        assert!(loaded.source_paths.contains(&plugin_config));
        assert!(matches!(
            loaded.hooks.as_slice(),
            [LoadedHook {
                source: HookSource::LuaFile(path),
                ..
            }] if path == &plugin_dir.join("guard.lua")
        ));
    }

    #[test]
    fn plugin_command_hooks_are_loaded_for_native_execution() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_dir = temp.path().join("plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let plugin_config = plugin_dir.join("hooks.toml");
        std::fs::write(
            &plugin_config,
            r#"
[[hooks]]
event = "PreToolUse"
command = "./hooks/validate-tool.sh"
"#,
        )
        .unwrap();

        let loaded = load_hook_config_with_trust_and_plugins(
            temp.path(),
            false,
            std::slice::from_ref(&plugin_config),
        )
        .unwrap();
        assert_eq!(loaded.hooks.len(), 1);
        assert!(loaded.source_paths.contains(&plugin_config));
        assert!(matches!(
            loaded.hooks.as_slice(),
            [LoadedHook {
                source: HookSource::Command(command),
                definition,
            }] if command == "./hooks/validate-tool.sh"
                && definition.working_dir.as_deref() == plugin_config.parent()
        ));
    }

    #[test]
    fn plugin_json_http_hooks_are_loaded_for_native_execution() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_config = temp.path().join("hooks.json");
        std::fs::write(
            &plugin_config,
            r#"
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "http", "url": "http://127.0.0.1:9/hook", "timeout": 250}]
    }]
  }
}
"#,
        )
        .unwrap();

        let loaded = load_hook_config_with_trust_and_plugins(
            temp.path(),
            false,
            std::slice::from_ref(&plugin_config),
        )
        .unwrap();
        assert!(matches!(
            loaded.hooks.as_slice(),
            [LoadedHook {
                source: HookSource::Http(url),
                definition,
            }] if url == "http://127.0.0.1:9/hook"
                && definition.tools == vec!["Bash"]
                && definition.timeout_ms == Some(250)
        ));
    }

    #[test]
    fn invalid_plugin_and_plugin_settings_are_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let invalid = temp.path().join("invalid.toml");
        std::fs::write(&invalid, "not = [valid").unwrap();
        let valid = temp.path().join("valid.toml");
        std::fs::write(
            &valid,
            r#"
[settings]
enabled = false
[[hooks]]
event = "PreToolUse"
lua = "return {}"
"#,
        )
        .unwrap();

        let loaded =
            load_hook_config_with_trust_and_plugins(temp.path(), false, &[invalid, valid]).unwrap();
        assert!(loaded.settings.enabled);
        assert_eq!(loaded.hooks.len(), 1);
    }

    #[test]
    fn test_parse_config() {
        let toml = r#"
[settings]
enabled = true
timeout_ms = 5000

[[hooks]]
event = "PreToolUse"
tools = ["Bash"]
command = "echo test"
description = "Test hook"
"#;

        let config: HookConfig = toml::from_str(toml).unwrap();
        assert!(config.settings.enabled);
        assert_eq!(config.settings.timeout_ms, 5000);
        assert_eq!(config.hooks.len(), 1);
        assert_eq!(config.hooks[0].event, HookEventType::PreToolUse);
    }

    #[test]
    fn pre_tool_wasm_policy_defaults_fail_closed_but_can_be_advisory() {
        let defaulted: HookConfig = toml::from_str(
            r#"
[[hooks]]
event = "PreToolUse"
wasm = "policy.wasm"
"#,
        )
        .unwrap();
        assert!(defaulted.hooks[0].required.is_none());
        assert!(defaulted.hooks[0].fail_closed());

        let advisory: HookConfig = toml::from_str(
            r#"
[[hooks]]
event = "PreToolUse"
wasm = "telemetry.wasm"
required = false
"#,
        )
        .unwrap();
        assert_eq!(advisory.hooks[0].required, Some(false));
        assert!(!advisory.hooks[0].fail_closed());
    }

    #[test]
    fn missing_wasm_path_remains_configured_for_policy_enforcement() {
        let cwd = tempfile::tempdir().unwrap();
        let config: HookConfig = toml::from_str(
            r#"
[[hooks]]
event = "PreToolUse"
wasm = "missing-policy.wasm"
"#,
        )
        .unwrap();

        assert!(matches!(
            determine_hook_source(&config.hooks[0], cwd.path()),
            Some(HookSource::Wasm(path)) if path == cwd.path().join("missing-policy.wasm")
        ));
    }

    #[test]
    fn test_lua_hook_config() {
        let toml = r#"
[[hooks]]
event = "PreToolUse"
lua = """
if tool_name == "Bash" then
    return { continue = true }
end
"""
"#;

        let config: HookConfig = toml::from_str(toml).unwrap();
        assert!(config.hooks[0].lua.is_some());
    }

    #[test]
    fn test_resolve_path_expands_tilde() {
        let cwd = Path::new("/tmp");
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let resolved = resolve_path("~", cwd);
        assert_eq!(resolved, home);
    }

    #[test]
    fn test_resolve_path_expands_tilde_backslash() {
        let cwd = Path::new("/tmp");
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let resolved = resolve_path("~\\composer-test", cwd);
        assert_eq!(resolved, home.join("composer-test"));
    }

    // ── Trust gate (repo-controlled `.composer/hooks.{toml,json}`) ───────

    fn write_project_hooks_toml(cwd: &Path, body: &str) {
        std::fs::create_dir_all(cwd.join(".composer")).unwrap();
        std::fs::write(cwd.join(".composer").join("hooks.toml"), body).unwrap();
    }

    /// Regression test for the trust-gate fix: an untrusted workspace's
    /// project-level `hooks.toml` must not be merged in (and therefore must
    /// not run its Lua/command hooks on every prompt and tool call). Before
    /// the fix, `load_hook_config` had no trust check at all.
    #[test]
    fn test_untrusted_workspace_does_not_load_project_hooks() {
        let temp = tempfile::TempDir::new().unwrap();
        write_project_hooks_toml(
            temp.path(),
            r#"
[[hooks]]
event = "PreToolUse"
command = "echo pwned"
"#,
        );

        let loaded = load_hook_config_with_trust(temp.path(), false).unwrap();
        assert!(
            loaded.hooks.is_empty(),
            "untrusted workspace must not load repo-controlled hooks"
        );
        assert_eq!(loaded.skipped_untrusted_paths.len(), 1);
        assert!(loaded.source_paths.is_empty());
    }

    #[test]
    fn test_trusted_workspace_loads_project_hooks() {
        let temp = tempfile::TempDir::new().unwrap();
        write_project_hooks_toml(
            temp.path(),
            r#"
[[hooks]]
event = "PreToolUse"
command = "echo trusted"
"#,
        );

        let loaded = load_hook_config_with_trust(temp.path(), true).unwrap();
        assert_eq!(loaded.hooks.len(), 1);
        assert!(loaded.skipped_untrusted_paths.is_empty());
        assert_eq!(loaded.source_paths.len(), 1);
    }

    #[test]
    fn test_has_project_hook_config() {
        let temp = tempfile::TempDir::new().unwrap();
        assert!(!has_project_hook_config(temp.path()));
        write_project_hooks_toml(temp.path(), "[settings]\nenabled = true\n");
        assert!(has_project_hook_config(temp.path()));
    }

    fn write_json_config(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("hooks.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn regex_matcher_is_kept_whole_and_selects_prefixed_tools() {
        let temp = tempfile::tempdir().unwrap();
        let config = write_json_config(
            temp.path(),
            r#"{"version":1,"hooks":{"PreToolUse":[{"matcher":"Write.*","hooks":[{"command":"./check.sh"}]}]}}"#,
        );

        let loaded = load_hook_config_with_trust_and_plugins(
            temp.path(),
            false,
            std::slice::from_ref(&config),
        )
        .unwrap();
        assert_eq!(loaded.hooks.len(), 1);
        assert_eq!(
            loaded.hooks[0].definition.tools,
            vec!["Write.*".to_string()]
        );

        let matcher =
            crate::hooks::matcher::ToolMatcher::compile(&loaded.hooks[0].definition.tools).unwrap();
        assert!(matcher.matches("Write"));
        assert!(matcher.matches("WriteFile"));
        assert!(!matcher.matches("Read"));
    }

    #[test]
    fn alternation_matcher_is_not_split_into_literals() {
        let temp = tempfile::tempdir().unwrap();
        let config = write_json_config(
            temp.path(),
            r#"{"version":1,"hooks":{"PreToolUse":[{"matcher":"Write|Edit","hooks":[{"command":"./check.sh"}]}]}}"#,
        );

        let loaded = load_hook_config_with_trust_and_plugins(
            temp.path(),
            false,
            std::slice::from_ref(&config),
        )
        .unwrap();
        assert_eq!(
            loaded.hooks[0].definition.tools,
            vec!["Write|Edit".to_string()]
        );
        let matcher =
            crate::hooks::matcher::ToolMatcher::compile(&loaded.hooks[0].definition.tools).unwrap();
        assert!(matcher.matches("Write"));
        assert!(matcher.matches("Edit"));
        assert!(!matcher.matches("Bash"));
    }

    #[test]
    fn malformed_matcher_fails_the_load_with_the_pattern() {
        let temp = tempfile::tempdir().unwrap();
        let config = write_json_config(
            temp.path(),
            r#"{"version":1,"hooks":{"PreToolUse":[{"matcher":"Write(","hooks":[{"command":"./check.sh"}]}]}}"#,
        );

        let error =
            load_json_config_file(&config).expect_err("an uncompilable matcher must fail the load");
        let message = format!("{error:#}");
        assert!(message.contains("Write("), "{message}");
        assert!(message.contains("not a valid regex"), "{message}");
    }

    #[test]
    fn unknown_event_name_fails_the_load() {
        let temp = tempfile::tempdir().unwrap();
        let config = write_json_config(
            temp.path(),
            r#"{"version":1,"hooks":{"BeforeLunch":[{"hooks":[{"command":"./check.sh"}]}]}}"#,
        );

        let error =
            load_json_config_file(&config).expect_err("an unknown hook event must fail the load");
        assert!(format!("{error:#}").contains("BeforeLunch"), "{error:#}");
    }

    #[test]
    fn config_version_defaults_to_one_and_zero_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let config = write_json_config(
            temp.path(),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"./check.sh"}]}]}}"#,
        );
        let loaded = load_json_config_file(&config).unwrap();
        assert_eq!(loaded.version, CURRENT_HOOK_CONFIG_VERSION);
        assert_eq!(loaded.hooks.len(), 1);

        let zero = write_json_config(
            temp.path(),
            r#"{"version":0,"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"./check.sh"}]}]}}"#,
        );
        let error = load_json_config_file(&zero).expect_err("version 0 must be rejected");
        assert!(
            format!("{error:#}").contains("positive integer"),
            "{error:#}"
        );
    }

    #[test]
    fn toml_config_version_is_validated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("hooks.toml");
        std::fs::write(
            &path,
            "version = 0\n[[hooks]]\nevent = \"PreToolUse\"\ncommand = \"echo hi\"\n",
        )
        .unwrap();
        let error = load_config_file(&path).expect_err("version 0 must be rejected");
        assert!(
            format!("{error:#}").contains("positive integer"),
            "{error:#}"
        );

        std::fs::write(
            &path,
            "[[hooks]]\nevent = \"PreToolUse\"\ntools = [\"Write(\"]\ncommand = \"echo hi\"\n",
        )
        .unwrap();
        let error = load_config_file(&path).expect_err("an uncompilable matcher must be rejected");
        assert!(format!("{error:#}").contains("Write("), "{error:#}");
    }
}
