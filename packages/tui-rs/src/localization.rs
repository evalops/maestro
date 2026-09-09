//! Application compatibility path for shared display localization.
pub use maestro_ui::localization::*;

/// Noninteractive output uses the same saved display preference as the TUI.
/// Called only at human-output sites; JSON and protocol serializers are unchanged.
pub fn cli_locale() -> Locale {
    crate::ui_prefs::UiPrefs::load_default().locale()
}
