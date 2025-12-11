//! Plan Parser
//!
//! Parses AI-generated execution plans into structured SwarmPlan objects.
//! Supports markdown-style task lists and dependency notation.

use anyhow::Result;
use regex::Regex;
use std::collections::HashMap;

use super::types::{SwarmPlan, SwarmTask, TaskId, TaskPriority};

/// Parse a plan from markdown text
///
/// # Format
///
/// The parser supports markdown with the following conventions:
///
/// ```markdown
/// # Plan Title
///
/// Goal: Description of overall goal
///
/// ## Tasks
///
/// 1. [task-1] First task title
///    Description of first task
///    Files: src/foo.rs, src/bar.rs
///    Priority: high
///
/// 2. [task-2] Second task (depends on: task-1)
///    Description of second task
/// ```
pub fn parse_plan(markdown: &str) -> Result<SwarmPlan> {
    let mut plan = SwarmPlan::default();

    // Extract title from first heading (multiline mode for ^ to match line start)
    let title_re = Regex::new(r"(?m)^#\s+(.+)$").unwrap();
    if let Some(cap) = title_re.captures_iter(markdown).next() {
        plan.title = cap[1].trim().to_string();
    }

    // Extract goal
    let goal_re = Regex::new(r"(?i)(?:goal|objective|purpose):\s*(.+?)(?:\n\n|\n#|$)").unwrap();
    if let Some(cap) = goal_re.captures(markdown) {
        plan.goal = cap[1].trim().to_string();
    }

    // Parse tasks
    let tasks = parse_tasks(markdown)?;
    plan.tasks = tasks;

    // Extract concurrency setting if present
    let concurrency_re = Regex::new(r"(?i)(?:concurrency|max[-_]?concurrent):\s*(\d+)").unwrap();
    if let Some(cap) = concurrency_re.captures(markdown) {
        if let Ok(n) = cap[1].parse::<usize>() {
            plan.max_concurrency = n.max(1);
        }
    }

    Ok(plan)
}

/// Parse tasks from markdown
fn parse_tasks(markdown: &str) -> Result<Vec<SwarmTask>> {
    let mut tasks = Vec::new();

    // Pattern for task items: numbered list with optional ID in brackets
    // Examples:
    // - 1. [task-1] Task title
    // - 2. Task title (depends on: task-1)
    // - - [setup] Setup task
    let task_re = Regex::new(
        r"(?m)^(?:\d+\.|[-*])\s*(?:\[([^\]]+)\])?\s*(.+?)(?:\s*\(depends?\s*(?:on)?:?\s*([^)]+)\))?$",
    )
    .unwrap();

    let mut task_id_counter = 0;
    let mut id_map: HashMap<String, TaskId> = HashMap::new();

    for cap in task_re.captures_iter(markdown) {
        let explicit_id = cap.get(1).map(|m| m.as_str().trim().to_string());
        let title = cap[2].trim().to_string();
        let deps_str = cap.get(3).map(|m| m.as_str());

        // Skip empty titles or headers
        if title.is_empty() || title.starts_with('#') {
            continue;
        }

        // Generate ID if not explicit
        task_id_counter += 1;
        let id = explicit_id.unwrap_or_else(|| format!("task-{}", task_id_counter));

        // Map title to ID for dependency resolution
        id_map.insert(title.to_lowercase(), id.clone());

        // Parse dependencies
        let dependencies = if let Some(deps) = deps_str {
            deps.split(',')
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty())
                .collect()
        } else {
            Vec::new()
        };

        let mut task = SwarmTask::new(&id, &title).with_dependencies(dependencies);

        // Try to extract description from following lines
        // This is a simplified approach - in practice, you'd want more robust parsing
        task = extract_task_metadata(markdown, &title, task);

        tasks.push(task);
    }

    Ok(tasks)
}

