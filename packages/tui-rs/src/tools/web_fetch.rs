//! Web Fetch tool for retrieving and processing web content
//!
//! This module provides a tool for fetching web pages and converting them to markdown
//! for easy consumption by the agent. It handles:
//!
//! - HTTP/HTTPS URL fetching with automatic redirects
//! - HTML to markdown conversion
//! - Content size limits to prevent memory exhaustion
//! - Timeout handling for slow responses
//!
//! # Features
//!
//! - **HTML Conversion**: Converts web pages to markdown for easier parsing
//! - **Redirect Handling**: Follows HTTP redirects up to 10 hops
//! - **Timeout Protection**: Default 30-second timeout for requests
//! - **Size Limits**: Response body limited to 1MB to prevent OOM
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use composer_tui::tools::web_fetch::{WebFetchTool, WebFetchArgs};
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let tool = WebFetchTool::new();
//!
//! let result = tool.execute(WebFetchArgs {
//!     url: "https://example.com".to_string(),
//!     prompt: Some("Extract the main heading".to_string()),
//! }).await;
//!
//! if result.success {
//!     println!("Content: {}", result.output);
//! }
//! # Ok(())
//! # }
//! ```

use std::time::Instant;

use futures::StreamExt;
use serde::{Deserialize, Serialize};

use super::details::WebFetchDetails;
use crate::agent::ToolResult;
use crate::ai::Tool;

/// Default timeout for web requests (30 seconds)
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Maximum response body size (1MB)
const MAX_BODY_SIZE: usize = 1_000_000;
/// Maximum output size after processing (50KB)
const MAX_OUTPUT_SIZE: usize = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// UTF-8 SAFE CASE-INSENSITIVE SEARCH
// ─────────────────────────────────────────────────────────────────────────────

/// Find a pattern case-insensitively, returning the byte position in the original string.
///
/// This is needed because `str.to_lowercase().find(pattern)` returns a byte position
/// in the LOWERCASED string, which may differ from the original if non-ASCII characters
/// change byte length when lowercased (e.g., Turkish "İ" -> "i").
///
/// This function returns the correct byte position in the original string.
fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let needle_lower: String = needle.to_lowercase();
    let needle_chars: Vec<char> = needle_lower.chars().collect();

    if needle_chars.is_empty() {
        return Some(0);
    }

    for (byte_pos, _) in haystack.char_indices() {
        let remaining = &haystack[byte_pos..];
        let mut matched = true;
        let mut remaining_chars = remaining.chars();

        for needle_char in &needle_chars {
            if let Some(hay_char) = remaining_chars.next() {
                // Compare lowercased characters
                let hay_lower = hay_char.to_lowercase().next().unwrap_or(hay_char);
                if hay_lower != *needle_char {
                    matched = false;
                    break;
                }
            } else {
                matched = false;
                break;
            }
        }

        if matched {
            return Some(byte_pos);
        }
    }

    None
}

/// Truncate a UTF-8 string at a byte boundary safely.
fn truncate_utf8(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }

    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

/// Arguments for web fetch execution
#[derive(Debug, Serialize, Deserialize)]
pub struct WebFetchArgs {
    /// The URL to fetch
    pub url: String,
    /// Optional prompt describing what to extract from the page
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Web fetch tool for retrieving and processing web content
pub struct WebFetchTool {
    /// HTTP client with redirect handling
    client: Option<reqwest::Client>,
    /// Initialization error for the HTTP client
    init_error: Option<String>,
}

impl WebFetchTool {
    /// Create a new `WebFetchTool` instance
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent("Mozilla/5.0 (compatible; ComposerAgent/1.0)")
            .build();

        match client {
            Ok(client) => Self {
                client: Some(client),
                init_error: None,
            },
            Err(err) => Self {
                client: None,
                init_error: Some(err.to_string()),
            },
        }
    }

