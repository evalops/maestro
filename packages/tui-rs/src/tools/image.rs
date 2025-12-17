//! Image Tool for Vision-Capable Models
//!
//! This module provides tools for working with images in the agent:
//!
//! - **read_image**: Read an image file and encode it for vision APIs
//! - **screenshot**: Capture a screenshot of the screen or a window
//!
//! # Supported Formats
//!
//! - PNG (image/png)
//! - JPEG (image/jpeg)
//! - GIF (image/gif)
//! - WebP (image/webp)
//!
//! # Usage
//!
//! Images are returned as base64-encoded data URIs that can be included
//! in message content for vision-capable models like Claude 3.5 Sonnet,
//! GPT-4 Vision, and Gemini Pro Vision.
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::tools::image::{ImageTool, ReadImageArgs};
//!
//! let tool = ImageTool::new();
//! let result = tool.read_image(ReadImageArgs {
//!     file_path: "/path/to/image.png".to_string(),
//!     max_dimension: Some(1024),
//! }).await;
//!
//! if result.success {
//!     // result.output contains base64-encoded image data
//! }
//! ```

use std::path::Path;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

use super::details::ImageDetails;
use crate::agent::ToolResult;
use crate::ai::Tool;

/// Maximum file size for images (10MB)
const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024;

/// Default max dimension for image resizing
const DEFAULT_MAX_DIMENSION: u32 = 2048;

/// Arguments for reading an image file
#[derive(Debug, Serialize, Deserialize)]
pub struct ReadImageArgs {
    /// Path to the image file
    pub file_path: String,
    /// Maximum dimension (width or height) for resizing
    /// Images larger than this will be scaled down
    #[serde(default)]
    pub max_dimension: Option<u32>,
}

/// Arguments for capturing a screenshot
#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotArgs {
    /// Optional window title to capture (if not specified, captures full screen)
    #[serde(default)]
    pub window_title: Option<String>,
    /// Optional delay in milliseconds before capture
    #[serde(default)]
    pub delay_ms: Option<u64>,
}

/// Image tool for reading images and capturing screenshots
pub struct ImageTool;

impl ImageTool {
    /// Create a new ImageTool instance
    pub fn new() -> Self {
        Self
    }

