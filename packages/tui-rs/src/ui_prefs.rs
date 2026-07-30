//! Lightweight UI preferences persisted under `~/.maestro/ui.json`.
//!
//! Currently stores footer density (`/footer`). Load failures fall back to
//! defaults so a corrupt file never blocks TUI startup.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::commands::FooterStyle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    #[serde(default)]
    pub footer_style: Option<String>,
}

impl UiPrefs {
    pub fn load_default() -> Self {
        load_from_path(&default_path()).unwrap_or_default()
    }

    pub fn save_default(&self) -> Result<()> {
        save_to_path(self, &default_path())
    }

    pub fn footer_style(&self) -> FooterStyle {
        self.footer_style
            .as_deref()
            .and_then(FooterStyle::parse)
            .unwrap_or_default()
    }

    pub fn set_footer_style(&mut self, style: FooterStyle) {
        self.footer_style = Some(style.as_str().to_string());
    }
}

fn default_path() -> PathBuf {
    crate::path_utils::maestro_home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ui.json")
}

fn load_from_path(path: &Path) -> Result<UiPrefs> {
    if !path.exists() {
        return Ok(UiPrefs::default());
    }
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let prefs: UiPrefs = serde_json::from_str(&raw).context("parse ui.json")?;
    Ok(prefs)
}

fn save_to_path(prefs: &UiPrefs, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let raw = serde_json::to_string_pretty(prefs).context("serialize ui prefs")?;
    crate::fs_atomic::write_atomic(path, raw.as_bytes()).context("write ui.json")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrip_footer_style() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ui.json");
        let mut prefs = UiPrefs::default();
        prefs.set_footer_style(FooterStyle::Solo);
        save_to_path(&prefs, &path).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.footer_style(), FooterStyle::Solo);
    }
}