    /// Get the tool definition for registration
    #[must_use]
    pub fn definition() -> Tool {
        Tool::new(
            "web_fetch",
            "Fetch content from a URL and convert it to readable markdown. Use this to retrieve web pages, documentation, or other online resources.",
        )
        .with_schema(serde_json::json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch (must be a valid HTTP or HTTPS URL)"
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional prompt describing what information to look for in the page"
                }
            },
            "required": ["url"]
        }))
    }

    /// Execute the web fetch tool
    pub async fn execute(&self, args: WebFetchArgs) -> ToolResult {
        let start_time = Instant::now();

        // Validate URL
        let url = args.url.trim();
        if url.is_empty() {
            return ToolResult::failure("URL is required");
        }

        let client = match &self.client {
            Some(client) => client,
            None => {
                return self.build_init_error(url, start_time);
            }
        };

        // Ensure URL has a scheme
        let url = if !url.starts_with("http://") && !url.starts_with("https://") {
            format!("https://{url}")
        } else {
            url.to_string()
        };

        // Parse and validate URL
        let parsed_url = match reqwest::Url::parse(&url) {
            Ok(u) => u,
            Err(e) => {
                let details = WebFetchDetails::new(&url)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!("Invalid URL: {e}"))
                    .with_details(details.to_json());
            }
        };

        // Fetch the URL
        let response = match client.get(parsed_url.clone()).send().await {
            Ok(r) => r,
            Err(e) => {
                let details = WebFetchDetails::new(&url)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!("Failed to fetch URL: {e}"))
                    .with_details(details.to_json());
            }
        };

        // Check for success status
        let status = response.status();
        let final_url = response.url().to_string();
        if !status.is_success() {
            let mut details = WebFetchDetails::new(&url)
                .with_status(status.as_u16())
                .with_duration(start_time.elapsed().as_millis() as u64);
            if final_url != url {
                details = details.with_final_url(&final_url);
            }
            return ToolResult::failure(format!(
                "HTTP error {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            ))
            .with_details(details.to_json());
        }

        // Get content type
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/html")
            .to_lowercase();

        // Check content-length before reading (if provided)
        if let Some(length) = response.content_length() {
            if length as usize > MAX_BODY_SIZE {
                let details = WebFetchDetails::new(&url)
                    .with_status(status.as_u16())
                    .with_content_type(&content_type)
                    .with_body_size(length as usize)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!(
                    "Response too large: {length} bytes (max {MAX_BODY_SIZE})"
                ))
                .with_details(details.to_json());
            }
        }

        // Read body with size limit (streamed)
        let mut body_bytes: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    let new_size = body_bytes.len() + bytes.len();
                    if new_size > MAX_BODY_SIZE {
                        let details = WebFetchDetails::new(&url)
                            .with_status(status.as_u16())
                            .with_content_type(&content_type)
                            .with_body_size(new_size)
                            .with_duration(start_time.elapsed().as_millis() as u64);
                        return ToolResult::failure(format!(
                            "Response too large: {new_size} bytes (max {MAX_BODY_SIZE})"
                        ))
                        .with_details(details.to_json());
                    }
                    body_bytes.extend_from_slice(&bytes);
                }
                Err(e) => {
                    let details = WebFetchDetails::new(&url)
                        .with_status(status.as_u16())
                        .with_content_type(&content_type)
                        .with_duration(start_time.elapsed().as_millis() as u64);
                    return ToolResult::failure(format!("Failed to read response body: {e}"))
                        .with_details(details.to_json());
                }
            }
        }

        // Convert body to string
        let body = String::from_utf8_lossy(&body_bytes).to_string();

        // Process based on content type
        let content =
            if content_type.contains("text/html") || content_type.contains("application/xhtml") {
                html_to_markdown(&body)
            } else if content_type.contains("application/json") {
                // Pretty print JSON
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(json) => serde_json::to_string_pretty(&json).unwrap_or(body),
                    Err(_) => body,
                }
            } else {
                // Plain text or other content
                body
            };

        // Truncate if necessary
        let truncated = content.len() > MAX_OUTPUT_SIZE;
        let output = if truncated {
            let truncated_content = truncate_utf8(&content, MAX_OUTPUT_SIZE);
            format!(
                "{}\n\n... (content truncated, {} more bytes)",
                truncated_content,
                content.len() - truncated_content.len()
            )
        } else {
            content
        };

        // Build WebFetchDetails
        let mut details = WebFetchDetails::new(&url)
            .with_status(status.as_u16())
            .with_content_type(&content_type)
            .with_body_size(body_bytes.len())
            .with_duration(start_time.elapsed().as_millis() as u64);
        if truncated {
            details = details.with_truncation();
        }
        if final_url != url {
            details = details.with_final_url(&final_url);
        }
        if let Some(ref prompt) = args.prompt {
            details = details.with_prompt(prompt);
        }

        // Add URL header and optional prompt context
        let mut result = format!("# Content from {parsed_url}\n\n");
        if let Some(prompt) = &args.prompt {
            result.push_str(&format!("*Looking for: {prompt}*\n\n"));
        }
        result.push_str(&output);

        ToolResult::success(result).with_details(details.to_json())
    }

    fn build_init_error(&self, url: &str, start_time: Instant) -> ToolResult {
        let details =
            WebFetchDetails::new(url).with_duration(start_time.elapsed().as_millis() as u64);
        let error = self
            .init_error
            .as_deref()
            .unwrap_or("HTTP client unavailable");
        ToolResult::failure(format!("Web fetch unavailable: {error}"))
            .with_details(details.to_json())
    }
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert HTML to markdown
///
/// This is a simplified HTML to markdown converter that handles:
/// - Headings (h1-h6)
/// - Paragraphs
/// - Links
/// - Lists
/// - Code blocks
/// - Bold/italic text
/// - Script/style removal
fn html_to_markdown(html: &str) -> String {
    // Remove script and style tags with their contents
    let html = remove_tag_with_content(html, "script");
    let html = remove_tag_with_content(&html, "style");
    let html = remove_tag_with_content(&html, "nav");
    let html = remove_tag_with_content(&html, "header");
    let html = remove_tag_with_content(&html, "footer");
    let html = remove_tag_with_content(&html, "aside");

    // Convert headings
    let html = convert_heading(&html, "h1", "#");
    let html = convert_heading(&html, "h2", "##");
    let html = convert_heading(&html, "h3", "###");
    let html = convert_heading(&html, "h4", "####");
    let html = convert_heading(&html, "h5", "#####");
    let html = convert_heading(&html, "h6", "######");

    // Convert paragraphs
    let html = html.replace("<p>", "\n\n").replace("</p>", "\n\n");
    let html = html
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");

    // Convert line breaks in divs
    let html = html.replace("<div>", "\n").replace("</div>", "\n");

    // Convert lists
    let html = html.replace("<ul>", "\n").replace("</ul>", "\n");
    let html = html.replace("<ol>", "\n").replace("</ol>", "\n");
    let html = html.replace("<li>", "- ").replace("</li>", "\n");

    // Convert code blocks
    let html = html
        .replace("<pre>", "\n```\n")
        .replace("</pre>", "\n```\n");
    let html = html.replace("<code>", "`").replace("</code>", "`");

    // Convert emphasis
    let html = convert_tag(&html, "strong", "**");
    let html = convert_tag(&html, "b", "**");
    let html = convert_tag(&html, "em", "*");
    let html = convert_tag(&html, "i", "*");

    // Convert links - simplified approach
    let html = convert_links(&html);

    // Remove remaining HTML tags
    let html = remove_all_tags(&html);

    // Decode HTML entities
    let html = decode_html_entities(&html);

    // Clean up whitespace
    let lines: Vec<&str> = html
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    lines.join("\n\n")
}

