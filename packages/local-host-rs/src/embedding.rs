//! Supported local embedding API for the native Maestro actor.
//!
//! [`EmbeddedAgentBuilder`] composes the existing local host, native actor,
//! provider resolution, and event relay. It does not create a second runtime
//! or accept Platform authority. Hosted callers continue to use their
//! Platform-owned admission and execution paths.

use std::path::Path;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::agent::{
    ExecutionSource, FromAgent, MaxTokensSource, NativeAgent, NativeAgentConfig, ToolDefinition,
    ToolResponseMessage, ToolResult,
};

/// The single event receiver returned by a started embedding.
pub type EmbeddedAgentEvents = mpsc::UnboundedReceiver<FromAgent>;

/// Builder for one local native-agent session.
///
/// The builder keeps the local host's defaults, including selective approval.
/// Tools supplied through [`Self::external_tools`] are caller-owned: receive
/// their [`FromAgent::ToolCall`] event and return a result with
/// [`EmbeddedAgent::send_tool_response`].
pub struct EmbeddedAgentBuilder {
    config: NativeAgentConfig,
    external_tools: Vec<ToolDefinition>,
}

impl EmbeddedAgentBuilder {
    /// Start a builder for an explicitly selected model.
    #[must_use]
    pub fn new(model: impl Into<String>) -> Self {
        let model = model.into();
        let config = NativeAgentConfig {
            max_tokens: crate::model_catalog::default_max_output_tokens(&model),
            model,
            ..NativeAgentConfig::default()
        };
        Self {
            config,
            external_tools: Vec::new(),
        }
    }

    /// Start a builder from an existing local-host configuration.
    ///
    /// This preserves every configured limit and policy field. It is useful
    /// for callers that already construct `NativeAgentConfig` values.
    #[must_use]
    pub fn from_config(config: NativeAgentConfig) -> Self {
        Self {
            config,
            external_tools: Vec::new(),
        }
    }

    /// Set the per-request output-token limit for the selected model.
    #[must_use]
    pub fn max_output_tokens(mut self, max_tokens: u32) -> Self {
        self.config.max_tokens = max_tokens;
        self.config.max_tokens_source = MaxTokensSource::Explicit;
        self
    }

    /// Set the local workspace used by the existing host's tools, hooks, and
    /// session integration.
    #[must_use]
    pub fn working_directory(mut self, path: impl AsRef<Path>) -> Self {
        self.config.cwd = path.as_ref().to_string_lossy().into_owned();
        self
    }

    /// Set the base instructions for the session.
    #[must_use]
    pub fn system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.config.system_prompt = Some(prompt.into());
        self
    }

    /// Enable or disable model thinking for this session.
    #[must_use]
    pub fn thinking(mut self, enabled: bool) -> Self {
        self.config.thinking_enabled = enabled;
        self
    }

    /// Set the model thinking-token budget for this session.
    #[must_use]
    pub fn thinking_budget(mut self, budget: u32) -> Self {
        self.config.thinking_budget = budget;
        self
    }

    /// Add tools whose execution and results are owned by the embedding
    /// caller.
    ///
    /// When a caller-owned tool reaches the native approval boundary, the
    /// loop emits a `ToolCall` and waits for the caller to approve, deny, or
    /// supply a result. This method does not register a local executable or
    /// grant Platform authority.
    #[must_use]
    pub fn external_tools(mut self, tools: impl IntoIterator<Item = ToolDefinition>) -> Self {
        self.external_tools.extend(tools);
        self
    }

    /// Compose the local host and start its native actor.
    pub fn start(self) -> Result<EmbeddedAgentSession> {
        self.validate()?;
        let (agent, events) = NativeAgent::new_with_tools(self.config, self.external_tools)?;
        Ok(EmbeddedAgentSession {
            agent: EmbeddedAgent { inner: agent },
            events,
        })
    }

    fn validate(&self) -> Result<()> {
        if self.config.model.trim().is_empty() {
            anyhow::bail!("an embedded agent requires a model identifier");
        }
        if self.config.cwd.trim().is_empty() {
            anyhow::bail!("an embedded agent requires a working directory");
        }
        Ok(())
    }

    #[cfg(feature = "test-support")]
    fn start_with_test_client(
        self,
        client: crate::ai::UnifiedClient,
    ) -> Result<EmbeddedAgentSession> {
        self.validate()?;
        let (agent, events) =
            NativeAgent::new_with_tools_and_test_client(self.config, self.external_tools, client)?;
        Ok(EmbeddedAgentSession {
            agent: EmbeddedAgent { inner: agent },
            events,
        })
    }
}

/// A started local embedding and its single event receiver.
///
/// Call [`Self::shutdown`] when the embedding stops. It cancels active and
/// queued work, then waits for the native actor to finish cleanup.
pub struct EmbeddedAgentSession {
    agent: EmbeddedAgent,
    events: EmbeddedAgentEvents,
}

impl EmbeddedAgentSession {
    /// Access the command and tool-response side of the embedding.
    #[must_use]
    pub fn agent(&self) -> &EmbeddedAgent {
        &self.agent
    }

    /// Receive the native actor's event stream.
    pub fn events(&mut self) -> &mut EmbeddedAgentEvents {
        &mut self.events
    }

