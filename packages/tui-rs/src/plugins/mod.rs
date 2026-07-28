//! Grok-style plugin discovery foundation.
//!
//! Plugins are filesystem packages that may bundle skills, slash-command
//! templates, hooks, and MCP configs:
//!
//! ```text
//! <plugin-root>/
//!   plugin.json          # optional manifest
//!   skills/              # SKILL.md packages
//!   commands/            # markdown command templates
//!   hooks/hooks.json or hooks.toml
//!   .mcp.json or mcp.json
//! ```
//!
//! # Discovery order (high → low priority)
//!
//! 1. CLI/env override (reserved for a later slice)
//! 2. `.maestro/plugins/*` (project)
//! 3. `~/.maestro/plugins/*` (user)
//! 4. Legacy: `.composer/plugins/*` and `~/.composer/plugins/*`
//!
//! Name collisions prefer the higher-priority origin (project over user).
//!
//! This module is foundation-only: discovery, listing, and skill-path
//! integration. Marketplace install / UI is intentionally out of scope.

mod discovery;
mod loader;
mod manager;
mod manifest;

pub use discovery::{default_search_roots, search_roots_for_workspace, PluginOrigin};
pub use loader::{load_manifest, resolve_components, PluginComponents};
pub use manager::{
    install, set_capability, set_enabled, InstallPreview, PluginCapability, PluginState,
};
pub use manifest::PluginManifest;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A plugin package discovered on disk.
#[derive(Debug, Clone)]
pub struct DiscoveredPlugin {
    /// Plugin name (manifest `name` or directory name).
    pub name: String,
    /// Absolute or CWD-relative plugin root directory.
    pub root: PathBuf,
    /// Discovery origin (project / user / legacy).
    pub origin: PluginOrigin,
    /// Parsed `plugin.json` when present.
    pub manifest: Option<PluginManifest>,
    /// Resolved component paths (skills, commands, hooks, MCP).
    pub components: PluginComponents,
}

impl DiscoveredPlugin {
    /// Short summary of present components for `/plugins` listing.
    #[must_use]
    pub fn component_summary(&self) -> String {
        let mut parts = Vec::new();
        if self.components.skills_dir.is_some() {
            parts.push("skills");
        }
        if self.components.commands_dir.is_some() {
            parts.push("commands");
        }
        if self.components.hooks_config.is_some() {
            parts.push("hooks");
        }
        if self.components.mcp_path.is_some() {
            parts.push("mcp");
        }
        if parts.is_empty() {
            "no components".to_string()
        } else {
            parts.join(", ")
        }
    }

    /// Detailed multi-line description for `/plugins <name>`.
    #[must_use]
    pub fn detail_report(&self) -> String {
        let mut msg = format!("## Plugin: {}\n\n", self.name);
        msg.push_str(&format!("**Path:** `{}`\n", self.root.display()));
        msg.push_str(&format!("**Origin:** {}\n", self.origin.as_str()));

        if let Some(ref manifest) = self.manifest {
            if let Some(ref version) = manifest.version {
                msg.push_str(&format!("**Version:** {version}\n"));
            }
            if let Some(ref description) = manifest.description {
                msg.push_str(&format!("**Description:** {description}\n"));
            }
            msg.push_str("**Manifest:** `plugin.json`\n");
        } else {
            msg.push_str("**Manifest:** _(convention paths)_\n");
        }

        msg.push_str("\n### Components\n\n");
        match &self.components.skills_dir {
            Some(p) => msg.push_str(&format!("- **skills:** `{}`\n", p.display())),
            None => msg.push_str("- **skills:** _(none)_\n"),
        }
        match &self.components.commands_dir {
            Some(p) => msg.push_str(&format!("- **commands:** `{}`\n", p.display())),
            None => msg.push_str("- **commands:** _(none)_\n"),
        }
        match &self.components.hooks_config {
            Some(p) => msg.push_str(&format!("- **hooks:** `{}`\n", p.display())),
            None => msg.push_str("- **hooks:** _(none)_\n"),
        }
        match &self.components.mcp_path {
            Some(p) => msg.push_str(&format!("- **mcp:** `{}`\n", p.display())),
            None => msg.push_str("- **mcp:** _(none)_\n"),
        }

        msg
    }
}

/// Registry of discovered plugins.
#[derive(Debug, Clone, Default)]
pub struct PluginRegistry {
    plugins: Vec<DiscoveredPlugin>,
}

impl PluginRegistry {
    /// Discover plugins from default Maestro/composer roots.
    #[must_use]
    pub fn discover() -> Self {
        let workspace_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::discover_for_workspace(&workspace_dir)
    }

