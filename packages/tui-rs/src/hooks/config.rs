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
//! ```

use super::types::HookEventType;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Hook configuration file structure
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookConfig {
    /// Global settings
    #[serde(default)]
    pub settings: HookSettings,

    /// Hook definitions
    #[serde(default)]
    pub hooks: Vec<HookDefinition>,
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

    /// TypeScript hook path (for IPC bridge)
    #[serde(default)]
    pub typescript: Option<String>,

    /// Hook timeout override
    #[serde(default)]
    pub timeout_ms: Option<u64>,

    /// Whether this hook is enabled
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Hook description
    #[serde(default)]
    pub description: Option<String>,
}

/// Raw JSON hooks configuration (TS schema)
#[derive(Debug, Clone, Default, Deserialize)]
struct RawHooksConfig {
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
    prompt: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

/// Loaded and validated hook configuration
#[derive(Debug)]
pub struct LoadedHookConfig {
    pub settings: HookSettings,
    pub hooks: Vec<LoadedHook>,
    pub source_paths: Vec<PathBuf>,
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
    /// Prompt template
    Prompt(String),
    /// Inline Lua script
    LuaInline(String),
    /// Lua script file
    LuaFile(PathBuf),
    /// WASM plugin
    Wasm(PathBuf),
    /// TypeScript hook (IPC bridge)
    TypeScript(PathBuf),
}

/// Load hook configuration from standard locations
pub fn load_hook_config(cwd: &Path) -> Result<LoadedHookConfig> {
    let mut config = HookConfig::default();
    let mut source_paths = Vec::new();

    // Load JSON config files (TS schema)
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
        let json_config = load_json_config_file(&local_json)?;
        merge_config(&mut config, json_config);
        source_paths.push(local_json);
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
        let local = load_config_file(&local_config)?;
        merge_config(&mut config, local);
        source_paths.push(local_config);
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
    })
}

/// Load a single config file
fn load_config_file(path: &Path) -> Result<HookConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read hook config: {}", path.display()))?;

    toml::from_str(&content)
        .with_context(|| format!("Failed to parse hook config: {}", path.display()))
}

/// Merge two configs (later config takes precedence)
fn merge_config(base: &mut HookConfig, other: HookConfig) {
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
    parse_raw_hooks_config(raw, base_dir)
}

fn parse_raw_hooks_config(raw: RawHooksConfig, base_dir: &Path) -> Result<HookConfig> {
    let mut config = HookConfig::default();

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
            let Some(event) = parse_event_type(&event_name) else {
                eprintln!("[hooks] Unknown event type: {event_name}");
                continue;
            };

            for matcher in matchers {
                let tools = parse_matcher_tools(matcher.matcher.as_deref());
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
                            prompt: Some(prompt),
                            lua: None,
                            lua_file: None,
                            wasm: None,
                            typescript: None,
                            timeout_ms: hook.timeout,
                            enabled: true,
                            description: None,
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
                        prompt: None,
                        lua: None,
                        lua_file: None,
                        wasm: None,
                        typescript: None,
                        timeout_ms: hook.timeout,
                        enabled: true,
                        description: None,
                    });
                }
            }
        }
    }

    Ok(config)
}

fn parse_matcher_tools(matcher: Option<&str>) -> Vec<String> {
    match matcher {
        None => Vec::new(),
        Some("*") => Vec::new(),
        Some(value) => value
            .split('|')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    }
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
        if path.exists() {
            return Some(HookSource::Wasm(path));
        }
    }

    if let Some(ref ts) = def.typescript {
        let path = resolve_path(ts, cwd);
        if path.exists() {
            return Some(HookSource::TypeScript(path));
        }
    }

    None
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
    if p.is_absolute() {
        p
    } else {
        cwd.join(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
