//! Enterprise policy enforcement (parity with TS).
//!
//! Reads ~/.composer/policy.json and enforces tool, path, network, model, and
//! session limits. Policy load failures fail closed (block) to match CLI behavior.

use serde::Deserialize;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

use regex::Regex;
use url::Url;

use super::dangerous_patterns::check_dangerous_patterns;
use super::path_containment::{expand_tilde, is_tilde_path};

#[derive(Debug, Deserialize, Clone)]
pub struct PolicyList {
    pub allowed: Option<Vec<String>>,
    pub blocked: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    pub allowed_hosts: Option<Vec<String>>,
    pub blocked_hosts: Option<Vec<String>>,
    pub block_localhost: Option<bool>,
    pub block_private_ips: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LimitsPolicy {
    pub max_tokens_per_session: Option<u64>,
    pub max_session_duration_minutes: Option<u64>,
    pub max_concurrent_sessions: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnterprisePolicy {
    pub org_id: Option<String>,
    pub tools: Option<PolicyList>,
    pub dependencies: Option<PolicyList>,
    pub models: Option<PolicyList>,
    pub paths: Option<PolicyList>,
    pub network: Option<NetworkPolicy>,
    pub limits: Option<LimitsPolicy>,
}

#[derive(Default)]
struct PolicyCache {
    policy: Option<EnterprisePolicy>,
    mtime: Option<SystemTime>,
}

static POLICY_CACHE: std::sync::LazyLock<RwLock<PolicyCache>> =
    std::sync::LazyLock::new(|| RwLock::new(PolicyCache::default()));

static FILE_COMMAND_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)(?:cd|cat|rm|mv|cp|mkdir|touch|nano|vim|vi|less|more|head|tail|chmod|chown|strings|hexdump|dd|tee|ln|readlink|stat|file|wc|grep|sed|awk|sort|uniq|diff|patch|tar|gzip|gunzip|zip|unzip|find|rsync|scp)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)")
        .expect("Invalid file command regex")
});

static REDIRECT_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"[<>]{1,2}\s*([^\s<>|&;]+)").expect("Invalid redirect regex")
});

static COMMAND_SUB_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?:\$\(|<\()([^)]+)\)|`([^`]+)`").expect("Invalid command substitution regex")
});

static URL_PATTERN: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r#"https?://[^\s"'<>]+"#).expect("Invalid URL regex"));

static CURL_WGET_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)(?:curl|wget)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)")
        .expect("Invalid curl/wget regex")
});

static SHELL_META_PATTERN: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"[;&|`$()<>]").expect("Invalid shell meta regex"));

static PACKAGE_INSTALL_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:npm|yarn|pnpm|bun|pip|pip3|gem|cargo|go\s+get|composer)\s+(?:install|add|i\b)",
    )
    .expect("Invalid package install regex")
});

static NPM_INSTALL_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s]+)")
        .expect("Invalid npm install regex")
});

static BUN_INSTALL_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)\bbun\s+(?:add|install)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s]+)")
        .expect("Invalid bun install regex")
});

static PIP_INSTALL_PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)\bpip\d*\s+install\s+(?:-[a-zA-Z-]+\s+)*([\w@\-/.:\s=<>]+)")
        .expect("Invalid pip install regex")
});

fn policy_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".composer").join("policy.json"))
}

