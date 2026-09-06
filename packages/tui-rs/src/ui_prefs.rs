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
    #[serde(default)]
    pub dex_personality: Option<String>,
    #[serde(default)]
    pub animations: Option<bool>,
    #[serde(default)]
    pub dex_accessory: crate::dex_delight::DexAccessory,
    #[serde(default)]
    pub dex_accent: crate::dex_delight::DexAccent,
    #[serde(default)]
    pub dex_tips_dismissed: bool,
    #[serde(default)]
    pub dex_notifications: bool,
    #[serde(default)]
    pub dex_suggestions_disabled: bool,
    #[serde(default)]
    pub dex_recap_disabled: bool,
    /// Show wall-clock timestamps beside conversation headings. Off by default.
    #[serde(default)]
    pub timestamps: Option<bool>,
}

impl UiPrefs {
    pub fn load_default() -> Self {
        load_from_path(&default_path()).unwrap_or_default()
    }

    pub fn save_default(&self) -> Result<()> {
        save_to_path(self, &default_path())
    }

    pub fn dex_personality(&self) -> crate::components::dex_companion::DexPersonality {
        use crate::components::dex_companion::DexPersonality;
        match self.dex_personality.as_deref() {
            Some("quiet") => DexPersonality::Quiet,
            Some("expressive") => DexPersonality::Expressive,
            _ => DexPersonality::Standard,
        }
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
    #[test]
    fn dex_preferences_persist_without_replacing_footer() {
        use crate::components::dex_companion::DexPersonality;
        let dir = tempdir().unwrap();
        let path = dir.path().join("ui.json");
        for (name, personality) in [
            ("quiet", DexPersonality::Quiet),
            ("standard", DexPersonality::Standard),
            ("expressive", DexPersonality::Expressive),
        ] {
            let mut prefs = UiPrefs::default();
            prefs.set_footer_style(FooterStyle::Solo);
            prefs.dex_personality = Some(name.to_owned());
            prefs.animations = Some(false);
            save_to_path(&prefs, &path).unwrap();
            let loaded = load_from_path(&path).unwrap();
            assert_eq!(loaded.dex_personality(), personality);
            assert_eq!(loaded.animations, Some(false));
            assert_eq!(loaded.footer_style(), FooterStyle::Solo);
        }
        let legacy: UiPrefs = serde_json::from_str(r#"{"footerStyle":"solo"}"#).unwrap();
        assert_eq!(legacy.dex_personality(), DexPersonality::Standard);
        assert_eq!(legacy.animations, None);
    }
    #[test]
    fn dex_cosmetics_and_controls_roundtrip_with_legacy_defaults() {
        use crate::dex_delight::{DexAccent, DexAccessory};
        let dir = tempdir().unwrap();
        let path = dir.path().join("ui.json");
        let prefs = UiPrefs {
            dex_accessory: DexAccessory::Beanie,
            dex_accent: DexAccent::Mint,
            dex_tips_dismissed: true,
            dex_notifications: true,
            dex_suggestions_disabled: true,
            dex_recap_disabled: true,
            ..Default::default()
        };
        save_to_path(&prefs, &path).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.dex_accessory, DexAccessory::Beanie);
        assert_eq!(loaded.dex_accent, DexAccent::Mint);
        assert!(loaded.dex_notifications && loaded.dex_tips_dismissed);
        assert!(loaded.dex_suggestions_disabled && loaded.dex_recap_disabled);
        for accessory in [
            DexAccessory::Sprout,
            DexAccessory::CatEars,
            DexAccessory::Crown,
            DexAccessory::Bow,
        ] {
            let customized = UiPrefs {
                dex_accessory: accessory,
                ..prefs.clone()
            };
            save_to_path(&customized, &path).unwrap();
            assert_eq!(load_from_path(&path).unwrap().dex_accessory, accessory);
        }
        let old: UiPrefs = serde_json::from_str(r#"{"footerStyle":"solo"}"#).unwrap();
        assert_eq!(old.dex_accessory, DexAccessory::None);
        assert!(!old.dex_notifications);
    }
}
