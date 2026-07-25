use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;

use rand::Rng as _;
use serde_json::{json, Value};

fn env_value(primary: &str, fallback: &str) -> Option<String> {
    std::env::var(primary)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var(fallback)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn true_flag(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn telemetry_flag() -> Option<bool> {
    env_value("MAESTRO_TELEMETRY", "PLAYWRIGHT_TELEMETRY").and_then(|value| {
        match value.trim().to_ascii_lowercase().as_str() {
            "0" | "false" => Some(false),
            "1" | "true" => Some(true),
            _ => None,
        }
    })
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn telemetry_file() -> Option<PathBuf> {
    env_value("MAESTRO_TELEMETRY_FILE", "PLAYWRIGHT_TELEMETRY_FILE")
        .map(|path| expand_home(path.trim()))
}

fn default_telemetry_file() -> PathBuf {
    std::env::var("MAESTRO_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|path| expand_home(path.trim()))
        .or_else(|| dirs::home_dir().map(|home| home.join(".maestro")))
        .unwrap_or_else(|| PathBuf::from(".maestro"))
        .join("telemetry.log")
}

fn sample_rate() -> f64 {
    env_value("MAESTRO_TELEMETRY_SAMPLE", "PLAYWRIGHT_TELEMETRY_SAMPLE")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(1.0)
}

fn staged_rollout_event(
    event: &str,
    surface_id: &str,
    surface_type: &str,
    owner: Option<&str>,
    source: &str,
) -> Value {
    let mut metadata = serde_json::Map::new();
    if let Some(owner) = owner {
        metadata.insert("owner".into(), json!(owner));
    }
    metadata.insert("source".into(), json!(source));
    json!({
        "type": "staged-rollout-surface",
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event": event,
        "surfaceId": surface_id,
        "surfaceType": surface_type,
        "metadata": metadata,
    })
}

/// Best-effort staged-rollout telemetry for native CLI surfaces.
pub async fn record_staged_rollout_surface_usage(
    event: &str,
    surface_id: &str,
    surface_type: &str,
    owner: Option<&str>,
    source: &str,
) {
    if true_flag("MAESTRO_INTERNAL_TELEMETRY_DISABLED")
        || true_flag("EVALOPS_INTERNAL_TELEMETRY_DISABLED")
        || telemetry_flag() == Some(false)
    {
        return;
    }

    let file = telemetry_file();
    let endpoint = env_value(
        "MAESTRO_TELEMETRY_ENDPOINT",
        "PLAYWRIGHT_TELEMETRY_ENDPOINT",
    );
    if telemetry_flag() != Some(true) && file.is_none() && endpoint.is_none() {
        return;
    }

    let rate = sample_rate();
    if rate == 0.0 || (rate < 1.0 && rand::rng().random::<f64>() > rate) {
        return;
    }

    let payload = staged_rollout_event(event, surface_id, surface_type, owner, source);
    let encoded = payload.to_string();

    if let Some(endpoint) = endpoint.as_deref() {
        // Best-effort telemetry must never hang the CLI on a dead host.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build();
        if let Ok(client) = client {
            let _ = client
                .post(endpoint)
                .header("content-type", "application/json")
                .body(encoded.clone())
                .send()
                .await;
        }
    }

    if let Some(path) = file.or_else(|| endpoint.is_none().then(default_telemetry_file)) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut output) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(output, "{encoded}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_rollout_event_matches_typescript_contract() {
        let event = staged_rollout_event(
            "hidden_mode_used",
            "mode:frontier",
            "mode",
            Some("agent-runtime"),
            "cli:modes:describe",
        );
        assert_eq!(event["type"], "staged-rollout-surface");
        assert_eq!(event["event"], "hidden_mode_used");
        assert_eq!(event["surfaceId"], "mode:frontier");
        assert_eq!(event["surfaceType"], "mode");
        assert_eq!(event["metadata"]["owner"], "agent-runtime");
        assert_eq!(event["metadata"]["source"], "cli:modes:describe");
        assert!(event["timestamp"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z')));
    }
}
