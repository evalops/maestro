use std::path::{Component, Path, PathBuf};

use crate::auth::{
    header_auth_matches, runtime_session_api_key_cookie_value, runtime_session_cookie_value,
    trusted_proxy_auth_subject, RUNTIME_SESSION_COOKIE_NAME,
};
use crate::http::{
    json_response, response_with_cache, response_with_cache_and_length,
    response_with_extra_headers_and_length, response_with_no_store,
    response_with_no_store_and_length, RequestHead,
};
use crate::Config;

pub(crate) const RUNTIME_CONFIG_SCRIPT_PATH: &str = "/__maestro/runtime-config.js";
pub(crate) const RUNTIME_CONFIG_SCRIPT_TAG: &str =
    r#"    <script src="/__maestro/runtime-config.js"></script>"#;

pub(crate) enum StaticPathResolution {
    Found(PathBuf),
    Missing,
    Forbidden,
}

pub(crate) fn is_static_asset_request(head: &RequestHead) -> bool {
    matches!(head.method.as_str(), "GET" | "HEAD") && !head.path.starts_with("/api/")
}

pub(crate) fn is_runtime_config_request(head: &RequestHead) -> bool {
    matches!(head.method.as_str(), "GET" | "HEAD") && head.path == RUNTIME_CONFIG_SCRIPT_PATH
}

pub(crate) fn runtime_config_response(head: &RequestHead, config: &Config) -> Vec<u8> {
    let body = runtime_config_script(config);
    if head.method == "HEAD" {
        response_with_no_store_and_length(
            200,
            "application/javascript; charset=utf-8",
            &[],
            body.len(),
        )
    } else {
        response_with_no_store(200, "application/javascript; charset=utf-8", &body)
    }
}

pub(crate) fn runtime_config_script(config: &Config) -> Vec<u8> {
    let csrf_token =
        serde_json::to_string(&config.csrf_token).unwrap_or_else(|_| "null".to_string());
    format!("delete window.__MAESTRO_API_KEY__;\nwindow.__MAESTRO_CSRF_TOKEN__ = {csrf_token};\n")
        .into_bytes()
}

pub(crate) fn should_inject_runtime_config(config: &Config) -> bool {
    config.api_key.is_some() || config.csrf_token.is_some()
}

pub(crate) fn spa_entry_body(bytes: &[u8], config: &Config) -> Vec<u8> {
    if !should_inject_runtime_config(config) {
        return bytes.to_vec();
    }
    let Ok(html) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    if html.contains(RUNTIME_CONFIG_SCRIPT_PATH) {
        return bytes.to_vec();
    }
    let Some(head_end) = html.find("</head>") else {
        return bytes.to_vec();
    };
    let mut updated = String::with_capacity(html.len() + RUNTIME_CONFIG_SCRIPT_TAG.len() + 1);
    updated.push_str(&html[..head_end]);
    updated.push_str(RUNTIME_CONFIG_SCRIPT_TAG);
    updated.push('\n');
    updated.push_str(&html[head_end..]);
    updated.into_bytes()
}

pub(crate) fn request_is_secure(head: &RequestHead) -> bool {
    let forwarded_proto = head
        .headers
        .get("x-forwarded-proto")
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("https"));
    let forwarded_scheme = head
        .headers
        .get("x-forwarded-scheme")
        .map(String::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("https"));
    let forwarded_ssl = head
        .headers
        .get("x-forwarded-ssl")
        .map(String::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("on"));
    forwarded_proto || forwarded_scheme || forwarded_ssl
}

pub(crate) fn spa_entry_session_cookie_value(
    head: &RequestHead,
    config: &Config,
) -> Option<String> {
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
        return runtime_session_api_key_cookie_value(config);
    }
    if let Some(subject) = trusted_proxy_auth_subject(head) {
        return runtime_session_cookie_value(config, &subject);
    }
    None
}

pub(crate) fn spa_entry_extra_headers(head: &RequestHead, config: &Config) -> String {
    let mut headers = "Cache-Control: no-store, no-cache, must-revalidate\r\n".to_string();
    if let Some(cookie_value) = spa_entry_session_cookie_value(head, config) {
        let secure = if request_is_secure(head) {
            "; Secure"
        } else {
            ""
        };
        headers.push_str(&format!(
            "Set-Cookie: {RUNTIME_SESSION_COOKIE_NAME}={cookie_value}; Path=/; HttpOnly; SameSite=Lax{secure}\r\n"
        ));
    }
    headers
}