fn load_policy(force: bool) -> Result<Option<EnterprisePolicy>, String> {
    let Some(path) = policy_path() else {
        return Ok(None);
    };

    if !path.exists() {
        if let Ok(mut cache) = POLICY_CACHE.write() {
            cache.policy = None;
            cache.mtime = None;
        }
        return Ok(None);
    }

    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to stat policy file {}: {e}", path.display()))?;
    let mtime = metadata.modified().ok();

    if let Ok(cache) = POLICY_CACHE.read() {
        if !force && cache.mtime.is_some() && cache.mtime == mtime {
            return Ok(cache.policy.clone());
        }
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read policy file {}: {e}", path.display()))?;

    let policy = serde_json::from_str::<EnterprisePolicy>(&content)
        .map_err(|e| format!("Failed to parse enterprise policy: {e}"))?;

    if let Ok(mut cache) = POLICY_CACHE.write() {
        cache.policy = Some(policy.clone());
        cache.mtime = mtime;
    }

    Ok(Some(policy))
}

fn expand_home_dir(path: &str) -> String {
    let raw = Path::new(path);
    if is_tilde_path(raw) {
        if let Some(expanded) = expand_tilde(raw) {
            return expanded.to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn resolve_absolute_path(path: &str) -> PathBuf {
    let expanded = expand_home_dir(path);
    let path = Path::new(&expanded);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn resolve_real_path(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    if let Some(parent) = path.parent() {
        if let Ok(real_parent) = parent.canonicalize() {
            if let Some(name) = path.file_name() {
                return real_parent.join(name);
            }
        }
    }
    path.to_path_buf()
}

fn normalize_for_match(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    value
}

fn contains_glob(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.contains('[') || pattern.contains('{')
}

fn matches_path_pattern(path: &Path, patterns: &[String]) -> bool {
    let normalized_path = resolve_absolute_path(&path.to_string_lossy());
    let real_path = resolve_real_path(&normalized_path);

    for pattern in patterns {
        let expanded = expand_home_dir(pattern);
        let is_glob = contains_glob(&expanded);
        let resolved_pattern = if is_glob {
            PathBuf::from(expanded)
        } else {
            resolve_absolute_path(&expanded)
        };

        for candidate in [&normalized_path, &real_path] {
            let path_str = normalize_for_match(candidate);
            let pattern_str = normalize_for_match(&resolved_pattern);
            if let Ok(glob_pat) = glob::Pattern::new(&pattern_str) {
                if glob_pat.matches(&path_str) {
                    return true;
                }
            }

            if !is_glob {
                if path_str == pattern_str || path_str.starts_with(&format!("{pattern_str}/")) {
                    return true;
                }
            }
        }
    }

    false
}

fn matches_model_pattern(model_id: &str, patterns: &[String]) -> bool {
    let model = model_id.to_lowercase();
    for pattern in patterns {
        let pat = pattern.to_lowercase();
        if let Ok(glob_pat) = glob::Pattern::new(&pat) {
            if glob_pat.matches(&model) {
                return true;
            }
        }
    }
    false
}

fn host_matches(host: &str, pattern: &str) -> bool {
    let host = host.to_lowercase();
    let pattern = pattern.to_lowercase();
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

fn is_localhost_alias(host: &str) -> bool {
    let host = host.to_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".localhost")
}

fn check_network_restrictions(url: &str, network: &NetworkPolicy) -> Option<String> {
    let parsed = match Url::parse(url.trim()) {
        Ok(parsed) => parsed,
        Err(_) => {
            return Some("Invalid URL format - cannot validate against network policy.".to_string())
        }
    };
    let host = match parsed.host_str() {
        Some(host) => host,
        None => {
            return Some("Invalid URL format - cannot validate against network policy.".to_string())
        }
    };
    let host = host.trim_matches(['[', ']']);

    let mut resolved_ips: Vec<IpAddr> = Vec::new();
    let is_ip = host.parse::<IpAddr>().is_ok();

    if is_ip {
        if let Ok(ip) = host.parse::<IpAddr>() {
            resolved_ips.push(ip);
        }
    } else if network.block_private_ips.unwrap_or(false) || network.block_localhost.unwrap_or(false)
    {
        let port = parsed.port_or_known_default().unwrap_or(80);
        let host_port = format!("{host}:{port}");
        if let Ok(addrs) = host_port.to_socket_addrs() {
            for addr in addrs {
                resolved_ips.push(addr.ip());
            }
        }
        if resolved_ips.is_empty() {
            return Some(format!(
                "DNS resolution failed for \"{host}\" and network policy requires IP validation (blockPrivateIPs/blockLocalhost enabled). Access blocked."
            ));
        }
    }

    if network.block_localhost.unwrap_or(false) {
        if is_localhost_alias(host) || resolved_ips.iter().any(|ip| ip.is_loopback()) {
            return Some("Access to localhost is blocked by enterprise policy.".to_string());
        }
    }

    if network.block_private_ips.unwrap_or(false) {
        if resolved_ips.iter().any(is_private_ip) {
            return Some(
                "Access to private IP addresses is blocked by enterprise policy.".to_string(),
            );
        }
    }

    if let Some(blocked) = &network.blocked_hosts {
        if blocked.iter().any(|pattern| host_matches(host, pattern)) {
            return Some(format!("Host \"{host}\" is blocked by enterprise policy."));
        }
    }

    if let Some(allowed) = &network.allowed_hosts {
        if allowed.is_empty() {
            return Some(format!("Host \"{host}\" is not in the allowed hosts list."));
        }
        let ok = allowed.iter().any(|pattern| host_matches(host, pattern));
        if !ok {
            return Some(format!("Host \"{host}\" is not in the allowed hosts list."));
        }
    }

    None
}

fn clean_package_spec(spec: &str) -> String {
    if spec.contains("://")
        || spec.starts_with("git@")
        || spec.starts_with("./")
        || spec.starts_with("../")
    {
        return spec.to_string();
    }

    if let Some(rest) = spec.strip_prefix('@') {
        if let Some(idx) = rest.find('@') {
            return format!("@{}", &rest[..idx]);
        }
        return format!("@{rest}");
    }

    spec.split(|c| c == '@' || c == '=' || c == '<' || c == '>')
        .next()
        .unwrap_or(spec)
        .to_string()
}

fn extract_dependencies(command: &str) -> Vec<String> {
    let mut results = Vec::new();
    let patterns = [
        &*NPM_INSTALL_PATTERN,
        &*BUN_INSTALL_PATTERN,
        &*PIP_INSTALL_PATTERN,
    ];

    for pattern in patterns {
        for caps in pattern.captures_iter(command) {
            let captured = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if captured.is_empty() {
                continue;
            }
            for part in captured.split_whitespace() {
                if part.starts_with('-') {
                    continue;
                }
                let cleaned = clean_package_spec(part);
                if !cleaned.is_empty() {
                    results.push(cleaned);
                }
            }
        }
    }

    results
}

fn has_package_install(command: &str) -> bool {
    PACKAGE_INSTALL_PATTERN.is_match(command)
}

fn extract_urls_from_value(value: &serde_json::Value, urls: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            for m in URL_PATTERN.find_iter(text) {
                let trimmed = m
                    .as_str()
                    .trim_end_matches(&[')', '}', ']', ',', '.', ';', ':'][..]);
                if !trimmed.is_empty() {
                    urls.push(trimmed.to_string());
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                extract_urls_from_value(item, urls);
            }
        }
        serde_json::Value::Object(map) => {
            for value in map.values() {
                extract_urls_from_value(value, urls);
            }
        }
        _ => {}
    }
}

fn extract_urls_from_shell_command(command: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let flags_with_values = [
        "-X",
        "--request",
        "-o",
        "-O",
        "--output",
        "-H",
        "--header",
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "-F",
        "--form",
        "-A",
        "--user-agent",
        "-u",
        "--user",
        "-T",
        "--upload-file",
        "-e",
        "--referer",
        "-b",
        "--cookie",
        "-c",
        "--cookie-jar",
        "-K",
        "--config",
        "--resolve",
        "--connect-to",
        "--max-time",
        "-m",
        "--retry",
        "--retry-delay",
        "-w",
        "--write-out",
    ];

    for caps in CURL_WGET_PATTERN.captures_iter(command) {
        let args_str = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let parts = shlex::split(args_str)
            .unwrap_or_else(|| args_str.split_whitespace().map(|s| s.to_string()).collect());
        let mut skip_next = false;
        for part in parts {
            let stripped = part.trim_matches(['"', '\'']);
            if skip_next {
                skip_next = false;
                continue;
            }
            if stripped.starts_with('-') {
                if stripped.contains('=') {
                    continue;
                }
                if flags_with_values.contains(&stripped) {
                    skip_next = true;
                }
                continue;
            }
            let mut url = stripped.to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                url = format!("http://{url}");
            }
            let cleaned = url.trim_end_matches(&[')', '}', ']', ',', '.', ';', ':'][..]);
            if !cleaned.is_empty() {
                urls.push(cleaned.to_string());
            }
        }
    }

    urls
}

fn extract_file_paths(tool_name: &str, args: &serde_json::Value) -> Vec<String> {
    let mut paths = Vec::new();
    let Some(map) = args.as_object() else {
        return paths;
    };

    let path_keys = [
        "path",
        "file_path",
        "filePath",
        "file",
        "files",
        "directory",
        "dir",
        "target",
        "source",
        "destination",
        "cwd",
        "output",
        "input",
        "src",
        "dest",
        "config",
        "workspace",
        "folder",
        "target_file",
        "target_directory",
    ];

    for key in path_keys {
        if let Some(value) = map.get(key) {
            match value {
                serde_json::Value::String(text) => {
                    if !text.is_empty() {
                        paths.push(text.clone());
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        if let Some(text) = item.as_str() {
                            if !text.is_empty() {
                                paths.push(text.to_string());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if matches!(tool_name, "bash" | "background_tasks") {
        if let Some(command) = map.get("command").and_then(|v| v.as_str()) {
            extract_paths_from_command(command, &mut paths, 0);
        }
    }

    paths
}

fn extract_paths_from_command(command: &str, paths: &mut Vec<String>, depth: usize) {
    if depth > 1 {
        return;
    }

    for caps in FILE_COMMAND_PATTERN.captures_iter(command) {
        let args_str = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let parts = shlex::split(args_str)
            .unwrap_or_else(|| args_str.split_whitespace().map(|s| s.to_string()).collect());
        for part in parts {
            let cleaned = part.trim_matches(['"', '\'']);
            if cleaned.is_empty() || cleaned.starts_with('-') {
                continue;
            }
            if matches!(cleaned.chars().next(), Some('<' | '>' | '|' | '&' | ';')) {
                continue;
            }
            paths.push(cleaned.to_string());
        }
    }

    for caps in REDIRECT_PATTERN.captures_iter(command) {
        if let Some(raw) = caps.get(1).map(|m| m.as_str()) {
            let cleaned = raw.trim_matches(['"', '\'']);
            if !cleaned.is_empty() {
                paths.push(cleaned.to_string());
            }
        }
    }

    for caps in COMMAND_SUB_PATTERN.captures_iter(command) {
        let inner = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str());
        if let Some(inner_cmd) = inner {
            extract_paths_from_command(inner_cmd, paths, depth + 1);
        }
    }
}

fn check_paths_against_policy(paths: &[String], policy: &EnterprisePolicy) -> Option<String> {
    let Some(path_policy) = policy.paths.as_ref() else {
        return None;
    };

    for path in paths {
        let path_buf = Path::new(path);
        if let Some(blocked) = &path_policy.blocked {
            if !blocked.is_empty() && matches_path_pattern(path_buf, blocked) {
                return Some(format!("Path \"{path}\" is blocked by enterprise policy."));
            }
        }
        if let Some(allowed) = &path_policy.allowed {
            if allowed.is_empty() || !matches_path_pattern(path_buf, allowed) {
                return Some(format!("Path \"{path}\" is not in the allowed paths list."));
            }
        }
    }

    None
}

fn check_dependencies_against_policy(command: &str, policy: &EnterprisePolicy) -> Option<String> {
    let Some(dep_policy) = policy.dependencies.as_ref() else {
        return None;
    };

    let deps = extract_dependencies(command);
    let is_install = has_package_install(command);

    if (is_install || !deps.is_empty()) && SHELL_META_PATTERN.is_match(command) {
        return Some("Command contains shell metacharacters which are not allowed by enterprise policy during package installation.".to_string());
    }

    if let Some(allowed) = &dep_policy.allowed {
        for dep in &deps {
            if allowed.is_empty() || !allowed.iter().any(|d| d == dep) {
                return Some(format!(
                    "Dependency \"{dep}\" is not in the approved dependencies list."
                ));
            }
        }
    }

    if let Some(blocked) = &dep_policy.blocked {
        for dep in &deps {
            if blocked.iter().any(|d| d == dep) {
                return Some(format!(
                    "Dependency \"{dep}\" is explicitly blocked by enterprise policy."
                ));
            }
        }
    }

    None
}

fn check_obfuscation_patterns(command: &str) -> Option<String> {
    let patterns = check_dangerous_patterns(command);
    let blocked_ids = [
        "base64_decode",
        "openssl_enc",
        "python_eval",
        "perl_eval",
        "node_eval",
        "php_eval",
        "ruby_eval",
        "eval_call",
        "exec_call",
    ];

    if patterns.iter().any(|p| blocked_ids.contains(&p.pattern_id)) {
        return Some("Command contains obfuscated or dangerous patterns (e.g. base64 decoding, inline code execution) which are blocked by enterprise policy.".to_string());
    }

    None
}

fn check_network_against_policy(
    args: &serde_json::Value,
    command: Option<&str>,
    policy: &EnterprisePolicy,
) -> Option<String> {
    let Some(network) = policy.network.as_ref() else {
        return None;
    };

    let mut urls = Vec::new();
    extract_urls_from_value(args, &mut urls);
    if let Some(cmd) = command {
        urls.extend(extract_urls_from_shell_command(cmd));
    }

    for url in urls {
        if let Some(reason) = check_network_restrictions(&url, network) {
            return Some(reason);
        }
    }

    None
}

pub fn check_tool_allowed(tool_name: &str) -> Option<String> {
    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Access blocked."));
        }
    }?;

    let tools = policy.tools.as_ref()?;

    if let Some(allowed) = &tools.allowed {
        if allowed.is_empty() || !allowed.iter().any(|t| t == tool_name) {
            return Some(format!(
                "Tool \"{tool_name}\" is not in the approved tools list."
            ));
        }
    }

    if let Some(blocked) = &tools.blocked {
        if blocked.iter().any(|t| t == tool_name) {
            return Some(format!(
                "Tool \"{tool_name}\" is explicitly blocked by enterprise policy."
            ));
        }
    }

    None
}

pub fn check_command_policy(tool_name: &str, args: &serde_json::Value) -> Option<String> {
    if !matches!(tool_name, "bash" | "background_tasks") {
        return None;
    }

    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Access blocked."));
        }
    }?;

    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if command.is_empty() {
        return None;
    }

    if let Some(reason) = check_obfuscation_patterns(command) {
        return Some(reason);
    }

    if let Some(reason) = check_dependencies_against_policy(command, &policy) {
        return Some(reason);
    }

    let paths = extract_file_paths(tool_name, args);
    if let Some(reason) = check_paths_against_policy(&paths, &policy) {
        return Some(reason);
    }

    if let Some(reason) = check_network_against_policy(args, Some(command), &policy) {
        return Some(reason);
    }

    None
}

pub fn check_path_allowed(path: &Path) -> Option<String> {
    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Access blocked."));
        }
    }?;

    check_paths_against_policy(&[path.to_string_lossy().to_string()], &policy)
}

pub fn check_url_allowed(url: &str) -> Option<String> {
    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Access blocked."));
        }
    }?;

    let network = policy.network.as_ref()?;
    check_network_restrictions(url, network)
}

pub fn check_model_allowed(model_id: &str) -> Option<String> {
    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Model blocked."));
        }
    }?;

    let models = policy.models.as_ref()?;

    if let Some(blocked) = &models.blocked {
        if !blocked.is_empty() && matches_model_pattern(model_id, blocked) {
            return Some(format!(
                "Model \"{model_id}\" is blocked by enterprise policy."
            ));
        }
    }

    if let Some(allowed) = &models.allowed {
        if allowed.is_empty() || !matches_model_pattern(model_id, allowed) {
            return Some(format!(
                "Model \"{model_id}\" is not in the approved models list."
            ));
        }
    }

    None
}