    /// Discover plugins for an explicit workspace while preserving the
    /// standard user roots.
    #[must_use]
    pub fn discover_for_workspace(workspace_dir: &Path) -> Self {
        let roots = search_roots_for_workspace(
            workspace_dir,
            crate::path_utils::maestro_home_dir().as_deref(),
            crate::path_utils::legacy_composer_home_dir().as_deref(),
        );
        Self::discover_from(&roots)
    }

    /// Discover plugins from explicit roots (low → high priority order).
    ///
    /// When multiple plugins share a name, the later (higher-priority) root wins.
    #[must_use]
    pub fn discover_from(roots: &[(PathBuf, PluginOrigin)]) -> Self {
        let mut by_name: HashMap<String, DiscoveredPlugin> = HashMap::new();

        for (root, origin) in roots {
            if !root.is_dir() {
                continue;
            }
            let state = match root
                .parent()
                .map(|parent| PluginState::load(&parent.join("plugin-state.json")))
                .transpose()
            {
                Ok(state) => state.unwrap_or_default(),
                Err(error) => {
                    eprintln!(
                        "[plugins] refusing to load {}: invalid trust state: {error}",
                        root.display()
                    );
                    continue;
                }
            };
            let Ok(entries) = fs::read_dir(root) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Some(mut plugin) = load_plugin_dir(&path, *origin) {
                    let key = plugin.name.to_lowercase();
                    if state
                        .plugins
                        .get(&key)
                        .is_some_and(|plugin_state| !plugin_state.enabled)
                    {
                        by_name.remove(&key);
                        continue;
                    }
                    if !state.capability_enabled(&key, PluginCapability::Skills) {
                        plugin.components.skills_dir = None;
                    }
                    if !state.capability_enabled(&key, PluginCapability::Commands) {
                        plugin.components.commands_dir = None;
                    }
                    if !state.capability_enabled(&key, PluginCapability::Hooks) {
                        plugin.components.hooks_config = None;
                    }
                    if !state.capability_enabled(&key, PluginCapability::Mcp) {
                        plugin.components.mcp_path = None;
                    }
                    by_name.insert(key, plugin);
                }
            }
        }

        let mut plugins: Vec<_> = by_name.into_values().collect();
        plugins.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.root.cmp(&b.root))
        });

        Self { plugins }
    }

    /// All discovered plugins (sorted by name).
    #[must_use]
    pub fn plugins(&self) -> &[DiscoveredPlugin] {
        &self.plugins
    }

    /// Look up a plugin by name (case-insensitive).
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&DiscoveredPlugin> {
        let needle = name.to_lowercase();
        self.plugins
            .iter()
            .find(|p| p.name.to_lowercase() == needle)
    }

    /// Skill directories from all plugins (for SkillLoader integration).
    #[must_use]
    pub fn skill_dirs(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|p| p.components.skills_dir.clone())
            .collect()
    }

    /// Command template directories from all plugins.
    #[must_use]
    pub fn command_dirs(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|p| p.components.commands_dir.clone())
            .collect()
    }

    /// MCP config file paths from all plugins.
    #[must_use]
    pub fn mcp_paths(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|p| p.components.mcp_path.clone())
            .collect()
    }

    /// Hook config file paths from all plugins.
    #[must_use]
    pub fn hook_configs(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|p| p.components.hooks_config.clone())
            .collect()
    }

    /// Number of discovered plugins.
    #[must_use]
    pub fn len(&self) -> usize {
        self.plugins.len()
    }

    /// Whether any plugins were discovered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.plugins.is_empty()
    }

    /// Format a list report for `/plugins`.
    #[must_use]
    pub fn list_report(&self) -> String {
        if self.plugins.is_empty() {
            return [
                "## Plugins\n".to_string(),
                "*No plugins found*\n\n".to_string(),
                "Install plugins under:\n".to_string(),
                "- `.maestro/plugins/<name>/` (project)\n".to_string(),
                "- `~/.maestro/plugins/<name>/` (user)\n\n".to_string(),
                "Each plugin may include `plugin.json`, `skills/`, `commands/`, hooks, and MCP configs.\n".to_string(),
            ]
            .concat();
        }

        let mut msg = String::from("## Plugins\n\n");
        for plugin in &self.plugins {
            let version = plugin
                .manifest
                .as_ref()
                .and_then(|m| m.version.as_deref())
                .unwrap_or("-");
            msg.push_str(&format!(
                "- **{}** ({}) — {} — `{}`\n  components: {}\n",
                plugin.name,
                plugin.origin.as_str(),
                version,
                plugin.root.display(),
                plugin.component_summary(),
            ));
        }
        msg.push_str(&format!(
            "\n*{} plugin(s) discovered*\n\nUse `/plugins <name>` for details.\n",
            self.plugins.len()
        ));
        msg
    }
}

