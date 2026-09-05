//! Run without a terminal, sleeps, network, or desktop notification permission.
use maestro_interaction::{Action, Attention, Event, Policy, Selection, Suggestion};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Task {
    Running,
    NeedsInput,
    Finished,
}

fn main() {
    let mut monitor = Attention::default();
    let policy = Policy {
        notifications: true,
        ..Policy::default()
    };
    // Recorded timestamps are the fake clock. The host owns real time in production.
    let events = [
        (0, Event::Started(Task::Running)),
        (1, Event::FocusLost),
        (
            10,
            Event::Observed {
                state: Task::NeedsInput,
                attention: true,
            },
        ),
        (
            10,
            Event::Observed {
                state: Task::NeedsInput,
                attention: true,
            },
        ),
        (
            200,
            Event::FocusGained {
                state: Task::Finished,
                attention: true,
            },
        ),
    ];
    for (seconds, event) in events {
        let effects = monitor.update(event, Duration::from_secs(seconds), policy);
        // A real host decides whether/how to deliver these requests.
        println!("{seconds}s: {effects:?}");
    }
    let actions = [Action::new("review", "Review changes", "/diff")];
    let selected = Selection::default().get(&actions).unwrap();
    let mut suggestion = Suggestion::default();
    let draft = suggestion.take(Some(selected.value)).unwrap();
    assert_eq!(draft, "/diff");
    // The value is only a draft. No executor is installed by this library.
    println!("Draft: {draft}");
}
