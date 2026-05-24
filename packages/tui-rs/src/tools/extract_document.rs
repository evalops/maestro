//! Document extraction tool helpers.
//!
//! This module provides functionality for extracting text content from various
//! document formats downloaded from URLs. It supports:
//!
//! - **PDF** - Portable Document Format
//! - **DOCX** - Microsoft Word Open XML documents
//! - **PPTX** - Microsoft PowerPoint Open XML presentations
//! - **XLSX** - Microsoft Excel Open XML spreadsheets
//! - **Text** - Plain text, Markdown, CSV, JSON, XML, YAML
//!
//! # Features
//!
//! - Automatic format detection based on file extension and MIME type
//! - Content-Disposition header parsing for filename extraction
//! - XML entity decoding for Office Open XML formats
//! - Size limits to prevent memory exhaustion (50MB max)
//! - Optional character limit truncation

use std::cmp::Ordering;
use std::env;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use zip::ZipArchive;

use crate::agent::ToolResult;

const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
const MARKITDOWN_EXTRACT_TIMEOUT: Duration = Duration::from_secs(20);
static MARKITDOWN_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
struct ExtractDocumentArgs {
    url: String,
    #[serde(default, alias = "maxChars")]
    max_chars: Option<usize>,
}

struct DocumentExtraction {
    format: String,
    extractor: String,
    text: String,
    truncated: bool,
}

fn guess_filename_from_url(url: &reqwest::Url) -> String {
    url.path_segments()
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()))
        .map_or_else(|| "document".to_string(), std::string::ToString::to_string)
}

fn parse_content_disposition(header: Option<&str>) -> Option<String> {
    let header = header?;
    let patterns = [
        Regex::new(r"filename\*=UTF-8''([^;]+)").ok()?,
        Regex::new(r#"filename="([^"]+)""#).ok()?,
        Regex::new(r"filename=([^;]+)").ok()?,
    ];
    for pattern in patterns {
        if let Some(caps) = pattern.captures(header) {
            if let Some(name) = caps.get(1) {
                let raw = name.as_str().trim();
                if let Ok(decoded) = urlencoding::decode(raw) {
                    return Some(decoded.to_string());
                }
                return Some(raw.to_string());
            }
        }
    }
    None
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn strip_xml(input: &str) -> String {
    static TAG_RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let mut text = input.replace("<w:tab/>", "\t");
    text = text.replace("<w:br/>", "\n");
    text = text.replace("</w:p>", "\n");
    let stripped = TAG_RE.replace_all(&text, "");
    decode_xml_entities(&stripped)
}

fn extract_zip_file(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut contents = String::new();
    use std::io::Read;
    file.read_to_string(&mut contents).ok()?;
    Some(contents)
}

fn extract_docx(bytes: &[u8]) -> Option<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes.to_vec())).ok()?;
    let xml = extract_zip_file(&mut archive, "word/document.xml")?;
    Some(strip_xml(&xml))
}

fn extract_pptx(bytes: &[u8]) -> Option<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes.to_vec())).ok()?;
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .collect();
    slide_names.sort_by(|a, b| {
        let a_num = a
            .rsplit("slide")
            .next()
            .and_then(|s| s.trim_end_matches(".xml").parse::<u32>().ok());
        let b_num = b
            .rsplit("slide")
            .next()
            .and_then(|s| s.trim_end_matches(".xml").parse::<u32>().ok());
        match (a_num, b_num) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    let mut outputs = Vec::new();
    for name in slide_names {
        if let Some(xml) = extract_zip_file(&mut archive, &name) {
            let text = strip_xml(&xml);
            if !text.trim().is_empty() {
                outputs.push(text);
            }
        }
    }
    if outputs.is_empty() {
        None
    } else {
        Some(outputs.join("\n"))
    }
}

fn extract_xlsx(bytes: &[u8]) -> Option<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes.to_vec())).ok()?;
    let xml = extract_zip_file(&mut archive, "xl/sharedStrings.xml")?;
    Some(strip_xml(&xml))
}

