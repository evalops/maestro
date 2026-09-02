//! Curated plugin marketplace catalog (Kimi-inspired).
//!
//! Install still goes through [`crate::plugins::install`]; this module only
//! lists known entries with trust tiers for discovery.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Trust tier shown to the operator before install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceTier {
    /// Shipped or maintained by EvalOps / Maestro.
    Official,
    /// Reviewed third-party; still requires explicit trust on remote install.
    Curated,
    /// Community listing; remote install requires `--trust`.
    Community,
}

impl MarketplaceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Curated => "curated",
            Self::Community => "community",
        }
    }

    pub fn requires_explicit_trust(self) -> bool {
        !matches!(self, Self::Official)
    }
}

/// One catalog entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceEntry {
    pub id: String,
    pub display_name: String,
    pub tier: MarketplaceTier,
    pub description: String,
    /// Local path (relative to repo) or https git URL.
    pub source: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

/// Built-in catalog (no network required for list).
pub fn builtin_catalog() -> Vec<MarketplaceEntry> {
    vec![
        MarketplaceEntry {
            id: "superpowers".into(),
            display_name: "Superpowers".into(),
            tier: MarketplaceTier::Curated,
            description: "Planning, TDD, debugging, and delivery workflows for coding agents."
                .into(),
            source: "https://github.com/obra/superpowers".into(),
            homepage: Some("https://github.com/obra/superpowers".into()),
            keywords: vec![
                "skills".into(),
                "planning".into(),
                "tdd".into(),
                "debugging".into(),
            ],
        },
        MarketplaceEntry {
            id: "vercel-plugin".into(),
            display_name: "Vercel Plugin".into(),
            tier: MarketplaceTier::Curated,
            description: "Skills, agents, and conventions for the Vercel platform.".into(),
            source: "https://github.com/vercel/vercel-plugin".into(),
            homepage: Some("https://vercel.com/docs/agent-resources/vercel-plugin".into()),
            keywords: vec!["vercel".into(), "deployment".into(), "nextjs".into()],
        },
    ]
}

/// True when a discovered plugin name matches a catalog id or display name.
pub fn is_installed(entry: &MarketplaceEntry, installed_names: &HashSet<String>) -> bool {
    installed_names.iter().any(|name| {
        name.eq_ignore_ascii_case(&entry.id) || name.eq_ignore_ascii_case(&entry.display_name)
    })
}

/// Human-readable marketplace listing.
///
/// `installed_names` are discovered plugin directory/manifest names; matching
/// catalog entries are marked **installed**.
pub fn format_catalog(entries: &[MarketplaceEntry], installed_names: &HashSet<String>) -> String {
    let mut out = String::from("## Plugin marketplace\n\n");
    out.push_str(
        "Trust tiers: **official** (EvalOps) · **curated** (reviewed third-party) · **community**.\n",
    );
    out.push_str(
        "Remote installs require `/plugins marketplace install <id> --trust` (except pure local paths).\n\n",
    );
    for e in entries {
        let installed = is_installed(e, installed_names);
        let status = if installed { " · **installed**" } else { "" };
        out.push_str(&format!(
            "- **{}** (`{}`) — *{}*{status}\n  {}\n  source: `{}`\n",
            e.display_name,
            e.id,
            e.tier.as_str(),
            e.description,
            e.source
        ));
        if let Some(home) = &e.homepage {
            out.push_str(&format!("  homepage: {home}\n"));
        }
    }
    out.push_str(
        "\nInstall: `/plugins marketplace install <id> [--trust]`\n\
         Or CLI: `maestro plugins marketplace list` / `maestro plugins install <url> --trust`\n",
    );
    out
}

pub fn find_entry<'a>(entries: &'a [MarketplaceEntry], id: &str) -> Option<&'a MarketplaceEntry> {
    entries
        .iter()
        .find(|e| e.id.eq_ignore_ascii_case(id) || e.display_name.eq_ignore_ascii_case(id))
}

/// Resolve a catalog entry to an install source string for [`crate::plugins::install`].
pub fn resolve_install_source(entry: &MarketplaceEntry) -> Result<String> {
    if let Some(rest) = entry.source.strip_prefix("local:") {
        let expanded = if let Some(stripped) = rest.strip_prefix("~/") {
            let home = dirs::home_dir().context("home directory")?;
            home.join(stripped).display().to_string()
        } else {
            rest.to_string()
        };
        if !Path::new(&expanded).exists() {
            bail!(
                "official local entry '{}' path does not exist yet: {expanded}",
                entry.id
            );
        }
        return Ok(expanded);
    }
    Ok(entry.source.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_only_installable_entries() {
        let cat = builtin_catalog();
        assert!(cat.iter().any(|e| e.tier == MarketplaceTier::Curated));
        assert!(find_entry(&cat, "superpowers").is_some());
        assert!(cat.iter().all(|entry| !entry.source.starts_with("local:")));
        assert!(find_entry(&cat, "evalops-sample").is_none());
    }

    #[test]
    fn format_includes_trust_guidance() {
        let text = format_catalog(&builtin_catalog(), &HashSet::new());
        assert!(text.contains("official"));
        assert!(text.contains("--trust"));
        assert!(!text.contains("**installed**"));
    }

    #[test]
    fn format_marks_installed_by_id() {
        let mut installed = HashSet::new();
        installed.insert("superpowers".into());
        let text = format_catalog(&builtin_catalog(), &installed);
        assert!(text.contains("**installed**"));
        assert!(text.contains("superpowers"));
    }
}
