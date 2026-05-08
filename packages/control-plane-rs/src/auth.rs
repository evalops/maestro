use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde_json::Value;
use sha2::Sha256;
use std::env;
use std::time::Duration;

use crate::http::{json_response, RequestHead};
use crate::{now_millis, trimmed_env, Config};

#[derive(Debug, Clone)]
pub(crate) struct AuthContext {
    pub(crate) subject: Option<String>,
    pub(crate) unrestricted: bool,
}

enum RuntimeSessionAuth {
    Scoped(String),
    ApiKey,
}

pub(crate) const RUNTIME_SESSION_COOKIE_NAME: &str = "maestro_web_session";
const RUNTIME_SESSION_COOKIE_CONTEXT: &[u8] = b"maestro-web-session:v1";
const RUNTIME_SESSION_API_KEY_COOKIE_CONTEXT: &[u8] = b"maestro-web-session-api-key:v1";

pub(crate) fn authorize(head: &RequestHead, config: &Config) -> Result<(), Vec<u8>> {
    if auth_context(head, config).is_some() {
        Ok(())
    } else {
        Err(json_response(
            401,
            &serde_json::json!({ "error": "Unauthorized" }),
        ))
    }
}

pub(crate) fn auth_context(head: &RequestHead, config: &Config) -> Option<AuthContext> {
    let bearer = head
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let header_key = head
        .headers
        .get("x-maestro-api-key")
        .or_else(|| head.headers.get("x-composer-api-key"))
        .map(String::as_str);

    if header_auth_matches(config, bearer, header_key) {
        return Some(AuthContext {
            subject: None,
            unrestricted: true,
        });
    }

    if let Some(subject) = bearer.and_then(bearer_token_subject) {
        return Some(AuthContext {
            subject: Some(subject),
            unrestricted: false,
        });
    }

    if let Some(subject) = trusted_proxy_auth_subject(head) {
        return Some(AuthContext {
            subject: Some(subject),
            unrestricted: false,
        });
    }

    if let Some(session_auth) = runtime_session_cookie_auth(head, config) {
        return Some(match session_auth {
            RuntimeSessionAuth::ApiKey => AuthContext {
                subject: None,
                unrestricted: true,
            },
            RuntimeSessionAuth::Scoped(subject) => AuthContext {
                subject: Some(subject),
                unrestricted: false,
            },
        });
    }

    if !config.require_key && !auth_is_configured(config) {
        return Some(AuthContext {
            subject: None,
            unrestricted: true,
        });
    }

    None
}

pub(crate) fn header_auth_matches(
    config: &Config,
    bearer: Option<&str>,
    header_key: Option<&str>,
) -> bool {
    config
        .api_key
        .as_deref()
        .map(|expected| bearer == Some(expected) || header_key == Some(expected))
        .unwrap_or(false)
}

fn runtime_session_cookie_auth(head: &RequestHead, config: &Config) -> Option<RuntimeSessionAuth> {
    let provided = cookie_value(head, RUNTIME_SESSION_COOKIE_NAME)?;
    let (encoded_subject, _signature) = provided.split_once('.')?;
    let payload = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded_subject).ok()?).ok()?;
    let api_key_expected = runtime_session_api_key_cookie_value(config)?;
    if constant_time_eq(provided.as_bytes(), api_key_expected.as_bytes()) {
        return Some(RuntimeSessionAuth::ApiKey);
    }
    let expected = runtime_session_cookie_value(config, &payload)?;
    constant_time_eq(provided.as_bytes(), expected.as_bytes())
        .then_some(RuntimeSessionAuth::Scoped(payload))
}

pub(crate) fn cookie_value<'a>(head: &'a RequestHead, name: &str) -> Option<&'a str> {
    let cookies = head.headers.get("cookie")?;
    cookies.split(';').find_map(|cookie| {
        let (cookie_name, value) = cookie.trim().split_once('=')?;
        (cookie_name == name).then_some(value)
    })
}

pub(crate) fn trusted_proxy_auth_subject(head: &RequestHead) -> Option<String> {
    let expected_token = trimmed_env("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN")?;
    let provided_token = head
        .headers
        .get("x-maestro-proxy-auth")
        .or_else(|| head.headers.get("x-composer-proxy-auth"))
        .map(String::as_str)?;
    if !constant_time_eq(provided_token.as_bytes(), expected_token.as_bytes()) {
        return None;
    }
    [
        "x-auth-request-email",
        "x-forwarded-email",
        "x-auth-request-user",
    ]
    .iter()
    .find_map(|name| {
        head.headers
            .get(*name)
            .and_then(|value| nonempty_str(value).map(str::to_string))
    })
}

