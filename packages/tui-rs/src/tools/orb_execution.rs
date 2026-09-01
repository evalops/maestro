//! Boundary for Maestro code that runs inside a hosted Computer.
//!
//! This is deliberately separate from [`super::orb_delegation`].  The latter
//! controls a durable Computer task from Maestro; this module describes the
//! secret-free context an agent receives when Computer itself provisions
//! hosted MCP tools for that task. Computer owns the personal/workspace registry,
//! endpoint selection, authentication, and project-authoritative merge.  No
//! local invocation config, URL, header, environment value, or credential is
//! accepted here.

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

/// The already-authorized hosted MCP context available to an agent running
/// inside Computer. `include_tools` is a high-level filter; the server remains
/// authoritative for the configured servers and credentials.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct HostedOrbMcpContext {
    #[serde(default)]
    pub include_tools: Vec<String>,
    #[serde(default)]
    pub authority: HostedOrbMcpAuthority,
}

/// Where Computer resolved the hosted MCP context. This intentionally has no
/// credential-bearing or endpoint-bearing variants.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HostedOrbMcpAuthority {
    #[default]
    ManagedWorkspace,
}

/// Provider seam for a future Computer agent adapter.
///
/// Implementations belong to the owner of Computer's hosted MCP registry. Maestro
/// task control must not call this provider, and model-visible tools must not
/// be able to construct or sequence it.
#[allow(dead_code)]
pub(crate) trait HostedOrbMcpContextProvider: Send + Sync {
    fn context_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<HostedOrbMcpContext>, String>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_is_secret_free_and_supports_tool_filtering() {
        let context = HostedOrbMcpContext {
            include_tools: vec!["calendar.search".to_string()],
            authority: HostedOrbMcpAuthority::ManagedWorkspace,
        };
        let encoded = serde_json::to_string(&context).unwrap();
        assert!(encoded.contains("calendar.search"));
        assert!(!encoded.contains("url"));
        assert!(!encoded.contains("header"));
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("env"));
    }
}
