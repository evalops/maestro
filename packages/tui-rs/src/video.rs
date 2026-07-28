//! Provider-neutral video input preprocessing.
//!
//! Video-capable prompts are converted into a bounded sequence of JPEG frames,
//! which works across Maestro's vision model providers without persisting media.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tokio::process::Command;

pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FRAMES: usize = 8;

#[must_use]
pub fn detect_video_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

/// Decode evenly sampled, size-bounded JPEG frames with the system ffmpeg.
pub async fn extract_frames(path: &Path) -> Result<Vec<String>> {
    if detect_video_mime(path).is_none() {
        bail!("unsupported video format: {}", path.display());
    }
    let metadata = tokio::fs::metadata(path).await?;
    if metadata.len() > MAX_VIDEO_BYTES {
        bail!("video exceeds the 100 MiB input limit");
    }
    let temporary = tempfile::TempDir::new()?;
    let pattern = temporary.path().join("frame-%03d.jpg");
    let mut command = Command::new("ffmpeg");
    command
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(path)
        .arg("-vf")
        .arg("select='eq(n,0)+gte(t-prev_selected_t,5)',scale='min(1280,iw)':-2,format=yuvj420p")
        .args(["-fps_mode", "vfr"])
        .arg("-frames:v")
        .arg(MAX_FRAMES.to_string())
        .arg(&pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_mins(1), command.output())
        .await
        .context("video decoding exceeded 60 seconds")?
        .context("ffmpeg is required for video attachments")?;
    if !output.status.success() {
        bail!(
            "video decoding failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let mut paths = std::fs::read_dir(temporary.path())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    if paths.is_empty() {
        bail!("video contained no decodable frames");
    }
    paths
        .into_iter()
        .map(|frame| {
            std::fs::read(frame)
                .map(|bytes| STANDARD.encode(bytes))
                .map_err(Into::into)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_video_containers() {
        assert_eq!(detect_video_mime(Path::new("clip.MP4")), Some("video/mp4"));
        assert_eq!(
            detect_video_mime(Path::new("clip.webm")),
            Some("video/webm")
        );
        assert_eq!(detect_video_mime(Path::new("clip.txt")), None);
    }

    #[tokio::test]
    async fn extracts_bounded_frames_when_ffmpeg_is_available() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let temporary = tempfile::tempdir().unwrap();
        let video = temporary.path().join("sample.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=32x32:d=1",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&video)
            .status()
            .unwrap();
        assert!(status.success());
        let frames = extract_frames(&video).await.unwrap();
        assert!(!frames.is_empty());
        assert!(frames.len() <= MAX_FRAMES);
    }
}