pub(crate) fn nonempty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn validate_csrf(head: &RequestHead, config: &Config) -> Result<(), Vec<u8>> {
    if !csrf_applies(head) || !config.require_csrf {
        return Ok(());
    }
    let Some(expected) = config.csrf_token.as_deref() else {
        return Err(json_response(
            403,
            &serde_json::json!({
                "error": "MAESTRO_WEB_CSRF_TOKEN is required for state-changing requests"
            }),
        ));
    };
    let provided = head
        .headers
        .get("x-composer-csrf")
        .or_else(|| head.headers.get("x-maestro-csrf"))
        .or_else(|| head.headers.get("x-csrf-token"))
        .or_else(|| head.headers.get("x-xsrf-token"))
        .map(String::as_str);
    if provided
        .map(|value| constant_time_eq(value.as_bytes(), expected.as_bytes()))
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(json_response(
            403,
            &serde_json::json!({ "error": "Forbidden: invalid CSRF token" }),
        ))
    }
}

pub(crate) fn csrf_applies(head: &RequestHead) -> bool {
    head.path.starts_with("/api/") && !matches!(head.method.as_str(), "GET" | "HEAD" | "OPTIONS")
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .iter()
        .zip(right.iter())
        .fold(0_u8, |diff, (left, right)| diff | (left ^ right));
    diff == 0
}

pub(crate) fn auth_is_configured(config: &Config) -> bool {
    config.api_key.is_some()
        || env::var("MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || env::var("MAESTRO_AUTH_SHARED_SECRET")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || env::var("MAESTRO_JWT_SECRET")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || env::var("MAESTRO_JWT_JWKS_URL")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

pub(crate) fn prod_profile() -> bool {
    matches!(
        env::var("MAESTRO_PROFILE")
            .or_else(|_| env::var("MAESTRO_WEB_PROFILE"))
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "prod" | "production" | "secure" | "hardened"
    )
}

pub(crate) fn bearer_token_subject(token: &str) -> Option<String> {
    shared_bearer_subject(token).or_else(|| jwt_subject(token))
}

pub(crate) fn shared_bearer_subject(token: &str) -> Option<String> {
    let Ok(secret) = env::var("MAESTRO_AUTH_SHARED_SECRET") else {
        return None;
    };
    let secret = secret.trim();
    if secret.is_empty() {
        return None;
    }
    let (encoded_user, provided_signature) = token.split_once('.')?;
    if provided_signature.contains('.') {
        return None;
    }
    let Ok(user_bytes) = URL_SAFE_NO_PAD.decode(encoded_user) else {
        return None;
    };
    let Ok(user_id) = String::from_utf8(user_bytes) else {
        return None;
    };
    let expected = hmac_sha256_hex(secret.as_bytes(), user_id.as_bytes());
    if constant_time_eq(provided_signature.as_bytes(), expected.as_bytes()) {
        Some(user_id)
    } else {
        None
    }
}

pub(crate) fn jwt_subject(token: &str) -> Option<String> {
    match env::var("MAESTRO_JWT_ALG")
        .ok()
        .map(|alg| alg.trim().to_string())
        .filter(|alg| !alg.is_empty())
        .unwrap_or_else(|| "HS256".to_string())
        .as_str()
    {
        "HS256" => hs256_jwt_subject(token),
        "RS256" => jwks_jwt_subject(token, Algorithm::RS256),
        "RS384" => jwks_jwt_subject(token, Algorithm::RS384),
        "RS512" => jwks_jwt_subject(token, Algorithm::RS512),
        _ => None,
    }
}

pub(crate) fn hs256_jwt_subject(token: &str) -> Option<String> {
    if env::var("MAESTRO_JWT_ALG")
        .ok()
        .map(|alg| alg != "HS256")
        .unwrap_or(false)
    {
        return None;
    }
    let Ok(secret) = env::var("MAESTRO_JWT_SECRET") else {
        return None;
    };
    let secret = secret.trim();
    if secret.is_empty() {
        return None;
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let Ok(header_value) = URL_SAFE_NO_PAD
        .decode(header)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .ok_or(())
    else {
        return None;
    };
    if header_value.get("alg").and_then(Value::as_str) != Some("HS256") {
        return None;
    }
    let signed = format!("{header}.{payload}");
    let expected = hmac_sha256_base64url(secret.as_bytes(), signed.as_bytes());
    if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
        return None;
    }
    let Ok(payload_value) = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .ok_or(())
    else {
        return None;
    };
    let subject = payload_value
        .get("sub")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|sub| !sub.is_empty())
        .map(str::to_string)?;
    let now_secs = now_millis() / 1000;
    if payload_value
        .get("exp")
        .and_then(Value::as_u64)
        .map(|exp| exp <= now_secs)
        .unwrap_or(false)
    {
        return None;
    }
    if payload_value
        .get("nbf")
        .and_then(Value::as_u64)
        .map(|nbf| nbf > now_secs)
        .unwrap_or(false)
    {
        return None;
    }
    if let Ok(audience) = env::var("MAESTRO_JWT_AUD") {
        if !jwt_claim_matches(&payload_value, "aud", audience.trim()) {
            return None;
        }
    }
    if let Ok(issuer) = env::var("MAESTRO_JWT_ISS") {
        if !jwt_claim_matches(&payload_value, "iss", issuer.trim()) {
            return None;
        }
    }
    Some(subject)
}

pub(crate) fn jwks_jwt_subject(token: &str, algorithm: Algorithm) -> Option<String> {
    let Ok(header) = decode_header(token) else {
        return None;
    };
    if header.alg != algorithm {
        return None;
    }
    let jwks = load_jwks()?;
    let key = jwks
        .keys
        .iter()
        .find(|key| {
            header
                .kid
                .as_deref()
                .map(|kid| key.common.key_id.as_deref() == Some(kid))
                .unwrap_or(true)
        })
        .and_then(|key| DecodingKey::from_jwk(key).ok());
    let key = key?;
    let mut validation = Validation::new(algorithm);
    if let Ok(audience) = env::var("MAESTRO_JWT_AUD") {
        let audience = audience.trim().to_string();
        if !audience.is_empty() {
            validation.set_audience(&[audience]);
        } else {
            validation.validate_aud = false;
        }
    } else {
        validation.validate_aud = false;
    }
    if let Ok(issuer) = env::var("MAESTRO_JWT_ISS") {
        let issuer = issuer.trim().to_string();
        if !issuer.is_empty() {
            validation.set_issuer(&[issuer]);
        }
    }
    let Ok(data) = decode::<Value>(token, &key, &validation) else {
        return None;
    };
    data.claims
        .get("sub")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|sub| !sub.is_empty())
        .map(str::to_string)
}

