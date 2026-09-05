use maestro_ui::{
    ActionPicker, KeyHint, Modal, ModalSize, Notice, NoticeTone, PickerOptions, PickerStatus,
    SettingField, SettingsForm, UiTheme, key_hints,
};
use ratatui::{
    Terminal,
    backend::TestBackend,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier},
    widgets::{ListItem, ListState, Widget},
};

fn themes() -> [UiTheme; 2] {
    [
        UiTheme {
            surface: Color::Black,
            text: Color::White,
            ..UiTheme::default()
        },
        UiTheme {
            surface: Color::White,
            text: Color::Black,
            ..UiTheme::default()
        },
    ]
}

#[test]
fn hints_borrow_strings_not_temporary_slice_and_use_semantic_styles() {
    const CONFIRM: KeyHint<'static> = KeyHint::new("Enter", "select");
    for theme in themes() {
        let label = String::from("cancel");
        let line = key_hints(&[CONFIRM, KeyHint::new("Esc", &label)], theme);
        assert_eq!(line.to_string(), "Enter select · Esc cancel");
        assert_eq!(line.spans[0].style.fg, Some(theme.focus));
        assert!(line.spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(line.spans[2].style.fg, Some(theme.muted));
        assert!(key_hints(&[], theme).spans.is_empty());
    }
}

#[test]
fn notice_tones_use_the_current_palette() {
    for theme in themes() {
        for (tone, color) in [
            (NoticeTone::Neutral, theme.muted),
            (NoticeTone::Busy, theme.focus),
            (NoticeTone::Success, theme.success),
            (NoticeTone::Attention, theme.attention),
            (NoticeTone::Error, theme.error),
        ] {
            let mut buffer = Buffer::empty(Rect::new(0, 0, 20, 1));
            Notice::themed("message", tone, theme).render(buffer.area, &mut buffer);
            assert_eq!(buffer[(0, 0)].fg, color);
            assert_eq!(buffer[(0, 0)].bg, theme.surface);
        }
    }
}

#[test]
fn themed_modal_sizes_padding_and_buffer_render_match_frame() {
    for (size, width, height) in [
        (ModalSize::Compact, 54, 16),
        (ModalSize::Standard, 72, 22),
        (ModalSize::Wide, 80, 25),
    ] {
        let theme = themes()[1];
        let parent = Rect::new(3, 2, 100, 40);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 110, 45));
        let modal = Modal::sized("Title", size).theme(theme);
        let area = modal.area(parent);
        assert_eq!((area.width, area.height), (width, height));
        let inner = modal.render_buffer(parent, &mut buffer);
        assert_eq!(
            inner,
            Rect::new(area.x + 2, area.y + 1, width - 4, height - 2)
        );
        assert_eq!(buffer[(area.x, area.y)].fg, theme.border);
        assert_eq!(buffer[(area.x + 1, area.y)].fg, theme.text);
        let mut terminal = Terminal::new(TestBackend::new(110, 45)).unwrap();
        terminal
            .draw(|frame| {
                assert_eq!(
                    Modal::sized("Title", size)
                        .theme(theme)
                        .render(frame, parent),
                    inner
                );
            })
            .unwrap();
        assert_eq!(terminal.backend().buffer(), &buffer);
    }
    for width in 0..8 {
        for height in 0..8 {
            let mut buffer = Buffer::empty(Rect::new(4, 5, width, height));
            let inner = Modal::sized("Long title", ModalSize::Wide)
                .theme(UiTheme::default())
                .render_buffer(buffer.area, &mut buffer);
            assert!(inner.width <= width && inner.height <= height);
        }
    }
}

#[test]
fn settings_selection_retains_validation_color_in_both_palettes() {
    for theme in themes() {
        let fields = [SettingField {
            category: "Group",
            label: "Value",
            value: "bad",
            description: "",
            error: Some("Invalid"),
        }];
        let mut terminal = Terminal::new(TestBackend::new(30, 8)).unwrap();
        terminal
            .draw(|frame| {
                SettingsForm::new(&fields, Some(0), theme).render(
                    frame,
                    frame.area(),
                    &mut ListState::default(),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let cell = buffer
            .content
            .iter()
            .find(|cell| cell.symbol() == "b")
            .unwrap();
        assert_eq!(cell.fg, theme.error);
        assert_eq!(cell.bg, theme.surface);
        assert!(cell.modifier.contains(Modifier::BOLD));
    }
}

#[test]
fn action_picker_status_colors_and_typed_hint_precedence() {
    for theme in themes() {
        for searchable in [false, true] {
            for (status, color) in [
                (PickerStatus::Loading("Waiting".into()), theme.focus),
                (PickerStatus::Error("Failed".into()), theme.error),
            ] {
                let mut picker = ActionPicker::new(vec!["stale"]);
                if searchable {
                    picker = picker.searchable(|item| item);
                }
                picker.open();
                picker.set_status(status);
                let mut terminal = Terminal::new(TestBackend::new(40, 9)).unwrap();
                terminal
                    .draw(|frame| {
                        picker.render(
                            frame,
                            frame.area(),
                            theme,
                            PickerOptions {
                                hints: Some(&[KeyHint::new("Esc", "close")]),
                                help_text: Some("ignored override"),
                                ..Default::default()
                            },
                            |item| ListItem::new(*item),
                        )
                    })
                    .unwrap();
                let buffer = terminal.backend().buffer();
                assert_eq!(buffer[(0, if searchable { 3 } else { 0 })].fg, color);
                let text: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
                assert!(text.contains("Esc close"));
                assert!(!text.contains("ignored override"));
                assert!(!text.contains("stale"));
            }
        }
    }
}
