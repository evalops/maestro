//! Declarative plugin schema for managed service-connection types.
//!
//! This schema intentionally contains no executable callbacks and no secret
//! backend hooks. A plugin can describe setup UX and requested capabilities;
//! Maestro remains the sole secret custodian and policy enforcer.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::service_connections::{ConnectionAuthKind, ConnectionPlacement};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionMcpBindingDefinition {
    pub server_name: String,
    pub endpoint: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_preset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionTypeDefinition {
    pub id: String,
    pub display_name: String,
    pub provider_id: String,
    pub auth_kind: ConnectionAuthKind,
    pub placement: ConnectionPlacement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_binding: Option<ConnectionMcpBindingDefinition>,
}

impl ConnectionTypeDefinition {
    pub fn validate(&self) -> Result<()> {
        for (field, value) in [
            ("id", self.id.as_str()),
            ("displayName", self.display_name.as_str()),
            ("providerId", self.provider_id.as_str()),
        ] {
            if value.trim().is_empty() {
                bail!("connection type {field} must not be empty");
            }
        }
        if !self
            .id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            bail!("connection type id contains unsupported characters");
        }
        match self.auth_kind {
            ConnectionAuthKind::ApiKey => {
                let env_var = self
                    .env_var
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .context("API-key connection types require envVar")?;
                crate::service_connections::validate_provider_env_target(
                    &self.provider_id,
                    env_var,
                )?;
            }
            ConnectionAuthKind::Subscription
            | ConnectionAuthKind::OAuth
            | ConnectionAuthKind::WorkloadIdentity => {
                if self.env_var.is_some() {
                    bail!("delegated connection types cannot declare envVar");
                }
            }
        }
        if self.capabilities.is_empty() {
            bail!("connection types must declare at least one capability");
        }
        if let Some(env_var) = &self.env_var {
            if !env_var
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
            {
                bail!("connection type envVar must be an uppercase environment name");
            }
        }
        let mut previous: Option<&str> = None;
        let mut seen = BTreeSet::new();
        for capability in &self.capabilities {
            if capability.is_empty()
                || !capability.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/')
                })
                || previous.is_some_and(|value| value >= capability.as_str())
                || !seen.insert(capability)
            {
                bail!("connection type capabilities must be normalized, sorted, and unique");
            }
            previous = Some(capability);
        }
        if let Some(url) = &self.documentation_url {
            let parsed =
                url::Url::parse(url).context("invalid connection type documentationUrl")?;
            if parsed.scheme() != "https" {
                bail!("connection type documentationUrl must use HTTPS");
            }
        }
        if let Some(binding) = &self.mcp_binding {
            if binding.server_name.trim().is_empty()
                || !binding
                    .server_name
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            {
                bail!("connection MCP binding serverName must be alphanumeric with - or _");
            }
            let endpoint = url::Url::parse(&binding.endpoint)
                .context("invalid connection MCP binding endpoint")?;
            if endpoint.scheme() != "https"
                || endpoint.host_str().is_none()
                || endpoint.username() != ""
                || endpoint.password().is_some()
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()
            {
                bail!(
                    "connection MCP binding endpoint must be an HTTPS URL without credentials, query, or fragment"
                );
            }
            if binding.scopes.is_empty() {
                bail!("connection MCP bindings must declare at least one scope");
            }
            let mut previous: Option<&str> = None;
            let mut seen = BTreeSet::new();
            for scope in &binding.scopes {
                if scope.is_empty()
                    || !scope.chars().all(|ch| {
                        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/')
                    })
                    || previous.is_some_and(|value| value >= scope.as_str())
                    || !seen.insert(scope)
                {
                    bail!("connection MCP binding scopes must be normalized, sorted, and unique");
                }
                previous = Some(scope);
            }
            if binding.scopes.iter().any(|scope| {
                !self
                    .capabilities
                    .iter()
                    .any(|capability| capability == scope)
            }) {
                bail!(
                    "connection MCP binding scopes must be included in the connection capabilities"
                );
            }
            if let Some(auth_preset) = &binding.auth_preset {
                if auth_preset.trim().is_empty()
                    || !auth_preset
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
                {
                    bail!("connection MCP binding authPreset contains unsupported characters");
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionTypeManifest {
    pub schema_version: u32,
    pub connection_types: Vec<ConnectionTypeDefinition>,
}

impl ConnectionTypeManifest {
    pub fn load(path: &Path) -> Result<Self> {
        let manifest: Self =
            serde_json::from_slice(&fs::read(path).with_context(|| {
                format!("failed to read connection types at {}", path.display())
            })?)
            .with_context(|| format!("invalid connection types at {}", path.display()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!("unsupported connection type manifest schema version");
        }
        let mut ids = BTreeSet::new();
        for definition in &self.connection_types {
            definition.validate()?;
            if !ids.insert(&definition.id) {
                bail!("duplicate connection type id: {}", definition.id);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_connection_types_are_declarative_and_strict() {
        let manifest: ConnectionTypeManifest = serde_json::from_str(
            r#"{
              "schemaVersion": 1,
              "connectionTypes": [{
                "id": "acme-api-key",
                "displayName": "Acme API key",
                "providerId": "acme",
                "authKind": "api_key",
                "placement": "either",
                "envVar": "ACME_API_KEY",
                "capabilities": ["records.read", "records.write"]
              }]
            }"#,
        )
        .unwrap();
        manifest.validate().unwrap();
        let encoded = serde_json::to_string(&manifest).unwrap();
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn rejects_executable_or_secret_backend_fields() {
        let error = serde_json::from_str::<ConnectionTypeManifest>(
            r#"{
              "schemaVersion": 1,
              "connectionTypes": [{
                "id": "unsafe",
                "displayName": "Unsafe",
                "providerId": "unsafe",
                "authKind": "api_key",
                "placement": "local",
                "envVar": "UNSAFE_KEY",
                "secretResolver": "./steal.sh"
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_known_provider_auth_target_and_delegated_env_mismatches() {
        let mut definition = ConnectionTypeDefinition {
            id: "openai-api-key".into(),
            display_name: "OpenAI API key".into(),
            provider_id: "openai".into(),
            auth_kind: ConnectionAuthKind::ApiKey,
            placement: ConnectionPlacement::Either,
            env_var: Some("ANTHROPIC_API_KEY".into()),
            capabilities: vec!["responses.create".into()],
            documentation_url: None,
            mcp_binding: None,
        };
        assert!(
            definition
                .validate()
                .unwrap_err()
                .to_string()
                .contains("not an authentication target")
        );

        definition.provider_id = "custom-provider".into();
        definition.validate().unwrap();

        definition.auth_kind = ConnectionAuthKind::OAuth;
        assert!(
            definition
                .validate()
                .unwrap_err()
                .to_string()
                .contains("cannot declare envVar")
        );
    }

    #[test]
    fn connection_types_can_declare_a_secret_free_mcp_binding() {
        let manifest: ConnectionTypeManifest = serde_json::from_str(
            r#"{
              "schemaVersion": 1,
              "connectionTypes": [{
                "id": "orb-hosted",
                "displayName": "Hosted Computer",
                "providerId": "orb",
                "authKind": "oauth",
                "placement": "local",
                "capabilities": ["orb:threads:read", "orb:threads:write"],
                "mcpBinding": {
                  "serverName": "orb",
                  "endpoint": "https://orb.evalops.dev/mcp",
                  "scopes": ["orb:threads:read", "orb:threads:write"]
                }
              }]
            }"#,
        )
        .unwrap();

        manifest.validate().unwrap();
        let binding = manifest.connection_types[0]
            .mcp_binding
            .as_ref()
            .expect("binding");
        assert_eq!(binding.server_name, "orb");
        assert_eq!(binding.endpoint, "https://orb.evalops.dev/mcp");
        let encoded = serde_json::to_string(&manifest).unwrap();
        assert!(!encoded.contains("access_token"));
        assert!(!encoded.contains("secret"));
    }

    #[test]
    fn mcp_binding_requires_https_and_declared_capability_scopes() {
        let mut definition = ConnectionTypeDefinition {
            id: "remote-mcp".into(),
            display_name: "Remote MCP".into(),
            provider_id: "remote".into(),
            auth_kind: ConnectionAuthKind::OAuth,
            placement: ConnectionPlacement::Either,
            env_var: None,
            capabilities: vec!["records.read".into()],
            documentation_url: None,
            mcp_binding: Some(ConnectionMcpBindingDefinition {
                server_name: "records".into(),
                endpoint: "http://mcp.example.test".into(),
                scopes: vec!["records.read".into()],
                auth_preset: None,
            }),
        };
        assert!(
            definition
                .validate()
                .unwrap_err()
                .to_string()
                .contains("HTTPS")
        );

        definition.mcp_binding.as_mut().unwrap().endpoint = "https://mcp.example.test".into();
        definition.mcp_binding.as_mut().unwrap().scopes = vec!["records.write".into()];
        assert!(
            definition
                .validate()
                .unwrap_err()
                .to_string()
                .contains("included in the connection capabilities")
        );
    }
}
