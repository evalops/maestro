//! Exa-backed websearch and codesearch helpers.
//!
//! This module provides tools for web search and code search using the Exa API.
//!
//! # Requirements
//!
//! The `EXA_API_KEY` environment variable must be set. Get your key at
//! <https://dashboard.exa.ai/api-keys>
//!
//! # Tools
//!
//! - [`websearch`] - General web search with optional content extraction
//! - [`codesearch`] - Code-focused search returning examples and context

use serde::Deserialize;
use serde_json::Value;

use crate::agent::ToolResult;

const EXA_API_BASE: &str = "https://api.exa.ai";
const MAX_RESULT_TEXT_CHARS: usize = 800;
const MAX_OUTPUT_CHARS: usize = 6000;

fn get_exa_api_key() -> Result<String, String> {
    std::env::var("EXA_API_KEY").map_err(|_| {
        "EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys"
            .to_string()
    })
}

fn normalize_cost_dollars(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return normalize_cost_dollars(&parsed);
            }
            trimmed.parse::<f64>().ok()
        }
        Value::Object(map) => map.get("total").and_then(serde_json::Value::as_f64),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct WebsearchArgs {
    query: String,
    #[serde(default, alias = "numResults")]
    num_results: Option<u32>,
    #[serde(default, rename = "type")]
    search_type: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default, alias = "includeDomains")]
    include_domains: Option<Vec<String>>,
    #[serde(default, alias = "excludeDomains")]
    exclude_domains: Option<Vec<String>>,
    #[serde(default)]
    text: Option<Value>,
    #[serde(default)]
    summary: Option<Value>,
    #[serde(default)]
    highlights: Option<Value>,
    #[serde(default)]
    context: Option<Value>,
    #[serde(default, alias = "startPublishedDate")]
    start_published_date: Option<String>,
    #[serde(default, alias = "endPublishedDate")]
    end_published_date: Option<String>,
    #[serde(default)]
    livecrawl: Option<String>,
    #[serde(default)]
    subpages: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CodesearchArgs {
    query: String,
    #[serde(default, alias = "tokensNum")]
    tokens_num: Option<Value>,
}