    /// Split the command handle from the event receiver.
    ///
    /// The caller that receives the handle must call
    /// [`EmbeddedAgent::shutdown`] after event processing finishes.
    #[must_use]
    pub fn into_parts(self) -> (EmbeddedAgent, EmbeddedAgentEvents) {
        (self.agent, self.events)
    }

    /// Cancel active work and wait for the actor's cleanup barrier.
    pub async fn shutdown(self) {
        self.agent.shutdown().await;
    }
}

/// Command handle for a started local embedding.
pub struct EmbeddedAgent {
    inner: NativeAgent,
}

impl EmbeddedAgent {
    /// Queue a prompt with no attachments.
    pub async fn prompt(&self, content: impl Into<String>) -> Result<()> {
        self.inner.prompt(content.into(), Vec::new()).await
    }

    /// Queue a prompt with caller-selected attachment paths.
    pub async fn prompt_with_attachments(
        &self,
        content: impl Into<String>,
        attachments: Vec<String>,
    ) -> Result<()> {
        self.inner.prompt(content.into(), attachments).await
    }

    /// Associate subsequent host hooks with a caller-owned session.
    ///
    /// The embedding does not take ownership of persisted tool spill cleanup.
    pub fn set_session_context(
        &self,
        session_id: Option<String>,
        reason: impl Into<String>,
    ) -> Result<()> {
        self.inner.set_session_context(session_id, reason, false)
    }

    /// Cancel the active prompt and any queued prompts.
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    /// Send one caller-owned tool decision or result to the native loop.
    pub fn send_tool_response(&self, response: EmbeddedToolResponse) -> Result<()> {
        let (call_id, approved, result, source) = response.into_parts();
        self.inner
            .tool_response_sender()
            .send((call_id, approved, result, source, None))
            .map_err(|_| anyhow::anyhow!("embedded agent has stopped accepting tool responses"))
    }

    /// Obtain the underlying response channel for an existing caller-owned
    /// approval registry.
    #[must_use]
    pub fn tool_response_sender(&self) -> mpsc::UnboundedSender<ToolResponseMessage> {
        self.inner.tool_response_sender()
    }

    /// Cancel active work and wait for the native actor's cleanup barrier.
    pub async fn shutdown(self) {
        self.inner.shutdown().await;
    }
}

/// A response to one [`FromAgent::ToolCall`] emitted for an embedding-owned
/// tool.
pub struct EmbeddedToolResponse {
    call_id: String,
    approved: bool,
    result: Option<ToolResult>,
    source: ExecutionSource,
}

impl EmbeddedToolResponse {
    /// Return a result supplied by the embedding caller.
    #[must_use]
    pub fn external_result(call_id: impl Into<String>, result: ToolResult) -> Self {
        Self {
            call_id: call_id.into(),
            approved: true,
            result: Some(result),
            source: ExecutionSource::RemoteClient,
        }
    }

    /// Deny an embedding-owned tool call without executing it.
    #[must_use]
    pub fn deny(call_id: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            approved: false,
            result: None,
            source: ExecutionSource::RemoteClient,
        }
    }

    fn into_parts(self) -> (String, bool, Option<ToolResult>, ExecutionSource) {
        (self.call_id, self.approved, self.result, self.source)
    }
}

/// Deterministic embedding construction for developer tests and examples.
#[cfg(feature = "test-support")]
pub mod test_kit {
    use std::path::Path;

    use anyhow::Result;

    use super::{EmbeddedAgentBuilder, EmbeddedAgentSession};
    use crate::agent::ToolDefinition;
    use crate::ai::{ScriptedClient, ScriptedResponse, UnifiedClient};

    const SCRIPTED_MODEL: &str = "scripted-replay/maestro-replay-v1";

    /// Builder backed by the deterministic scripted provider.
    pub struct ScriptedEmbeddingBuilder {
        builder: EmbeddedAgentBuilder,
        responses: Vec<ScriptedResponse>,
    }

    impl ScriptedEmbeddingBuilder {
        /// Start a scripted embedding with responses consumed in order.
        #[must_use]
        pub fn new(responses: Vec<ScriptedResponse>) -> Self {
            Self {
                builder: EmbeddedAgentBuilder::new(SCRIPTED_MODEL),
                responses,
            }
        }

        /// Set the local workspace used by the existing host composition.
        #[must_use]
        pub fn working_directory(mut self, path: impl AsRef<Path>) -> Self {
            self.builder = self.builder.working_directory(path);
            self
        }

        /// Set the base instructions for the scripted session.
        #[must_use]
        pub fn system_prompt(mut self, prompt: impl Into<String>) -> Self {
            self.builder = self.builder.system_prompt(prompt);
            self
        }

        /// Add caller-owned tools to the scripted session.
        #[must_use]
        pub fn external_tools(mut self, tools: impl IntoIterator<Item = ToolDefinition>) -> Self {
            self.builder = self.builder.external_tools(tools);
            self
        }

        /// Compose the local host with a scripted provider.
        pub fn start(self) -> Result<EmbeddedAgentSession> {
            let model = self.builder.config.model.clone();
            let client = UnifiedClient::Scripted(ScriptedClient::new(model, self.responses));
            self.builder.start_with_test_client(client)
        }
    }
}