/// Extract metadata from task description block
fn extract_task_metadata(markdown: &str, title: &str, mut task: SwarmTask) -> SwarmTask {
    // Find the task in the markdown and look for metadata in following lines
    if let Some(start) = markdown.find(title) {
        let rest = &markdown[start + title.len()..];

        // Take lines until next task or section
        let mut description_lines = Vec::new();
        for line in rest.lines() {
            let trimmed = line.trim();

            // Stop at next task or section
            if trimmed.starts_with('#')
                || trimmed.starts_with("- [")
                || trimmed.starts_with("* [")
                || (trimmed.len() > 2 && trimmed.chars().next().is_some_and(|c| c.is_numeric()))
            {
                break;
            }

            // Parse metadata
            if let Some(files) = trimmed
                .strip_prefix("Files:")
                .or(trimmed.strip_prefix("files:"))
            {
                task.files = files
                    .split(',')
                    .map(|f| f.trim().to_string())
                    .filter(|f| !f.is_empty())
                    .collect();
            } else if let Some(priority) = trimmed
                .strip_prefix("Priority:")
                .or(trimmed.strip_prefix("priority:"))
            {
                task.priority = parse_priority(priority.trim());
            } else if let Some(complexity) = trimmed
                .strip_prefix("Complexity:")
                .or(trimmed.strip_prefix("complexity:"))
            {
                if let Ok(c) = complexity.trim().parse::<u8>() {
                    task.complexity = c.clamp(1, 10);
                }
            } else if let Some(tags) = trimmed
                .strip_prefix("Tags:")
                .or(trimmed.strip_prefix("tags:"))
            {
                task.tags = tags
                    .split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            } else if !trimmed.is_empty() && !trimmed.starts_with('(') {
                description_lines.push(trimmed);
            }
        }

        if !description_lines.is_empty() {
            task.description = description_lines.join("\n");
        }
    }

    task
}

/// Parse priority string to TaskPriority
fn parse_priority(s: &str) -> TaskPriority {
    match s.to_lowercase().as_str() {
        "low" | "1" => TaskPriority::Low,
        "normal" | "medium" | "2" => TaskPriority::Normal,
        "high" | "3" => TaskPriority::High,
        "critical" | "urgent" | "4" => TaskPriority::Critical,
        _ => TaskPriority::Normal,
    }
}

/// Parse a simple task list format
///
/// Format:
/// ```text
/// Task 1 title
/// Task 2 title -> Task 1
/// Task 3 title -> Task 1, Task 2
/// ```
pub fn parse_simple_list(text: &str) -> Result<Vec<SwarmTask>> {
    let mut tasks = Vec::new();
    let mut task_titles: HashMap<String, TaskId> = HashMap::new();

    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let id = format!("task-{}", i + 1);
        let (title, deps) = if let Some(arrow_pos) = line.find("->") {
            let title = line[..arrow_pos].trim().to_string();
            let deps_str = &line[arrow_pos + 2..];
            let deps: Vec<TaskId> = deps_str
                .split(',')
                .map(|d| d.trim())
                .filter(|d| !d.is_empty())
                .filter_map(|d| task_titles.get(&d.to_lowercase()).cloned())
                .collect();
            (title, deps)
        } else {
            (line.to_string(), Vec::new())
        };

        task_titles.insert(title.to_lowercase(), id.clone());
        tasks.push(SwarmTask::new(&id, &title).with_dependencies(deps));
    }

    Ok(tasks)
}

/// Validate a plan for consistency
pub fn validate_plan(plan: &SwarmPlan) -> Result<()> {
    let task_ids: std::collections::HashSet<_> = plan.tasks.iter().map(|t| &t.id).collect();

    // Check for duplicate IDs
    if task_ids.len() != plan.tasks.len() {
        anyhow::bail!("Plan contains duplicate task IDs");
    }

    // Check dependencies exist
    for task in &plan.tasks {
        for dep in &task.dependencies {
            if !task_ids.contains(dep) {
                anyhow::bail!("Task '{}' depends on unknown task '{}'", task.id, dep);
            }
        }
    }

    // Check for cycles (simple DFS)
    for task in &plan.tasks {
        if has_cycle(task, &plan.tasks, &mut std::collections::HashSet::new()) {
            anyhow::bail!("Plan contains cyclic dependencies");
        }
    }

    Ok(())
}

