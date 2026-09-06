//! Deterministic component gallery: no terminal modes, credentials, or network.
use maestro_ui::{
    KeyHint, Modal, ModalSize, NoticeTone, Picker, SettingField, SettingsForm, UiTheme, key_hints,
};
use ratatui::{
    Terminal,
    backend::TestBackend,
    style::Color,
    widgets::{ListItem, ListState},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for (name, width, height) in [
        ("normal", 80, 24),
        ("narrow", 32, 12),
        ("empty", 60, 14),
        ("error", 60, 14),
        ("settings", 70, 18),
    ] {
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        let theme = UiTheme {
            surface: Color::Black,
            text: Color::White,
            ..UiTheme::default()
        };
        let mut state = ListState::default().with_selected(Some(1));
        terminal.draw(|frame| {
            let area = frame.area();
            let inner = Modal::sized(format!(" {name} "), ModalSize::Standard)
                .margin(1)
                .theme(theme)
                .render(frame, area);
            if name == "settings" {
                let fields = [
                    SettingField {
                        category: "Appearance",
                        label: "Theme",
                        value: "Dark",
                        description: "Colors follow the selected theme.",
                        error: None,
                    },
                    SettingField {
                        category: "Appearance",
                        label: "Motion",
                        value: "Off",
                        description: "Static presentation preserves all activity labels.",
                        error: None,
                    },
                    SettingField {
                        category: "Tools",
                        label: "Choice",
                        value: "Unavailable",
                        description: "",
                        error: Some("Choose an available value"),
                    },
                ];
                SettingsForm::new(&fields, Some(1), theme)
                    .help(key_hints(
                        &[
                            KeyHint::new("↑↓", "select"),
                            KeyHint::new("←→", "change"),
                            KeyHint::new("Esc", "close"),
                        ],
                        theme,
                    ))
                    .render(frame, inner, &mut state);
            } else {
                let items = if name == "empty" {
                    vec![]
                } else {
                    (0..15)
                        .map(|n| ListItem::new(format!("Session {n}")))
                        .collect()
                };
                let picker = Picker::new("", "Search sessions", items, theme)
                    .empty("No matching sessions")
                    .help(key_hints(
                        &[
                            KeyHint::new("↑↓", "navigate"),
                            KeyHint::new("Enter", "open"),
                            KeyHint::new("Esc", "close"),
                        ],
                        theme,
                    ));
                let picker = if name == "error" {
                    picker.notice("Sessions could not be read", NoticeTone::Error)
                } else {
                    picker
                };
                picker.render(frame, inner, &mut state);
            }
        })?;
        println!("{name} ({width}x{height})");
        let buffer = terminal.backend().buffer();
        for y in 0..height {
            let row: String = (0..width).map(|x| buffer[(x, y)].symbol()).collect();
            println!("{}", row.trim_end());
        }
    }
    Ok(())
}