fn load_plugin_dir(path: &Path, origin: PluginOrigin) -> Option<DiscoveredPlugin> {
    if path.join(".maestro-untrusted").exists() {
        return None;
    }
    let dir_name = path.file_name()?.to_str()?.to_string();
    // Skip hidden directories (e.g. .git under plugins root).
    if dir_name.starts_with('.') {
        return None;
    }

    let manifest = load_manifest(path);
    let name = manifest
        .as_ref()
        .and_then(|m| m.name.clone())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(dir_name);
    let components = resolve_components(path, manifest.as_ref());

    Some(DiscoveredPlugin {
        name,
        root: path.to_path_buf(),
        origin,
        manifest,
        components,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn make_plugin(root: &Path, name: &str, with_manifest: bool, with_skills: bool) {
        let plugin = root.join(name);
        fs::create_dir_all(&plugin).unwrap();
        if with_manifest {
            write_file(
                &plugin.join("plugin.json"),
                &format!(
                    r#"{{"name":"{name}","version":"0.1.0","description":"test plugin","skills":"skills"}}"#
                ),
            );
        }
        if with_skills {
            let skill_dir = plugin.join("skills").join("demo-skill");
            fs::create_dir_all(&skill_dir).unwrap();
            write_file(
                &skill_dir.join("SKILL.md"),
                "---\nname: demo-skill\ndescription: Demo skill for plugin tests\n---\n# Demo\n",
            );
        }
    }

    #[test]
    fn discover_with_manifest_and_skills() {
        let tmp = TempDir::new().unwrap();
        let plugins_root = tmp.path().join("plugins");
        make_plugin(&plugins_root, "team-tools", true, true);

        let registry = PluginRegistry::discover_from(&[(plugins_root, PluginOrigin::Project)]);
        assert_eq!(registry.len(), 1);
        let plugin = registry.get("team-tools").unwrap();
        assert!(plugin.components.skills_dir.is_some());
        assert_eq!(plugin.origin, PluginOrigin::Project);
        assert!(plugin.manifest.is_some());
        assert_eq!(registry.skill_dirs().len(), 1);
    }

    #[test]
    fn discover_missing_manifest_uses_convention() {
        let tmp = TempDir::new().unwrap();
        let plugins_root = tmp.path().join("plugins");
        make_plugin(&plugins_root, "bare-plugin", false, true);
        write_file(
            &plugins_root.join("bare-plugin").join("mcp.json"),
            r#"{"mcpServers":{}}"#,
        );

        let registry = PluginRegistry::discover_from(&[(plugins_root, PluginOrigin::User)]);
        let plugin = registry.get("bare-plugin").unwrap();
        assert!(plugin.manifest.is_none());
        assert!(plugin.components.skills_dir.is_some());
        assert!(plugin.components.mcp_path.is_some());
        assert_eq!(plugin.component_summary(), "skills, mcp");
    }

    #[test]
    fn name_collision_prefers_project_over_user() {
        let tmp = TempDir::new().unwrap();
        let user_root = tmp.path().join("user-plugins");
        let project_root = tmp.path().join("project-plugins");
        make_plugin(&user_root, "shared", true, true);
        // Project copy without skills so we can tell which won via components.
        make_plugin(&project_root, "shared", true, false);
        write_file(
            &project_root.join("shared").join("plugin.json"),
            r#"{"name":"shared","version":"9.9.9","description":"project wins"}"#,
        );

        let roots = [
            (user_root, PluginOrigin::User),
            (project_root.clone(), PluginOrigin::Project),
        ];
        let registry = PluginRegistry::discover_from(&roots);
        assert_eq!(registry.len(), 1);
        let plugin = registry.get("shared").unwrap();
        assert_eq!(plugin.origin, PluginOrigin::Project);
        assert_eq!(
            plugin.manifest.as_ref().and_then(|m| m.version.as_deref()),
            Some("9.9.9")
        );
        assert!(plugin.root.starts_with(&project_root));
        assert!(plugin.components.skills_dir.is_none());
    }

    #[test]
    fn reverse_order_still_prefers_higher_origin_when_sorted_by_insert_order() {
        // discover_from relies on walk order (low → high). If project is last it wins.
        let tmp = TempDir::new().unwrap();
        let legacy = tmp.path().join("legacy");
        let project = tmp.path().join("project");
        make_plugin(&legacy, "x", true, false);
        make_plugin(&project, "x", true, true);

        let registry = PluginRegistry::discover_from(&[
            (legacy, PluginOrigin::LegacyUser),
            (project, PluginOrigin::Project),
        ]);
        let plugin = registry.get("x").unwrap();
        assert_eq!(plugin.origin, PluginOrigin::Project);
        assert!(plugin.components.skills_dir.is_some());
    }

    #[test]
    fn empty_registry_list_report() {
        let registry = PluginRegistry::default();
        let report = registry.list_report();
        assert!(report.contains("No plugins found"));
        assert!(report.contains(".maestro/plugins"));
    }

    #[test]
    fn detail_report_includes_paths() {
        let tmp = TempDir::new().unwrap();
        let plugins_root = tmp.path().join("plugins");
        make_plugin(&plugins_root, "detail-me", true, true);
        let registry = PluginRegistry::discover_from(&[(plugins_root, PluginOrigin::Project)]);
        let report = registry.get("detail-me").unwrap().detail_report();
        assert!(report.contains("## Plugin: detail-me"));
        assert!(report.contains("**Origin:** project"));
        assert!(report.contains("skills"));
    }

    #[test]
    fn skips_hidden_directories() {
        let tmp = TempDir::new().unwrap();
        let plugins_root = tmp.path().join("plugins");
        make_plugin(&plugins_root, ".hidden", false, true);
        make_plugin(&plugins_root, "visible", false, true);
        let registry = PluginRegistry::discover_from(&[(plugins_root, PluginOrigin::Project)]);
        assert_eq!(registry.len(), 1);
        assert!(registry.get("visible").is_some());
        assert!(registry.get(".hidden").is_none());
    }

    #[test]
    fn skips_incomplete_untrusted_installs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        let plugin = root.join("incomplete");
        fs::create_dir_all(plugin.join("skills")).unwrap();
        write_file(&plugin.join(".maestro-untrusted"), "incomplete");
        let registry = PluginRegistry::discover_from(&[(root, PluginOrigin::User)]);
        assert!(registry.is_empty());
    }

    #[test]
    fn skill_command_mcp_hook_accessors() {
        let tmp = TempDir::new().unwrap();
        let plugins_root = tmp.path().join("plugins");
        let plugin = plugins_root.join("full");
        fs::create_dir_all(plugin.join("skills")).unwrap();
        fs::create_dir_all(plugin.join("commands")).unwrap();
        write_file(&plugin.join("hooks/hooks.json"), "{}\n");
        write_file(&plugin.join(".mcp.json"), "{}\n");

        let registry = PluginRegistry::discover_from(&[(plugins_root, PluginOrigin::User)]);
        assert_eq!(registry.skill_dirs().len(), 1);
        assert_eq!(registry.command_dirs().len(), 1);
        assert_eq!(registry.mcp_paths().len(), 1);
        assert_eq!(registry.hook_configs().len(), 1);
    }

    #[test]
    fn disabled_higher_priority_plugin_tombstones_lower_priority_copy() {
        let tmp = TempDir::new().unwrap();
        let legacy_root = tmp.path().join("legacy").join("plugins");
        let native_root = tmp.path().join("native").join("plugins");
        make_plugin(&legacy_root, "duplicate", true, false);
        make_plugin(&native_root, "duplicate", true, false);
        let mut state = manager::PluginState::default();
        state.plugins.insert(
            "duplicate".into(),
            manager::PluginTrustState {
                enabled: false,
                ..Default::default()
            },
        );
        state
            .save(&native_root.parent().unwrap().join("plugin-state.json"))
            .unwrap();

        let registry = PluginRegistry::discover_from(&[
            (legacy_root, PluginOrigin::LegacyUser),
            (native_root, PluginOrigin::User),
        ]);
        assert!(registry.get("duplicate").is_none());
    }

    #[test]
    fn workspace_style_discovery_order() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().join("ws");
        let user_home = tmp.path().join("home").join(".maestro");
        let legacy_home = tmp.path().join("home").join(".composer");

        make_plugin(&user_home.join("plugins"), "dup", true, false);
        write_file(
            &user_home.join("plugins").join("dup").join("plugin.json"),
            r#"{"name":"dup","version":"user"}"#,
        );
        make_plugin(
            &workspace.join(".maestro").join("plugins"),
            "dup",
            true,
            false,
        );
        write_file(
            &workspace
                .join(".maestro")
                .join("plugins")
                .join("dup")
                .join("plugin.json"),
            r#"{"name":"dup","version":"project"}"#,
        );

        let roots = search_roots_for_workspace(&workspace, Some(&user_home), Some(&legacy_home));
        let registry = PluginRegistry::discover_from(&roots);
        let plugin = registry.get("dup").unwrap();
        assert_eq!(
            plugin.manifest.as_ref().and_then(|m| m.version.as_deref()),
            Some("project")
        );
        assert_eq!(plugin.origin, PluginOrigin::Project);
    }
}
