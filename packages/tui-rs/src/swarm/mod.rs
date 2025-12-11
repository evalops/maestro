//! Swarm Mode - Multi-Agent Task Orchestration
//!
//! This module provides infrastructure for executing complex tasks across
//! multiple agents in parallel, with dependency management and progress tracking.
//!
//! # Overview
//!
//! Swarm mode allows breaking down large tasks into smaller subtasks that can
//! be executed concurrently by multiple agent instances. Key features:
//!
//! - **Dependency Management**: Tasks can depend on other tasks
//! - **Parallel Execution**: Multiple agents work simultaneously
//! - **Progress Tracking**: Real-time status updates and events
//! - **Error Handling**: Configurable behavior on task failures
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::swarm::{SwarmExecutor, SwarmPlan, SwarmTask, SwarmConfig};
//!
//! // Create a plan
//! let plan = SwarmPlan::new("Refactoring Plan")
//!     .with_goal("Refactor authentication module")
//!     .with_tasks(vec![
//!         SwarmTask::new("analyze", "Analyze existing code"),
//!         SwarmTask::new("design", "Design new structure")
//!             .with_dependencies(vec!["analyze".into()]),
//!         SwarmTask::new("implement", "Implement changes")
//!             .with_dependencies(vec!["design".into()]),
//!         SwarmTask::new("test", "Write tests")
//!             .with_dependencies(vec!["implement".into()]),
//!     ]);
//!
//! // Create executor
//! let executor = SwarmExecutor::new(plan, SwarmConfig::default())?;
//!
//! // Run with a task executor function
//! let result = executor.run(|task| async move {
//!     // Execute the task using an AI agent
//!     execute_with_agent(task).await
//! }).await?;
//!
//! println!("Completed {} tasks", result.completed_tasks.len());
//! ```
//!
//! # Plan Format
//!
//! Plans can be parsed from markdown using the `parse_plan` function:
//!
//! ```markdown
//! # My Plan
//!
//! Goal: Implement feature X
//!
//! ## Tasks
//!
//! 1. [setup] Setup project structure
//!    Priority: high
//!    Files: src/main.rs
//!
//! 2. [core] Implement core logic (depends on: setup)
//!    Main implementation work
//!    Complexity: 5
//!
//! 3. [tests] Add tests (depends on: core)
//! ```

mod executor;
mod plan_parser;
mod types;

pub use executor::SwarmExecutor;
pub use plan_parser::{parse_plan, parse_simple_list, validate_plan};
pub use types::{
    AgentId, SwarmConfig, SwarmEvent, SwarmPlan, SwarmState, SwarmStatus, SwarmTask, TaskId,
    TaskPriority, TaskResult, TaskStatus,
};
