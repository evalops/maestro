//! Resolve plugin components from a plugin root and optional manifest.

use super::manifest::PluginManifest;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Maestro's native manifest location.
pub const NATIVE_PLUGIN_MANIFEST_PATH: &str = "plugin.json";
/// Portable manifest location used by OpenHands and Claude Code plugins.
pub const PORTABLE_PLUGIN_MANIFEST_PATH: &str = ".plugin/plugin.json";

/// Resolved component paths for a single plugin package.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginComponents {
    pub skills_dir: Option<PathBuf>,
    pub agents_dir: Option<PathBuf>,
    pub commands_dir: Option<PathBuf>,
    pub hooks_config: Option<PathBuf>,
    pub mcp_path: Option<PathBuf>,
    pub connections_path: Option<PathBuf>,
}

/// Largest plugin file read at load time.
///
/// Symlinked plugin files are refused and each file is capped at 10 MiB.
/// Without a cap a plugin
/// directory can hand the loader an arbitrarily large `plugin.json` and the
/// whole file is read into memory before parsing fails.
pub const MAX_PLUGIN_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Read a plugin file, refusing symlinks and files over
/// [`MAX_PLUGIN_FILE_BYTES`].
///
/// Returns `None` when the path is missing, is a symbolic link, is not a
/// regular file, is too large, or is not UTF-8.
pub fn read_plugin_file(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_PLUGIN_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Load an optional plugin manifest from a plugin root.
///
/// Maestro's root `plugin.json` takes precedence. When it is absent, the
/// portable `.plugin/plugin.json` layout used by OpenHands and Claude Code is
/// accepted. If the higher-priority path exists but is invalid, loading fails
/// closed instead of silently falling through to a second identity.
pub fn load_manifest(plugin_root: &Path) -> Option<PluginManifest> {
    load_manifest_with_path(plugin_root).map(|(manifest, _)| manifest)
}

/// Load a plugin manifest together with the path that supplied its identity.
pub fn load_manifest_with_path(plugin_root: &Path) -> Option<(PluginManifest, PathBuf)> {
    for relative in [NATIVE_PLUGIN_MANIFEST_PATH, PORTABLE_PLUGIN_MANIFEST_PATH] {
        let candidate = plugin_root.join(relative);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {
                let candidate = contained_component(plugin_root, relative)?;
                let text = read_plugin_file(&candidate)?;
                let manifest = PluginManifest::from_json(&text).ok()?;
                return Some((manifest, candidate));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Resolve skill/command/hook/MCP paths for a plugin root.
///
/// When `manifest` is `None`, convention paths are used. Manifest path fields
/// that resolve to missing files/dirs are ignored (treated as absent).
pub fn resolve_components(
    plugin_root: &Path,
    manifest: Option<&PluginManifest>,
) -> PluginComponents {
    let skills_dir = resolve_dir(
        plugin_root,
        manifest.and_then(|m| m.skills.as_deref()),
        &["skills"],
    );
    let agents_dir = resolve_dir(
        plugin_root,
        manifest.and_then(|m| m.agents.as_deref()),
        &["agents"],
    );
    let commands_dir = resolve_dir(
        plugin_root,
        manifest.and_then(|m| m.commands.as_deref()),
        &["commands"],
    );
    let hooks_config = resolve_file(
        plugin_root,
        manifest.and_then(|m| m.hooks.as_deref()),
        &[
            "hooks/hooks.toml",
            "hooks/hooks.json",
            "hooks.toml",
            "hooks.json",
        ],
    );
    let mcp_path = resolve_file(
        plugin_root,
        manifest.and_then(|m| m.mcp.as_deref()),
        &["mcp.json", ".mcp.json"],
    );
    let connections_path = resolve_file(
        plugin_root,
        manifest.and_then(|m| m.connections.as_deref()),
        &["connections.json"],
    );

    PluginComponents {
        skills_dir,
        agents_dir,
        commands_dir,
        hooks_config,
        mcp_path,
        connections_path,
    }
}

fn resolve_dir(root: &Path, explicit: Option<&str>, conventions: &[&str]) -> Option<PathBuf> {
    if let Some(rel) = explicit {
        if let Some(path) = contained_component(root, rel).filter(|path| path.is_dir()) {
            return Some(path);
        }
        // Explicit path missing: do not fall through to conventions.
        return None;
    }
    for rel in conventions {
        if let Some(path) = contained_component(root, rel).filter(|path| path.is_dir()) {
            return Some(path);
        }
    }
    None
}

fn resolve_file(root: &Path, explicit: Option<&str>, conventions: &[&str]) -> Option<PathBuf> {
    if let Some(rel) = explicit {
        if let Some(path) = contained_component(root, rel).filter(|path| path.is_file()) {
            return Some(path);
        }
        return None;
    }
    for rel in conventions {
        if let Some(path) = contained_component(root, rel).filter(|path| path.is_file()) {
            return Some(path);
        }
    }
    None
}

fn contained_component(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let canonical_root = dunce::canonicalize(root).ok()?;
    let candidate = root.join(relative);
    let canonical_candidate = dunce::canonicalize(&candidate).ok()?;
    canonical_candidate
        .starts_with(&canonical_root)
        .then_some(candidate)
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

    #[test]
    fn convention_fallback_without_manifest() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("skills")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::create_dir_all(root.join("commands")).unwrap();
        write_file(&root.join("hooks/hooks.toml"), "enabled = true\n");
        write_file(&root.join("mcp.json"), "{}\n");
        write_file(
            &root.join("connections.json"),
            "{\"schemaVersion\":1,\"connectionTypes\":[]}\n",
        );

        let components = resolve_components(root, None);
        assert_eq!(components.skills_dir, Some(root.join("skills")));
        assert_eq!(components.agents_dir, Some(root.join("agents")));
        assert_eq!(components.commands_dir, Some(root.join("commands")));
        assert_eq!(components.hooks_config, Some(root.join("hooks/hooks.toml")));
        assert_eq!(components.mcp_path, Some(root.join("mcp.json")));
        assert_eq!(
            components.connections_path,
            Some(root.join("connections.json"))
        );
    }

    #[test]
    fn manifest_overrides_convention_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("custom-skills")).unwrap();
        write_file(&root.join("custom-mcp.json"), "{}\n");
        // Convention paths also exist but should be ignored when manifest sets paths.
        fs::create_dir_all(root.join("skills")).unwrap();

        let manifest = PluginManifest {
            skills: Some("custom-skills".into()),
            mcp: Some("custom-mcp.json".into()),
            ..Default::default()
        };
        let components = resolve_components(root, Some(&manifest));
        assert_eq!(components.skills_dir, Some(root.join("custom-skills")));
        assert_eq!(components.mcp_path, Some(root.join("custom-mcp.json")));
        assert!(components.commands_dir.is_none());
    }

    #[test]
    fn load_manifest_reads_plugin_json() {
        let tmp = TempDir::new().unwrap();
        write_file(
            &tmp.path().join("plugin.json"),
            r#"{"name":"demo","version":"1.0.0"}"#,
        );
        let manifest = load_manifest(tmp.path()).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("demo"));
        assert_eq!(manifest.version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn load_manifest_reads_portable_plugin_json() {
        let tmp = TempDir::new().unwrap();
        write_file(
            &tmp.path().join(PORTABLE_PLUGIN_MANIFEST_PATH),
            r#"{"name":"portable-demo","version":"2.0.0"}"#,
        );
        let (manifest, path) = load_manifest_with_path(tmp.path()).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("portable-demo"));
        assert_eq!(path, tmp.path().join(PORTABLE_PLUGIN_MANIFEST_PATH));
    }

    #[test]
    fn native_manifest_precedes_portable_manifest() {
        let tmp = TempDir::new().unwrap();
        write_file(
            &tmp.path().join(NATIVE_PLUGIN_MANIFEST_PATH),
            r#"{"name":"native"}"#,
        );
        write_file(
            &tmp.path().join(PORTABLE_PLUGIN_MANIFEST_PATH),
            r#"{"name":"portable"}"#,
        );
        let (manifest, path) = load_manifest_with_path(tmp.path()).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("native"));
        assert_eq!(path, tmp.path().join(NATIVE_PLUGIN_MANIFEST_PATH));
    }

    #[test]
    fn invalid_native_manifest_does_not_fall_through_to_portable_identity() {
        let tmp = TempDir::new().unwrap();
        write_file(&tmp.path().join(NATIVE_PLUGIN_MANIFEST_PATH), "{not-json");
        write_file(
            &tmp.path().join(PORTABLE_PLUGIN_MANIFEST_PATH),
            r#"{"name":"portable"}"#,
        );
        assert!(load_manifest_with_path(tmp.path()).is_none());
    }

    #[test]
    fn missing_explicit_path_is_none() {
        let tmp = TempDir::new().unwrap();
        let manifest = PluginManifest {
            skills: Some("does-not-exist".into()),
            ..Default::default()
        };
        let components = resolve_components(tmp.path(), Some(&manifest));
        assert!(components.skills_dir.is_none());
    }

    #[test]
    fn manifest_paths_cannot_escape_plugin_root() {
        let tmp = TempDir::new().unwrap();
        let plugin = tmp.path().join("plugin");
        fs::create_dir_all(&plugin).unwrap();
        write_file(&tmp.path().join("outside.json"), "{}");
        let manifest = PluginManifest {
            mcp: Some("../outside.json".into()),
            ..Default::default()
        };
        assert!(
            resolve_components(&plugin, Some(&manifest))
                .mcp_path
                .is_none()
        );
    }
}
