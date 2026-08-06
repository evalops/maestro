//! Distinct identifiers for conversation sessions vs subagent parent scopes.
//!
//! The TUI routes child lifecycle events with keys like `session:<uuid>` or
//! `pending:<uuid>`. Hook payloads use the bare session uuid so they correlate
//! with every other hook in that conversation. Keeping both shapes as typed
//! values prevents stamping a routing key into `sessionId` again.

use serde::{Deserialize, Serialize};

macro_rules! opaque_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            #[must_use]
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            #[must_use]
            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl From<String> for $name {
            fn from(id: String) -> Self {
                Self(id)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

opaque_id!(RunnerSessionId, "Runner transport session identifier.");
opaque_id!(MaestroThreadId, "Maestro conversation thread identifier.");
opaque_id!(WorkItemId, "Platform work item identifier.");
opaque_id!(AgentId, "Agent runtime identifier.");
opaque_id!(ToolExecutionId, "Single tool execution identifier.");

/// Bare conversation id as stamped onto hook payloads and session records.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for SessionId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// Routing key for a parent that owns subagent children.
///
/// Always carries a prefix (`session:` or `pending:`). Use
/// [`ParentScopeId::hook_session_id`] when stamping hook payloads.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParentScopeId(String);

impl ParentScopeId {
    #[must_use]
    pub fn for_session(session_id: &SessionId) -> Self {
        Self(format!("session:{}", session_id.as_str()))
    }

    #[must_use]
    pub fn for_session_str(session_id: &str) -> Self {
        Self(format!("session:{session_id}"))
    }

    #[must_use]
    pub fn pending() -> Self {
        Self(format!("pending:{}", uuid::Uuid::new_v4()))
    }

    #[must_use]
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }

    /// Bare session id for hook `sessionId` fields.
    ///
    /// Strips a leading `session:` when present. `pending:` scopes are left
    /// intact so a pre-session parent still has a stable correlator.
    #[must_use]
    pub fn hook_session_id(&self) -> SessionId {
        SessionId(
            self.0
                .strip_prefix("session:")
                .unwrap_or(self.0.as_str())
                .to_string(),
        )
    }
}

impl std::fmt::Display for ParentScopeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for ParentScopeId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// Build the parent scope for a session id option (matches historical
/// `subagent_scope_for_session` behavior).
#[must_use]
pub fn parent_scope_for_session(session_id: Option<&str>) -> ParentScopeId {
    match session_id {
        Some(session_id) => ParentScopeId::for_session_str(session_id),
        None => ParentScopeId::pending(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_scope_strips_for_hooks() {
        let scope = ParentScopeId::for_session_str("abc-123");
        assert_eq!(scope.as_str(), "session:abc-123");
        assert_eq!(scope.hook_session_id().as_str(), "abc-123");
    }

    #[test]
    fn pending_scope_is_left_intact_for_hooks() {
        let scope = ParentScopeId::from_raw("pending:xyz");
        assert_eq!(scope.hook_session_id().as_str(), "pending:xyz");
    }
}
