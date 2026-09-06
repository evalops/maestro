//! Small supplied-state examples of the production composer and tool result.
use crate::Scene;
use maestro_presentation::components::{
    composer::Composer,
    tool_result::{ToolPhase, ToolResult},
};
use maestro_ui::textarea::TextArea;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{Paragraph, Widget},
};

pub const STATES: &[&str] = &[
    "typing",
    "streaming",
    "error",
    "approval",
    "queued",
    "completed",
];

pub fn scenes() -> Vec<Scene> {
    [40, 60, 100]
        .into_iter()
        .flat_map(|width| {
            STATES.iter().map(move |state| Scene {
                id: format!("conversation-{state}"),
                label: format!("Conversation · {state}"),
                width,
                height: 18,
                time_ms: 0,
            })
        })
        .collect()
}

pub fn render(scene: &Scene) -> Result<Buffer, String> {
    let state = scene
        .id
        .strip_prefix("conversation-")
        .filter(|state| STATES.contains(state))
        .ok_or("unknown conversation scene")?;
    let area = Rect::new(0, 0, scene.width, scene.height);
    let mut buf = Buffer::empty(area);
    let theme = maestro_presentation::palette::conversation();
    buf.set_style(area, Style::default().bg(theme.surface).fg(theme.text));
    let content = Rect::new(
        1,
        1,
        area.width.saturating_sub(2),
        area.height.saturating_sub(2),
    );
    Paragraph::new("Dex Code  ·  release-planner")
        .style(Style::default().fg(theme.focus))
        .render(
            Rect {
                height: 1,
                ..content
            },
            &mut buf,
        );
    Paragraph::new("Check the release before we ship.").render(
        Rect {
            y: content.y + 2,
            height: 1,
            ..content
        },
        &mut buf,
    );
    let (phase, summary, output) = match state {
        "streaming" => (
            ToolPhase::Running,
            "Run release checks",
            "Checking formatting…\nChecking the workspace…",
        ),
        "error" => (
            ToolPhase::Failed,
            "Run release checks",
            "README.md: missing release version\nAdd a version before publishing.",
        ),
        "approval" => (
            ToolPhase::Pending,
            "Approval needed",
            "Publish the release?\nWaiting for your decision.",
        ),
        _ => (
            ToolPhase::Completed,
            "Read README.md",
            "1  # Release checklist\n3  Choose a release owner.\n5  Review the changes.\n7  Run the checks.\n9  Prepare release notes.\n11 Tag the release.",
        ),
    };
    if state != "typing" {
        ToolResult {
            phase,
            summary,
            arguments: "",
            output,
            expanded: false,
            detail: "",
            truncation: None,
            theme,
        }
        .render(
            Rect::new(0, 5, area.width, area.height.saturating_sub(10)),
            &mut buf,
        );
    }
    let mut editor = TextArea::new();
    editor.set_text(match state {
        "typing" => "Review the release notes for clarity.",
        "queued" => "Keep the examples concise.",
        "error" => "Add the missing version and run checks again.",
        _ => "",
    });
    editor.set_cursor(editor.text().len());
    let queued = if state == "queued" {
        vec![Line::styled(
            "Queued after this turn · summarize the changes",
            Style::default().fg(theme.muted),
        )]
    } else {
        Vec::new()
    };
    let height = (4 + u16::from(!queued.is_empty())).min(area.height);
    Composer {
        editor: &editor,
        queued: &queued,
        busy: matches!(state, "streaming" | "approval" | "queued"),
        footer: Some("Gemini · normal"),
        completion: None,
        theme,
    }
    .render(
        Rect::new(0, area.height.saturating_sub(height), area.width, height),
        &mut buf,
    );
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_state_supports_the_minimum_manual_preview_height() {
        for mut scene in scenes() {
            scene.height = 3;
            assert!(render(&scene).is_ok());
        }
    }

    #[test]
    fn every_declared_state_renders_deterministically_at_each_width() {
        for scene in scenes() {
            assert_eq!(render(&scene).unwrap(), render(&scene).unwrap());
        }
    }
}
