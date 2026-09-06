use maestro_interaction::{Action, Attention, Event, Policy, Reaction, Selection};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Working,
    Finished,
    NeedsInput,
}

fn policy() -> Policy {
    Policy {
        notifications: true,
        recaps: true,
        recap_after: Duration::from_secs(180),
    }
}

#[test]
fn replay_focus_return_observes_completion_without_a_render_or_alert() {
    let mut state = Attention::default();
    state.update(Event::Started(State::Working), Duration::ZERO, policy());
    state.update(Event::FocusLost, Duration::ZERO, policy());
    let effects = state.update(
        Event::FocusGained {
            state: State::Finished,
            attention: true,
        },
        Duration::from_secs(181),
        policy(),
    );
    assert_eq!(effects.recap, Some(State::Finished));
    assert_eq!(effects.notification, None);
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(182),
                policy()
            )
            .recap,
        None
    );
}

#[test]
fn replay_two_quick_turns_can_each_need_attention_but_duplicates_do_not_notify() {
    let mut state = Attention::default();
    state.update(Event::FocusLost, Duration::ZERO, policy());
    for _ in 0..2 {
        state.update(Event::Started(State::Working), Duration::ZERO, policy());
        let event = Event::Observed {
            state: State::NeedsInput,
            attention: true,
        };
        assert_eq!(
            state.update(event, Duration::ZERO, policy()).notification,
            Some(State::NeedsInput)
        );
        assert_eq!(
            state.update(event, Duration::ZERO, policy()).notification,
            None
        );
    }
}

#[test]
fn replay_opt_out_keeps_recap_and_reset_forgets_the_previous_session() {
    let mut state = Attention::default();
    let quiet = Policy {
        notifications: false,
        ..policy()
    };
    state.update(Event::FocusLost, Duration::ZERO, quiet);
    assert_eq!(
        state
            .update(
                Event::Observed {
                    state: State::Finished,
                    attention: true
                },
                Duration::ZERO,
                quiet
            )
            .notification,
        None
    );
    assert!(state.changed_while_away());
    state.update(Event::Reset, Duration::ZERO, quiet);
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(181),
                quiet
            )
            .recap,
        None
    );
}

#[test]
fn reaction_is_bounded_and_time_is_supplied_by_the_host() {
    let mut reaction = Reaction::default();
    reaction.start(Duration::from_secs(2));
    assert_eq!(
        reaction.frame(
            Duration::from_millis(2299),
            Duration::from_millis(100),
            Duration::from_millis(900)
        ),
        Some(2)
    );
    assert_eq!(
        reaction.frame(
            Duration::from_millis(2900),
            Duration::from_millis(100),
            Duration::from_millis(900)
        ),
        None
    );
    assert_eq!(
        reaction.frame(
            Duration::ZERO,
            Duration::from_millis(100),
            Duration::from_millis(900)
        ),
        None
    );
}

#[test]
fn selection_handles_empty_and_shrinking_lists_and_returns_typed_actions() {
    let actions = [
        Action::new("mint", "Mint", 42),
        Action::new("rose", "Rose", 7),
    ];
    let mut selection = Selection::default();
    selection.down(actions.len());
    assert_eq!(selection.get(&actions).map(|a| a.value), Some(7));
    selection.reconcile(1);
    assert_eq!(selection.index(1), Some(0));
    selection.down(0);
    assert_eq!(selection.index(0), None);
    assert_eq!(selection.get::<Action<i32>>(&[]), None);
}

#[test]
fn suggestion_acceptance_returns_a_value_once_and_never_dispatches_it() {
    let mut suggestion = maestro_interaction::Suggestion::default();
    assert_eq!(suggestion.visible(Some("/diff")), Some("/diff"));
    assert_eq!(suggestion.take(Some("/diff")), Some("/diff"));
    assert_eq!(suggestion.take(Some("/diff")), None);
    suggestion.reset();
    suggestion.dismiss();
    assert_eq!(suggestion.visible(Some("/diff")), None);
    suggestion.reset();
    assert_eq!(suggestion.take::<&str>(None), None);
    assert_eq!(suggestion.visible(Some("/diff")), Some("/diff"));
}

#[test]
fn replay_old_completion_and_short_absence_do_not_create_a_recap() {
    let mut state = Attention::default();
    let complete = Event::Observed {
        state: State::Finished,
        attention: true,
    };
    assert_eq!(
        state
            .update(complete, Duration::ZERO, policy())
            .notification,
        None
    );
    state.update(Event::FocusLost, Duration::ZERO, policy());
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(200),
                policy()
            )
            .recap,
        None
    );
    state.update(
        Event::Started(State::Working),
        Duration::from_secs(200),
        policy(),
    );
    state.update(Event::FocusLost, Duration::from_secs(200), policy());
    state.update(complete, Duration::from_secs(201), policy());
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(202),
                policy()
            )
            .recap,
        None
    );
}

#[test]
fn replay_duplicate_focus_loss_keeps_the_original_absence_and_recaps_can_be_disabled() {
    let mut state = Attention::default();
    state.update(Event::FocusLost, Duration::ZERO, policy());
    state.update(Event::FocusLost, Duration::from_secs(179), policy());
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(181),
                policy()
            )
            .recap,
        Some(State::Finished)
    );
    state.update(
        Event::Started(State::Working),
        Duration::from_secs(182),
        policy(),
    );
    state.update(Event::FocusLost, Duration::from_secs(183), policy());
    assert_eq!(
        state
            .update(
                Event::FocusGained {
                    state: State::Finished,
                    attention: true
                },
                Duration::from_secs(400),
                Policy {
                    recaps: false,
                    ..policy()
                }
            )
            .recap,
        None
    );
}
