//! Ephemeral composer recovery over the existing prompt history authority.
use super::*;
use crate::components::textarea::TextArea;

pub(super) struct Draft {
    editor: TextArea,
    attachments: Vec<String>,
}

pub(super) struct HistorySearch {
    query: String,
    matches: Vec<String>,
    selected: usize,
}

impl App {
    pub(super) fn swap_draft_stash(&mut self) {
        let mut draft = self.draft_stash.take().unwrap_or(Draft {
            editor: TextArea::new(),
            attachments: Vec::new(),
        });
        self.state.swap_input_editor(&mut draft.editor);
        std::mem::swap(&mut self.pending_attachments, &mut draft.attachments);
        self.draft_stash =
            (!draft.editor.is_empty() || !draft.attachments.is_empty()).then_some(draft);
        self.prompt_history.reset_navigation();
        self.update_slash_state();
        self.state.ghost_completion = None;
    }

    pub(super) fn open_history_search(&mut self) {
        self.history_search = Some(HistorySearch {
            query: String::new(),
            matches: Vec::new(),
            selected: 0,
        });
        self.refresh_history_search();
    }

    fn refresh_history_search(&mut self) {
        if let Some(search) = &mut self.history_search {
            search.matches = self
                .prompt_history
                .search(&search.query)
                .matches
                .into_iter()
                .map(|item| item.entry.prompt)
                .collect();
            search.selected = 0;
        }
    }

    pub(super) fn paste_history_query(&mut self, text: &str) {
        if let Some(search) = &mut self.history_search {
            search
                .query
                .push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        }
        self.refresh_history_search();
    }

    pub(super) fn handle_history_search_key(
        &mut self,
        code: KeyCode,
        modifiers: CrosstermModifiers,
    ) {
        let Some(search) = &mut self.history_search else {
            return;
        };
        let ctrl = modifiers.contains(CrosstermModifiers::CONTROL);
        match code {
            KeyCode::Esc | KeyCode::Char('c') if code == KeyCode::Esc || ctrl => {
                // The original composer was never changed: cursor, folds and attachments survive.
                self.history_search = None;
            }
            KeyCode::Enter => {
                if let Some(prompt) = search.matches.get(search.selected).cloned() {
                    self.state.set_input(&prompt);
                    // History stores text only. Keep the current attachments explicitly.
                    self.history_search = None;
                    self.prompt_history.reset_navigation();
                    self.update_slash_state();
                    self.state.ghost_completion = None;
                }
            }
            KeyCode::Down | KeyCode::Char('r')
                if (code == KeyCode::Down || ctrl) && !search.matches.is_empty() =>
            {
                search.selected = (search.selected + 1) % search.matches.len();
            }
            KeyCode::Up => {
                search.selected = search.selected.saturating_sub(1);
            }
            KeyCode::Backspace => {
                search.query.pop();
                self.refresh_history_search();
            }
            KeyCode::Char('u') if ctrl => {
                search.query.clear();
                self.refresh_history_search();
            }
            KeyCode::Char(c) if !ctrl && !modifiers.contains(CrosstermModifiers::ALT) => {
                search.query.push(c);
                self.refresh_history_search();
            }
            _ => {}
        }
    }
}

pub(super) fn render(
    frame: &mut ratatui::Frame,
    area: Rect,
    input: Rect,
    search: Option<&HistorySearch>,
    stashed: bool,
) {
    use ratatui::widgets::{Clear, Paragraph};
    let theme = crate::themes::current_ui_theme();
    let hint = if stashed {
        " Ctrl+S restore/swap draft · Ctrl+R history "
    } else {
        " Ctrl+S stash draft · Ctrl+R history "
    };
    if input.width > 4 && input.height > 0 {
        frame.render_widget(
            Paragraph::new(hint).style(theme.muted_style()),
            Rect::new(input.x + 1, input.y, input.width - 2, 1),
        );
    }
    let Some(search) = search else { return };
    // A bounded inline list above the composer; preserve its original draft underneath.
    let height = input.y.saturating_sub(area.y).min(6);
    if height == 0 || area.width < 4 {
        return;
    }
    let popup = Rect::new(area.x, input.y - height, area.width, height);
    let mut lines = vec![
        ratatui::text::Line::raw(format!("History: {}", search.query.replace('\n', " "))),
        ratatui::text::Line::raw("↑/↓ select · Enter restore text (attachments kept) · Esc cancel"),
    ];
    let count = usize::from(height.saturating_sub(2));
    let start = search.selected.saturating_sub(count.saturating_sub(1));
    for (index, prompt) in search.matches.iter().enumerate().skip(start).take(count) {
        lines.push(ratatui::text::Line::styled(
            format!(
                "{} {}",
                if index == search.selected { "›" } else { " " },
                prompt.replace(['\n', '\r'], " ")
            ),
            if index == search.selected {
                theme.on_panel().text_style().patch(theme.selection_style())
            } else {
                theme.on_panel().text_style()
            },
        ));
    }
    if search.matches.is_empty() && count > 0 {
        lines.push(ratatui::text::Line::raw("No matching prompts"));
    }
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(lines).style(theme.on_panel().text_style()),
        popup,
    );
    let col = unicode_width::UnicodeWidthStr::width(search.query.replace('\n', " ").as_str()) + 9;
    frame.set_cursor_position((
        popup.x + col.min(usize::from(popup.width - 1)) as u16,
        popup.y,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composer_recall_inline_search_renders_selection_and_stash_hint() {
        let backend = ratatui::backend::TestBackend::new(90, 12);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        let search = HistorySearch {
            query: "deploy".into(),
            matches: vec!["deploy staging".into(), "deploy production".into()],
            selected: 1,
        };
        terminal
            .draw(|frame| {
                render(
                    frame,
                    frame.area(),
                    Rect::new(0, 9, 90, 3),
                    Some(&search),
                    true,
                );
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let rendered = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("› deploy production"));
        assert!(rendered.contains("Enter restore text (attachments kept)"));
        assert!(rendered.contains("Ctrl+S restore/swap draft"));
    }
}