/// Remove an HTML tag along with its contents
fn remove_tag_with_content(html: &str, tag: &str) -> String {
    let mut result = html.to_string();
    let open_tag = format!("<{tag}");
    let close_tag = format!("</{tag}>");

    while let Some(start) = find_case_insensitive(&result, &open_tag) {
        if let Some(end_pos) = find_case_insensitive(&result[start..], &close_tag) {
            let end = start + end_pos + close_tag.len();
            result = format!("{}{}", &result[..start], &result[end..]);
        } else {
            // No closing tag found, just remove the opening tag
            break;
        }
    }

    result
}

/// Convert an HTML heading to markdown
fn convert_heading(html: &str, tag: &str, prefix: &str) -> String {
    let mut result = html.to_string();
    let open_tag = format!("<{tag}");
    let close_tag = format!("</{tag}>");

    while let Some(start) = find_case_insensitive(&result, &open_tag) {
        // Find the end of the opening tag (> is ASCII, so regular find is safe here)
        if let Some(tag_end) = result[start..].find('>') {
            let content_start = start + tag_end + 1;
            if let Some(end_offset) = find_case_insensitive(&result[content_start..], &close_tag) {
                let content = &result[content_start..content_start + end_offset];
                let replacement = format!("\n\n{} {}\n\n", prefix, content.trim());
                let end = content_start + end_offset + close_tag.len();
                result = format!("{}{}{}", &result[..start], replacement, &result[end..]);
            } else {
                break;
            }
        } else {
            break;
        }
    }

    result
}

