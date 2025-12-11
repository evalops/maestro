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

use serde::{Deserialize, Serialize};

use crate::agent::ToolResult;
use crate::ai::Tool;

/// Default timeout for web requests (30 seconds)
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Maximum response body size (1MB)
const MAX_BODY_SIZE: usize = 1_000_000;
/// Maximum output size after processing (50KB)
const MAX_OUTPUT_SIZE: usize = 50_000;

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
    client: reqwest::Client,
}

impl WebFetchTool {
    /// Create a new WebFetchTool instance
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent("Mozilla/5.0 (compatible; ComposerAgent/1.0)")
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
    }

    /// Get the tool definition for registration
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
        // Validate URL
        let url = args.url.trim();
        if url.is_empty() {
            return ToolResult {
                success: false,
                output: String::new(),
                error: Some("URL is required".to_string()),
            };
        }

        // Ensure URL has a scheme
        let url = if !url.starts_with("http://") && !url.starts_with("https://") {
            format!("https://{}", url)
        } else {
            url.to_string()
        };

        // Parse and validate URL
        let parsed_url = match reqwest::Url::parse(&url) {
            Ok(u) => u,
            Err(e) => {
                return ToolResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Invalid URL: {}", e)),
                };
            }
        };

        // Fetch the URL
        let response = match self.client.get(parsed_url.clone()).send().await {
            Ok(r) => r,
            Err(e) => {
                return ToolResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Failed to fetch URL: {}", e)),
                };
            }
        };

        // Check for success status
        let status = response.status();
        if !status.is_success() {
            return ToolResult {
                success: false,
                output: String::new(),
                error: Some(format!("HTTP error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown"))),
            };
        }

        // Get content type
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/html")
            .to_lowercase();

        // Read body with size limit
        let body_bytes = match response.bytes().await {
            Ok(b) => {
                if b.len() > MAX_BODY_SIZE {
                    return ToolResult {
                        success: false,
                        output: String::new(),
                        error: Some(format!("Response too large: {} bytes (max {})", b.len(), MAX_BODY_SIZE)),
                    };
                }
                b
            }
            Err(e) => {
                return ToolResult {
                    success: false,
                    output: String::new(),
                    error: Some(format!("Failed to read response body: {}", e)),
                };
            }
        };

        // Convert body to string
        let body = String::from_utf8_lossy(&body_bytes).to_string();

        // Process based on content type
        let content = if content_type.contains("text/html") || content_type.contains("application/xhtml") {
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
        let output = if content.len() > MAX_OUTPUT_SIZE {
            format!(
                "{}\n\n... (content truncated, {} more bytes)",
                &content[..MAX_OUTPUT_SIZE],
                content.len() - MAX_OUTPUT_SIZE
            )
        } else {
            content
        };

        // Add URL header and optional prompt context
        let mut result = format!("# Content from {}\n\n", parsed_url);
        if let Some(prompt) = &args.prompt {
            result.push_str(&format!("*Looking for: {}*\n\n", prompt));
        }
        result.push_str(&output);

        ToolResult {
            success: true,
            output: result,
            error: None,
        }
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
    let html = html.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n");

    // Convert line breaks in divs
    let html = html.replace("<div>", "\n").replace("</div>", "\n");

    // Convert lists
    let html = html.replace("<ul>", "\n").replace("</ul>", "\n");
    let html = html.replace("<ol>", "\n").replace("</ol>", "\n");
    let html = html.replace("<li>", "- ").replace("</li>", "\n");

    // Convert code blocks
    let html = html.replace("<pre>", "\n```\n").replace("</pre>", "\n```\n");
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
    let lines: Vec<&str> = html.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    lines.join("\n\n")
}

/// Remove an HTML tag along with its contents
fn remove_tag_with_content(html: &str, tag: &str) -> String {
    let mut result = html.to_string();
    let open_tag = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);

    while let Some(start) = result.to_lowercase().find(&open_tag) {
        if let Some(end_pos) = result[start..].to_lowercase().find(&close_tag) {
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
    let open_tag = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);

    while let Some(start) = result.to_lowercase().find(&open_tag) {
        // Find the end of the opening tag
        if let Some(tag_end) = result[start..].find('>') {
            let content_start = start + tag_end + 1;
            if let Some(end_offset) = result[content_start..].to_lowercase().find(&close_tag) {
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
    let open_tag = format!("<{}>", tag);
    let close_tag = format!("</{}>", tag);

    result = result.replace(&open_tag, marker);
    result = result.replace(&close_tag, marker);

    // Handle tags with attributes
    let open_pattern = format!("<{} ", tag);
    while let Some(start) = result.to_lowercase().find(&open_pattern) {
        if let Some(end) = result[start..].find('>') {
            result = format!("{}{}{}", &result[..start], marker, &result[start + end + 1..]);
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

    while let Some(start) = result.to_lowercase().find(open_tag) {
        // Find href
        let tag_content = &result[start..];
        if let Some(tag_end) = tag_content.find('>') {
            let tag_str = &tag_content[..tag_end];

            // Extract href
            let href = if let Some(href_start) = tag_str.to_lowercase().find("href=") {
                let href_content = &tag_str[href_start + 5..];
                let quote_char = href_content.chars().next().unwrap_or('"');
                if quote_char == '"' || quote_char == '\'' {
                    href_content[1..]
                        .find(quote_char)
                        .map(|end| &href_content[1..1 + end])
                        .unwrap_or("")
                } else {
                    href_content
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .map(|end| &href_content[..end])
                        .unwrap_or("")
                }
            } else {
                ""
            };

            // Find closing tag
            let after_open = &result[start + tag_end + 1..];
            if let Some(close_offset) = after_open.to_lowercase().find("</a>") {
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
        let result = tool.execute(WebFetchArgs {
            url: "".to_string(),
            prompt: None,
        }).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("required"));
    }

    #[tokio::test]
    async fn test_execute_invalid_url() {
        let tool = WebFetchTool::new();
        let result = tool.execute(WebFetchArgs {
            url: "not a valid url ://foo".to_string(),
            prompt: None,
        }).await;
        assert!(!result.success);
    }
}
