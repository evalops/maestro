//! Ambient Agent
//!
//! An always-on GitHub agent that watches repositories, identifies work,
//! and ships code autonomously via PRs.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────────────┐
//! │                            AMBIENT DAEMON                                     │
//! ├─────────────────────────────────────────────────────────────────────────────┤
//! │                                                                               │
//! │  WATCHERS ──▶ EVENT BUS ──▶ DECIDER ──▶ CASCADER ──▶ EXECUTOR ──▶ CRITIC   │
//! │                                │                           │         │       │
//! │                                │                           ▼         ▼       │
//! │                                │                      CHECKPOINT    PR       │
//! │                                │                                    │        │
//! │                                └──────────────────────────────┐     │        │
//! │                                                               ▼     ▼        │
//! │                                                            LEARNER           │
//! │                                                               │              │
//! │                                                               ▼              │
//! │                                                           RETRAINER          │
//! └─────────────────────────────────────────────────────────────────────────────┘
//!
//! Flow: WATCH → FILTER → DECIDE → PLAN → ROUTE → EXECUTE → CRITIQUE → PR → LEARN
//! ```
//!
//! # Core Philosophy
//!
//! 1. **PRs are the permission layer** - Agent can do anything, but nothing lands without human review
//! 2. **Confidence-gated autonomy** - High confidence → act; low confidence → ask
//! 3. **Learn from outcomes** - Merged PRs reinforce patterns; rejected PRs update priors
//! 4. **Swarm for complexity** - Simple tasks = single agent; complex = spawn teammates

pub mod cascader;
pub mod checkpoint;
pub mod critic;
pub mod daemon;
pub mod decider;
pub mod event_bus;
mod execution_report;
pub mod executor;
pub mod file_permission;
pub mod github_watcher;
pub mod ipc;
pub mod learner;
pub mod platform_event_bus;
pub mod policy;
pub mod pr_creator;
pub mod prompt;
pub mod runtime_config;
mod task_run;
mod text;
pub mod types;

pub use cascader::Cascader;
pub use checkpoint::CheckpointManager;
pub use critic::Critic;
pub use daemon::AmbientDaemon;
pub use decider::Decider;
pub use event_bus::EventBus;
pub use executor::Executor;
pub use file_permission::{
    FilePermissionDecision, FilePermissionEvaluation, FilePermissionPolicy,
    FilePermissionPolicyError, FilePermissionRule,
};
pub use github_watcher::GitHubWatcher;
pub use learner::Learner;
pub use policy::{PolicyGate, PolicyGateConfig, PolicyGateResult};
pub use pr_creator::PrCreator;
pub use prompt::{PromptBuilder, PromptBundle, PromptFileContext};
pub use runtime_config::EffectiveRuntimeConfig;
pub use types::*;

/// Prelude for convenient imports
pub mod prelude {
    pub use crate::cascader::Cascader;
    pub use crate::checkpoint::CheckpointManager;
    pub use crate::critic::Critic;
    pub use crate::daemon::AmbientDaemon;
    pub use crate::decider::Decider;
    pub use crate::event_bus::EventBus;
    pub use crate::executor::Executor;
    pub use crate::file_permission::{
        FilePermissionDecision, FilePermissionEvaluation, FilePermissionPolicy,
        FilePermissionPolicyError, FilePermissionRule,
    };
    pub use crate::github_watcher::{GitHubWatcher, GitHubWatcherConfig};
    pub use crate::learner::Learner;
    pub use crate::policy::{PolicyGate, PolicyGateConfig, PolicyGateResult};
    pub use crate::pr_creator::{PrCreator, PrCreatorConfig};
    pub use crate::prompt::{PromptBuilder, PromptBundle, PromptFileContext};
    pub use crate::runtime_config::EffectiveRuntimeConfig;
    pub use crate::types::*;
}
