//! Document extraction tool helpers.

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