/// Check if a task has a dependency cycle
fn has_cycle(
    task: &SwarmTask,
    all_tasks: &[SwarmTask],
    visited: &mut std::collections::HashSet<TaskId>,
) -> bool {
    if visited.contains(&task.id) {
        return true;
    }

    visited.insert(task.id.clone());

    for dep_id in &task.dependencies {
        if let Some(dep_task) = all_tasks.iter().find(|t| &t.id == dep_id) {
            if has_cycle(dep_task, all_tasks, visited) {
                return true;
            }
        }
    }

    visited.remove(&task.id);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_plan_basic() {
        let markdown = r#"
# Implementation Plan

Goal: Add user authentication

## Tasks

1. [setup] Setup project structure
   Files: src/main.rs
   Priority: high

2. [auth] Implement auth module (depends on: setup)
   Add authentication logic
   Files: src/auth.rs
"#;

        let plan = parse_plan(markdown).unwrap();
        assert_eq!(plan.title, "Implementation Plan");
        assert!(plan.goal.contains("authentication"));
        assert_eq!(plan.tasks.len(), 2);

        let setup = &plan.tasks[0];
        assert_eq!(setup.id, "setup");
        assert_eq!(setup.priority, TaskPriority::High);
        assert!(setup.files.contains(&"src/main.rs".to_string()));

        let auth = &plan.tasks[1];
        assert_eq!(auth.id, "auth");
        assert_eq!(auth.dependencies, vec!["setup"]);
    }

    #[test]
    fn test_parse_simple_list() {
        let text = r#"
Setup project
Add authentication -> Setup project
Add tests -> Setup project, Add authentication
"#;

        let tasks = parse_simple_list(text).unwrap();
        assert_eq!(tasks.len(), 3);
        assert!(tasks[0].dependencies.is_empty());
        assert_eq!(tasks[1].dependencies.len(), 1);
        assert_eq!(tasks[2].dependencies.len(), 2);
    }

    #[test]
    fn test_validate_plan_duplicate_ids() {
        let plan = SwarmPlan::new("Test").with_tasks(vec![
            SwarmTask::new("task-1", "First"),
            SwarmTask::new("task-1", "Duplicate"), // Same ID
        ]);

        assert!(validate_plan(&plan).is_err());
    }

    #[test]
    fn test_validate_plan_missing_dependency() {
        let plan = SwarmPlan::new("Test").with_tasks(vec![
            SwarmTask::new("task-1", "First").with_dependencies(vec!["nonexistent".into()])
        ]);

        assert!(validate_plan(&plan).is_err());
    }

    #[test]
    fn test_validate_plan_cycle() {
        let plan = SwarmPlan::new("Test").with_tasks(vec![
            SwarmTask::new("task-1", "First").with_dependencies(vec!["task-2".into()]),
            SwarmTask::new("task-2", "Second").with_dependencies(vec!["task-1".into()]),
        ]);

        assert!(validate_plan(&plan).is_err());
    }

    #[test]
    fn test_validate_plan_valid() {
        let plan = SwarmPlan::new("Test").with_tasks(vec![
            SwarmTask::new("task-1", "First"),
            SwarmTask::new("task-2", "Second").with_dependencies(vec!["task-1".into()]),
            SwarmTask::new("task-3", "Third")
                .with_dependencies(vec!["task-1".into(), "task-2".into()]),
        ]);

        assert!(validate_plan(&plan).is_ok());
    }

    #[test]
    fn test_parse_priority() {
        assert_eq!(parse_priority("low"), TaskPriority::Low);
        assert_eq!(parse_priority("HIGH"), TaskPriority::High);
        assert_eq!(parse_priority("critical"), TaskPriority::Critical);
        assert_eq!(parse_priority("unknown"), TaskPriority::Normal);
    }
}
