//! Installation and trust state for native Maestro plugins.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use wait_timeout::ChildExt;

use super::{load_manifest, resolve_components};

const MAX_PLUGIN_FILES: usize = 10_000;
const MAX_PLUGIN_BYTES: u64 = 100 * 1024 * 1024;
const PLUGIN_CLONE_TIMEOUT: Duration = Duration::from_mins(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginCapability {
    Skills,
    Agents,
    Commands,
    Hooks,
    Mcp,
    Connections,
}

impl PluginCapability {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "skills" => Ok(Self::Skills),
            "agents" => Ok(Self::Agents),
            "commands" => Ok(Self::Commands),
            "hooks" => Ok(Self::Hooks),
            "mcp" => Ok(Self::Mcp),
            "connections" => Ok(Self::Connections),
            _ => bail!("unknown plugin capability: {value}"),
        }
    }

    /// Whether a missing capability entry in legacy `plugin-state.json`
    /// should be treated as enabled.
    ///
    /// Pre-existing capabilities default on so older state files keep their
    /// prior behavior. Capabilities introduced after those files were written
    /// default off until an explicit grant is recorded.
    fn defaults_enabled_when_absent(self) -> bool {
        !matches!(self, Self::Agents | Self::Connections)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PluginTrustState {
    pub trusted_source: String,
    pub enabled: bool,
    pub capabilities: BTreeMap<PluginCapability, bool>,
    /// Marketplace catalog id when installed via marketplace install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_id: Option<String>,
    /// Marketplace trust tier at install time (official|curated|community).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_tier: Option<String>,
    /// Unix seconds when the plugin was installed (if known).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at_unix: Option<u64>,
}

/// Optional provenance recorded into `plugin-state.json` on install.
#[derive(Debug, Clone, Default)]
pub struct InstallProvenance {
    pub marketplace_id: Option<String>,
    pub marketplace_tier: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginState {
    pub plugins: BTreeMap<String, PluginTrustState>,
}

impl PluginState {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).context("invalid plugin-state.json"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        crate::path_utils::atomic_private_write(path, &serde_json::to_vec_pretty(self)?)
    }

    pub fn capability_enabled(&self, plugin: &str, capability: PluginCapability) -> bool {
        self.plugins.get(&plugin.to_lowercase()).map_or_else(
            // Preserve convention-based discovery for existing components.
            // Connection types are the first component that always requires
            // a plugin-state grant, including for manually placed plugins.
            || !matches!(capability, PluginCapability::Connections),
            |state| {
                state.enabled
                    && state
                        .capabilities
                        .get(&capability)
                        .copied()
                        // Missing entries for capabilities that existed when
                        // the state file was written stay enabled. Newly
                        // introduced capabilities (Agents) default off so an
                        // upgrade does not activate them without a grant.
                        .unwrap_or_else(|| capability.defaults_enabled_when_absent())
            },
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub name: String,
    pub source: String,
    pub capabilities: BTreeSet<PluginCapability>,
}

/// Install from a local directory or a git URL. Remote sources require explicit trust.
pub fn install(
    source: &str,
    destination_root: &Path,
    state_path: &Path,
    trust: bool,
) -> Result<InstallPreview> {
    install_with_provenance(source, destination_root, state_path, trust, None)
}

/// Install with optional marketplace provenance for `plugin-state.json`.
pub fn install_with_provenance(
    source: &str,
    destination_root: &Path,
    state_path: &Path,
    trust: bool,
    provenance: Option<InstallProvenance>,
) -> Result<InstallPreview> {
    let source_path = Path::new(source);
    let checkout;
    let root = if source_path.is_dir() {
        source_path
    } else {
        if !trust {
            bail!("remote plugin code requires explicit --trust");
        }
        validate_remote_source(source)?;
        checkout = TempDir::new()?;
        clone_remote(source, checkout.path(), PLUGIN_CLONE_TIMEOUT)?;
        checkout.path()
    };

    validate_tree(root)?;
    let manifest = load_manifest(root);
    let name = manifest
        .as_ref()
        .and_then(|value| value.name.clone())
        .or_else(|| {
            if source_path.is_dir() {
                source_path.file_name()?.to_str().map(ToOwned::to_owned)
            } else {
                source
                    .trim_end_matches('/')
                    .rsplit(['/', ':'])
                    .next()
                    .map(|value| value.trim_end_matches(".git").to_string())
            }
        })
        .context("plugin name is missing or non-UTF-8")?;
    validate_name(&name)?;
    let components = resolve_components(root, manifest.as_ref());
    let capabilities = capabilities_for(&components);
    if capabilities.is_empty() {
        bail!("plugin contains no supported components");
    }
    let mut state = PluginState::load(state_path)?;
    let previous_state = state.clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let provenance = provenance.unwrap_or_default();
    state.plugins.insert(
        name.to_lowercase(),
        PluginTrustState {
            trusted_source: source.to_string(),
            enabled: true,
            capabilities: capabilities
                .iter()
                .map(|value| (*value, !matches!(value, PluginCapability::Connections)))
                .collect(),
            marketplace_id: provenance.marketplace_id,
            marketplace_tier: provenance.marketplace_tier,
            installed_at_unix: Some(now),
        },
    );

    fs::create_dir_all(destination_root)?;
    let destination = destination_root.join(&name);
    let staging = destination_root.join(format!(".{name}.installing"));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    for entry in fs::read_dir(destination_root)?.filter_map(|entry| entry.ok()) {
        let directory_name = entry.file_name();
        let manifest_name = entry
            .file_type()
            .ok()
            .filter(|file_type| file_type.is_dir())
            .and_then(|_| load_manifest(&entry.path()))
            .and_then(|manifest| manifest.name);
        if directory_name.to_string_lossy().eq_ignore_ascii_case(&name)
            || manifest_name
                .as_deref()
                .is_some_and(|identity| identity.eq_ignore_ascii_case(&name))
        {
            bail!(
                "plugin already installed: {}",
                directory_name.to_string_lossy()
            );
        }
    }
    copy_tree(root, &staging)?;
    fs::write(
        staging.join(".maestro-untrusted"),
        "Installation is incomplete; Maestro will not load this plugin.\n",
    )?;
    fs::rename(&staging, &destination)?;

    if let Err(error) = state.save(state_path) {
        remove_failed_install(&destination)
            .context("plugin state save failed and installation rollback also failed")?;
        return Err(error.context("failed to save plugin trust state; installation rolled back"));
    }
    if let Err(error) = fs::remove_file(destination.join(".maestro-untrusted")) {
        remove_failed_install(&destination)
            .context("plugin activation failed and installation rollback also failed")?;
        previous_state
            .save(state_path)
            .context("plugin activation failed and trust-state rollback also failed")?;
        return Err(error).context("failed to activate plugin; installation rolled back");
    }
    Ok(InstallPreview {
        name,
        source: source.to_string(),
        capabilities,
    })
}

fn validate_remote_source(source: &str) -> Result<()> {
    let Ok(url) = url::Url::parse(source) else {
        return Ok(());
    };
    if matches!(url.scheme(), "http" | "https")
        && (!url.username().is_empty() || url.password().is_some())
    {
        bail!("plugin source URLs may not contain credentials");
    }
    if url.query_pairs().any(|(key, _)| {
        matches!(
            key.to_ascii_lowercase().replace(['-', '_'], "").as_str(),
            "token"
                | "apikey"
                | "secret"
                | "clientsecret"
                | "accesstoken"
                | "privatetoken"
                | "refreshtoken"
                | "bearertoken"
                | "authtoken"
                | "xapikey"
                | "password"
        )
    }) {
        bail!("plugin source URLs may not contain credential query parameters");
    }
    Ok(())
}

fn clone_remote(source: &str, destination: &Path, timeout: Duration) -> Result<()> {
    let mut child = Command::new("git")
        .args(["clone", "--depth", "1", "--", source])
        .arg(destination)
        .spawn()
        .context("failed to run git clone")?;
    let status = wait_for_clone(&mut child, source, timeout)?;
    if !status.success() {
        bail!("git clone failed for {source}");
    }
    Ok(())
}

fn wait_for_clone(
    child: &mut std::process::Child,
    source: &str,
    timeout: Duration,
) -> Result<std::process::ExitStatus> {
    match child
        .wait_timeout(timeout)
        .context("failed while waiting for git clone")?
    {
        Some(status) => Ok(status),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("git clone timed out for {source}");
        }
    }
}

fn remove_failed_install(destination: &Path) -> Result<()> {
    match fs::remove_dir_all(destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn set_enabled(state_path: &Path, plugin: &str, enabled: bool) -> Result<()> {
    let mut state = PluginState::load(state_path)?;
    let entry = state
        .plugins
        .entry(plugin.to_lowercase())
        .or_insert_with(|| PluginTrustState {
            trusted_source: "adopted-existing-plugin".to_string(),
            enabled: true,
            capabilities: BTreeMap::new(),
            ..Default::default()
        });
    entry.enabled = enabled;
    state.save(state_path)
}

pub fn set_capability(
    state_path: &Path,
    plugin: &str,
    capability: PluginCapability,
    enabled: bool,
) -> Result<()> {
    let mut state = PluginState::load(state_path)?;
    let entry = state
        .plugins
        .entry(plugin.to_lowercase())
        .or_insert_with(|| PluginTrustState {
            trusted_source: "adopted-existing-plugin".to_string(),
            enabled: true,
            capabilities: BTreeMap::new(),
            ..Default::default()
        });
    entry.capabilities.insert(capability, enabled);
    state.save(state_path)
}

fn capabilities_for(components: &super::PluginComponents) -> BTreeSet<PluginCapability> {
    let mut values = BTreeSet::new();
    if components.skills_dir.is_some() {
        values.insert(PluginCapability::Skills);
    }
    if components.agents_dir.is_some() {
        values.insert(PluginCapability::Agents);
    }
    if components.commands_dir.is_some() {
        values.insert(PluginCapability::Commands);
    }
    if components.hooks_config.is_some() {
        values.insert(PluginCapability::Hooks);
    }
    if components.mcp_path.is_some() {
        values.insert(PluginCapability::Mcp);
    }
    if components.connections_path.is_some() {
        values.insert(PluginCapability::Connections);
    }
    values
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('.')
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        bail!("unsafe plugin name: {name}");
    }
    Ok(())
}

fn validate_tree(root: &Path) -> Result<()> {
    let mut stack = vec![root.to_path_buf()];
    let mut files = 0;
    let mut bytes = 0;
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                bail!("plugin packages may not contain symbolic links");
            }
            if metadata.is_dir() {
                if entry.file_name() != ".git" {
                    stack.push(entry.path());
                }
            } else {
                files += 1;
                bytes += metadata.len();
                if files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES {
                    bail!("plugin package exceeds installation limits");
                }
            }
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            bail!("plugin packages may not contain symbolic links");
        }
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_records_trust_and_capability_toggles() {
        let source = TempDir::new().unwrap();
        fs::create_dir(source.path().join("skills")).unwrap();
        fs::write(
            source.path().join("plugin.json"),
            r#"{"name":"demo-plugin"}"#,
        )
        .unwrap();
        fs::write(
            source.path().join("connections.json"),
            r#"{"schemaVersion":1,"connectionTypes":[]}"#,
        )
        .unwrap();
        let home = TempDir::new().unwrap();
        let state_path = home.path().join("plugin-state.json");
        let preview = install(
            source.path().to_str().unwrap(),
            &home.path().join("plugins"),
            &state_path,
            false,
        )
        .unwrap();
        assert!(preview.capabilities.contains(&PluginCapability::Skills));
        assert!(preview
            .capabilities
            .contains(&PluginCapability::Connections));
        let initial_state = PluginState::load(&state_path).unwrap();
        assert!(!initial_state.capability_enabled("demo-plugin", PluginCapability::Connections));
        set_capability(&state_path, "demo-plugin", PluginCapability::Skills, false).unwrap();
        let state = PluginState::load(&state_path).unwrap();
        assert!(!state.capability_enabled("demo-plugin", PluginCapability::Skills));
    }

    #[test]
    fn toggles_adopt_plugins_without_existing_trust_state() {
        let home = TempDir::new().unwrap();
        let state_path = home.path().join("plugin-state.json");

        set_enabled(&state_path, "legacy-plugin", false).unwrap();
        set_enabled(&state_path, "legacy-plugin", true).unwrap();
        set_capability(
            &state_path,
            "legacy-plugin",
            PluginCapability::Commands,
            false,
        )
        .unwrap();

        let state = PluginState::load(&state_path).unwrap();
        let adopted = &state.plugins["legacy-plugin"];
        assert!(adopted.enabled);
        assert_eq!(adopted.trusted_source, "adopted-existing-plugin");
        assert_eq!(
            adopted.capabilities.get(&PluginCapability::Commands),
            Some(&false)
        );
    }

    #[test]
    fn remote_sources_require_trust() {
        let home = TempDir::new().unwrap();
        let error = install(
            "https://example.invalid/plugin.git",
            &home.path().join("plugins"),
            &home.path().join("state.json"),
            false,
        )
        .unwrap_err();
        assert!(error.to_string().contains("--trust"));
    }

    #[test]
    fn install_rejects_case_insensitive_duplicate_name() {
        let source = TempDir::new().unwrap();
        fs::create_dir(source.path().join("skills")).unwrap();
        fs::write(source.path().join("plugin.json"), r#"{"name":"demo"}"#).unwrap();
        let home = TempDir::new().unwrap();
        let destination_root = home.path().join("plugins");
        fs::create_dir_all(destination_root.join("Demo")).unwrap();

        let error = install(
            source.path().to_str().unwrap(),
            &destination_root,
            &home.path().join("plugin-state.json"),
            false,
        )
        .unwrap_err();

        assert!(error.to_string().contains("plugin already installed: Demo"));
        let entries = fs::read_dir(&destination_root).unwrap().count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn install_rejects_duplicate_manifest_identity_under_alias_directory() {
        let source = TempDir::new().unwrap();
        fs::create_dir(source.path().join("skills")).unwrap();
        fs::write(source.path().join("plugin.json"), r#"{"name":"demo"}"#).unwrap();
        let home = TempDir::new().unwrap();
        let destination_root = home.path().join("plugins");
        let alias = destination_root.join("legacy-alias");
        fs::create_dir_all(&alias).unwrap();
        fs::write(alias.join("plugin.json"), r#"{"name":"Demo"}"#).unwrap();

        let error = install(
            source.path().to_str().unwrap(),
            &destination_root,
            &home.path().join("plugin-state.json"),
            false,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("plugin already installed: legacy-alias"));
        assert_eq!(fs::read_dir(&destination_root).unwrap().count(), 1);
    }

    #[test]
    fn install_removes_stale_staging_before_duplicate_scan() {
        let source = TempDir::new().unwrap();
        fs::create_dir(source.path().join("skills")).unwrap();
        fs::write(source.path().join("plugin.json"), r#"{"name":"demo"}"#).unwrap();
        let home = TempDir::new().unwrap();
        let destination_root = home.path().join("plugins");
        let staging = destination_root.join(".demo.installing");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("plugin.json"), r#"{"name":"demo"}"#).unwrap();
        fs::write(staging.join("stale"), "partial install").unwrap();

        install(
            source.path().to_str().unwrap(),
            &destination_root,
            &home.path().join("plugin-state.json"),
            false,
        )
        .unwrap();

        assert!(destination_root.join("demo").exists());
        assert!(!staging.exists());
        assert!(!destination_root.join("demo").join("stale").exists());
    }

    #[test]
    fn remote_sources_reject_embedded_credentials_before_clone() {
        let home = TempDir::new().unwrap();
        for source in [
            "https://user:token@example.test/plugin.git",
            "https://example.test/plugin.git?access_token=secret",
        ] {
            let error = install(
                source,
                &home.path().join("plugins"),
                &home.path().join("state.json"),
                true,
            )
            .unwrap_err();
            assert!(error.to_string().contains("plugin source URL"));
        }
    }

    #[test]
    fn remote_sources_reject_additional_normalized_credential_query_keys() {
        let home = TempDir::new().unwrap();
        let state_path = home.path().join("state.json");
        for source in [
            "https://example.test/plugin.git?private_token=secret",
            "https://example.test/plugin.git?x-api-key=secret",
            "https://example.test/plugin.git?auth_token=secret",
            "https://example.test/plugin.git?authtoken=secret",
        ] {
            let error =
                install(source, &home.path().join("plugins"), &state_path, true).unwrap_err();

            assert!(error.to_string().contains("credential query parameters"));
            assert!(!state_path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn clone_wait_timeout_kills_stalled_child() {
        let mut child = Command::new("sh").args(["-c", "sleep 5"]).spawn().unwrap();
        let error = wait_for_clone(
            &mut child,
            "stalled.example/plugin.git",
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.to_string().contains("git clone timed out"));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn malformed_trust_state_leaves_no_installed_plugin() {
        let source = TempDir::new().unwrap();
        fs::create_dir(source.path().join("skills")).unwrap();
        fs::write(
            source.path().join("plugin.json"),
            r#"{"name":"retryable-plugin"}"#,
        )
        .unwrap();
        let home = TempDir::new().unwrap();
        let destination_root = home.path().join("plugins");
        let state_path = home.path().join("plugin-state.json");
        fs::write(&state_path, "{not-json").unwrap();

        let error = install(
            source.path().to_str().unwrap(),
            &destination_root,
            &state_path,
            false,
        )
        .unwrap_err();

        assert!(error.to_string().contains("invalid plugin-state.json"));
        assert!(!destination_root.join("retryable-plugin").exists());
    }

    #[test]
    fn agents_capability_defaults_off_when_absent_from_legacy_state() {
        let state = PluginState {
            plugins: BTreeMap::from([(
                "legacy".to_string(),
                PluginTrustState {
                    trusted_source: "local".to_string(),
                    enabled: true,
                    // No Agents entry: pre-dates that capability.
                    capabilities: BTreeMap::from([(PluginCapability::Skills, true)]),
                    ..Default::default()
                },
            )]),
        };
        assert!(state.capability_enabled("legacy", PluginCapability::Skills));
        assert!(
            !state.capability_enabled("legacy", PluginCapability::Agents),
            "legacy state without an Agents grant must not activate agents/"
        );
        assert!(
            !state.capability_enabled("legacy", PluginCapability::Connections),
            "legacy state without a Connections grant must not activate connection types"
        );
        assert!(
            state.capability_enabled("legacy", PluginCapability::Commands),
            "pre-existing capabilities without an entry stay enabled"
        );
    }

    #[test]
    fn connection_capability_defaults_off_without_any_plugin_state() {
        let state = PluginState::default();
        assert!(state.capability_enabled("manual", PluginCapability::Skills));
        assert!(state.capability_enabled("manual", PluginCapability::Agents));
        assert!(!state.capability_enabled("manual", PluginCapability::Connections));
    }

    #[test]
    fn discovery_enforces_persisted_capability_state() {
        let home = TempDir::new().unwrap();
        let root = home.path().join("plugins");
        let plugin = root.join("demo");
        fs::create_dir_all(plugin.join("skills")).unwrap();
        fs::write(plugin.join("mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        let state = PluginState {
            plugins: BTreeMap::from([(
                "demo".to_string(),
                PluginTrustState {
                    trusted_source: "local".to_string(),
                    enabled: true,
                    capabilities: BTreeMap::from([(PluginCapability::Mcp, false)]),
                    ..Default::default()
                },
            )]),
        };
        state.save(&home.path().join("plugin-state.json")).unwrap();
        let registry = super::super::PluginRegistry::discover_from(&[(
            root,
            super::super::PluginOrigin::User,
        )]);
        let discovered = registry.get("demo").unwrap();
        assert!(discovered.components.skills_dir.is_some());
        assert!(discovered.components.mcp_path.is_none());
    }
}
