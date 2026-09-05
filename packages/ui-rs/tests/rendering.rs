use maestro_ui::{Modal, SearchField};
use ratatui::{
    Terminal,
    backend::TestBackend,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Padding, Paragraph, Widget},
};

#[test]
fn modal_preserves_selector_geometry_and_offset() {
    assert_eq!(
        Modal::new(" Theme ", 50, 12).area(Rect::new(10, 5, 80, 24)),
        Rect::new(25, 11, 50, 12),
    );
    assert_eq!(
        Modal::new(" Model ", 60, 22).area(Rect::new(10, 5, 30, 12)),
        Rect::new(12, 7, 26, 8),
    );
    assert_eq!(
        Modal::new("", 50, 12)
            .margin(0)
            .area(Rect::new(7, 3, 10, 5)),
        Rect::new(7, 3, 10, 5),
    );
}

#[test]
fn modal_clears_only_its_surface_and_returns_padded_content() {
    let mut terminal = Terminal::new(TestBackend::new(30, 14)).unwrap();
    terminal
        .draw(|frame| {
            frame.render_widget(
                Paragraph::new(vec!["x".repeat(30); 14].join("\n")),
                frame.area(),
            );
            let inner = Modal::new("", 16, 8)
                .block(Block::bordered().padding(Padding::uniform(1)))
                .render(frame, Rect::new(4, 2, 22, 10));
            assert_eq!(inner, Rect::new(9, 6, 12, 2));
            frame.render_widget(Paragraph::new("Child"), inner);
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), "x");
    assert_eq!(buffer[(6, 4)].symbol(), "x");
    assert_eq!(buffer[(7, 4)].symbol(), "┌");
    assert_eq!(buffer[(8, 5)].symbol(), " ");
    assert_eq!(buffer[(9, 6)].symbol(), "C");
    assert_eq!(buffer[(23, 4)].symbol(), "x");
}

#[test]
fn search_field_matches_existing_selector_rendering_including_unicode() {
    for query in [
        "",
        "dark",
        "模型é",
        "a very long query beyond the right edge",
    ] {
        for width in [0, 1, 2, 8, 40] {
            let area = Rect::new(3, 2, width, 3);
            let mut actual = Buffer::empty(Rect::new(0, 0, 50, 8));
            let mut expected = actual.clone();
            SearchField::new(query, "Type to filter themes...").render(area, &mut actual);
            // The original theme/model selector path, before extraction.
            let block = Block::default()
                .title(" Search ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray));
            let paragraph = if query.is_empty() {
                Paragraph::new("Type to filter themes...")
                    .style(Style::default().fg(Color::DarkGray))
            } else {
                Paragraph::new(query).style(Style::default().fg(Color::White))
            };
            paragraph.block(block).render(area, &mut expected);
            assert_eq!(actual, expected, "query={query:?}, width={width}");
        }
    }
}

#[test]
fn search_field_accepts_application_styles() {
    for (query, color, symbol) in [("", Color::Yellow, "H"), ("Q", Color::Green, "Q")] {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 10, 3));
        SearchField::new(query, "Hint")
            .block(Block::default())
            .text_style(Style::default().fg(Color::Green))
            .placeholder_style(Style::default().fg(Color::Yellow))
            .render(buffer.area, &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), symbol);
        assert_eq!(buffer[(0, 0)].fg, color);
    }
}

#[test]
fn tiny_terminals_and_large_margins_are_safe() {
    for width in 0..12 {
        for height in 0..10 {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal
                .draw(|frame| {
                    let inner = Modal::new(" Select ", 50, 12).render(frame, frame.area());
                    assert!(inner.right() <= width);
                    assert!(inner.bottom() <= height);
                    frame.render_widget(SearchField::new("模型", "Search"), inner);
                })
                .unwrap();
        }
    }
    let area = Modal::new("", u16::MAX, u16::MAX)
        .margin(u16::MAX)
        .area(Rect::new(7, 9, 80, 24));
    assert_eq!(area.width, 0);
    assert_eq!(area.height, 0);
}

#[test]
fn action_list_renders_labels_without_dispatching_intents() {
    use maestro_interaction::Action;
    use maestro_ui::{ActionList, UiTheme};
    use ratatui::widgets::ListState;
    let actions = [
        Action::new("first", "First option", 7),
        Action::new("second", "Second option", 42),
    ];
    let mut state = ListState::default().with_selected(Some(1));
    let mut terminal = Terminal::new(TestBackend::new(24, 4)).unwrap();
    terminal
        .draw(|frame| {
            ActionList::new(&actions, UiTheme::default()).render(frame, frame.area(), &mut state)
        })
        .unwrap();
    let text: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(text.contains("Second option"));
    assert_eq!(actions[state.selected().unwrap()].value, 42);
}

#[test]
fn notice_uses_the_supplied_bounds_without_overwriting_other_rows() {
    use maestro_ui::Notice;
    let area = Rect::new(0, 0, 20, 4);
    let mut buffer = Buffer::empty(area);
    Paragraph::new("keep").render(Rect::new(0, 0, 20, 1), &mut buffer);
    Notice::new("Saved").render(Rect::new(2, 3, 10, 1), &mut buffer);
    assert_eq!(buffer[(0, 0)].symbol(), "k");
    assert_eq!(buffer[(2, 3)].symbol(), "S");
}
