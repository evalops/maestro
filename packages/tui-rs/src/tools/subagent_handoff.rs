//! A child's self-reported handoff, retained in its existing result journal.
//! Parsing a handoff never establishes acceptance or grants new authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Outcome {
    Complete,
    Partial,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcedureFeedback {
    pub skill_path: String,
    pub observation: String,
    pub suggested_change: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Handoff {
    pub outcome: Outcome,
    pub summary: String,
    pub completed: Vec<String>,
    pub remaining: Vec<String>,
    pub blockers: Vec<String>,
    pub references: Vec<String>,
    pub procedure_feedback: Vec<ProcedureFeedback>,
}

pub(super) const INSTRUCTIONS: &str = r#"
Return your final result as one JSON object, without a Markdown fence:
{"outcome":"complete|partial|blocked","summary":"brief result","completed":["work finished"],"remaining":["unfinished work"],"blockers":["specific blocker"],"references":["path:line or evidence reference"],"procedure_feedback":[{"skill_path":"source SKILL.md","observation":"what actually happened","suggested_change":"concrete proposed edit"}]}.
Use empty arrays when appropriate. Use partial or blocked whenever assigned work remains. Complete requires empty remaining and blockers arrays, at least one completed item, and at least one reference to the evidence supporting it. A reference is a lead for the parent to verify, not proof of acceptance. Keep the whole handoff under 16 KiB, each string under 2 KiB, and each list under 32 entries.
Report the assigned task only. Include exact locations and enough evidence that the parent does not repeat your exploration. Suggest procedure changes only when supported by this run. Do not edit persistent instructions unless the assigned task explicitly authorizes that edit. Feedback is a proposal for review, never permission or an automatically applied rule.
"#;

pub(super) fn parse(output: &str) -> Result<Handoff, String> {
    if output.len() > 16_384 {
        return Err("handoff exceeds 16 KiB".into());
    }
    let handoff: Handoff = serde_json::from_str(output)
        .map_err(|_| "child did not return a valid structured handoff".to_string())?;
    let valid = |s: &str| !s.trim().is_empty() && s.len() <= 2_048;
    let lists = [
        &handoff.completed,
        &handoff.remaining,
        &handoff.blockers,
        &handoff.references,
    ];
    if !valid(&handoff.summary)
        || lists
            .iter()
            .any(|list| list.len() > 32 || list.iter().any(|s| !valid(s)))
        || handoff.procedure_feedback.len() > 32
        || handoff
            .procedure_feedback
            .iter()
            .any(|f| !valid(&f.skill_path) || !valid(&f.observation) || !valid(&f.suggested_change))
    {
        return Err("handoff contains empty or oversized fields".into());
    }
    if handoff.outcome == Outcome::Complete
        && (!handoff.remaining.is_empty() || !handoff.blockers.is_empty())
    {
        return Err("child reported complete with unfinished work or blockers".into());
    }
    if handoff.outcome == Outcome::Complete
        && (handoff.completed.is_empty() || handoff.references.is_empty())
    {
        return Err(
            "child reported complete without completed work and evidence references".into(),
        );
    }
    if handoff.outcome == Outcome::Partial && handoff.remaining.is_empty() {
        return Err("partial handoff must name unfinished work".into());
    }
    if handoff.outcome == Outcome::Blocked && handoff.blockers.is_empty() {
        return Err("blocked handoff must name a blocker".into());
    }
    Ok(handoff)
}

/// Action comes before summary so long summaries cannot hide unfinished work.
pub(super) fn notification(output: &str) -> String {
    let note = match parse(output) {
        Ok(h) => match h.outcome {
            Outcome::Complete => format!(
                "Child reports its assignment complete. Inspect the saved handoff and evidence before treating the parent task as complete. {}",
                h.summary
            ),
            Outcome::Partial => format!(
                "Unfinished work: {}. Retrieve the saved handoff and continue within the original authorization. {}",
                h.remaining.join("; "),
                h.summary
            ),
            Outcome::Blocked => format!(
                "Child needs help: {}. Retrieve the saved handoff, resolve an authorized blocker or report the required decision. {}",
                h.blockers.join("; "),
                h.summary
            ),
        },
        Err(error) => format!(
            "Completion is unverified: {error}. Retrieve the saved result and clarify remaining work before declaring the parent task complete. {}",
            output.trim()
        ),
    };
    note.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn fixture() -> serde_json::Value {
        serde_json::json!({"outcome":"partial","summary":"Parser added",
            "completed":["Parser implementation"],"remaining":["Wire the UI"],
            "blockers":[],"references":["src/parser.rs:12"],
            "procedure_feedback":[{"skill_path":"skills/build/SKILL.md",
                "observation":"The documented target does not exist",
                "suggested_change":"Replace make test-ui with npm run test:ui"}]})
    }

    #[test]
    fn completion_requires_evidence_but_does_not_establish_acceptance() {
        let mut value = fixture();
        value["outcome"] = "complete".into();
        value["remaining"] = serde_json::json!([]);
        assert!(parse(&value.to_string()).is_ok());
        for field in ["completed", "references"] {
            let mut missing = value.clone();
            missing[field] = serde_json::json!([]);
            assert!(parse(&missing.to_string()).is_err());
            assert!(notification(&missing.to_string()).starts_with("Completion is unverified"));
        }
    }

    #[test]
    fn handoff_preserves_unfinished_work_and_reviewable_feedback() {
        let text = fixture().to_string();
        let handoff = parse(&text).unwrap();
        assert_eq!(handoff.remaining, ["Wire the UI"]);
        assert_eq!(
            handoff.procedure_feedback[0].skill_path,
            "skills/build/SKILL.md"
        );
        assert!(notification(&text).starts_with("Unfinished work: Wire the UI"));
        let replay = serde_json::to_string(&handoff).unwrap();
        assert_eq!(parse(&replay).unwrap().references, ["src/parser.rs:12"]);
    }

    #[test]
    fn prose_and_contradictory_completion_cannot_hide_remaining_work() {
        assert!(parse("All done").is_err());
        assert!(notification("All done").starts_with("Completion is unverified"));
        let mut contradictory = fixture();
        contradictory["outcome"] = "complete".into();
        assert!(parse(&contradictory.to_string()).is_err());
    }

    #[test]
    fn oversized_and_incomplete_handoffs_are_rejected() {
        let mut v = fixture();
        v["summary"] = "x".repeat(2049).into();
        assert!(parse(&v.to_string()).is_err());
        let mut v = fixture();
        v.as_object_mut().unwrap().remove("remaining");
        assert!(parse(&v.to_string()).is_err());
    }
}
