//! Owner-supplied graph expansion. These values are not admission authority.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::{SwarmPlan, SwarmTask, TaskResult, TaskStatus, validate_plan};

/// Inputs for one admitted callback, including only its direct dependencies.
#[derive(Debug, Clone)]
pub struct SwarmTaskContext {
    /// Stable callback admission identity. Owners can correlate this with a
    /// persisted in-flight reservation when reconciling after a crash.
    pub dispatch_id: String,
    pub task: SwarmTask,
    pub dependency_results: BTreeMap<String, TaskResult>,
}

/// A result and additional tasks admitted by the caller's execution owner.
/// The scheduler never parses model prose into tasks or grants capabilities.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SwarmTaskOutcome {
    pub result: TaskResult,
    pub follow_up_tasks: Vec<SwarmTask>,
}

impl From<TaskResult> for SwarmTaskOutcome {
    fn from(result: TaskResult) -> Self {
        Self {
            result,
            follow_up_tasks: Vec::new(),
        }
    }
}

/// Validate the whole replacement before publishing any graph mutation.
pub(crate) fn expanded_plan(
    plan: &SwarmPlan,
    source: &str,
    mut additions: Vec<SwarmTask>,
    max_tasks: usize,
) -> Result<SwarmPlan> {
    if additions.len() > max_tasks.saturating_sub(plan.tasks.len()) {
        bail!("Swarm task budget exhausted");
    }
    for task in &mut additions {
        if task.id.trim().is_empty()
            || task.status != TaskStatus::Pending
            || task.result.is_some()
            || task.assigned_agent.is_some()
        {
            bail!("Expanded tasks must have an identity and be unstarted");
        }
        if !task.dependencies.iter().any(|id| id == source) {
            task.dependencies.push(source.to_owned());
        }
    }
    let mut candidate = plan.clone();
    // Existing consumers wait for the entire discovered subgraph. This also
    // makes a follow-up depending on a consumer a cycle, rejected below.
    for task in &mut candidate.tasks {
        if task.dependencies.iter().any(|id| id == source) {
            if task.status != TaskStatus::Pending {
                bail!("Cannot expand a task after its consumers have started");
            }
            task.dependencies
                .extend(additions.iter().map(|child| child.id.clone()));
        }
    }
    candidate.tasks.extend(additions);
    validate_plan(&candidate)?;
    Ok(candidate)
}

/// Declared file scopes are scheduling hints, never a sandbox boundary.
/// Unknown/glob claims overlap conservatively; concrete directories overlap
/// their descendants, but `src/a` does not overlap `src/ab`.
pub(crate) fn files_overlap(left: &SwarmTask, right: &SwarmTask) -> bool {
    left.files.iter().any(|left| {
        right.files.iter().any(|right| {
            let (Some(left), Some(right)) = (file_scope(left), file_scope(right)) else {
                return true;
            };
            left == right
                || left
                    .strip_prefix(&right)
                    .is_some_and(|s| s.starts_with('/'))
                || right
                    .strip_prefix(&left)
                    .is_some_and(|s| s.starts_with('/'))
        })
    })
}

fn file_scope(path: &str) -> Option<String> {
    if path.is_empty() || path.contains(['*', '?', '[', ']']) {
        return None;
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    // Case folding is conservative on case-sensitive workspaces and also
    // prevents common macOS/Windows aliases from overlapping at runtime.
    Some(parts.join("/").to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_file_scopes_compare_aliases_directories_and_uncertain_claims() {
        let task = |scope: &str| {
            let mut task = SwarmTask::new(scope, "edit");
            task.files = vec![scope.into()];
            task
        };
        for (left, right) in [
            ("./src/a.rs", "src/a.rs"),
            ("src/lib/../a.rs", "src/a.rs"),
            ("src", "src/a.rs"),
            ("SRC/A.RS", "src/a.rs"),
            ("src\\a.rs", "src/a.rs"),
            ("src/*.rs", "tests/a.rs"),
            ("../outside", "src/a.rs"),
            ("/absolute", "src/a.rs"),
        ] {
            assert!(files_overlap(&task(left), &task(right)), "{left}, {right}");
        }
        assert!(!files_overlap(&task("src/a"), &task("src/ab")));
        assert!(!files_overlap(&task("src/a"), &task("tests/a")));
    }

    #[test]
    fn diamond_graph_validation_reuses_completed_traversals() {
        let mut tasks = vec![SwarmTask::new("root", "root")];
        for i in 0..60 {
            let dependencies = if i == 0 {
                vec!["root".into()]
            } else {
                vec![format!("left-{}", i - 1), format!("right-{}", i - 1)]
            };
            tasks.push(
                SwarmTask::new(format!("left-{i}"), "left").with_dependencies(dependencies.clone()),
            );
            tasks.push(
                SwarmTask::new(format!("right-{i}"), "right").with_dependencies(dependencies),
            );
        }
        validate_plan(&SwarmPlan::new("diamond").with_tasks(tasks)).unwrap();
    }
}
