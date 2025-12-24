//! Enterprise policy enforcement (minimal parity with TS).
//!
//! Reads ~/.composer/policy.json and enforces tool/path restrictions.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Clone)]
pub struct PolicyList {
    pub allowed: Option<Vec<String>>,
    pub blocked: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct NetworkPolicy {
    pub allowed_hosts: Option<Vec<String>>,
    pub blocked_hosts: Option<Vec<String>>,
    pub block_localhost: Option<bool>,
    pub block_private_ips: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EnterprisePolicy {
    pub tools: Option<PolicyList>,
    pub paths: Option<PolicyList>,
    pub network: Option<NetworkPolicy>,
}

static POLICY: Lazy<Option<EnterprisePolicy>> = Lazy::new(load_policy_file);

fn load_policy_file() -> Option<EnterprisePolicy> {
    let home = dirs::home_dir()?;
    let path = home.join(".composer").join("policy.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<EnterprisePolicy>(&content).ok()
}

fn matches_pattern_list(value: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        glob::Pattern::new(pattern)
            .map(|p| p.matches(value))
            .unwrap_or(false)
    })
}

pub fn check_tool_allowed(tool_name: &str) -> Option<String> {
    let policy = POLICY.as_ref()?;
    let tools = policy.tools.as_ref()?;

    if let Some(blocked) = &tools.blocked {
        if matches_pattern_list(tool_name, blocked) {
            return Some(format!(
                "Tool '{}' is blocked by enterprise policy",
                tool_name
            ));
        }
    }

    if let Some(allowed) = &tools.allowed {
        if !matches_pattern_list(tool_name, allowed) {
            return Some(format!(
                "Tool '{}' is not in the enterprise allowlist",
                tool_name
            ));
        }
    }

    None
}

pub fn check_path_allowed(path: &Path) -> Option<String> {
    let policy = POLICY.as_ref()?;
    let paths = policy.paths.as_ref()?;

    let path_str = path.to_string_lossy();

    if let Some(blocked) = &paths.blocked {
        if matches_pattern_list(&path_str, blocked) {
            return Some(format!(
                "Path '{}' is blocked by enterprise policy",
                path_str
            ));
        }
    }

    if let Some(allowed) = &paths.allowed {
        if !matches_pattern_list(&path_str, allowed) {
            return Some(format!(
                "Path '{}' is not in the enterprise allowlist",
                path_str
            ));
        }
    }

    None
}

#[allow(dead_code)]
pub fn policy_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".composer").join("policy.json"))
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 127)
                || (octets[0] == 169 && octets[1] == 254)
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local(),
    }
}

pub fn check_url_allowed(url: &str) -> Option<String> {
    let policy = POLICY.as_ref()?;
    let network = policy.network.as_ref()?;
    let trimmed = url.trim();
    let parsed = match reqwest::Url::parse(trimmed) {
        Ok(u) => u,
        Err(_) => return None,
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => return None,
    };

    if network.block_localhost.unwrap_or(false)
        && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    {
        return Some("Localhost access blocked by enterprise policy".to_string());
    }
    if network.block_private_ips.unwrap_or(false) {
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_private_ip(&ip) {
                return Some("Private IP access blocked by enterprise policy".to_string());
            }
        }
    }

    if let Some(blocked) = &network.blocked_hosts {
        if matches_pattern_list(&host, blocked) {
            return Some(format!("Host '{}' is blocked by enterprise policy", host));
        }
    }
    if let Some(allowed) = &network.allowed_hosts {
        if !matches_pattern_list(&host, allowed) {
            return Some(format!(
                "Host '{}' is not in the enterprise allowlist",
                host
            ));
        }
    }

    None
}