pub(crate) fn spa_entry_response(
    head: &RequestHead,
    mime: &str,
    body: &[u8],
    config: &Config,
) -> Vec<u8> {
    let extra_headers = spa_entry_extra_headers(head, config);
    if head.method == "HEAD" {
        response_with_extra_headers_and_length(200, mime, &[], &extra_headers, body.len())
    } else {
        response_with_extra_headers_and_length(200, mime, body, &extra_headers, body.len())
    }
}

pub(crate) async fn static_response(head: &RequestHead, config: &Config) -> Vec<u8> {
    let Some(path) = resolve_static_path(&config.static_root, &head.path) else {
        return json_response(403, &serde_json::json!({ "error": "Forbidden" }));
    };

    match canonical_static_path(&config.static_root, &path).await {
        StaticPathResolution::Found(path) => match tokio::fs::read(&path).await {
            Ok(bytes) => {
                if is_spa_entry_path(&path) {
                    let body = spa_entry_body(&bytes, config);
                    spa_entry_response(head, mime_for_path(&path), &body, config)
                } else if head.method == "HEAD" {
                    response_with_cache_and_length(
                        200,
                        mime_for_path(&path),
                        &[],
                        config.static_cache_max_age,
                        bytes.len(),
                    )
                } else {
                    response_with_cache(
                        200,
                        mime_for_path(&path),
                        &bytes,
                        config.static_cache_max_age,
                    )
                }
            }
            Err(_) => json_response(
                404,
                &serde_json::json!({
                    "error": "Not found",
                    "staticRoot": config.static_root
                }),
            ),
        },
        StaticPathResolution::Forbidden => {
            json_response(403, &serde_json::json!({ "error": "Forbidden" }))
        }
        StaticPathResolution::Missing => {
            if !should_spa_fallback(head) {
                return json_response(
                    404,
                    &serde_json::json!({
                        "error": "Not found",
                        "staticRoot": config.static_root
                    }),
                );
            }
            let index = config.static_root.join("index.html");
            match canonical_static_path(&config.static_root, &index).await {
                StaticPathResolution::Found(index) => match tokio::fs::read(&index).await {
                    Ok(bytes) => {
                        let body = spa_entry_body(&bytes, config);
                        spa_entry_response(head, "text/html; charset=utf-8", &body, config)
                    }
                    Err(_) => json_response(
                        404,
                        &serde_json::json!({
                            "error": "Not found",
                            "staticRoot": config.static_root
                        }),
                    ),
                },
                StaticPathResolution::Forbidden => {
                    json_response(403, &serde_json::json!({ "error": "Forbidden" }))
                }
                StaticPathResolution::Missing => json_response(
                    404,
                    &serde_json::json!({
                        "error": "Not found",
                        "staticRoot": config.static_root
                    }),
                ),
            }
        }
    }
}

pub(crate) fn should_spa_fallback(head: &RequestHead) -> bool {
    let trimmed = head.path.trim_end_matches('/');
    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    !last_segment.contains('.')
}

pub(crate) async fn canonical_static_path(root: &Path, path: &Path) -> StaticPathResolution {
    let Ok(canonical_root) = tokio::fs::canonicalize(root).await else {
        return StaticPathResolution::Missing;
    };
    match tokio::fs::canonicalize(path).await {
        Ok(canonical_path) if canonical_path.starts_with(&canonical_root) => {
            StaticPathResolution::Found(canonical_path)
        }
        Ok(_) => StaticPathResolution::Forbidden,
        Err(_) => StaticPathResolution::Missing,
    }
}

pub(crate) fn resolve_static_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let trimmed = request_path.trim_start_matches('/');
    let mut relative = PathBuf::new();
    if trimmed.is_empty() {
        relative.push("index.html");
    } else {
        for component in Path::new(trimmed).components() {
            match component {
                Component::Normal(segment) => {
                    if segment.to_string_lossy().contains('\\') {
                        return None;
                    }
                    relative.push(segment);
                }
                _ => return None,
            }
        }
    }

    let candidate = root.join(&relative);
    let Some(canonical_root) = root.canonicalize().ok() else {
        return Some(candidate);
    };
    let existing = existing_static_ancestor(&candidate, root)?;
    if !existing.canonicalize().ok()?.starts_with(&canonical_root) {
        return None;
    }
    Some(candidate)
}

pub(crate) fn existing_static_ancestor<'a>(mut path: &'a Path, root: &'a Path) -> Option<&'a Path> {
    loop {
        if path.exists() {
            return Some(path);
        }
        if path == root {
            return None;
        }
        path = path.parent()?;
    }
}

pub(crate) fn is_spa_entry_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("index.html"))
}

pub(crate) fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}
