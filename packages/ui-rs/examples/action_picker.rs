//! Minimal host: supply items, feed keys, render, and handle the typed result.
//! This deterministic example uses a test terminal and never saves preferences.
use crossterm::event::KeyCode;
use maestro_interaction::{Action, ActionCatalog};
use maestro_ui::{ActionPicker, PickerOptions, PickerOutcome, UiTheme};
use ratatui::{Terminal, backend::TestBackend, style::Color, widgets::ListItem};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Look {
    Sprout,
    Glasses,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let actions = [
        Action::new("sprout", "Sprout", Look::Sprout).description("Wear a small sprout"),
        Action::new("glasses", "Glasses", Look::Glasses),
    ];
    let catalog = ActionCatalog::new(&actions)?;
    println!("{}", catalog.help());
    let mut picker = ActionPicker::new(catalog.actions().to_vec())
        .identified_by(|action| action.id)?
        .searchable(|action| action.label);
    picker.open();
    picker.select_id("sprout");
    let opening = Look::Sprout;
    if let PickerOutcome::Changed(Some(action)) = picker.insert_str("glass") {
        println!(
            "Preview {:?}; saved choice remains {opening:?}.",
            action.value
        );
    }
    let theme = UiTheme {
        surface: Color::Black,
        text: Color::White,
        muted: Color::Gray,
        border: Color::Blue,
        focus: Color::Magenta,
        success: Color::Green,
        attention: Color::Yellow,
        error: Color::Red,
    };
    let mut terminal = Terminal::new(TestBackend::new(40, 10))?;
    terminal.draw(|frame| {
        picker.render(
            frame,
            frame.area(),
            theme,
            PickerOptions {
                placeholder: "Find a look",
                empty: "No matching looks",
                ..PickerOptions::default()
            },
            |action| ListItem::new(action.label),
        )
    })?;
    if let PickerOutcome::Selected(action) = picker.handle_key(KeyCode::Enter, false) {
        assert_eq!(action.value, Look::Glasses);
        println!(
            "Selected {:?}; the host decides whether to save it.",
            action.value
        );
    }
    Ok(())
}
