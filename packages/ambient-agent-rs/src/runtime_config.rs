//! Effective runtime configuration for a single event.
//!
//! Repository-level config overrides daemon defaults for thresholds and
//! capabilities, while daemon limits remain hard ceilings. Keeping that
//! resolution in one place prevents decider, daemon, and future Platform-backed
//! controls from drifting apart.

use crate::policy::PolicyGateConfig;
use crate::types::{AmbientConfig, Capabilities, Limits, NormalizedEvent, Thresholds};

#[derive(Debug, Clone)]
pub struct EffectiveRuntimeConfig<'a> {
    pub thresholds: &'a Thresholds,
    pub limits: Limits,
    pub capabilities: &'a Capabilities,
}

impl<'a> EffectiveRuntimeConfig<'a> {
    pub fn from_ambient(defaults: &'a AmbientConfig, event: &'a NormalizedEvent) -> Self {
        Self::from_parts(
            &defaults.thresholds,
            &defaults.limits,
            &defaults.capabilities,
            event,
        )
    }

    pub fn from_parts(
        default_thresholds: &'a Thresholds,
        default_limits: &'a Limits,
        default_capabilities: &'a Capabilities,
        event: &'a NormalizedEvent,
    ) -> Self {
        let repo_config = event.repo.config.as_ref();
        let limits = repo_config
            .map(|config| effective_limits(default_limits, &config.limits))
            .unwrap_or_else(|| default_limits.clone());

        Self {
            thresholds: repo_config
                .map(|config| &config.thresholds)
                .unwrap_or(default_thresholds),
            limits,
            capabilities: repo_config
                .map(|config| &config.capabilities)
                .unwrap_or(default_capabilities),
        }
    }

    pub fn policy_gate_config(&self) -> PolicyGateConfig {
        PolicyGateConfig {
            limits: self.limits.clone(),
            capabilities: (*self.capabilities).clone(),
        }
    }
}

fn effective_limits(daemon: &Limits, repo: &Limits) -> Limits {
    Limits {
        max_prs_per_day: daemon.max_prs_per_day.min(repo.max_prs_per_day),
        max_complexity: daemon.max_complexity.min(repo.max_complexity),
        max_files_changed: daemon.max_files_changed.min(repo.max_files_changed),
        max_cost_per_task_usd: daemon.max_cost_per_task_usd.min(repo.max_cost_per_task_usd),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    use chrono::Utc;
    use std::collections::HashMap;

    fn ambient_config() -> AmbientConfig {
        AmbientConfig {
            enabled: true,
            auto_triggers: vec![],
            thresholds: Thresholds {
                auto_execute: 0.8,
                ask_human: 0.5,
                skip: 0.0,
            },
            limits: Limits::default(),
            capabilities: Capabilities::default(),
            schedule: ScheduleConfig::default(),
            notify: NotifyConfig::default(),
            learning: LearningConfig::default(),
        }
    }

    fn event_with_repo_config(repo_config: Option<AmbientConfig>) -> NormalizedEvent {
        let repo = Repository {
            owner: "evalops".to_string(),
            name: "maestro".to_string(),
            full_name: "evalops/maestro".to_string(),
            default_branch: "main".to_string(),
            path: "/tmp/maestro".to_string(),
            url: "https://github.com/evalops/maestro".to_string(),
            config: repo_config,
            agent_md: Some("instructions".to_string()),
            test_coverage: Some(80.0),
            codeowners: vec!["@evalops/runtime".to_string()],
        };

        NormalizedEvent {
            id: "evt_runtime_config".to_string(),
            source: WatcherType::GitHubPoll,
            event_type: EventType::Issue,
            repo: repo.clone(),
            repository: repo.full_name.clone(),
            priority: 50,
            title: "Fix hosted runtime".to_string(),
            body: Some("Fix a small bug.".to_string()),
            labels: vec![],
            context: EventContext {
                repo,
                history: vec![],
                related: vec![],
            },
            payload: EventPayload {
                title: Some("Fix hosted runtime".to_string()),
                body: Some("Fix a small bug.".to_string()),
                number: Some(1),
                labels: vec![],
                author: Some("octocat".to_string()),
                url: Some("https://github.com/evalops/maestro/issues/1".to_string()),
                extra: HashMap::new(),
            },
            created_at: Utc::now(),
            processed_at: None,
            status: EventStatus::Pending,
            flags: EventFlags::default(),
        }
    }

    #[test]
    fn uses_daemon_defaults_when_repo_has_no_config() {
        let defaults = ambient_config();
        let event = event_with_repo_config(None);

        let effective = EffectiveRuntimeConfig::from_ambient(&defaults, &event);

        assert_eq!(effective.thresholds.auto_execute, 0.8);
        assert_eq!(effective.limits.max_cost_per_task_usd, 5.0);
        assert!(effective.capabilities.fix_bugs);
    }

    #[test]
    fn repo_config_overrides_thresholds_and_capabilities_but_tightens_limits() {
        let defaults = ambient_config();
        let mut repo_config = ambient_config();
        repo_config.thresholds.auto_execute = 0.95;
        repo_config.limits.max_cost_per_task_usd = 0.25;
        repo_config.limits.max_files_changed = 10;
        repo_config.limits.max_complexity = Complexity::Simple;
        repo_config.capabilities.fix_bugs = false;
        let event = event_with_repo_config(Some(repo_config));

        let effective = EffectiveRuntimeConfig::from_ambient(&defaults, &event);
        let policy = effective.policy_gate_config();

        assert_eq!(effective.thresholds.auto_execute, 0.95);
        assert_eq!(effective.limits.max_cost_per_task_usd, 0.25);
        assert_eq!(effective.limits.max_files_changed, 10);
        assert_eq!(effective.limits.max_complexity, Complexity::Simple);
        assert!(!effective.capabilities.fix_bugs);
        assert_eq!(policy.limits.max_cost_per_task_usd, 0.25);
        assert!(!policy.capabilities.fix_bugs);
    }

    #[test]
    fn repo_config_cannot_raise_daemon_limit_ceilings() {
        let mut defaults = ambient_config();
        defaults.limits.max_cost_per_task_usd = 0.25;
        defaults.limits.max_files_changed = 5;
        defaults.limits.max_complexity = Complexity::Medium;

        let mut repo_config = ambient_config();
        repo_config.limits.max_cost_per_task_usd = 999999.0;
        repo_config.limits.max_files_changed = 1000;
        repo_config.limits.max_complexity = Complexity::High;
        let event = event_with_repo_config(Some(repo_config));

        let effective = EffectiveRuntimeConfig::from_ambient(&defaults, &event);

        assert_eq!(effective.limits.max_cost_per_task_usd, 0.25);
        assert_eq!(effective.limits.max_files_changed, 5);
        assert_eq!(effective.limits.max_complexity, Complexity::Medium);
    }
}