    /// Get the tool definition for read_image
    pub fn read_image_definition() -> Tool {
        Tool::new(
            "read_image",
            "Read an IMAGE file (PNG, JPEG, GIF, WebP only) and encode it for vision analysis. DO NOT use for text files like .txt, .md, .rs, .json - use the 'read' tool instead. Returns base64-encoded image data.",
        )
        .with_schema(serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the image file to read"
                },
                "max_dimension": {
                    "type": "integer",
                    "description": "Optional maximum dimension (width or height) for resizing. Default 2048."
                }
            },
            "required": ["file_path"]
        }))
    }

    /// Get the tool definition for screenshot
    pub fn screenshot_definition() -> Tool {
        Tool::new(
            "screenshot",
            "Capture a screenshot of the screen or a specific window. Returns base64-encoded PNG image.",
        )
        .with_schema(serde_json::json!({
            "type": "object",
            "properties": {
                "window_title": {
                    "type": "string",
                    "description": "Optional window title to capture. If not specified, captures the entire screen."
                },
                "delay_ms": {
                    "type": "integer",
                    "description": "Optional delay in milliseconds before capturing. Useful for capturing menus or tooltips."
                }
            },
            "required": []
        }))
    }

    /// Read an image file and return base64-encoded data
    pub async fn read_image(&self, args: ReadImageArgs) -> ToolResult {
        let start_time = Instant::now();
        let path = Path::new(&args.file_path);

        // Check if file exists
        if !path.exists() {
            let details = ImageDetails::from_file(&args.file_path)
                .with_duration(start_time.elapsed().as_millis() as u64);
            return ToolResult::failure(format!("Image file not found: {}", args.file_path))
                .with_details(details.to_json());
        }

        // Determine MIME type from extension
        let mime_type = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("bmp") => "image/bmp",
            Some("svg") => "image/svg+xml",
            Some(ext) => {
                let details = ImageDetails::from_file(&args.file_path)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!(
                    "Not an image file: .{} is not a supported image format. Use the 'read' tool for text files (.txt, .md, .rs, .json, etc). Supported image formats: PNG, JPEG, GIF, WebP, BMP, SVG",
                    ext
                )).with_details(details.to_json());
            }
            None => {
                let details = ImageDetails::from_file(&args.file_path)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure("Could not determine image format from extension")
                    .with_details(details.to_json());
            }
        };

        // Read the file
        let data = match tokio::fs::read(path).await {
            Ok(data) => data,
            Err(e) => {
                let details = ImageDetails::from_file(&args.file_path)
                    .with_mime_type(mime_type)
                    .with_duration(start_time.elapsed().as_millis() as u64);
                return ToolResult::failure(format!("Failed to read image: {}", e))
                    .with_details(details.to_json());
            }
        };

        // Check file size
        if data.len() > MAX_IMAGE_SIZE {
            let details = ImageDetails::from_file(&args.file_path)
                .with_mime_type(mime_type)
                .with_size(data.len() as u64)
                .with_duration(start_time.elapsed().as_millis() as u64);
            return ToolResult::failure(format!(
                "Image too large: {} bytes (max {} bytes)",
                data.len(),
                MAX_IMAGE_SIZE
            ))
            .with_details(details.to_json());
        }

        // Encode to base64
        let base64_data = STANDARD.encode(&data);

        // Get image dimensions info if possible
        let dimensions = get_image_dimensions(&data);
        let max_dim = args.max_dimension.unwrap_or(DEFAULT_MAX_DIMENSION);
        let dim_info = dimensions
            .map(|(w, h)| {
                if w > max_dim || h > max_dim {
                    format!(" ({}x{}, exceeds max {})", w, h, max_dim)
                } else {
                    format!(" ({}x{})", w, h)
                }
            })
            .unwrap_or_default();

        // Format as data URI for easy consumption
        let data_uri = format!("data:{};base64,{}", mime_type, base64_data);

        // Return structured output
        let output = serde_json::json!({
            "mime_type": mime_type,
            "size_bytes": data.len(),
            "dimensions": dimensions.map(|(w, h)| format!("{}x{}", w, h)),
            "base64_length": base64_data.len(),
            "data_uri": data_uri,
        });

        // Build ImageDetails
        let mut details = ImageDetails::from_file(&args.file_path)
            .with_mime_type(mime_type)
            .with_size(data.len() as u64)
            .with_base64_length(base64_data.len())
            .with_duration(start_time.elapsed().as_millis() as u64);
        if let Some((w, h)) = dimensions {
            details = details.with_dimensions(w, h);
        }

        ToolResult::success(format!(
            "Image loaded: {} ({} bytes){}\n\n{}",
            args.file_path,
            data.len(),
            dim_info,
            serde_json::to_string_pretty(&output).unwrap_or_default()
        ))
        .with_details(details.to_json())
    }

    /// Capture a screenshot
    pub async fn screenshot(&self, args: ScreenshotArgs) -> ToolResult {
        let start_time = Instant::now();

        // Apply delay if specified
        if let Some(delay) = args.delay_ms {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        // Try platform-specific screenshot tools
        let result = if cfg!(target_os = "linux") {
            capture_screenshot_linux(args.window_title.as_deref()).await
        } else if cfg!(target_os = "macos") {
            capture_screenshot_macos(args.window_title.as_deref()).await
        } else if cfg!(target_os = "windows") {
            capture_screenshot_windows(args.window_title.as_deref()).await
        } else {
            Err("Screenshot not supported on this platform".to_string())
        };

        match result {
            Ok((data, mime_type)) => {
                let base64_data = STANDARD.encode(&data);
                let dimensions = get_image_dimensions(&data);
                let data_uri = format!("data:{};base64,{}", mime_type, base64_data);

                let output = serde_json::json!({
                    "mime_type": mime_type,
                    "size_bytes": data.len(),
                    "dimensions": dimensions.map(|(w, h)| format!("{}x{}", w, h)),
                    "base64_length": base64_data.len(),
                    "data_uri": data_uri,
                });

                // Build ImageDetails for screenshot
                let mut details = ImageDetails::screenshot()
                    .with_mime_type(mime_type)
                    .with_size(data.len() as u64)
                    .with_base64_length(base64_data.len())
                    .with_duration(start_time.elapsed().as_millis() as u64);
                if let Some((w, h)) = dimensions {
                    details = details.with_dimensions(w, h);
                }

                ToolResult::success(format!(
                    "Screenshot captured ({} bytes)\n\n{}",
                    data.len(),
                    serde_json::to_string_pretty(&output).unwrap_or_default()
                ))
                .with_details(details.to_json())
            }
            Err(e) => {
                let details = ImageDetails::screenshot()
                    .with_duration(start_time.elapsed().as_millis() as u64);
                ToolResult::failure(format!("Screenshot failed: {}", e))
                    .with_details(details.to_json())
            }
        }
    }
}

