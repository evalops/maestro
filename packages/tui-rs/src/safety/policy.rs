//! Enterprise policy enforcement (minimal parity with TS).
//!
//! Reads ~/.composer/policy.json and enforces tool/path restrictions.

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

static POLICY: std::sync::LazyLock<Option<EnterprisePolicy>> =
    std::sync::LazyLock::new(load_policy_file);

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
                "Tool '{tool_name}' is blocked by enterprise policy"
            ));
        }
    }

    if let Some(allowed) = &tools.allowed {
        if !matches_pattern_list(tool_name, allowed) {
            return Some(format!(
                "Tool '{tool_name}' is not in the enterprise allowlist"
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
            return Some(format!("Path '{path_str}' is blocked by enterprise policy"));
        }
    }

    if let Some(allowed) = &paths.allowed {
        if !matches_pattern_list(&path_str, allowed) {
            return Some(format!(
                "Path '{path_str}' is not in the enterprise allowlist"
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
            return Some(format!("Host '{host}' is blocked by enterprise policy"));
        }
    }
    if let Some(allowed) = &network.allowed_hosts {
        if !matches_pattern_list(&host, allowed) {
            return Some(format!("Host '{host}' is not in the enterprise allowlist"));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Pattern Matching Tests
    // ========================================================================

    #[test]
    fn test_matches_pattern_list_exact() {
        let patterns = vec!["bash".to_string(), "read".to_string()];
        assert!(matches_pattern_list("bash", &patterns));
        assert!(matches_pattern_list("read", &patterns));
        assert!(!matches_pattern_list("write", &patterns));
    }

    #[test]
    fn test_matches_pattern_list_glob_star() {
        let patterns = vec!["bash*".to_string()];
        assert!(matches_pattern_list("bash", &patterns));
        assert!(matches_pattern_list("bash_script", &patterns));
        assert!(!matches_pattern_list("read", &patterns));
    }

    #[test]
    fn test_matches_pattern_list_glob_question() {
        let patterns = vec!["re?d".to_string()];
        assert!(matches_pattern_list("read", &patterns));
        assert!(matches_pattern_list("reed", &patterns));
        assert!(!matches_pattern_list("red", &patterns));
        assert!(!matches_pattern_list("reaad", &patterns));
    }

    #[test]
    fn test_matches_pattern_list_glob_brackets() {
        let patterns = vec!["[rw]ead".to_string()];
        assert!(matches_pattern_list("read", &patterns));
        assert!(matches_pattern_list("wead", &patterns));
        assert!(!matches_pattern_list("bead", &patterns));
    }

    #[test]
    fn test_matches_pattern_list_empty() {
        let patterns: Vec<String> = vec![];
        assert!(!matches_pattern_list("bash", &patterns));
    }

    // ========================================================================
    // Private IP Detection Tests
    // ========================================================================

    #[test]
    fn test_is_private_ip_class_a() {
        // 10.0.0.0/8 range
        assert!(is_private_ip(&"10.0.0.1".parse().unwrap()));
        assert!(is_private_ip(&"10.255.255.255".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_class_b() {
        // 172.16.0.0/12 range
        assert!(is_private_ip(&"172.16.0.1".parse().unwrap()));
        assert!(is_private_ip(&"172.31.255.255".parse().unwrap()));
        assert!(!is_private_ip(&"172.15.0.1".parse().unwrap()));
        assert!(!is_private_ip(&"172.32.0.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_class_c() {
        // 192.168.0.0/16 range
        assert!(is_private_ip(&"192.168.0.1".parse().unwrap()));
        assert!(is_private_ip(&"192.168.255.255".parse().unwrap()));
        assert!(!is_private_ip(&"192.167.0.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_loopback() {
        // 127.0.0.0/8 range
        assert!(is_private_ip(&"127.0.0.1".parse().unwrap()));
        assert!(is_private_ip(&"127.255.255.255".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_link_local() {
        // 169.254.0.0/16 range
        assert!(is_private_ip(&"169.254.0.1".parse().unwrap()));
        assert!(is_private_ip(&"169.254.255.255".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_public() {
        // Public IPs should not be private
        assert!(!is_private_ip(&"8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip(&"1.1.1.1".parse().unwrap()));
        assert!(!is_private_ip(&"142.250.80.110".parse().unwrap())); // google.com
    }

    #[test]
    fn test_is_private_ip_ipv6_loopback() {
        assert!(is_private_ip(&"::1".parse().unwrap()));
    }

    // ========================================================================
    // PolicyList Deserialization Tests
    // ========================================================================

    #[test]
    fn test_policy_list_deserialization() {
        let json = r#"{"allowed": ["bash", "read"], "blocked": ["rm"]}"#;
        let policy: PolicyList = serde_json::from_str(json).unwrap();
        assert_eq!(policy.allowed.as_ref().unwrap().len(), 2);
        assert_eq!(policy.blocked.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_policy_list_partial() {
        let json = r#"{"allowed": ["bash"]}"#;
        let policy: PolicyList = serde_json::from_str(json).unwrap();
        assert!(policy.allowed.is_some());
        assert!(policy.blocked.is_none());
    }

    #[test]
    fn test_network_policy_deserialization() {
        let json = r#"{
            "allowed_hosts": ["example.com"],
            "blocked_hosts": ["evil.com"],
            "block_localhost": true,
            "block_private_ips": false
        }"#;
        let policy: NetworkPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.allowed_hosts.as_ref().unwrap().len(), 1);
        assert_eq!(policy.blocked_hosts.as_ref().unwrap().len(), 1);
        assert!(policy.block_localhost.unwrap());
        assert!(!policy.block_private_ips.unwrap());
    }

    #[test]
    fn test_enterprise_policy_deserialization() {
        let json = r#"{
            "tools": {"allowed": ["bash", "read"]},
            "paths": {"blocked": ["/etc/*"]},
            "network": {"block_localhost": true}
        }"#;
        let policy: EnterprisePolicy = serde_json::from_str(json).unwrap();
        assert!(policy.tools.is_some());
        assert!(policy.paths.is_some());
        assert!(policy.network.is_some());
    }

    #[test]
    fn test_policy_file_path() {
        let path = policy_file_path();
        // Should return Some path if home dir exists
        if dirs::home_dir().is_some() {
            assert!(path.is_some());
            let p = path.unwrap();
            assert!(p.ends_with("policy.json"));
        }
    }
}
