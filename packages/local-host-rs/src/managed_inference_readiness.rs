//! Read-only, tenant-bound managed inference diagnostics. Never execution authority.
use super::{CheckStatus, DoctorCheck};
use crate::credential_mode::{DetectedMode, ENVIRONMENT_ENV, PROVIDER_ENV, PlatformSession};
use anyhow::{Result, bail};
use prost::Message;
mod wire {
    include!(concat!(env!("OUT_DIR"), "/console.v1.rs"));
}
use std::{collections::HashMap, io::Read, time::Duration};
use wire::{
    GetManagedInferenceReadinessRequest, GetManagedInferenceReadinessResponse,
    ManagedInferenceNextAction as Action, ManagedInferenceReadinessStatus as Status,
};

pub(super) async fn check(
    readiness: &Result<DetectedMode>,
    requested: &str,
    env: &HashMap<String, String>,
    live: bool,
) -> DoctorCheck {
    // Offline diagnostics must neither refresh identity nor promise live enrollment.
    if !live {
        return super::check("managed_inference", CheckStatus::Skipped,
            "Managed inference readiness not checked", Some("Run `deixic-code doctor --live` to check access, funding and policy for the selected tenant and model.".into()), false);
    }
    let Ok(DetectedMode::Platform(session)) = readiness else {
        return super::check(
            "managed_inference",
            CheckStatus::Skipped,
            "Managed inference requires a managed login",
            Some("Bring your own provider remains available separately.".into()),
            false,
        );
    };
    let request = match request_for(session, requested, env) {
        Ok(request) => request,
        Err(_) => return unavailable(),
    };
    let session = session.clone();
    match tokio::task::spawn_blocking(move || fetch(&session, &request)).await {
        Ok(Ok(response)) => present(&response),
        _ => unavailable(),
    }
}

fn unavailable() -> DoctorCheck {
    super::check(
        "managed_inference",
        CheckStatus::Warning,
        "Temporarily unavailable",
        Some("Retry `deixic-code doctor --live`. Managed access could not be checked.".into()),
        true,
    )
}

fn request_for(
    session: &PlatformSession,
    requested: &str,
    env: &HashMap<String, String>,
) -> Result<GetManagedInferenceReadinessRequest> {
    let managed = session.managed_env(requested, env)?;
    let route = session.managed_model_route(requested);
    Ok(GetManagedInferenceReadinessRequest {
        organization_id: session.organization_id.clone(),
        workspace_id: session
            .workspace_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("workspace required"))?,
        provider: managed
            .get(PROVIDER_ENV)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("provider required"))?,
        model: route.strip_prefix("evalops/").unwrap_or(&route).to_owned(),
        environment: managed.get(ENVIRONMENT_ENV).cloned().unwrap_or_default(),
    })
}

fn fetch(
    session: &PlatformSession,
    request: &GetManagedInferenceReadinessRequest,
) -> Result<GetManagedInferenceReadinessResponse> {
    let base = crate::managed_setup::platform_base_url()
        .ok_or_else(|| anyhow::anyhow!("platform address required"))?;
    fetch_from(session, request, &base)
}

fn fetch_from(
    session: &PlatformSession,
    request: &GetManagedInferenceReadinessRequest,
    base: &str,
) -> Result<GetManagedInferenceReadinessResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(format!(
            "{}/deixic.v1.DeixicService/GetManagedInferenceReadiness",
            base.trim_end_matches('/')
        ))
        .bearer_auth(&session.access_token)
        .header("x-organization-id", &request.organization_id)
        .header("x-workspace-id", &request.workspace_id)
        .header("connect-protocol-version", "1")
        .header("content-type", "application/proto")
        .header("accept", "application/proto")
        .body(request.encode_to_vec())
        .send()?;
    if !response.status().is_success() {
        bail!("readiness unavailable");
    }
    let mut bytes = Vec::new();
    response.take(65_537).read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        bail!("readiness response exceeds diagnostic limit");
    }
    let response = GetManagedInferenceReadinessResponse::decode(bytes.as_slice())?;
    if response.environment != request.environment
        || response.organization_id != request.organization_id
        || response.workspace_id != request.workspace_id
        || response.target.as_ref().is_none_or(|target| {
            target.provider != request.provider || target.model != request.model
        })
    {
        bail!("readiness scope mismatch");
    }
    Ok(response)
}

