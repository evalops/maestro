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
use std::io::Cursor;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use zip::ZipArchive;

use crate::agent::ToolResult;

const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ExtractDocumentArgs {
    url: String,
    #[serde(default, alias = "maxChars")]
    max_chars: Option<usize>,
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

    let format = detect_format(&file_name, content_type.as_deref());
    let format = match format {
        Some(fmt) => fmt,
        None => {
            return ToolResult::failure(
                "Unsupported document format. Supported: PDF (.pdf), Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and common text files."
                    .to_string(),
            )
        }
    };

    let extracted = match extract_from_format(format, &bytes) {
        Some(text) => text,
        None => {
            return ToolResult::failure("Failed to extract document text.".to_string());
        }
    };

    let mut truncated = false;
    let max_chars = parsed.max_chars.unwrap_or(1_000_000);
    let output = if extracted.chars().count() > max_chars {
        truncated = true;
        extracted.chars().take(max_chars).collect::<String>()
    } else {
        extracted
    };

    let details = serde_json::json!({
        "url": url.to_string(),
        "fileName": file_name,
        "mimeType": content_type,
        "format": format,
        "sizeBytes": bytes.len(),
        "truncated": truncated
    });

    ToolResult::success(output).with_details(details)
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

    // ========================================================================
    // MAX_DOWNLOAD_BYTES Constant
    // ========================================================================

    #[test]
    fn test_max_download_bytes() {
        // 50MB = 50 * 1024 * 1024 = 52,428,800 bytes
        assert_eq!(MAX_DOWNLOAD_BYTES, 52_428_800);
    }
}