fn extract_text_file(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn detect_format(file_name: &str, mime: Option<&str>) -> Option<&'static str> {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".pdf") || mime == Some("application/pdf") {
        return Some("pdf");
    }
    if lower.ends_with(".docx")
        || mime == Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    {
        return Some("docx");
    }
    if lower.ends_with(".pptx")
        || mime == Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
    {
        return Some("pptx");
    }
    if lower.ends_with(".xlsx")
        || mime == Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    {
        return Some("xlsx");
    }
    if lower.ends_with(".txt")
        || lower.ends_with(".md")
        || lower.ends_with(".csv")
        || lower.ends_with(".json")
        || lower.ends_with(".xml")
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
        || mime.is_some_and(|m| m.starts_with("text/"))
    {
        return Some("text");
    }
    None
}

fn extract_from_format(format: &str, bytes: &[u8]) -> Option<String> {
    match format {
        "pdf" => pdf_extract::extract_text_from_mem(bytes).ok(),
        "docx" => extract_docx(bytes),
        "pptx" => extract_pptx(bytes),
        "xlsx" => extract_xlsx(bytes),
        "text" => Some(extract_text_file(bytes)),
        _ => None,
    }
}

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
        .unwrap_or(false)
}

fn env_flag_disabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            )
        })
        .unwrap_or(false)
}

fn markitdown_disabled() -> bool {
    env_flag_disabled("MAESTRO_MARKITDOWN")
}

fn markitdown_preferred() -> bool {
    env_flag_enabled("MAESTRO_MARKITDOWN_PREFER")
}

fn split_command_args(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn markitdown_candidates() -> Vec<(String, Vec<String>)> {
    if let Ok(command) = env::var("MAESTRO_MARKITDOWN_CMD") {
        let command = command.trim();
        if !command.is_empty() {
            return vec![(
                command.to_string(),
                split_command_args(env::var("MAESTRO_MARKITDOWN_ARGS").ok()),
            )];
        }
    }
    vec![
        ("markitdown".to_string(), Vec::new()),
        ("uvx".to_string(), vec!["markitdown".to_string()]),
    ]
}

fn should_try_markitdown(format: &str, file_name: &str, mime_type: Option<&str>) -> bool {
    if markitdown_disabled() {
        return false;
    }
    if markitdown_preferred() {
        return true;
    }
    let lower_name = file_name.to_ascii_lowercase();
    let mime_type = mime_type.unwrap_or("").to_ascii_lowercase();
    format == "unknown"
        || lower_name.ends_with(".html")
        || lower_name.ends_with(".htm")
        || mime_type.contains("text/html")
}

fn read_markitdown_pipe<R>(mut pipe: R) -> thread::JoinHandle<std::io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        pipe.read_to_end(&mut output)?;
        Ok(output)
    })
}

fn join_markitdown_pipe(
    name: &str,
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("MarkItDown {name} reader panicked"))?
        .map_err(|error| format!("failed to read MarkItDown {name}: {error}"))
}

#[cfg(unix)]
fn set_markitdown_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            let _ = libc::setpgid(0, 0);
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn set_markitdown_process_group(_command: &mut Command) {}

fn kill_markitdown_process(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            let pgid = unsafe { libc::getpgid(pid) };
            if pgid > 0 && pgid == pid {
                unsafe {
                    let _ = libc::kill(-pgid, libc::SIGKILL);
                }
            }
        }
    }

    let _ = child.kill();
}

