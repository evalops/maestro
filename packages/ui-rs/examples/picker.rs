//! Deterministic preview; no raw mode, credentials, or network required.
use maestro_ui::{Modal, SearchField};
use ratatui::{
    Terminal,
    backend::TestBackend,
    layout::{Constraint, Layout},
    widgets::{List, ListState},
};

fn main() -> Result<(), std::convert::Infallible> {
    let mut terminal = Terminal::new(TestBackend::new(64, 18))?;
    let mut selection = ListState::default().with_selected(Some(0));
    terminal.draw(|frame| {
        let inner = Modal::new(" Select item ", 50, 12).render(frame, frame.area());
        let areas = Layout::vertical([Constraint::Length(3), Constraint::Min(0)]).split(inner);
        frame.render_widget(SearchField::new("", "Type to filter..."), areas[0]);
        frame.render_stateful_widget(
            List::new(["First item", "Second item"]).highlight_symbol("> "),
            areas[1],
            &mut selection,
        );
    })?;
    let buffer = terminal.backend().buffer();
    for y in 0..buffer.area.height {
        let line: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        println!("{}", line.trim_end());
    }
    Ok(())
}
