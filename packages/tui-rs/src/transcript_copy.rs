//! Explicit copying of visible conversation text. Tool payloads and reasoning are excluded.
use crate::state::{Message, MessageKind, MessageRole};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyTarget {
    Prompt,
    Response,
    Prompts,
    Responses,
    Turns { first: usize, last: usize },
    Session,
    All,
}
impl CopyTarget {
    pub fn parse(input: &str) -> Result<Self, String> {
        let words: Vec<_> = input.split_whitespace().collect();
        match words.as_slice() {
            [] | ["response" | "last"] => Ok(Self::Response),
            ["prompt"] => Ok(Self::Prompt),
            ["prompts"] => Ok(Self::Prompts),
            ["responses"] => Ok(Self::Responses),
            ["session" | "session-id"] => Ok(Self::Session),
            ["all"] => Ok(Self::All),
            ["turn" | "turns", range] => {
                let (first, last) = range.split_once('-').unwrap_or((range, range));
                let first = first.parse::<usize>().map_err(|_| Self::usage())?;
                let last = last.parse::<usize>().map_err(|_| Self::usage())?;
                if first == 0 || last < first {
                    return Err(Self::usage());
                }
                Ok(Self::Turns { first, last })
            }
            _ => Err(Self::usage()),
        }
    }
    fn usage() -> String {
        maestro_ui::localization::tr(
            "Usage: /copy [prompt|response|prompts|responses|turns <first-last>|session|all]",
        )
        .into()
    }
}

pub fn copy_text(
    target: &CopyTarget,
    messages: &[Message],
    session: Option<&str>,
) -> Result<String, String> {
    if matches!(target, CopyTarget::Session) {
        return session
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .ok_or_else(|| maestro_ui::localization::tr("No saved session to copy").into());
    }
    let regular: Vec<_> = messages
        .iter()
        .filter(|m| m.kind == MessageKind::Regular)
        .collect();
    if matches!(target, CopyTarget::Prompt | CopyTarget::Response) {
        let role = if matches!(target, CopyTarget::Prompt) {
            MessageRole::User
        } else {
            MessageRole::Assistant
        };
        return regular
            .iter()
            .rev()
            .find(|m| m.role == role && !m.content.is_empty())
            .map(|m| m.content.clone())
            .ok_or_else(|| maestro_ui::localization::tr("No message to copy").into());
    }
    let turns = regular
        .iter()
        .filter(|m| m.role == MessageRole::User)
        .count();
    if let CopyTarget::Turns { last, .. } = target {
        if *last > turns {
            return Err(maestro_ui::localization::format(
                "Only {0} turns are available in the current transcript",
                &[(turns).to_string()],
            ));
        }
    }
    let mut turn = 0;
    let mut text = Vec::new();
    for message in regular {
        if message.role == MessageRole::User {
            turn += 1;
        }
        let include = match target {
            CopyTarget::Prompts => message.role == MessageRole::User,
            CopyTarget::Responses => message.role == MessageRole::Assistant,
            CopyTarget::Turns { first, last } => turn >= *first && turn <= *last,
            CopyTarget::All => true,
            _ => false,
        };
        if include && !message.content.is_empty() {
            let role = if message.role == MessageRole::User {
                maestro_ui::localization::tr("User")
            } else {
                maestro_ui::localization::tr("Assistant")
            };
            text.push(format!("{role}:\n{}", message.content));
        }
    }
    if text.is_empty() {
        Err(maestro_ui::localization::tr("No message to copy").into())
    } else {
        Ok(text.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    fn conversation() -> AppState {
        let mut state = AppState::new();
        state.add_user_message("first prompt".into());
        state.add_user_message("first reply".into());
        let reply = state.messages.last_mut().unwrap();
        reply.role = MessageRole::Assistant;
        reply.thinking = "private reasoning".into();
        state.add_system_message("internal notice".into());
        state.add_user_message("second prompt 日本語".into());
        state.add_user_message("second reply".into());
        state.messages.last_mut().unwrap().role = MessageRole::Assistant;
        state
    }
    #[test]
    fn copy_selects_roles_ranges_and_session_without_internal_content() {
        let state = conversation();
        assert_eq!(
            copy_text(&CopyTarget::Prompt, &state.messages, None).unwrap(),
            "second prompt 日本語"
        );
        assert_eq!(
            copy_text(&CopyTarget::Response, &state.messages, None).unwrap(),
            "second reply"
        );
        assert_eq!(
            copy_text(
                &CopyTarget::Turns { first: 1, last: 1 },
                &state.messages,
                None
            )
            .unwrap(),
            "User:\nfirst prompt\n\nAssistant:\nfirst reply"
        );
        let all = copy_text(&CopyTarget::All, &state.messages, None).unwrap();
        assert!(!all.contains("internal notice"));
        assert!(!all.contains("private reasoning"));
        assert!(
            !copy_text(&CopyTarget::Prompts, &state.messages, None)
                .unwrap()
                .contains("reply")
        );
        assert!(
            !copy_text(&CopyTarget::Responses, &state.messages, None)
                .unwrap()
                .contains("prompt")
        );
        assert_eq!(
            copy_text(&CopyTarget::Session, &[], Some("saved-id")).unwrap(),
            "saved-id"
        );
        assert!(copy_text(&CopyTarget::Session, &[], None).is_err());
        assert!(
            copy_text(
                &CopyTarget::Turns { first: 2, last: 3 },
                &state.messages,
                None
            )
            .is_err()
        );
    }
    #[test]
    fn invalid_ranges_never_fall_back_to_copying_other_text() {
        for input in [
            "turns 0",
            "turns 3-1",
            "turns -1",
            "turns 1-2-3",
            "turns 999999999999999999999999",
            "prompt extra",
        ] {
            assert!(CopyTarget::parse(input).is_err(), "{input}");
        }
        assert_eq!(
            CopyTarget::parse("turns 2-3").unwrap(),
            CopyTarget::Turns { first: 2, last: 3 }
        );
        assert_eq!(CopyTarget::parse("").unwrap(), CopyTarget::Response);
    }
}
