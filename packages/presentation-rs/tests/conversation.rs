use maestro_presentation::components::{
    composer::Composer,
    tool_result::{ToolPhase, ToolResult},
};
use maestro_ui::{UiTheme, textarea::TextArea};
use ratatui::{buffer::Buffer, layout::Rect, text::Line, widgets::Widget};

fn text(buf: &Buffer) -> String {
    (buf.area.y..buf.area.bottom())
        .map(|y| {
            (buf.area.x..buf.area.right())
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn composer_reserves_editor_space_after_queued_content_and_resize() {
    let mut editor = TextArea::new();
    editor.set_text("Ship 世界");
    editor.set_cursor(editor.text().len());
    let queued = vec![Line::from("Follow-up"); 10];
    for area in [Rect::new(2, 3, 30, 5), Rect::new(2, 3, 12, 3)] {
        let view = Composer {
            editor: &editor,
            queued: &queued,
            busy: true,
            footer: Some("Gemini · normal"),
            completion: None,
            theme: UiTheme::default(),
        };
        let cursor = view.cursor_pos(area).expect("editor stays visible");
        assert!(cursor.0 < area.right() && cursor.1 < area.bottom() - 1);
        let mut buf = Buffer::empty(Rect::new(0, 0, 40, 12));
        view.render(area, &mut buf);
        if area.width == 30 {
            assert!(text(&buf).contains("Ship"));
        }
        assert!(text(&buf).contains("界"));
        assert_eq!(buf[(0, 0)].symbol(), " ");
    }
}

#[test]
fn tool_output_text_cannot_override_failure_and_clipped_content_is_disclosed() {
    let output = (1..=8)
        .map(|n| format!("Success line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let view = ToolResult {
        phase: ToolPhase::Failed,
        summary: "Run checks",
        arguments: "",
        output: &output,
        expanded: false,
        detail: "bash #private",
        truncation: Some("Output limited by the caller"),
        theme: UiTheme::default(),
    };
    let area = Rect::new(0, 0, 60, view.height(60));
    let mut buf = Buffer::empty(area);
    view.render(area, &mut buf);
    let rendered = text(&buf);
    assert!(rendered.contains("Failed · Run checks"));
    assert!(rendered.contains("Success line 5"));
    assert!(!rendered.contains("Success line 6"));
    assert!(rendered.contains("+3 lines"));
    assert!(rendered.contains("Output limited by the caller"));
    assert!(!rendered.contains("private"));
    assert_eq!(area.height, 8);
}

#[test]
fn expanded_results_preserve_blank_lines_and_show_execution_identity() {
    let view = ToolResult {
        phase: ToolPhase::Completed,
        summary: "Read README.md",
        arguments: "README.md",
        output: "first\n\nlast",
        expanded: true,
        detail: "read #read-1",
        truncation: None,
        theme: UiTheme::default(),
    };
    assert_eq!(view.height(60), 5);
    let mut buf = Buffer::empty(Rect::new(0, 0, 60, 5));
    view.render(buf.area, &mut buf);
    let rendered = text(&buf);
    assert!(rendered.contains("read #read-1"));
    assert!(rendered.contains("last"));
    assert_eq!(rendered.matches("README.md").count(), 1);
}

#[test]
fn narrow_composer_does_not_paint_a_wide_glyph_outside_its_editor() {
    let mut editor = TextArea::new();
    editor.set_text("界");
    let mut buf = Buffer::empty(Rect::new(0, 0, 12, 5));
    buf[(5, 1)].set_symbol("x");
    Composer {
        editor: &editor,
        queued: &[],
        busy: false,
        footer: None,
        completion: None,
        theme: UiTheme::default(),
    }
    .render(Rect::new(0, 0, 5, 3), &mut buf);
    assert_eq!(buf[(5, 1)].symbol(), "x");
    assert_eq!(
        buf[(3, 1)].symbol(),
        " ",
        "wide glyph cannot cross the editor's right inset"
    );
}

#[test]
fn empty_editor_suggestion_preserves_prompt_spacing() {
    let editor = TextArea::new();
    let mut buf = Buffer::empty(Rect::new(0, 0, 40, 4));
    Composer {
        editor: &editor,
        queued: &[],
        busy: false,
        footer: None,
        completion: Some("Summarize the changes"),
        theme: UiTheme::default(),
    }
    .render(buf.area, &mut buf);
    assert!(text(&buf).contains("> Summarize the changes"));
}
