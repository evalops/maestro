//! Behavior version catalog for version-managed tools.
//!
//! Pattern adopted from grok-build's `xai-grok-tools/src/versions.rs`: this
//! module defines which tools are version-managed, which contract versions
//! each supports, and the resolution logic that maps an optional per-tool
//! override to a concrete version.
//!
//! # Adding a version-managed tool
//!
//! 1. Give the tool a directory module (`tools/<name>/mod.rs` for current
//!    behavior, `tools/<name>/versions/<legacy>.rs` for each pinned legacy
//!    contract — see `tools/bash/` for the reference layout).
//! 2. Add the tool name to [`MANAGED_TOOLS`] and a [`ToolVersionEntry`] to
//!    [`TOOL_VERSION_REGISTRY`] with one [`VersionLifecycle`] per supported
//!    version. `"current"` is a moving alias for the latest behavior; legacy
//!    versions are stable pins with a summary of what they preserve.
//! 3. Stamp the selected version into the tool's receipt details so the
//!    session entry records it, and read the override in `ToolExecutor`
//!    (see `ToolExecutor::pin_tool_version`).
//!
//! Session replay pins behavior by reading the version recorded in a
//! session entry's receipt details and calling
//! `ToolExecutor::pin_tool_version` with it before re-executing.

use std::collections::HashMap;

/// Lifecycle stage of a tool contract version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionStage {
    /// Fully supported and recommended.
    Active,
    /// Still works but will be removed in a future release.
    Deprecated,
}

/// A single contract version supported by a tool.
#[derive(Debug)]
pub struct VersionLifecycle {
    /// Version string (e.g. `"current"`, `"legacy-1"`).
    pub version: &'static str,
    /// Lifecycle stage of this tool+version pair.
    pub stage: VersionStage,
    /// Suggested replacement when deprecated.
    pub replacement: Option<&'static str>,
    /// One-line summary of what this version's behavior is.
    /// Empty for `"current"` (a moving alias that changes over time).
    pub summary: &'static str,
}

/// Per-tool version metadata. Each managed tool has one entry in
/// [`TOOL_VERSION_REGISTRY`].
#[derive(Debug)]
pub struct ToolVersionEntry {
    /// Tool name as registered in `ToolRegistry` (e.g. `"bash"`).
    pub tool_name: &'static str,
    /// Supported versions and their individual lifecycle.
    pub versions: &'static [VersionLifecycle],
}

/// `"current"` is a moving alias — its summary is empty because the behavior
/// it points at changes over time. Stable pins carry their own metadata.
const V_CURRENT: VersionLifecycle = VersionLifecycle {
    version: "current",
    stage: VersionStage::Active,
    replacement: None,
    summary: "",
};

/// Names of version-managed tools. Only tools listed here accept version
/// overrides via [`ToolVersionOverrides`].
pub const MANAGED_TOOLS: &[&str] = &["bash"];

/// Per-tool version registry — canonical source for which versions each
/// managed tool supports.
pub const TOOL_VERSION_REGISTRY: &[ToolVersionEntry] = &[ToolVersionEntry {
    tool_name: "bash",
    versions: &[
        V_CURRENT,
        VersionLifecycle {
            version: "legacy-1",
            stage: VersionStage::Active,
            replacement: Some("current"),
            summary: "Pre-#3070 behavior: world-readable temp captures in the system temp dir; \
                      quote-blind find-flag detection; unrestricted git branch/remote; \
                      auto-approved cargo check",
        },
    ],
}];

/// Check whether a tool name is version-managed.
pub fn is_version_managed(tool_name: &str) -> bool {
    MANAGED_TOOLS.contains(&tool_name)
}

/// Get the supported versions for a tool, or `None` if it is not managed.
pub fn tool_supported_versions(tool_name: &str) -> Option<&'static [VersionLifecycle]> {
    TOOL_VERSION_REGISTRY
        .iter()
        .find(|entry| entry.tool_name == tool_name)
        .map(|entry| entry.versions)
}

/// Check whether `version` is a supported contract version for `tool_name`.
pub fn is_supported_version(tool_name: &str, version: &str) -> bool {
    tool_supported_versions(tool_name)
        .is_some_and(|versions| versions.iter().any(|v| v.version == version))
}

/// Per-tool behavior version overrides, keyed by tool name.
///
/// Resolution rule: a pinned override wins; anything else resolves to
/// `"current"`. Unknown tool names or versions are rejected at pin time so a
/// typo in a replay harness fails loudly instead of silently falling back.
#[derive(Debug, Clone, Default)]
pub struct ToolVersionOverrides {
    pins: HashMap<String, String>,
}

impl ToolVersionOverrides {
    /// Pin `tool_name` to `version`. Errors if the tool is not
    /// version-managed or the version is not in its registry entry.
    pub fn pin(&mut self, tool_name: &str, version: &str) -> Result<(), String> {
        if !is_version_managed(tool_name) {
            return Err(format!(
                "tool {tool_name:?} is not version-managed (managed tools: {MANAGED_TOOLS:?})"
            ));
        }
        if !is_supported_version(tool_name, version) {
            return Err(format!(
                "unsupported version {version:?} for tool {tool_name:?}"
            ));
        }
        self.pins.insert(tool_name.to_string(), version.to_string());
        Ok(())
    }

    /// Resolve the effective contract version for a tool: the pinned override
    /// if present, otherwise `"current"`.
    #[must_use]
    pub fn resolve<'a>(&'a self, tool_name: &str) -> &'a str {
        self.pins.get(tool_name).map_or("current", String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_is_the_only_managed_tool() {
        assert!(is_version_managed("bash"));
        assert!(!is_version_managed("read"));
        assert!(!is_version_managed("edit"));
    }

    #[test]
    fn bash_supports_current_and_legacy_1() {
        let versions = tool_supported_versions("bash").expect("bash is managed");
        let names: Vec<&str> = versions.iter().map(|v| v.version).collect();
        assert_eq!(names, ["current", "legacy-1"]);
        assert!(is_supported_version("bash", "legacy-1"));
        assert!(!is_supported_version("bash", "legacy-2"));
        assert!(tool_supported_versions("read").is_none());
    }

    #[test]
    fn resolution_defaults_to_current() {
        let overrides = ToolVersionOverrides::default();
        assert_eq!(overrides.resolve("bash"), "current");
        assert_eq!(overrides.resolve("anything"), "current");
    }

    #[test]
    fn pinned_override_wins() {
        let mut overrides = ToolVersionOverrides::default();
        overrides.pin("bash", "legacy-1").unwrap();
        assert_eq!(overrides.resolve("bash"), "legacy-1");
    }

    #[test]
    fn pinning_rejects_unmanaged_tools_and_unknown_versions() {
        let mut overrides = ToolVersionOverrides::default();
        assert!(overrides.pin("read", "legacy-1").is_err());
        assert!(overrides.pin("bash", "legacy-99").is_err());
        assert!(overrides.pin("bash", "current").is_ok());
    }
}
