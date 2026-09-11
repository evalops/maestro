//! Offline Maestro scenario validation and replay without the agent runtime.

#[path = "../../tui-rs/src/scenario_cli.rs"]
mod scenario_cli;

pub use scenario_cli::run_scenario;

// Reuse the dependency-free display catalog without linking the TUI runtime.
#[path = "../../ui-rs/src/localization.rs"]
pub mod display_localization;
#[path = "../../ui-rs/src/translations.rs"]
mod translations;

pub mod localization {
    use super::display_localization::Locale;
    use std::path::Path;

    #[must_use]
    pub fn cli_locale() -> Locale {
        let home = std::env::var("MAESTRO_HOME")
            .ok()
            .and_then(|value| {
                let value = value.trim();
                if value.is_empty() {
                    return None;
                }
                if value == "~" {
                    return dirs::home_dir();
                }
                if let Some(relative) = value.strip_prefix("~/") {
                    return dirs::home_dir().map(|home| home.join(relative));
                }
                Some(std::path::PathBuf::from(value))
            })
            .or_else(|| dirs::home_dir().map(|home| home.join(".maestro")))
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        read_locale(&home.join("ui.json"))
    }

    fn read_locale(path: &Path) -> Locale {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DisplayPreferences {
            display_language: Option<String>,
        }
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DisplayPreferences>(&bytes).ok())
            .and_then(|prefs| prefs.display_language)
            .and_then(|language| Locale::parse(&language))
            .unwrap_or_default()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn standalone_runner_uses_saved_language_and_rejects_invalid_preferences() {
            let path = std::env::temp_dir().join(format!(
                "maestro-scenario-locale-{}.json",
                std::process::id()
            ));
            for locale in Locale::ALL {
                std::fs::write(
                    &path,
                    serde_json::json!({"displayLanguage":locale.code()}).to_string(),
                )
                .unwrap();
                assert_eq!(read_locale(&path), locale);
            }
            for invalid in [r#"{"displayLanguage":"unknown"}"#, "invalid JSON"] {
                std::fs::write(&path, invalid).unwrap();
                assert_eq!(read_locale(&path), Locale::English);
            }
            std::fs::remove_file(&path).unwrap();
            assert_eq!(read_locale(&path), Locale::English);
        }
    }
}
