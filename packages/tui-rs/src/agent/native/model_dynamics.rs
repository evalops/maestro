//! Task-scoped intelligence changes at provider request boundaries.
use super::*;

#[derive(Debug, thiserror::Error)]
#[error("provider request failed: {0:#}")]
pub(super) struct ProviderRequestFailure(pub anyhow::Error);

impl NativeAgentRunner {
    pub(super) fn preserve_explicit_intelligence_choice(&mut self) {
        self.boost_original = None;
        let mut state = self.dynamics.lock().expect("model dynamics mutex");
        state.requested = false;
        state.status = crate::model_dynamics::BoostStatus::Idle;
        let _ = self.event_tx.send(FromAgent::BoostChanged {
            status: state.status,
            thinking: None,
        });
    }

    pub(super) fn current_model_choice(&self) -> crate::model_dynamics::ModelChoice {
        crate::model_dynamics::ModelChoice {
            model: self.config.model.clone(),
            thinking: crate::model_dynamics::thinking_level(
                self.config.thinking_enabled,
                self.config.thinking_budget,
            ),
        }
    }

    /// Change only at a request boundary; preserve the complete canonical history.
    pub(super) fn apply_model_choice(
        &mut self,
        choice: &crate::model_dynamics::ModelChoice,
    ) -> Result<()> {
        if self
            .client
            .as_ref()
            .is_some_and(UnifiedClient::is_managed_gateway)
        {
            anyhow::bail!("Hosted model choices require Platform authorization");
        }
        if let Some(reason) = check_model_allowed(&policy_model_id(&choice.model)) {
            anyhow::bail!("{reason}");
        }
        if choice.model != self.config.model {
            let old = crate::model_catalog::find_model(&self.config.model)
                .context("Current model capabilities are unavailable")?;
            let new = crate::model_catalog::find_model(&choice.model)
                .context("Target model capabilities are unavailable")?;
            anyhow::ensure!(
                old.capabilities.protocol == new.capabilities.protocol
                    && new.capabilities.context_tokens >= old.capabilities.context_tokens
                    && (!old.capabilities.vision || new.capabilities.vision)
                    && (!old.capabilities.tools || new.capabilities.tools),
                "This model change needs an explicit context transition; use /model"
            );
            anyhow::ensure!(
                !self.model_route.uses_app_server(),
                "Use /model to change a Codex session model"
            );
            let provider = if policy_model_id(&self.config.model)
                .split_once('/')
                .map(|(provider, _)| provider)
                == policy_model_id(&choice.model)
                    .split_once('/')
                    .map(|(provider, _)| provider)
            {
                // Retain the already-authorized endpoint and connection profile.
                self.client
                    .as_ref()
                    .context("Direct provider client unavailable")?
                    .provider_name()
                    .to_owned()
            } else {
                let (client, provider, route, scope) = resolve_native_client(&choice.model, None)?;
                anyhow::ensure!(
                    client.as_ref().is_some_and(|c| !c.is_managed_gateway())
                        && !route.uses_app_server(),
                    "Automatic routing cannot cross inference authority"
                );
                anyhow::ensure!(
                    scope.is_some()
                        && scope
                            == *self
                                .telemetry_identity_scope
                                .read()
                                .expect("telemetry identity scope lock"),
                    "Automatic routing cannot change the active organization or workspace"
                );
                self.client = client;
                self.model_route = route;
                *self
                    .telemetry_identity_scope
                    .write()
                    .expect("telemetry identity scope lock") = scope;
                provider
            };
            refresh_model_budgets(&mut self.config, &mut self.compactor, &choice.model);
            self.config.model.clone_from(&choice.model);
            self.model_tool_cache = None;
            self.hooks.set_model(&choice.model);
            let _ = self.event_tx.send(FromAgent::ModelChanged {
                model: choice.model.clone(),
                provider,
            });
        }
        let thinking = crate::model_dynamics::normalize_thinking(&choice.model, choice.thinking);
        let (enabled, budget) = thinking.to_config();
        self.config.thinking_enabled = enabled;
        self.config.thinking_budget = budget;
        Ok(())
    }

    pub(super) fn apply_requested_boost(&mut self) -> Result<()> {
        let preferences = self.config.model_dynamics.clone();
        let choice =
            crate::model_dynamics::boost_choice(&self.current_model_choice(), &preferences);
        let available = choice
            .as_ref()
            .is_some_and(|choice| check_model_allowed(&policy_model_id(&choice.model)).is_none())
            && !self
                .client
                .as_ref()
                .is_some_and(UnifiedClient::is_managed_gateway);
        self.dynamics
            .lock()
            .expect("model dynamics mutex")
            .available = available;
        let requested = {
            let mut state = self.dynamics.lock().expect("model dynamics mutex");
            let request = !state.used
                && (state.requested
                    || (preferences.auto_boost
                        && state.status == crate::model_dynamics::BoostStatus::Suggested));
            state.requested = false;
            if request {
                state.used = true;
            }
            request
        };
        if !requested {
            return Ok(());
        }
        let original = self.current_model_choice();
        let result = crate::model_dynamics::boost_choice(&original, &preferences)
            .context("No higher supported setting is configured")
            .and_then(|choice| {
                if choice.model != original.model {
                    let old = crate::model_catalog::find_model(&original.model)
                        .context("Current model capabilities are unavailable")?;
                    let new = crate::model_catalog::find_model(&choice.model)
                        .context("Boost model capabilities are unavailable")?;
                    anyhow::ensure!(
                        old.capabilities.context_tokens == new.capabilities.context_tokens
                            && old.capabilities.vision == new.capabilities.vision
                            && old.capabilities.tools == new.capabilities.tools,
                        "A temporary boost needs matching context and tool capabilities; use /model"
                    );
                }
                self.apply_model_choice(&choice)?;
                self.boost_original = Some(original);
                Ok(self.current_model_choice().thinking)
            });
        let (status, thinking) = match result {
            Ok(_) if self.model_route.uses_app_server() => {
                (crate::model_dynamics::BoostStatus::Pending, None)
            }
            Ok(thinking) => (crate::model_dynamics::BoostStatus::Active, Some(thinking)),
            Err(error) => {
                let _ = self.event_tx.send(FromAgent::Status {
                    message: format!("Boost unavailable: {error}"),
                });
                (crate::model_dynamics::BoostStatus::Idle, None)
            }
        };
        self.dynamics.lock().expect("model dynamics mutex").status = status;
        let _ = self
            .event_tx
            .send(FromAgent::BoostChanged { status, thinking });
        Ok(())
    }