pub async fn websearch(args: Value) -> ToolResult {
    let parsed: WebsearchArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => {
            return ToolResult::failure(format!("Invalid websearch arguments: {err}"));
        }
    };

    let api_key = match get_exa_api_key() {
        Ok(key) => key,
        Err(err) => return ToolResult::failure(err),
    };

    let mut body = serde_json::Map::new();
    body.insert("query".to_string(), Value::String(parsed.query.clone()));
    body.insert(
        "numResults".to_string(),
        Value::Number(serde_json::Number::from(parsed.num_results.unwrap_or(5))),
    );
    body.insert(
        "type".to_string(),
        Value::String(parsed.search_type.unwrap_or_else(|| "auto".to_string())),
    );

    if let Some(category) = parsed.category {
        body.insert("category".to_string(), Value::String(category));
    }
    if let Some(domains) = parsed.include_domains {
        body.insert(
            "includeDomains".to_string(),
            Value::Array(domains.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(domains) = parsed.exclude_domains {
        body.insert(
            "excludeDomains".to_string(),
            Value::Array(domains.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(date) = parsed.start_published_date {
        body.insert("startPublishedDate".to_string(), Value::String(date));
    }
    if let Some(date) = parsed.end_published_date {
        body.insert("endPublishedDate".to_string(), Value::String(date));
    }
    if let Some(livecrawl) = parsed.livecrawl {
        body.insert("livecrawl".to_string(), Value::String(livecrawl));
    }
    if let Some(subpages) = parsed.subpages {
        body.insert("subpages".to_string(), subpages);
    }

    let mut contents = serde_json::Map::new();
    if let Some(text) = parsed.text {
        contents.insert("text".to_string(), text);
    }
    if let Some(summary) = parsed.summary {
        contents.insert("summary".to_string(), summary);
    }
    if let Some(highlights) = parsed.highlights {
        contents.insert("highlights".to_string(), highlights);
    }
    if let Some(context) = parsed.context {
        contents.insert("context".to_string(), context);
    }
    if !contents.is_empty() {
        body.insert("contents".to_string(), Value::Object(contents));
    }

    let client = reqwest::Client::new();
    let response = match client
        .post(format!("{EXA_API_BASE}/search"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => {
            return ToolResult::failure(format!("Websearch failed: {err}"));
        }
    };

    let status = response.status();
    let data: Value = match response.json().await {
        Ok(json) => json,
        Err(err) => {
            return ToolResult::failure(format!(
                "Failed to parse websearch response (status {status}): {err}"
            ));
        }
    };

    if !status.is_success() {
        let message = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| data.get("message").and_then(|v| v.as_str()))
            .unwrap_or("Websearch failed");
        return ToolResult::failure(format!("Websearch error ({status}): {message}"));
    }

    let results = data
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let resolved_type = data
        .get("resolvedSearchType")
        .and_then(|v| v.as_str())
        .unwrap_or("auto");
    let context = data.get("context").and_then(|v| v.as_str()).unwrap_or("");
    let cost = data.get("costDollars").and_then(normalize_cost_dollars);
    let request_id = data.get("requestId").and_then(|v| v.as_str()).unwrap_or("");

    let mut output_lines = Vec::new();
    output_lines.push(format!("Results: {}", results.len()));
    if !resolved_type.is_empty() {
        output_lines.push(format!("Search type: {resolved_type}"));
    }
    if let Some(cost) = cost {
        output_lines.push(format!("Cost: ${cost:.4}"));
    }
    output_lines.push(String::new());

    for result in &results {
        let title = result
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled");
        let url = result.get("url").and_then(|v| v.as_str()).unwrap_or("");
        output_lines.push(format!("{title} - {url}"));
        if let Some(text) = result.get("text").and_then(|v| v.as_str()) {
            let snippet: String = text.chars().take(MAX_RESULT_TEXT_CHARS).collect();
            if !snippet.trim().is_empty() {
                output_lines.push(snippet);
            }
        } else if let Some(summary) = result.get("summary").and_then(|v| v.as_str()) {
            let snippet: String = summary.chars().take(MAX_RESULT_TEXT_CHARS).collect();
            if !snippet.trim().is_empty() {
                output_lines.push(snippet);
            }
        }
        output_lines.push(String::new());
    }

    if !context.trim().is_empty() {
        output_lines.push("Context:".to_string());
        output_lines.push(context.to_string());
    }

    let mut output = output_lines.join("\n");
    let mut truncated = false;
    if output.chars().count() > MAX_OUTPUT_CHARS {
        output = output.chars().take(MAX_OUTPUT_CHARS).collect::<String>();
        output.push_str("\n\n(truncated)");
        truncated = true;
    }

    let details = serde_json::json!({
        "requestId": request_id,
        "resolvedSearchType": resolved_type,
        "resultsCount": results.len(),
        "costDollars": cost,
        "context": if context.is_empty() { Value::Null } else { Value::String(context.to_string()) },
        "results": results,
        "truncated": truncated
    });

    ToolResult::success(output).with_details(details)
}

pub async fn codesearch(args: Value) -> ToolResult {
    let parsed: CodesearchArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid codesearch arguments: {err}")),
    };

    let api_key = match get_exa_api_key() {
        Ok(key) => key,
        Err(err) => return ToolResult::failure(err),
    };

    let tokens = parsed
        .tokens_num
        .unwrap_or_else(|| Value::String("dynamic".to_string()));
    let body = serde_json::json!({
        "query": parsed.query,
        "tokensNum": tokens
    });

    let client = reqwest::Client::new();
    let response = match client
        .post(format!("{EXA_API_BASE}/context"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => return ToolResult::failure(format!("Codesearch failed: {err}")),
    };

    let status = response.status();
    let data: Value = match response.json().await {
        Ok(json) => json,
        Err(err) => {
            return ToolResult::failure(format!(
                "Failed to parse codesearch response (status {status}): {err}"
            ));
        }
    };

    if !status.is_success() {
        let message = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .or_else(|| data.get("message").and_then(|v| v.as_str()))
            .unwrap_or("Codesearch failed");
        return ToolResult::failure(format!("Codesearch error ({status}): {message}"));
    }

    let response_text = data
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let results_count = data
        .get("resultsCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let output_tokens = data
        .get("outputTokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let search_time = data
        .get("searchTime")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let cost = data
        .get("costDollars")
        .and_then(normalize_cost_dollars)
        .unwrap_or(0.0);
    let request_id = data.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
    let query = data.get("query").and_then(|v| v.as_str()).unwrap_or("");

    let mut output_lines = Vec::new();
    output_lines.push(format!("Query: \"{query}\""));
    output_lines.push(format!(
        "Results: {results_count} sources, {output_tokens} tokens"
    ));
    output_lines.push(format!(
        "Search time: {:.2}s, Cost: ${:.4}",
        (search_time as f64) / 1000.0,
        cost
    ));
    output_lines.push(String::new());
    output_lines.push("Code Examples and Context:".to_string());
    output_lines.push("─".repeat(80));
    output_lines.push(String::new());
    output_lines.push(response_text.clone());

    let details = serde_json::json!({
        "requestId": request_id,
        "query": query,
        "resultsCount": results_count,
        "outputTokens": output_tokens,
        "searchTime": search_time,
        "costDollars": cost,
        "response": response_text
    });

    ToolResult::success(output_lines.join("\n")).with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // normalize_cost_dollars Tests
    // ========================================================================

    #[test]
    fn test_normalize_cost_number() {
        let value = serde_json::json!(0.0025);
        assert_eq!(normalize_cost_dollars(&value), Some(0.0025));
    }

    #[test]
    fn test_normalize_cost_string() {
        let value = serde_json::json!("0.0025");
        assert_eq!(normalize_cost_dollars(&value), Some(0.0025));
    }

    #[test]
    fn test_normalize_cost_string_with_whitespace() {
        let value = serde_json::json!("  0.0025  ");
        assert_eq!(normalize_cost_dollars(&value), Some(0.0025));
    }

    #[test]
    fn test_normalize_cost_object_with_total() {
        let value = serde_json::json!({"total": 0.05});
        assert_eq!(normalize_cost_dollars(&value), Some(0.05));
    }

    #[test]
    fn test_normalize_cost_empty_string() {
        let value = serde_json::json!("");
        assert_eq!(normalize_cost_dollars(&value), None);
    }

    #[test]
    fn test_normalize_cost_null() {
        let value = Value::Null;
        assert_eq!(normalize_cost_dollars(&value), None);
    }

    #[test]
    fn test_normalize_cost_array() {
        let value = serde_json::json!([1, 2, 3]);
        assert_eq!(normalize_cost_dollars(&value), None);
    }

    #[test]
    fn test_normalize_cost_nested_string_number() {
        // String containing a number that needs to be parsed
        let value = serde_json::json!("0.123");
        assert_eq!(normalize_cost_dollars(&value), Some(0.123));
    }

    // ========================================================================
    // WebsearchArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_websearch_args_minimal() {
        let json = serde_json::json!({"query": "rust programming"});
        let args: WebsearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "rust programming");
        assert!(args.num_results.is_none());
        assert!(args.search_type.is_none());
    }

    #[test]
    fn test_websearch_args_full() {
        let json = serde_json::json!({
            "query": "rust async",
            "numResults": 10,
            "type": "keyword",
            "category": "programming",
            "includeDomains": ["docs.rs", "crates.io"],
            "excludeDomains": ["example.com"],
            "startPublishedDate": "2024-01-01",
            "endPublishedDate": "2024-12-31",
            "livecrawl": "always"
        });
        let args: WebsearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "rust async");
        assert_eq!(args.num_results, Some(10));
        assert_eq!(args.search_type, Some("keyword".to_string()));
        assert_eq!(args.category, Some("programming".to_string()));
        assert_eq!(
            args.include_domains,
            Some(vec!["docs.rs".to_string(), "crates.io".to_string()])
        );
        assert_eq!(args.exclude_domains, Some(vec!["example.com".to_string()]));
    }

    #[test]
    fn test_websearch_args_with_content_options() {
        let json = serde_json::json!({
            "query": "test",
            "text": true,
            "summary": {"maxLength": 100},
            "highlights": true
        });
        let args: WebsearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "test");
        assert!(args.text.is_some());
        assert!(args.summary.is_some());
        assert!(args.highlights.is_some());
    }

    // ========================================================================
    // CodesearchArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_codesearch_args_minimal() {
        let json = serde_json::json!({"query": "how to parse JSON in rust"});
        let args: CodesearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "how to parse JSON in rust");
        assert!(args.tokens_num.is_none());
    }

    #[test]
    fn test_codesearch_args_with_tokens() {
        let json = serde_json::json!({
            "query": "async await pattern",
            "tokensNum": 5000
        });
        let args: CodesearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "async await pattern");
        assert!(args.tokens_num.is_some());
    }

    #[test]
    fn test_codesearch_args_dynamic_tokens() {
        let json = serde_json::json!({
            "query": "error handling",
            "tokensNum": "dynamic"
        });
        let args: CodesearchArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.query, "error handling");
        assert_eq!(args.tokens_num, Some(Value::String("dynamic".to_string())));
    }

    // ========================================================================
    // get_exa_api_key Tests
    // ========================================================================

    #[test]
    fn test_get_exa_api_key_not_set() {
        // Temporarily unset the key if it exists
        let original = std::env::var("EXA_API_KEY").ok();
        std::env::remove_var("EXA_API_KEY");

        let result = get_exa_api_key();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("EXA_API_KEY"));

        // Restore if it was set
        if let Some(key) = original {
            std::env::set_var("EXA_API_KEY", key);
        }
    }

    #[test]
    fn test_get_exa_api_key_set() {
        let original = std::env::var("EXA_API_KEY").ok();
        std::env::set_var("EXA_API_KEY", "test-key-123");

        let result = get_exa_api_key();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test-key-123");

        // Restore original state
        if let Some(key) = original {
            std::env::set_var("EXA_API_KEY", key);
        } else {
            std::env::remove_var("EXA_API_KEY");
        }
    }
}