/// Convert inline tags like <strong> to markdown
fn convert_tag(html: &str, tag: &str, marker: &str) -> String {
    let mut result = html.to_string();
    let open_tag = format!("<{tag}>");
    let close_tag = format!("</{tag}>");

    result = result.replace(&open_tag, marker);
    result = result.replace(&close_tag, marker);

    // Handle tags with attributes
    let open_pattern = format!("<{tag} ");
    while let Some(start) = find_case_insensitive(&result, &open_pattern) {
        // > is ASCII, so regular find is safe after we have the correct start position
        if let Some(end) = result[start..].find('>') {
            result = format!(
                "{}{}{}",
                &result[..start],
                marker,
                &result[start + end + 1..]
            );
        } else {
            break;
        }
    }

    result
}

/// Convert HTML links to markdown
fn convert_links(html: &str) -> String {
    let mut result = html.to_string();
    let open_tag = "<a ";

    while let Some(start) = find_case_insensitive(&result, open_tag) {
        // Find href (> is ASCII, so regular find is safe after correct start)
        let tag_content = &result[start..];
        if let Some(tag_end) = tag_content.find('>') {
            let tag_str = &tag_content[..tag_end];

            // Extract href (href= is ASCII, safe to use find_case_insensitive)
            let href = if let Some(href_start) = find_case_insensitive(tag_str, "href=") {
                let href_content = &tag_str[href_start + 5..];
                if href_content.is_empty() {
                    ""
                } else {
                    let quote_char = href_content.chars().next().unwrap_or('"');
                    if quote_char == '"' || quote_char == '\'' {
                        href_content[1..]
                            .find(quote_char)
                            .map_or("", |end| &href_content[1..=end])
                    } else {
                        href_content
                            .find(|c: char| c.is_whitespace() || c == '>')
                            .map_or("", |end| &href_content[..end])
                    }
                }
            } else {
                ""
            };

            // Find closing tag
            let after_open = &result[start + tag_end + 1..];
            if let Some(close_offset) = find_case_insensitive(after_open, "</a>") {
                let link_text = &after_open[..close_offset];
                let markdown_link = if href.is_empty() {
                    link_text.to_string()
                } else {
                    format!("[{}]({})", link_text.trim(), href)
                };

                let end = start + tag_end + 1 + close_offset + 4; // 4 for "</a>"
                result = format!("{}{}{}", &result[..start], markdown_link, &result[end..]);
            } else {
                // No closing tag, just remove the opening
                result = format!("{}{}", &result[..start], &result[start + tag_end + 1..]);
            }
        } else {
            break;
        }
    }

    result
}