fn present(response: &GetManagedInferenceReadinessResponse) -> DoctorCheck {
    let (status, label) = match Status::try_from(response.status).unwrap_or(Status::Unspecified) {
        Status::Ready => (CheckStatus::Pass, "Ready"),
        Status::ActivationRequired => (CheckStatus::Warning, "Activation required"),
        Status::FundingRequired => (CheckStatus::Warning, "Funding required"),
        Status::LimitReached => (CheckStatus::Warning, "Limit reached"),
        Status::AccessSuspended => (CheckStatus::Warning, "Access suspended"),
        _ => (CheckStatus::Warning, "Temporarily unavailable"),
    };
    let mut details = vec![format!(
        "Deixic-managed inference: {} / {}; provider {}; model {}",
        response.organization_id,
        response.workspace_id,
        response
            .target
            .as_ref()
            .map(|target| target.provider.as_str())
            .unwrap_or("unknown"),
        response
            .target
            .as_ref()
            .map(|target| target.model.as_str())
            .unwrap_or("unknown")
    )];
    if Status::try_from(response.status).unwrap_or(Status::Unspecified) == Status::Ready {
        details.push("No provider key is required. Requests remain subject to your organization’s policy and available funding.".into());
    }
    for action in &response.next_actions {
        match Action::try_from(*action).unwrap_or(Action::Unspecified) {
            Action::ContactAdministrator => {
                details.push("Contact your organization administrator.".into());
            }
            Action::ViewFunding => {
                details.push("View funding in Deixic Settings > Billing.".into());
            }
            Action::Retry => details.push("Retry `deixic-code doctor --live`.".into()),
            _ => {}
        }
    }
    super::check(
        "managed_inference",
        status,
        label,
        Some(details.join("\n")),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_inference_readiness_distinguishes_denial_from_unavailable() {
        for (state, expected) in [
            (Status::Ready, "Ready"),
            (Status::ActivationRequired, "Activation required"),
            (Status::FundingRequired, "Funding required"),
            (Status::LimitReached, "Limit reached"),
            (Status::AccessSuspended, "Access suspended"),
            (Status::TemporarilyUnavailable, "Temporarily unavailable"),
            (Status::Unspecified, "Temporarily unavailable"),
        ] {
            let response = GetManagedInferenceReadinessResponse {
                status: state.into(),
                ..Default::default()
            };
            let report = present(&response);
            assert_eq!(report.summary, expected);
            assert_eq!(report.status == CheckStatus::Pass, state == Status::Ready);
        }
    }

    #[tokio::test]
    async fn managed_inference_readiness_offline_never_claims_live_readiness() {
        let report = check(
            &Ok(DetectedMode::Platform(session())),
            "evalops/gpt-5.6",
            &HashMap::new(),
            false,
        )
        .await;
        assert_eq!(report.status, CheckStatus::Skipped);
        assert!(!report.live);
    }
    fn session() -> PlatformSession {
        PlatformSession {
            access_token: "fixture-token".into(),
            organization_id: "org-a".into(),
            workspace_id: Some("workspace-a".into()),
            provider_ref: serde_json::json!({"provider":"openrouter", "environment":"production"}),
            email: None,
            user_id: None,
        }
    }

    #[test]
    fn managed_inference_readiness_preserves_upstream_model_and_tenant() {
        let request = request_for(&session(), "evalops/openai/gpt-5.6", &HashMap::new()).unwrap();
        assert_eq!(request.provider, "openrouter");
        assert_eq!(request.model, "openai/gpt-5.6");
        assert_eq!(request.organization_id, "org-a");
        assert_eq!(request.workspace_id, "workspace-a");
    }

    #[test]
    fn managed_inference_readiness_rpc_verifies_response_scope() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for matches in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() < end + 4 + length {
                            continue;
                        }
                        assert!(headers.starts_with(
                            "post /deixic.v1.deixicservice/getmanagedinferencereadiness "
                        ));
                        assert!(headers.contains("content-type: application/proto"));
                        assert!(headers.contains("connect-protocol-version: 1"));
                        assert!(headers.contains("x-organization-id: org-a"));
                        assert!(headers.contains("x-workspace-id: workspace-a"));
                        let request =
                            GetManagedInferenceReadinessRequest::decode(&bytes[end + 4..]).unwrap();
                        assert_eq!(request.model, "openai/gpt-5.6");
                        let response = GetManagedInferenceReadinessResponse {
                            organization_id: if matches {
                                request.organization_id
                            } else {
                                "org-other".into()
                            },
                            workspace_id: request.workspace_id,
                            environment: request.environment,
                            status: Status::Ready.into(),
                            target: wire::InferenceProviderTarget {
                                provider: request.provider,
                                model: request.model,
                            }
                            .into(),
                            ..Default::default()
                        }
                        .encode_to_vec();
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/proto\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                        stream.write_all(&response).unwrap();
                        break;
                    }
                }
            });
            let session = session();
            let request = request_for(&session, "evalops/openai/gpt-5.6", &HashMap::new()).unwrap();
            assert_eq!(
                fetch_from(&session, &request, &format!("http://{address}")).is_ok(),
                matches
            );
            server.join().unwrap();
        }
    }
}