pub fn check_session_limits(
    started_at: SystemTime,
    token_count: Option<u64>,
    active_session_count: Option<usize>,
) -> Option<String> {
    let policy = match load_policy(false) {
        Ok(policy) => policy,
        Err(err) => {
            return Some(format!("Enterprise policy error: {err}. Access blocked."));
        }
    }?;

    let limits = policy.limits.as_ref()?;

    if let Some(max_minutes) = limits.max_session_duration_minutes {
        if max_minutes > 0 {
            let duration = SystemTime::now()
                .duration_since(started_at)
                .unwrap_or_default();
            let elapsed = duration.as_secs_f64() / 60.0;
            if elapsed > max_minutes as f64 {
                return Some(format!(
                    "Session duration limit exceeded ({} / {} minutes). Please start a new session.",
                    elapsed.floor(),
                    max_minutes
                ));
            }
        }
    }

    if let Some(max_tokens) = limits.max_tokens_per_session {
        if max_tokens > 0 {
            if let Some(tokens) = token_count {
                if tokens > max_tokens {
                    return Some(format!(
                        "Session token limit exceeded ({tokens}/{max_tokens} tokens). Please start a new session."
                    ));
                }
            } else {
                return Some(format!(
                    "Session token limit is active ({max_tokens}) but token usage data is unavailable. Access blocked for safety."
                ));
            }
        }
    }

    if let Some(max_sessions) = limits.max_concurrent_sessions {
        if max_sessions > 0 {
            if let Some(active) = active_session_count {
                if active as u64 > max_sessions {
                    return Some(format!(
                        "Concurrent session limit exceeded ({active}/{max_sessions}). Please close existing sessions before starting a new one."
                    ));
                }
            } else {
                return Some(format!(
                    "Concurrent session limit is active ({max_sessions}) but session count data is unavailable. Access blocked for safety."
                ));
            }
        }
    }

    None
}

pub fn get_policy_limits() -> Option<LimitsPolicy> {
    load_policy(false).ok().flatten().and_then(|p| p.limits)
}

#[allow(dead_code)]
pub fn policy_file_path() -> Option<PathBuf> {
    policy_path()
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

#[cfg(test)]
mod tests {
    use super::*;

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
            "allowedHosts": ["example.com"],
            "blockedHosts": ["evil.com"],
            "blockLocalhost": true,
            "blockPrivateIPs": false
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
            "network": {"blockLocalhost": true},
            "models": {"allowed": ["anthropic/*"]},
            "limits": {"maxTokensPerSession": 1000}
        }"#;
        let policy: EnterprisePolicy = serde_json::from_str(json).unwrap();
        assert!(policy.tools.is_some());
        assert!(policy.paths.is_some());
        assert!(policy.network.is_some());
        assert!(policy.models.is_some());
        assert!(policy.limits.is_some());
    }

    #[test]
    fn test_policy_file_path() {
        let path = policy_file_path();
        if dirs::home_dir().is_some() {
            assert!(path.is_some());
            let p = path.unwrap();
            assert!(p.ends_with("policy.json"));
        }
    }
}
