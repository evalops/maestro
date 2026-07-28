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
    let duration = probe_duration(path).await?;
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
        .arg(sampling_filter(duration))
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

async fn probe_duration(path: &Path) -> Result<f64> {
    let mut command = Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .context("video duration probe exceeded 10 seconds")?
        .context("ffprobe is required for video attachments")?;
    if !output.status.success() {
        bail!(
            "video duration probe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let duration = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .context("ffprobe returned an invalid video duration")?;
    if !duration.is_finite() || duration <= 0.0 {
        bail!("video duration must be positive");
    }
    Ok(duration)
}

fn sampling_filter(duration: f64) -> String {
    let final_timestamp = duration * 0.999;
    let frames_per_second = (MAX_FRAMES.saturating_sub(1) as f64) / final_timestamp;
    format!("fps={frames_per_second:.9},scale='min(1280,iw)':-2,format=yuvj420p")
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

    #[test]
    fn sampling_rate_spans_the_full_video() {
        let filter = sampling_filter(80.0);
        let rate = filter
            .strip_prefix("fps=")
            .and_then(|value| value.split(',').next())
            .and_then(|value| value.parse::<f64>().ok())
            .expect("sampling rate");
        let last_timestamp = (MAX_FRAMES - 1) as f64 / rate;

        assert!(last_timestamp > 79.0);
        assert!(last_timestamp < 80.0);
    }

    #[tokio::test]
    async fn extracts_bounded_frames_when_ffmpeg_is_available() {
        if ["ffmpeg", "ffprobe"].iter().any(|command| {
            std::process::Command::new(command)
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_err()
        }) {
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