fn run_markitdown_command(command: &str, args: &[String]) -> Result<String, String> {
    let mut process = Command::new(command);
    process
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    set_markitdown_process_group(&mut process);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let stdout_reader = child
        .stdout
        .take()
        .map(read_markitdown_pipe)
        .ok_or_else(|| "failed to capture MarkItDown stdout".to_string())?;
    let stderr_reader = child
        .stderr
        .take()
        .map(read_markitdown_pipe)
        .ok_or_else(|| "failed to capture MarkItDown stderr".to_string())?;
    let mut stdout_reader = Some(stdout_reader);
    let mut stderr_reader = Some(stderr_reader);
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to wait for MarkItDown: {error}"))?
        {
            let stdout = join_markitdown_pipe(
                "stdout",
                stdout_reader
                    .take()
                    .ok_or_else(|| "missing MarkItDown stdout reader".to_string())?,
            )?;
            let stderr = join_markitdown_pipe(
                "stderr",
                stderr_reader
                    .take()
                    .ok_or_else(|| "missing MarkItDown stderr reader".to_string())?,
            )?;
            if status.success() {
                return String::from_utf8(stdout)
                    .map_err(|_| "MarkItDown output was not UTF-8".to_string());
            }
            let stderr = String::from_utf8_lossy(&stderr);
            return Err(format!(
                "MarkItDown exited with {}{}",
                status,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", stderr.chars().take(500).collect::<String>())
                }
            ));
        }
        if started.elapsed() > MARKITDOWN_EXTRACT_TIMEOUT {
            kill_markitdown_process(&mut child);
            let _ = child.wait();
            return Err("MarkItDown conversion timed out".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn extract_with_markitdown(
    bytes: &[u8],
    file_name: &str,
    mime_type: Option<&str>,
) -> Result<Option<String>, String> {
    if markitdown_disabled() {
        return Ok(None);
    }
    let counter = MARKITDOWN_TEMP_COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
    let temp_dir =
        env::temp_dir().join(format!("maestro-markitdown-{}-{}", process::id(), counter));
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("failed to create MarkItDown temp dir: {error}"))?;
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .unwrap_or("bin");
    let input_path = temp_dir.join(format!("input.{extension}"));
    let result = (|| {
        fs::write(&input_path, bytes)
            .map_err(|error| format!("failed to write MarkItDown input: {error}"))?;
        let mut last_error: Option<String> = None;
        for (command, prefix_args) in markitdown_candidates() {
            let mut args = prefix_args;
            args.push(input_path.to_string_lossy().to_string());
            if let Some(mime_type) = mime_type {
                args.push("--mime-type".to_string());
                args.push(mime_type.to_string());
            }
            match run_markitdown_command(&command, &args) {
                Ok(output) => {
                    let text = output.trim().to_string();
                    if !text.is_empty() {
                        return Ok(Some(text));
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }
        if env::var("MAESTRO_MARKITDOWN_CMD")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Err(format!(
                "MarkItDown extraction failed: {}",
                last_error.unwrap_or_else(|| "no output".to_string())
            ));
        }
        Ok(None)
    })();
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

fn extract_document_bytes(
    file_name: &str,
    mime_type: Option<&str>,
    bytes: &[u8],
    max_chars: Option<usize>,
) -> Result<DocumentExtraction, String> {
    let format = detect_format(file_name, mime_type);
    let format_label = format.unwrap_or("unknown").to_string();
    let prefer_markitdown = markitdown_preferred() && !markitdown_disabled();
    let mut extractor = "native".to_string();
    let mut extracted = if prefer_markitdown {
        match extract_with_markitdown(bytes, file_name, mime_type)? {
            Some(text) => {
                extractor = "markitdown".to_string();
                text
            }
            None => String::new(),
        }
    } else {
        String::new()
    };

    if extracted.is_empty() {
        if let Some(format) = format {
            extracted = extract_from_format(format, bytes).unwrap_or_default();
        }
    }

    if extractor != "markitdown" && should_try_markitdown(&format_label, file_name, mime_type) {
        if let Some(text) = extract_with_markitdown(bytes, file_name, mime_type)? {
            extracted = text;
            extractor = "markitdown".to_string();
        }
    }

    if extracted.is_empty() && format.is_none() {
        return Err("Unsupported document format. Supported: PDF (.pdf), Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and common text files.".to_string());
    }
    if extracted.is_empty() {
        return Err("Failed to extract document text.".to_string());
    }

    let max_chars = max_chars.unwrap_or(1_000_000);
    let truncated = extracted.chars().count() > max_chars;
    let text = if truncated {
        extracted.chars().take(max_chars).collect()
    } else {
        extracted
    };

    Ok(DocumentExtraction {
        format: format_label,
        extractor,
        text,
        truncated,
    })
}

pub async fn extract_document(args: Value) -> ToolResult {
    let parsed: ExtractDocumentArgs = match serde_json::from_value(args) {
        Ok(val) => val,
        Err(err) => {
            return ToolResult::failure(format!("Invalid extract_document arguments: {err}"))
        }
    };

    let url = match reqwest::Url::parse(parsed.url.trim()) {
        Ok(url) => url,
        Err(_) => return ToolResult::failure(format!("Invalid URL: {}", parsed.url)),
    };

    if url.scheme() != "http" && url.scheme() != "https" {
        return ToolResult::failure("Only http(s) URLs are supported".to_string());
    }

    let client = reqwest::Client::new();
    let response = match client.get(url.clone()).send().await {
        Ok(resp) => resp,
        Err(err) => {
            return ToolResult::failure(format!("Failed to download document: {err}"));
        }
    };

    if !response.status().is_success() {
        return ToolResult::failure(format!(
            "Unable to download document ({} {})",
            response.status(),
            response
                .status()
                .canonical_reason()
                .unwrap_or("Unknown status")
        ));
    }

    if let Some(len) = response.content_length() {
        if len as usize > MAX_DOWNLOAD_BYTES {
            return ToolResult::failure(format!(
                "Document is too large ({:.1}MB). Maximum supported size is 50MB.",
                (len as f64) / (1024.0 * 1024.0)
            ));
        }
    }

    let headers = response.headers().clone();
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string());
    let content_disposition = headers
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(std::string::ToString::to_string);

    let bytes = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(err) => {
            return ToolResult::failure(format!("Failed to read document bytes: {err}"));
        }
    };

    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return ToolResult::failure(format!(
            "Document is too large ({:.1}MB). Maximum supported size is 50MB.",
            (bytes.len() as f64) / (1024.0 * 1024.0)
        ));
    }

    let file_name = parse_content_disposition(content_disposition.as_deref())
        .unwrap_or_else(|| guess_filename_from_url(&url));

    let extraction = match extract_document_bytes(
        &file_name,
        content_type.as_deref(),
        &bytes,
        parsed.max_chars,
    ) {
        Ok(extraction) => extraction,
        Err(error) => {
            return ToolResult::failure(error);
        }
    };

    let details = serde_json::json!({
        "url": url.to_string(),
        "fileName": file_name,
        "mimeType": content_type,
        "format": extraction.format,
        "extractor": extraction.extractor,
        "sizeBytes": bytes.len(),
        "truncated": extraction.truncated
    });

    ToolResult::success(extraction.text).with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // ExtractDocumentArgs Deserialization Tests
    // ========================================================================

    #[test]
    fn test_args_deserialize_minimal() {
        let json = serde_json::json!({
            "url": "https://example.com/doc.pdf"
        });
        let args: ExtractDocumentArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.url, "https://example.com/doc.pdf");
        assert!(args.max_chars.is_none());
    }

    #[test]
    fn test_args_deserialize_with_max_chars() {
        let json = serde_json::json!({
            "url": "https://example.com/doc.pdf",
            "max_chars": 5000
        });
        let args: ExtractDocumentArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.max_chars, Some(5000));
    }

    #[test]
    fn test_args_deserialize_camel_case_alias() {
        let json = serde_json::json!({
            "url": "https://example.com/doc.pdf",
            "maxChars": 10000
        });
        let args: ExtractDocumentArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.max_chars, Some(10000));
    }

    // ========================================================================
    // guess_filename_from_url Tests
    // ========================================================================

    #[test]
    fn test_guess_filename_simple() {
        let url = reqwest::Url::parse("https://example.com/report.pdf").unwrap();
        assert_eq!(guess_filename_from_url(&url), "report.pdf");
    }

    #[test]
    fn test_guess_filename_with_path() {
        let url = reqwest::Url::parse("https://example.com/docs/2024/report.docx").unwrap();
        assert_eq!(guess_filename_from_url(&url), "report.docx");
    }

    #[test]
    fn test_guess_filename_trailing_slash() {
        let url = reqwest::Url::parse("https://example.com/files/").unwrap();
        assert_eq!(guess_filename_from_url(&url), "files");
    }

    #[test]
    fn test_guess_filename_no_path() {
        let url = reqwest::Url::parse("https://example.com/").unwrap();
        assert_eq!(guess_filename_from_url(&url), "document");
    }

    // ========================================================================
    // parse_content_disposition Tests
    // ========================================================================

    #[test]
    fn test_parse_content_disposition_quoted() {
        let header = r#"attachment; filename="report.pdf""#;
        assert_eq!(
            parse_content_disposition(Some(header)),
            Some("report.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_unquoted() {
        let header = "attachment; filename=report.pdf";
        assert_eq!(
            parse_content_disposition(Some(header)),
            Some("report.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_utf8() {
        let header = "attachment; filename*=UTF-8''report%20final.pdf";
        assert_eq!(
            parse_content_disposition(Some(header)),
            Some("report final.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_none() {
        assert_eq!(parse_content_disposition(None), None);
    }

    #[test]
    fn test_parse_content_disposition_no_filename() {
        let header = "attachment";
        assert_eq!(parse_content_disposition(Some(header)), None);
    }

    // ========================================================================
    // decode_xml_entities Tests
    // ========================================================================

    #[test]
    fn test_decode_xml_entities_basic() {
        assert_eq!(decode_xml_entities("&lt;div&gt;"), "<div>");
    }

    #[test]
    fn test_decode_xml_entities_ampersand() {
        assert_eq!(decode_xml_entities("A &amp; B"), "A & B");
    }

    #[test]
    fn test_decode_xml_entities_quotes() {
        assert_eq!(
            decode_xml_entities("&quot;hello&quot; &apos;world&apos;"),
            "\"hello\" 'world'"
        );
    }

    #[test]
    fn test_decode_xml_entities_mixed() {
        assert_eq!(
            decode_xml_entities("x &lt; y &amp;&amp; y &gt; z"),
            "x < y && y > z"
        );
    }

    #[test]
    fn test_decode_xml_entities_none() {
        assert_eq!(decode_xml_entities("plain text"), "plain text");
    }

    // ========================================================================
    // strip_xml Tests
    // ========================================================================

    #[test]
    fn test_strip_xml_simple_tags() {
        assert_eq!(strip_xml("<p>Hello</p>"), "Hello");
    }

    #[test]
    fn test_strip_xml_nested_tags() {
        assert_eq!(strip_xml("<div><span>Text</span></div>"), "Text");
    }

    #[test]
    fn test_strip_xml_paragraph_breaks() {
        assert_eq!(
            strip_xml("<w:p>Para1</w:p><w:p>Para2</w:p>"),
            "Para1\nPara2\n"
        );
    }

    #[test]
    fn test_strip_xml_tabs() {
        assert_eq!(strip_xml("A<w:tab/>B"), "A\tB");
    }

    #[test]
    fn test_strip_xml_line_breaks() {
        assert_eq!(strip_xml("Line1<w:br/>Line2"), "Line1\nLine2");
    }

    #[test]
    fn test_strip_xml_with_entities() {
        assert_eq!(strip_xml("<p>x &lt; y</p>"), "x < y");
    }

    // ========================================================================
    // detect_format Tests
    // ========================================================================

    #[test]
    fn test_detect_format_pdf_by_extension() {
        assert_eq!(detect_format("report.pdf", None), Some("pdf"));
    }

    #[test]
    fn test_detect_format_pdf_by_mime() {
        assert_eq!(
            detect_format("unknown", Some("application/pdf")),
            Some("pdf")
        );
    }

    #[test]
    fn test_detect_format_docx_by_extension() {
        assert_eq!(detect_format("document.docx", None), Some("docx"));
    }

    #[test]
    fn test_detect_format_docx_by_mime() {
        assert_eq!(
            detect_format(
                "doc",
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            ),
            Some("docx")
        );
    }

    #[test]
    fn test_detect_format_pptx() {
        assert_eq!(detect_format("slides.pptx", None), Some("pptx"));
    }

    #[test]
    fn test_detect_format_xlsx() {
        assert_eq!(detect_format("data.xlsx", None), Some("xlsx"));
    }

    #[test]
    fn test_detect_format_text_extensions() {
        assert_eq!(detect_format("readme.txt", None), Some("text"));
        assert_eq!(detect_format("readme.md", None), Some("text"));
        assert_eq!(detect_format("data.csv", None), Some("text"));
        assert_eq!(detect_format("config.json", None), Some("text"));
        assert_eq!(detect_format("config.yaml", None), Some("text"));
        assert_eq!(detect_format("config.yml", None), Some("text"));
        assert_eq!(detect_format("data.xml", None), Some("text"));
    }

    #[test]
    fn test_detect_format_text_by_mime() {
        assert_eq!(detect_format("unknown", Some("text/plain")), Some("text"));
        assert_eq!(detect_format("unknown", Some("text/html")), Some("text"));
    }

    #[test]
    fn test_detect_format_unknown() {
        assert_eq!(detect_format("unknown.bin", None), None);
        assert_eq!(detect_format("image.png", Some("image/png")), None);
    }

    #[test]
    fn test_detect_format_case_insensitive() {
        assert_eq!(detect_format("DOC.PDF", None), Some("pdf"));
        assert_eq!(detect_format("DOC.DOCX", None), Some("docx"));
    }

    // ========================================================================
    // extract_text_file Tests
    // ========================================================================

    #[test]
    fn test_extract_text_file_utf8() {
        let bytes = b"Hello, World!";
        assert_eq!(extract_text_file(bytes), "Hello, World!");
    }

    #[test]
    fn test_extract_text_file_multiline() {
        let bytes = b"Line 1\nLine 2\nLine 3";
        assert_eq!(extract_text_file(bytes), "Line 1\nLine 2\nLine 3");
    }

    #[test]
    fn test_extract_text_file_unicode() {
        let text = "こんにちは World 🌍";
        let bytes = text.as_bytes();
        assert_eq!(extract_text_file(bytes), text);
    }

    // ========================================================================
    // extract_from_format Tests
    // ========================================================================

    #[test]
    fn test_extract_from_format_text() {
        let bytes = b"Hello from text file";
        let result = extract_from_format("text", bytes);
        assert_eq!(result, Some("Hello from text file".to_string()));
    }

    #[test]
    fn test_extract_from_format_unknown() {
        let bytes = b"some data";
        let result = extract_from_format("unknown_format", bytes);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_document_bytes_uses_configured_markitdown_for_html() {
        let script_path = env::temp_dir().join(format!(
            "maestro-tui-fake-markitdown-{}-{}.sh",
            process::id(),
            MARKITDOWN_TEMP_COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
        ));
        fs::write(
            &script_path,
            "printf '# Converted by MarkItDown\\n\\nRust TUI body from fake CLI'",
        )
        .expect("fake MarkItDown script should be written");
        env::set_var("MAESTRO_MARKITDOWN_CMD", "sh");
        env::set_var(
            "MAESTRO_MARKITDOWN_ARGS",
            script_path.to_string_lossy().to_string(),
        );
        env::remove_var("MAESTRO_MARKITDOWN");
        env::remove_var("MAESTRO_MARKITDOWN_PREFER");

        let output = extract_document_bytes(
            "brief.html",
            Some("text/html"),
            b"<html><body><h1>Ignored native HTML</h1></body></html>",
            None,
        )
        .expect("MarkItDown extraction should succeed");

        assert_eq!(output.format, "text");
        assert_eq!(output.extractor, "markitdown");
        assert!(output.text.contains("# Converted by MarkItDown"));

        env::remove_var("MAESTRO_MARKITDOWN_CMD");
        env::remove_var("MAESTRO_MARKITDOWN_ARGS");
        let _ = fs::remove_file(script_path);
    }

    #[test]
    fn test_run_markitdown_command_drains_large_stdout_before_waiting() {
        let script_path = env::temp_dir().join(format!(
            "maestro-tui-large-markitdown-{}-{}.sh",
            process::id(),
            MARKITDOWN_TEMP_COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
        ));
        fs::write(
            &script_path,
            "i=0\nwhile [ \"$i\" -lt 12000 ]; do\n  printf '0123456789abcdef0123456789abcdef\\n'\n  i=$((i + 1))\ndone\nprintf 'MARKITDOWN_DONE\\n'\n",
        )
        .expect("large fake MarkItDown script should be written");

        let output = run_markitdown_command("sh", &[script_path.to_string_lossy().to_string()])
            .expect("large MarkItDown output should not deadlock");

        assert!(output.len() > 200_000);
        assert!(output.contains("MARKITDOWN_DONE"));

        let _ = fs::remove_file(script_path);
    }

    #[test]
    fn test_run_markitdown_command_timeout_does_not_wait_for_inherited_pipe_handles() {
        let script_path = env::temp_dir().join(format!(
            "maestro-tui-timeout-markitdown-{}-{}.sh",
            process::id(),
            MARKITDOWN_TEMP_COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
        ));
        fs::write(&script_path, "sleep 28 &\nsleep 28\n")
            .expect("timeout fake MarkItDown script should be written");

        let started = Instant::now();
        let error = run_markitdown_command("sh", &[script_path.to_string_lossy().to_string()])
            .expect_err("timed-out MarkItDown command should fail");
        let elapsed = started.elapsed();

        assert_eq!(error, "MarkItDown conversion timed out");
        assert!(
            elapsed < MARKITDOWN_EXTRACT_TIMEOUT + Duration::from_secs(4),
            "timeout path waited for inherited pipe handles for {elapsed:?}"
        );

        let _ = fs::remove_file(script_path);
    }

    // ========================================================================
    // MAX_DOWNLOAD_BYTES Constant
    // ========================================================================

    #[test]
    fn test_max_download_bytes() {
        // 50MB = 50 * 1024 * 1024 = 52,428,800 bytes
        assert_eq!(MAX_DOWNLOAD_BYTES, 52_428_800);
    }
}
