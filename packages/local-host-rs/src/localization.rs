//! Application compatibility path for shared display localization.
pub use maestro_ui::localization::*;

/// Noninteractive output uses the same saved display preference as the TUI.
/// Called only at human-output sites; JSON and protocol serializers are unchanged.
pub fn cli_locale() -> Locale {
    crate::ui_prefs::UiPrefs::load_default().locale()
}

#[cfg(test)]
mod report_tests {
    use super::*;

    #[test]
    fn human_reports_translate_without_changing_user_text_or_stored_state() {
        let mut variables = crate::rlm::RlmStore::default();
        variables
            .set("user_text", "Ready /goal create 保持原文", None)
            .unwrap();
        let mut goals = crate::goal::GoalStore::default();
        goals
            .create("Ready /goal create 保持原文", None, false, None, None)
            .unwrap();
        let before = serde_json::to_string(&variables).unwrap();
        for locale in Locale::ALL {
            with_locale(locale, || {
                let report = variables.report();
                assert!(report.contains("Ready /goal create 保持原文"));
                assert!(report.contains("`{{user_text}}`"));
                assert!(goals.report().contains("Ready /goal create 保持原文"));
                assert!(goals.report().contains("`update_goal`"));
                assert_eq!(
                    variables.render_template("{{user_text}}").unwrap(),
                    "Ready /goal create 保持原文"
                );
                if locale != Locale::English {
                    assert!(!report.contains("## RLM context"));
                    assert!(!goals.report().contains("**Auto-continue:**"));
                }
                assert_eq!(serde_json::to_string(&variables).unwrap(), before);
            });
        }
    }
}