pub(crate) fn load_jwks() -> Option<jsonwebtoken::jwk::JwkSet> {
    if let Ok(raw) = env::var("MAESTRO_JWT_JWKS") {
        return serde_json::from_str(raw.trim()).ok();
    }
    let url = env::var("MAESTRO_JWT_JWKS_URL").ok()?;
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    // `reqwest::blocking` panics when used directly on a Tokio runtime thread.
    let url = url.to_string();
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || fetch_jwks_from_url(&url))
            .join()
            .ok()
            .flatten();
    }
    fetch_jwks_from_url(&url)
}

pub(crate) fn fetch_jwks_from_url(url: &str) -> Option<jsonwebtoken::jwk::JwkSet> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?
        .get(url)
        .header("accept", "application/json")
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()
}

pub(crate) fn jwt_claim_matches(payload: &Value, claim: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    match payload.get(claim) {
        Some(Value::String(value)) => value == expected,
        Some(Value::Array(values)) => values.iter().any(|value| value.as_str() == Some(expected)),
        _ => false,
    }
}

pub(crate) fn hmac_sha256_base64url(secret: &[u8], payload: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key sizes");
    mac.update(payload);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub(crate) fn hmac_sha256_hex(secret: &[u8], payload: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key sizes");
    mac.update(payload);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn runtime_session_cookie_value(config: &Config, subject: &str) -> Option<String> {
    runtime_session_cookie_value_for_payload(config, RUNTIME_SESSION_COOKIE_CONTEXT, subject)
}

pub(crate) fn runtime_session_api_key_cookie_value(config: &Config) -> Option<String> {
    runtime_session_cookie_value_for_payload(
        config,
        RUNTIME_SESSION_API_KEY_COOKIE_CONTEXT,
        "api-key",
    )
}

pub(crate) fn runtime_session_cookie_value_for_payload(
    config: &Config,
    context: &[u8],
    payload: &str,
) -> Option<String> {
    let api_key = config.api_key.as_deref()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(api_key.as_bytes()).ok()?;
    mac.update(context);
    mac.update(b":");
    mac.update(payload.as_bytes());
    let encoded_subject = URL_SAFE_NO_PAD.encode(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{encoded_subject}.{signature}"))
}