    pub(super) async fn validate_codex_boost(&mut self) {
        let Some(original) = self.boost_original.clone() else {
            return;
        };
        if self.dynamics.lock().expect("model dynamics mutex").status
            != crate::model_dynamics::BoostStatus::Pending
        {
            return;
        }
        let Some(session) = self.codex_session.as_ref() else {
            return;
        };
        let result = session
            .is_reasoning_boost(
                original.thinking.to_config(),
                (self.config.thinking_enabled, self.config.thinking_budget),
            )
            .await;
        let (status, thinking) = if matches!(result, Ok(true)) {
            (
                crate::model_dynamics::BoostStatus::Active,
                self.current_model_choice().thinking,
            )
        } else {
            let reason = result.err().map_or_else(
                || "The current setting already uses the highest supported effort".to_owned(),
                |error| error.to_string(),
            );
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!("Boost unavailable: {reason}"),
            });
            // Codex boost keeps the same model; restore effort directly without changing authority.
            let (enabled, budget) = original.thinking.to_config();
            self.config.thinking_enabled = enabled;
            self.config.thinking_budget = budget;
            self.boost_original = None;
            (crate::model_dynamics::BoostStatus::Idle, original.thinking)
        };
        self.dynamics.lock().expect("model dynamics mutex").status = status;
        let _ = self.event_tx.send(FromAgent::BoostChanged {
            status,
            thinking: Some(thinking),
        });
    }

    pub(super) fn finish_task_boost(&mut self, cancelled: bool) {
        let thinking = self.boost_original.clone().map(|original| {
            if let Err(error) = self.apply_model_choice(&original) {
                // Restoration must not change the inference authority to evade policy.
                let _ = self.event_tx.send(FromAgent::Status {
                    message: format!("Could not restore the previous model: {error}"),
                });
                self.current_model_choice().thinking
            } else {
                original.thinking
            }
        });
        self.boost_original = None;
        let status = {
            let mut state = self.dynamics.lock().expect("model dynamics mutex");
            let pending = !cancelled && state.requested && !state.used;
            *state = Default::default();
            if pending {
                state.requested = true;
                state.status = crate::model_dynamics::BoostStatus::Pending;
            }
            state.status
        };
        let _ = self
            .event_tx
            .send(FromAgent::BoostChanged { status, thinking });
    }

    pub(super) async fn run_with_model_recovery(
        &mut self,
        step_budget: &mut TurnStepBudget,
    ) -> Result<()> {
        let preferences = self.config.model_dynamics.clone();
        self.dynamics
            .lock()
            .expect("model dynamics mutex")
            .fallback_models
            .insert(self.config.model.clone());
        let mut remaining = preferences.fallbacks.into_iter();
        loop {
            self.apply_requested_boost()?;
            // Keep the large tool-loop future off the recovery wrapper's stack.
            let result = Box::pin(self.run_loop_inner(step_budget)).await;
            let eligible = result.as_ref().err().is_some_and(|error| {
                (error.is::<ProviderRequestFailure>() || error.is::<ProviderStreamFailure>())
                    && matches!(
                        super::super::retry::ErrorKind::classify(&format!("{error:#}")),
                        super::super::retry::ErrorKind::Transient
                            | super::super::retry::ErrorKind::RateLimited { .. }
                    )
            });
            if !eligible
                || self.model_route.uses_app_server()
                || self
                    .client
                    .as_ref()
                    .is_some_and(UnifiedClient::is_managed_gateway)
                || self
                    .cancel_token
                    .as_ref()
                    .is_some_and(CancellationToken::is_cancelled)
                || self.shutdown_token.is_cancelled()
            {
                return result;
            }
            let choice = {
                let mut state = self.dynamics.lock().expect("model dynamics mutex");
                state.fallback_models.insert(self.config.model.clone());
                if state.fallback_attempts >= 3 {
                    return result;
                }
                let choice =
                    remaining.find(|choice| state.fallback_models.insert(choice.model.clone()));
                if choice.is_some() {
                    state.fallback_attempts += 1;
                }
                choice
            };
            let Some(choice) = choice else {
                return result;
            };
            if let Err(error) = self.apply_model_choice(&choice) {
                let _ = self.event_tx.send(FromAgent::Status {
                    message: format!("Model fallback unavailable: {error}"),
                });
                return result;
            }
            self.boost_original = None;
            self.dynamics.lock().expect("model dynamics mutex").status =
                crate::model_dynamics::BoostStatus::Idle;
            let _ = self.event_tx.send(FromAgent::BoostChanged {
                status: crate::model_dynamics::BoostStatus::Idle,
                thinking: Some(self.current_model_choice().thinking),
            });
            let _ = self.event_tx.send(FromAgent::Status {
                message: format!("Continuing with {}", choice.model),
            });
            // Completed tool calls remain in self.messages; only the failed generation is retried.
            self.repair_orphaned_tool_calls();
        }
    }
}