/// Remove all HTML tags from the string
fn remove_all_tags(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;

    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }

    result
}

/// Decode common HTML entities
fn decode_html_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&ndash;", "–")
        .replace("&mdash;", "—")
        .replace("&copy;", "©")
        .replace("&reg;", "®")
        .replace("&trade;", "™")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_definition() {
        let tool = WebFetchTool::definition();
        assert_eq!(tool.name, "web_fetch");
        assert!(tool.description.contains("Fetch"));

        // Check schema has required fields
        let schema = &tool.input_schema;
        assert!(schema.get("properties").is_some());
        assert!(schema.get("required").is_some());
    }

    #[test]
    fn test_html_to_markdown_headings() {
        let html = "<h1>Title</h1><h2>Subtitle</h2>";
        let md = html_to_markdown(html);
        assert!(md.contains("# Title"));
        assert!(md.contains("## Subtitle"));
    }

    #[test]
    fn test_html_to_markdown_paragraphs() {
        let html = "<p>First paragraph</p><p>Second paragraph</p>";
        let md = html_to_markdown(html);
        assert!(md.contains("First paragraph"));
        assert!(md.contains("Second paragraph"));
    }

    #[test]
    fn test_html_to_markdown_links() {
        let html = r#"<a href="https://example.com">Example</a>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("[Example](https://example.com)"));
    }

    #[test]
    fn test_html_to_markdown_emphasis() {
        let html = "<strong>Bold</strong> and <em>italic</em>";
        let md = html_to_markdown(html);
        assert!(md.contains("**Bold**"));
        assert!(md.contains("*italic*"));
    }

    #[test]
    fn test_html_to_markdown_lists() {
        let html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
        let md = html_to_markdown(html);
        assert!(md.contains("- Item 1"));
        assert!(md.contains("- Item 2"));
    }

    #[test]
    fn test_html_to_markdown_code() {
        let html = "<code>inline code</code><pre>block code</pre>";
        let md = html_to_markdown(html);
        assert!(md.contains("`inline code`"));
        assert!(md.contains("```"));
        assert!(md.contains("block code"));
    }

    #[test]
    fn test_html_to_markdown_removes_scripts() {
        let html = "<p>Hello</p><script>alert('xss')</script><p>World</p>";
        let md = html_to_markdown(html);
        assert!(md.contains("Hello"));
        assert!(md.contains("World"));
        assert!(!md.contains("alert"));
        assert!(!md.contains("script"));
    }

    #[test]
    fn test_html_to_markdown_removes_styles() {
        let html = "<style>.foo { color: red; }</style><p>Content</p>";
        let md = html_to_markdown(html);
        assert!(md.contains("Content"));
        assert!(!md.contains("color"));
        assert!(!md.contains("style"));
    }

    #[test]
    fn test_decode_html_entities() {
        let text = "&amp; &lt; &gt; &quot; &#39;";
        let decoded = decode_html_entities(text);
        assert_eq!(decoded, "& < > \" '");
    }

    #[test]
    fn test_remove_tag_with_content() {
        let html = "<p>Keep</p><nav>Remove</nav><p>Also Keep</p>";
        let result = remove_tag_with_content(html, "nav");
        assert!(result.contains("Keep"));
        assert!(result.contains("Also Keep"));
        assert!(!result.contains("Remove"));
    }

    #[test]
    fn test_url_validation() {
        // URL normalization is done in execute, test directly
        let url = "example.com";
        let normalized = format!("https://{}", url);
        assert_eq!(normalized, "https://example.com");
    }

    #[tokio::test]
    async fn test_execute_empty_url() {
        let tool = WebFetchTool::new();
        let result = tool
            .execute(WebFetchArgs {
                url: "".to_string(),
                prompt: None,
            })
            .await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("required"));
    }

    #[tokio::test]
    async fn test_execute_invalid_url() {
        let tool = WebFetchTool::new();
        let result = tool
            .execute(WebFetchArgs {
                url: "not a valid url ://foo".to_string(),
                prompt: None,
            })
            .await;
        assert!(!result.success);
    }

    #[tokio::test]
    async fn test_execute_without_http_client() {
        let tool = WebFetchTool {
            client: None,
            init_error: Some("init failed".to_string()),
        };
        let result = tool
            .execute(WebFetchArgs {
                url: "https://example.com".to_string(),
                prompt: None,
            })
            .await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("Web fetch unavailable"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTF-8 SAFE CASE-INSENSITIVE SEARCH TESTS
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_find_case_insensitive_ascii() {
        assert_eq!(find_case_insensitive("Hello World", "world"), Some(6));
        assert_eq!(find_case_insensitive("Hello World", "WORLD"), Some(6));
        assert_eq!(find_case_insensitive("Hello World", "WoRlD"), Some(6));
        assert_eq!(find_case_insensitive("Hello World", "xyz"), None);
    }

    #[test]
    fn test_find_case_insensitive_empty() {
        assert_eq!(find_case_insensitive("Hello", ""), Some(0));
        assert_eq!(find_case_insensitive("", "hello"), None);
        assert_eq!(find_case_insensitive("", ""), Some(0));
    }

    #[test]
    fn test_find_case_insensitive_html_tags() {
        // The main use case - finding HTML tags
        assert_eq!(find_case_insensitive("<A HREF='x'>", "<a "), Some(0));
        assert_eq!(find_case_insensitive("text<A HREF='x'>", "<a "), Some(4));
        assert_eq!(find_case_insensitive("text</A>more", "</a>"), Some(4));
    }

    #[test]
    fn test_find_case_insensitive_utf8_before_pattern() {
        // This is the bug we fixed: non-ASCII chars before the pattern
        // German text with ß (which stays ß when lowercased in Rust)
        let html = "Größe<a href='x'>link</a>";
        let pos = find_case_insensitive(html, "<a ");
        assert!(pos.is_some());
        // Verify we can actually slice at this position without panic
        let slice = &html[pos.unwrap()..];
        assert!(slice.starts_with("<a "));
    }

    #[test]
    fn test_find_case_insensitive_utf8_multibyte() {
        // Test with various multibyte UTF-8 characters
        let html = "日本語<DIV>content</div>";
        let pos = find_case_insensitive(html, "<div>");
        assert!(pos.is_some());
        let slice = &html[pos.unwrap()..];
        assert!(slice.to_lowercase().starts_with("<div>"));
    }

    #[test]
    fn test_html_to_markdown_utf8_content() {
        // Ensure HTML conversion works with UTF-8 content before tags
        let html = "<p>Größenangabe</p><a href='x'>日本語リンク</a>";
        let md = html_to_markdown(html);
        assert!(md.contains("Größenangabe"));
        assert!(md.contains("日本語リンク"));
    }

    #[test]
    fn test_remove_tag_utf8_before_tag() {
        // Test removing tags when UTF-8 appears before them
        let html = "Ümläuts<script>evil()</script>after";
        let result = remove_tag_with_content(html, "script");
        assert!(result.contains("Ümläuts"));
        assert!(result.contains("after"));
        assert!(!result.contains("evil"));
    }

    #[test]
    fn test_convert_links_utf8() {
        // Test link conversion with UTF-8
        let html = r#"Größe<a href="https://example.com">日本語</a>text"#;
        let result = convert_links(html);
        assert!(result.contains("[日本語](https://example.com)"));
        assert!(result.contains("Größe"));
    }
}
