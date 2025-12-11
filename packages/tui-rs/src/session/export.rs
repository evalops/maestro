//! Session Export Functionality
//!
//! Provides export capabilities for sessions in multiple formats:
//! - Markdown (readable documentation)
//! - HTML (shareable web page)
//! - JSON (structured data)
//! - Plain text (simple copy/paste)

use std::fmt::Write as FmtWrite;
use std::io::{self, Write};

use chrono::DateTime;

use super::entries::{
    AppMessage, ContentBlock, MessageContent, SessionHeader, SessionMeta, SessionStats,
    ThinkingLevel,
};
use super::reader::{ParsedSession, SessionReader};

/// Export format options
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// Markdown format (human-readable)
    Markdown,
    /// HTML format (shareable web page)
    Html,
    /// JSON format (structured data)
    Json,
    /// Plain text (simple)
    PlainText,
}

impl ExportFormat {
    /// Get file extension for this format
    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Html => "html",
            ExportFormat::Json => "json",
            ExportFormat::PlainText => "txt",
        }
    }

    /// Get MIME type for this format
    pub fn mime_type(&self) -> &'static str {
        match self {
            ExportFormat::Markdown => "text/markdown",
            ExportFormat::Html => "text/html",
            ExportFormat::Json => "application/json",
            ExportFormat::PlainText => "text/plain",
        }
    }
}

/// Options for session export
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Export format
    pub format: ExportFormat,
    /// Include thinking blocks
    pub include_thinking: bool,
    /// Include tool calls
    pub include_tool_calls: bool,
    /// Include tool results
    pub include_tool_results: bool,
    /// Include usage statistics
    pub include_usage: bool,
    /// Include timestamps
    pub include_timestamps: bool,
    /// Custom title (overrides session title)
    pub title: Option<String>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Markdown,
            include_thinking: false,
            include_tool_calls: true,
            include_tool_results: false,
            include_usage: true,
            include_timestamps: true,
            title: None,
        }
    }
}

impl ExportOptions {
    /// Create options for markdown export
    pub fn markdown() -> Self {
        Self {
            format: ExportFormat::Markdown,
            ..Default::default()
        }
    }

    /// Create options for HTML export
    pub fn html() -> Self {
        Self {
            format: ExportFormat::Html,
            ..Default::default()
        }
    }

    /// Create options for JSON export
    pub fn json() -> Self {
        Self {
            format: ExportFormat::Json,
            include_thinking: true,
            include_tool_calls: true,
            include_tool_results: true,
            ..Default::default()
        }
    }

    /// Create options for plain text export
    pub fn plain_text() -> Self {
        Self {
            format: ExportFormat::PlainText,
            include_thinking: false,
            include_tool_calls: false,
            include_tool_results: false,
            include_usage: false,
            include_timestamps: false,
            ..Default::default()
        }
    }

    /// Set custom title
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Include thinking blocks
    pub fn with_thinking(mut self, include: bool) -> Self {
        self.include_thinking = include;
        self
    }
}

/// Session exporter
pub struct SessionExporter<'a> {
    header: &'a SessionHeader,
    messages: &'a [AppMessage],
    meta: Option<&'a SessionMeta>,
    stats: &'a SessionStats,
    options: ExportOptions,
}

impl<'a> SessionExporter<'a> {
    /// Create a new exporter for a session
    pub fn new(
        header: &'a SessionHeader,
        messages: &'a [AppMessage],
        meta: Option<&'a SessionMeta>,
        stats: &'a SessionStats,
        options: ExportOptions,
    ) -> Self {
        Self {
            header,
            messages,
            meta,
            stats,
            options,
        }
    }

    /// Create exporter from a parsed session
    pub fn from_session(session: &'a ParsedSession, options: ExportOptions) -> Self {
        Self {
            header: &session.header,
            messages: &session.messages,
            meta: session.meta.as_ref(),
            stats: &session.stats,
            options,
        }
    }

    /// Export session to a string
    pub fn export_to_string(&self) -> String {
        match self.options.format {
            ExportFormat::Markdown => self.to_markdown(),
            ExportFormat::Html => self.to_html(),
            ExportFormat::Json => self.to_json(),
            ExportFormat::PlainText => self.to_plain_text(),
        }
    }