impl Default for ImageTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Get image dimensions from raw data (PNG/JPEG header parsing)
fn get_image_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if data.len() >= 24 && data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        // PNG IHDR chunk starts at byte 8, dimensions at 16-23
        let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
        let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
        return Some((width, height));
    }

    // JPEG signature: FF D8 FF
    if data.len() >= 2 && data.starts_with(&[0xFF, 0xD8]) {
        // JPEG dimensions are in SOF0/SOF2 markers, more complex to parse
        // For now, return None for JPEG (could be improved)
        return None;
    }

    // GIF signature: GIF87a or GIF89a
    if data.len() >= 10 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        let width = u16::from_le_bytes([data[6], data[7]]) as u32;
        let height = u16::from_le_bytes([data[8], data[9]]) as u32;
        return Some((width, height));
    }

    None
}

/// Capture screenshot on Linux using scrot or gnome-screenshot
async fn capture_screenshot_linux(
    window_title: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    use std::env::temp_dir;
    use std::process::Command;

    let temp_path = temp_dir().join(format!("composer_screenshot_{}.png", std::process::id()));
    let temp_str = temp_path.to_string_lossy().to_string();

    // Try different screenshot tools
    let tools = [
        ("scrot", vec!["-o", &temp_str]),
        ("gnome-screenshot", vec!["-f", &temp_str]),
        ("maim", vec![&temp_str]),
        ("import", vec!["-window", "root", &temp_str]), // ImageMagick
    ];

    let mut last_error = String::new();

    for (tool, mut args) in tools {
        // Add window selection if specified
        if let Some(_title) = window_title {
            if tool == "scrot" {
                args = vec!["-u", "-o", &temp_str]; // Focused window
            }
        }

        match Command::new(tool).args(&args).output() {
            Ok(output) if output.status.success() => {
                // Read the captured image
                match std::fs::read(&temp_path) {
                    Ok(data) => {
                        let _ = std::fs::remove_file(&temp_path);
                        return Ok((data, "image/png"));
                    }
                    Err(e) => {
                        last_error = format!("Failed to read screenshot: {}", e);
                    }
                }
            }
            Ok(output) => {
                last_error = format!(
                    "{} failed: {}",
                    tool,
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(_) => {
                // Tool not found, try next
                continue;
            }
        }
    }

    Err(format!(
        "No screenshot tool available. Install scrot, gnome-screenshot, or maim. Last error: {}",
        last_error
    ))
}

/// Capture screenshot on macOS using screencapture
async fn capture_screenshot_macos(
    window_title: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    use std::env::temp_dir;
    use std::process::Command;

    let temp_path = temp_dir().join(format!("composer_screenshot_{}.png", std::process::id()));
    let temp_str = temp_path.to_string_lossy().to_string();

    let mut args = vec!["-x"]; // Silent mode

    if window_title.is_some() {
        args.push("-w"); // Interactive window selection
    }

    args.push(&temp_str);

    match Command::new("screencapture").args(&args).output() {
        Ok(output) if output.status.success() => match std::fs::read(&temp_path) {
            Ok(data) => {
                let _ = std::fs::remove_file(&temp_path);
                Ok((data, "image/png"))
            }
            Err(e) => Err(format!("Failed to read screenshot: {}", e)),
        },
        Ok(output) => Err(format!(
            "screencapture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Err(e) => Err(format!("Failed to run screencapture: {}", e)),
    }
}

/// Capture screenshot on Windows using PowerShell
async fn capture_screenshot_windows(
    _window_title: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    use std::env::temp_dir;
    use std::process::Command;

    let temp_path = temp_dir().join(format!("composer_screenshot_{}.png", std::process::id()));
    let temp_str = temp_path.to_string_lossy().to_string();

    // PowerShell script to capture screen
    let script = format!(
        r#"
        Add-Type -AssemblyName System.Windows.Forms
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen
        $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
        $bitmap.Save('{}')
        $graphics.Dispose()
        $bitmap.Dispose()
        "#,
        temp_str.replace('\\', "\\\\").replace('\'', "''")
    );

    match Command::new("powershell")
        .args(["-Command", &script])
        .output()
    {
        Ok(output) if output.status.success() => match std::fs::read(&temp_path) {
            Ok(data) => {
                let _ = std::fs::remove_file(&temp_path);
                Ok((data, "image/png"))
            }
            Err(e) => Err(format!("Failed to read screenshot: {}", e)),
        },
        Ok(output) => Err(format!(
            "PowerShell screenshot failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Err(e) => Err(format!("Failed to run PowerShell: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_image_definition() {
        let tool = ImageTool::read_image_definition();
        assert_eq!(tool.name, "read_image");
        assert!(tool.description.contains("image"));
    }

    #[test]
    fn test_screenshot_definition() {
        let tool = ImageTool::screenshot_definition();
        assert_eq!(tool.name, "screenshot");
        assert!(tool.description.contains("screenshot"));
    }

    #[test]
    fn test_get_png_dimensions() {
        // PNG header with 100x200 dimensions
        let png_header: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length
            0x49, 0x48, 0x44, 0x52, // IHDR
            0x00, 0x00, 0x00, 0x64, // width = 100
            0x00, 0x00, 0x00, 0xC8, // height = 200
        ];

        let dims = get_image_dimensions(&png_header);
        assert_eq!(dims, Some((100, 200)));
    }

    #[test]
    fn test_get_gif_dimensions() {
        // GIF header with 320x240 dimensions
        let gif_header: Vec<u8> = vec![
            b'G', b'I', b'F', b'8', b'9', b'a', // GIF89a
            0x40, 0x01, // width = 320 (little endian)
            0xF0, 0x00, // height = 240 (little endian)
        ];

        let dims = get_image_dimensions(&gif_header);
        assert_eq!(dims, Some((320, 240)));
    }

    #[test]
    fn test_get_dimensions_unknown_format() {
        let random_data = vec![0x00, 0x01, 0x02, 0x03];
        let dims = get_image_dimensions(&random_data);
        assert_eq!(dims, None);
    }

    #[tokio::test]
    async fn test_read_image_not_found() {
        let tool = ImageTool::new();
        let result = tool
            .read_image(ReadImageArgs {
                file_path: "/nonexistent/image.png".to_string(),
                max_dimension: None,
            })
            .await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn test_read_image_unsupported_format() {
        let tool = ImageTool::new();
        // Create a temp file with unsupported extension
        let temp_dir = std::env::temp_dir();
        let temp_path = temp_dir.join("test_image.xyz");
        tokio::fs::write(&temp_path, b"test").await.unwrap();

        let result = tool
            .read_image(ReadImageArgs {
                file_path: temp_path.to_string_lossy().to_string(),
                max_dimension: None,
            })
            .await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("Not an image file"));

        let _ = tokio::fs::remove_file(&temp_path).await;
    }
}