    /// Export session to a writer
    pub fn export_to_writer<W: Write>(&self, writer: &mut W) -> io::Result<()> {
        writer.write_all(self.export_to_string().as_bytes())
    }

    /// Export to Markdown format
    fn to_markdown(&self) -> String {
        let mut md = String::new();

        // Title
        let title = self
            .options
            .title
            .as_deref()
            .or(self.meta.and_then(|m| m.title.as_deref()))
            .unwrap_or("Conversation");
        writeln!(md, "# {}\n", title).unwrap();

        // Metadata
        writeln!(md, "**Model:** {}  ", self.header.model).unwrap();
        writeln!(
            md,
            "**Date:** {}  ",
            format_timestamp(&self.header.timestamp)
        )
        .unwrap();
        if self.header.thinking_level != ThinkingLevel::Off {
            writeln!(md, "**Thinking:** {}  ", self.header.thinking_level.label()).unwrap();
        }
        writeln!(md).unwrap();

        // Stats
        if self.options.include_usage {
            writeln!(md, "---").unwrap();
            writeln!(
                md,
                "**Stats:** {} user messages, {} assistant messages",
                self.stats.user_messages, self.stats.assistant_messages
            )
            .unwrap();
            if self.stats.total_input_tokens > 0 {
                writeln!(
                    md,
                    "**Tokens:** {} in, {} out",
                    self.stats.total_input_tokens, self.stats.total_output_tokens
                )
                .unwrap();
            }
            if self.stats.total_cost > 0.0 {
                writeln!(md, "**Cost:** ${:.4}", self.stats.total_cost).unwrap();
            }
            writeln!(md).unwrap();
        }

        writeln!(md, "---\n").unwrap();

        // Messages
        for msg in self.messages {
            self.write_message_markdown(&mut md, msg);
        }

        // Footer
        writeln!(md, "---").unwrap();
        writeln!(md, "*Exported from Composer*").unwrap();

        md
    }

    fn write_message_markdown(&self, md: &mut String, msg: &AppMessage) {
        match msg {
            AppMessage::User {
                content, timestamp, ..
            } => {
                writeln!(md, "## User").unwrap();
                if self.options.include_timestamps && *timestamp > 0 {
                    writeln!(md, "*{}*\n", format_millis_timestamp(*timestamp)).unwrap();
                }
                match content {
                    MessageContent::Text(text) => writeln!(md, "{}\n", text).unwrap(),
                    MessageContent::Blocks(blocks) => {
                        for block in blocks {
                            if let ContentBlock::Text { text } = block {
                                writeln!(md, "{}", text).unwrap();
                            }
                        }
                        writeln!(md).unwrap();
                    }
                }
            }
            AppMessage::Assistant {
                content,
                model,
                usage,
                timestamp,
                ..
            } => {
                writeln!(md, "## Assistant").unwrap();
                if self.options.include_timestamps {
                    let model_str = model.as_deref().unwrap_or(&self.header.model);
                    if *timestamp > 0 {
                        writeln!(
                            md,
                            "*{} ({})*\n",
                            format_millis_timestamp(*timestamp),
                            model_str
                        )
                        .unwrap();
                    } else {
                        writeln!(md, "*({})*\n", model_str).unwrap();
                    }
                }

                for block in content {
                    match block {
                        ContentBlock::Text { text } => {
                            writeln!(md, "{}\n", text).unwrap();
                        }
                        ContentBlock::Thinking { text, .. } if self.options.include_thinking => {
                            writeln!(md, "<details>").unwrap();
                            writeln!(md, "<summary>Thinking</summary>\n").unwrap();
                            writeln!(md, "{}", text).unwrap();
                            writeln!(md, "</details>\n").unwrap();
                        }
                        ContentBlock::ToolCall { name, args, .. }
                            if self.options.include_tool_calls =>
                        {
                            writeln!(md, "```tool").unwrap();
                            writeln!(md, "{}: {}", name, args).unwrap();
                            writeln!(md, "```\n").unwrap();
                        }
                        _ => {}
                    }
                }

                if self.options.include_usage {
                    if let Some(u) = usage {
                        writeln!(md, "*Tokens: {} in, {} out*\n", u.input, u.output).unwrap();
                    }
                }
            }
            AppMessage::ToolResult {
                tool_name,
                content,
                is_error,
                ..
            } if self.options.include_tool_results => {
                let status = if *is_error { "Error" } else { "Result" };
                writeln!(md, "### {} {}\n", tool_name, status).unwrap();
                writeln!(md, "```").unwrap();
                // Truncate long outputs
                let truncated = if content.len() > 500 {
                    format!("{}...(truncated)", &content[..500])
                } else {
                    content.clone()
                };
                writeln!(md, "{}", truncated).unwrap();
                writeln!(md, "```\n").unwrap();
            }
            _ => {}
        }
    }

    /// Export to HTML format
    fn to_html(&self) -> String {
        let mut html = String::new();

        let title = self
            .options
            .title
            .as_deref()
            .or(self.meta.and_then(|m| m.title.as_deref()))
            .unwrap_or("Conversation");

        // HTML header
        writeln!(
            html,
            r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{}</title>
    <style>
        :root {{
            --bg: #1a1a2e;
            --fg: #eaeaea;
            --user-bg: #16213e;
            --assistant-bg: #0f3460;
            --code-bg: #0d0d1a;
            --border: #333;
        }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--fg);
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
        }}
        h1 {{ color: #9b59b6; }}
        .meta {{ color: #888; font-size: 0.9em; margin-bottom: 20px; }}
        .message {{
            margin: 15px 0;
            padding: 15px;
            border-radius: 8px;
        }}
        .user {{ background: var(--user-bg); }}
        .assistant {{ background: var(--assistant-bg); }}
        .role {{ font-weight: bold; margin-bottom: 10px; color: #3498db; }}
        pre {{
            background: var(--code-bg);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
        }}
        code {{ font-family: 'Fira Code', monospace; }}
        .thinking {{
            background: var(--code-bg);
            padding: 10px;
            margin: 10px 0;
            border-left: 3px solid #9b59b6;
            font-style: italic;
        }}
        .stats {{ margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--border); }}
        .footer {{ margin-top: 30px; text-align: center; color: #666; }}
    </style>
</head>
<body>"#,
            title
        )
        .unwrap();

        // Title and metadata
        writeln!(html, "<h1>{}</h1>", title).unwrap();
        writeln!(html, r#"<div class="meta">"#).unwrap();
        writeln!(html, "<p><strong>Model:</strong> {}</p>", self.header.model).unwrap();
        writeln!(
            html,
            "<p><strong>Date:</strong> {}</p>",
            format_timestamp(&self.header.timestamp)
        )
        .unwrap();
        writeln!(html, "</div>").unwrap();

        // Messages
        for msg in self.messages {
            self.write_message_html(&mut html, msg);
        }

        // Stats
        if self.options.include_usage {
            writeln!(html, r#"<div class="stats">"#).unwrap();
            writeln!(
                html,
                "<p><strong>Messages:</strong> {} user, {} assistant</p>",
                self.stats.user_messages, self.stats.assistant_messages
            )
            .unwrap();
            if self.stats.total_input_tokens > 0 {
                writeln!(
                    html,
                    "<p><strong>Tokens:</strong> {} in, {} out</p>",
                    self.stats.total_input_tokens, self.stats.total_output_tokens
                )
                .unwrap();
            }
            if self.stats.total_cost > 0.0 {
                writeln!(
                    html,
                    "<p><strong>Cost:</strong> ${:.4}</p>",
                    self.stats.total_cost
                )
                .unwrap();
            }
            writeln!(html, "</div>").unwrap();
        }

        // Footer
        writeln!(html, r#"<div class="footer">Exported from Composer</div>"#).unwrap();
        writeln!(html, "</body>\n</html>").unwrap();

        html
    }

    fn write_message_html(&self, html: &mut String, msg: &AppMessage) {
        match msg {
            AppMessage::User { content, .. } => {
                writeln!(html, r#"<div class="message user">"#).unwrap();
                writeln!(html, r#"<div class="role">User</div>"#).unwrap();
                let text = match content {
                    MessageContent::Text(t) => t.clone(),
                    MessageContent::Blocks(blocks) => blocks
                        .iter()
                        .filter_map(|b| {
                            if let ContentBlock::Text { text } = b {
                                Some(text.as_str())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                };
                writeln!(html, "<p>{}</p>", escape_html(&text)).unwrap();
                writeln!(html, "</div>").unwrap();
            }
            AppMessage::Assistant { content, .. } => {
                writeln!(html, r#"<div class="message assistant">"#).unwrap();
                writeln!(html, r#"<div class="role">Assistant</div>"#).unwrap();

                for block in content {
                    match block {
                        ContentBlock::Text { text } => {
                            writeln!(html, "<p>{}</p>", escape_html(text)).unwrap();
                        }
                        ContentBlock::Thinking { text, .. } if self.options.include_thinking => {
                            writeln!(html, r#"<div class="thinking">"#).unwrap();
                            writeln!(html, "<strong>Thinking:</strong><br>").unwrap();
                            writeln!(html, "{}", escape_html(text)).unwrap();
                            writeln!(html, "</div>").unwrap();
                        }
                        ContentBlock::ToolCall { name, args, .. }
                            if self.options.include_tool_calls =>
                        {
                            writeln!(
                                html,
                                "<pre><code>{}: {}</code></pre>",
                                name,
                                escape_html(&args.to_string())
                            )
                            .unwrap();
                        }
                        _ => {}
                    }
                }
                writeln!(html, "</div>").unwrap();
            }
            AppMessage::ToolResult { .. } => {
                // Tool results typically not shown in HTML
            }
        }
    }

    /// Export to JSON format
    fn to_json(&self) -> String {
        let export = serde_json::json!({
            "session": {
                "id": self.header.id,
                "timestamp": self.header.timestamp,
                "cwd": self.header.cwd,
                "model": self.header.model,
                "thinking_level": self.header.thinking_level,
            },
            "meta": self.meta.map(|m| serde_json::json!({
                "title": m.title,
                "summary": m.summary,
                "tags": m.tags,
            })),
            "stats": {
                "user_messages": self.stats.user_messages,
                "assistant_messages": self.stats.assistant_messages,
                "tool_calls": self.stats.tool_calls,
                "total_input_tokens": self.stats.total_input_tokens,
                "total_output_tokens": self.stats.total_output_tokens,
                "total_cost": self.stats.total_cost,
            },
            "messages": self.messages.iter().map(|msg| {
                serde_json::json!({
                    "timestamp": msg.timestamp(),
                    "message": msg,
                })
            }).collect::<Vec<_>>(),
        });

        serde_json::to_string_pretty(&export).unwrap_or_default()
    }

    /// Export to plain text format
    fn to_plain_text(&self) -> String {
        let mut txt = String::new();

        let title = self
            .options
            .title
            .as_deref()
            .or(self.meta.and_then(|m| m.title.as_deref()))
            .unwrap_or("Conversation");

        writeln!(txt, "{}", title).unwrap();
        writeln!(txt, "{}\n", "=".repeat(title.len())).unwrap();

        for msg in self.messages {
            match msg {
                AppMessage::User { content, .. } => {
                    writeln!(txt, "USER:").unwrap();
                    let text = match content {
                        MessageContent::Text(t) => t.clone(),
                        MessageContent::Blocks(blocks) => blocks
                            .iter()
                            .filter_map(|b| {
                                if let ContentBlock::Text { text } = b {
                                    Some(text.as_str())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(""),
                    };
                    writeln!(txt, "{}\n", text).unwrap();
                }
                AppMessage::Assistant { content, .. } => {
                    writeln!(txt, "ASSISTANT:").unwrap();
                    for block in content {
                        if let ContentBlock::Text { text } = block {
                            writeln!(txt, "{}", text).unwrap();
                        }
                    }
                    writeln!(txt).unwrap();
                }
                _ => {}
            }
        }

        txt
    }
}

/// Helper to escape HTML special characters
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Format ISO timestamp to human readable
fn format_timestamp(timestamp: &str) -> String {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| timestamp.to_string())
}

/// Convenience function to export a session file
pub fn export_session_file(
    path: impl AsRef<std::path::Path>,
    options: ExportOptions,
) -> io::Result<String> {
    let session = SessionReader::read_file(path)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    let exporter = SessionExporter::from_session(&session, options);
    Ok(exporter.export_to_string())
}

/// Format milliseconds timestamp to human readable
fn format_millis_timestamp(timestamp_millis: u64) -> String {
    use chrono::{TimeZone, Utc};
    let secs = (timestamp_millis / 1000) as i64;
    let nsecs = ((timestamp_millis % 1000) * 1_000_000) as u32;
    match Utc.timestamp_opt(secs, nsecs) {
        chrono::LocalResult::Single(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
        _ => format!("{}", timestamp_millis),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_header() -> SessionHeader {
        SessionHeader {
            id: "test-123".to_string(),
            timestamp: "2024-01-15T10:30:00Z".to_string(),
            cwd: "/tmp".to_string(),
            model: "claude-sonnet-4".to_string(),
            model_metadata: None,
            thinking_level: ThinkingLevel::Medium,
            system_prompt: None,
            tools: vec![],
            branched_from: None,
        }
    }

    fn sample_messages() -> Vec<AppMessage> {
        vec![
            AppMessage::User {
                content: MessageContent::Text("Hello!".to_string()),
                timestamp: 1705318201000,
            },
            AppMessage::Assistant {
                content: vec![ContentBlock::Text {
                    text: "Hi there! How can I help?".to_string(),
                }],
                api: None,
                provider: None,
                model: None,
                usage: None,
                stop_reason: None,
                timestamp: 1705318202000,
            },
        ]
    }

    fn sample_stats() -> SessionStats {
        SessionStats {
            user_messages: 1,
            assistant_messages: 1,
            tool_calls: 0,
            tool_results: 0,
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cost: 0.001,
        }
    }

    #[test]
    fn test_export_markdown() {
        let header = sample_header();
        let messages = sample_messages();
        let stats = sample_stats();

        let exporter =
            SessionExporter::new(&header, &messages, None, &stats, ExportOptions::markdown());
        let md = exporter.export_to_string();

        assert!(md.contains("# Conversation"));
        assert!(md.contains("**Model:** claude-sonnet-4"));
        assert!(md.contains("## User"));
        assert!(md.contains("Hello!"));
        assert!(md.contains("## Assistant"));
        assert!(md.contains("Hi there!"));
    }

    #[test]
    fn test_export_html() {
        let header = sample_header();
        let messages = sample_messages();
        let stats = sample_stats();

        let exporter =
            SessionExporter::new(&header, &messages, None, &stats, ExportOptions::html());
        let html = exporter.export_to_string();

        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("<title>Conversation</title>"));
        assert!(html.contains("Hello!"));
    }

    #[test]
    fn test_export_json() {
        let header = sample_header();
        let messages = sample_messages();
        let stats = sample_stats();

        let exporter =
            SessionExporter::new(&header, &messages, None, &stats, ExportOptions::json());
        let json = exporter.export_to_string();

        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["session"]["id"], "test-123");
        assert_eq!(parsed["stats"]["user_messages"], 1);
    }

    #[test]
    fn test_export_plain_text() {
        let header = sample_header();
        let messages = sample_messages();
        let stats = sample_stats();

        let exporter = SessionExporter::new(
            &header,
            &messages,
            None,
            &stats,
            ExportOptions::plain_text(),
        );
        let txt = exporter.export_to_string();

        assert!(txt.contains("USER:"));
        assert!(txt.contains("ASSISTANT:"));
        assert!(txt.contains("Hello!"));
    }

    #[test]
    fn test_export_with_title() {
        let header = sample_header();
        let messages = sample_messages();
        let stats = sample_stats();

        let options = ExportOptions::markdown().with_title("My Custom Title");
        let exporter = SessionExporter::new(&header, &messages, None, &stats, options);
        let md = exporter.export_to_string();

        assert!(md.contains("# My Custom Title"));
    }

    #[test]
    fn test_format_extensions() {
        assert_eq!(ExportFormat::Markdown.extension(), "md");
        assert_eq!(ExportFormat::Html.extension(), "html");
        assert_eq!(ExportFormat::Json.extension(), "json");
        assert_eq!(ExportFormat::PlainText.extension(), "txt");
    }

    #[test]
    fn test_escape_html() {
        assert_eq!(escape_html("<script>"), "&lt;script&gt;");
        assert_eq!(escape_html("a & b"), "a &amp; b");
    }
}
