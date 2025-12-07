//! Message framing protocol
//!
//! Provides reliable message framing for the headless protocol.
//! Supports multiple framing modes:
//! - Newline-delimited JSON (default, compatible with existing agents)
//! - Length-prefixed binary (for future high-performance transports)

use std::io::{self, BufRead, BufReader, Read, Write};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Framing mode for message transport
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FramingMode {
    /// Newline-delimited JSON (default)
    /// Each message is a single line of JSON followed by \n
    #[default]
    NewlineDelimited,
    /// Length-prefixed binary
    /// Format: [4-byte big-endian length][JSON bytes]
    LengthPrefixed,
}

/// Error type for framing operations
#[derive(Debug)]
pub enum FramingError {
    /// IO error
    Io(io::Error),
    /// JSON parse error
    Json(serde_json::Error),
    /// Message too large
    MessageTooLarge { size: usize, max: usize },
    /// Invalid frame format
    InvalidFrame(String),
    /// Connection closed
    ConnectionClosed,
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramingError::Io(e) => write!(f, "IO error: {}", e),
            FramingError::Json(e) => write!(f, "JSON error: {}", e),
            FramingError::MessageTooLarge { size, max } => {
                write!(f, "Message too large: {} bytes (max: {})", size, max)
            }
            FramingError::InvalidFrame(msg) => write!(f, "Invalid frame: {}", msg),
            FramingError::ConnectionClosed => write!(f, "Connection closed"),
        }
    }
}

impl std::error::Error for FramingError {}

impl From<io::Error> for FramingError {
    fn from(e: io::Error) -> Self {
        FramingError::Io(e)
    }
}

impl From<serde_json::Error> for FramingError {
    fn from(e: serde_json::Error) -> Self {
        FramingError::Json(e)
    }
}

/// Maximum message size (10MB)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Synchronous message writer
pub struct FrameWriter<W> {
    writer: W,
    mode: FramingMode,
    max_size: usize,
}

impl<W: Write> FrameWriter<W> {
    /// Create a new frame writer with default settings
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            mode: FramingMode::default(),
            max_size: MAX_MESSAGE_SIZE,
        }
    }

    /// Set the framing mode
    pub fn with_mode(mut self, mode: FramingMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set the maximum message size
    pub fn with_max_size(mut self, size: usize) -> Self {
        self.max_size = size;
        self
    }

    /// Write a message
    pub fn write_message<T: serde::Serialize>(&mut self, msg: &T) -> Result<(), FramingError> {
        let json = serde_json::to_string(msg)?;
        let bytes = json.as_bytes();

        if bytes.len() > self.max_size {
            return Err(FramingError::MessageTooLarge {
                size: bytes.len(),
                max: self.max_size,
            });
        }

        match self.mode {
            FramingMode::NewlineDelimited => {
                self.writer.write_all(bytes)?;
                self.writer.write_all(b"\n")?;
            }
            FramingMode::LengthPrefixed => {
                let len = bytes.len() as u32;
                self.writer.write_all(&len.to_be_bytes())?;
                self.writer.write_all(bytes)?;
            }
        }

        self.writer.flush()?;
        Ok(())
    }

    /// Get a mutable reference to the inner writer
    pub fn inner_mut(&mut self) -> &mut W {
        &mut self.writer
    }

    /// Consume and return the inner writer
    pub fn into_inner(self) -> W {
        self.writer
    }
}

/// Synchronous message reader
pub struct FrameReader<R> {
    reader: BufReader<R>,
    mode: FramingMode,
    max_size: usize,
    buffer: Vec<u8>,
}

impl<R: Read> FrameReader<R> {
    /// Create a new frame reader with default settings
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, reader),
            mode: FramingMode::default(),
            max_size: MAX_MESSAGE_SIZE,
            buffer: Vec::with_capacity(4096),
        }
    }

    /// Set the framing mode
    pub fn with_mode(mut self, mode: FramingMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set the maximum message size
    pub fn with_max_size(mut self, size: usize) -> Self {
        self.max_size = size;
        self
    }

    /// Read a message
    pub fn read_message<T: serde::de::DeserializeOwned>(&mut self) -> Result<T, FramingError> {
        match self.mode {
            FramingMode::NewlineDelimited => {
                self.buffer.clear();
                let bytes_read = self.reader.read_until(b'\n', &mut self.buffer)?;

                if bytes_read == 0 {
                    return Err(FramingError::ConnectionClosed);
                }

                // Remove trailing newline
                if self.buffer.last() == Some(&b'\n') {
                    self.buffer.pop();
                }

                if self.buffer.is_empty() {
                    // Empty line, try again
                    return self.read_message();
                }

                if self.buffer.len() > self.max_size {
                    return Err(FramingError::MessageTooLarge {
                        size: self.buffer.len(),
                        max: self.max_size,
                    });
                }

                let msg = serde_json::from_slice(&self.buffer)?;
                Ok(msg)
            }
            FramingMode::LengthPrefixed => {
                let mut len_bytes = [0u8; 4];
                self.reader.read_exact(&mut len_bytes)?;
                let len = u32::from_be_bytes(len_bytes) as usize;

                if len > self.max_size {
                    return Err(FramingError::MessageTooLarge {
                        size: len,
                        max: self.max_size,
                    });
                }

                self.buffer.resize(len, 0);
                self.reader.read_exact(&mut self.buffer)?;

                let msg = serde_json::from_slice(&self.buffer)?;
                Ok(msg)
            }
        }
    }
}

/// Async message writer
pub struct AsyncFrameWriter<W> {
    writer: W,
    mode: FramingMode,
    max_size: usize,
}

impl<W: AsyncWrite + Unpin> AsyncFrameWriter<W> {
    /// Create a new async frame writer
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            mode: FramingMode::default(),
            max_size: MAX_MESSAGE_SIZE,
        }
    }

    /// Set the framing mode
    pub fn with_mode(mut self, mode: FramingMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set the maximum message size
    pub fn with_max_size(mut self, size: usize) -> Self {
        self.max_size = size;
        self
    }

    /// Write a message
    pub async fn write_message<T: serde::Serialize>(
        &mut self,
        msg: &T,
    ) -> Result<(), FramingError> {
        let json = serde_json::to_string(msg)?;
        let bytes = json.as_bytes();

        if bytes.len() > self.max_size {
            return Err(FramingError::MessageTooLarge {
                size: bytes.len(),
                max: self.max_size,
            });
        }

        match self.mode {
            FramingMode::NewlineDelimited => {
                self.writer.write_all(bytes).await?;
                self.writer.write_all(b"\n").await?;
            }
            FramingMode::LengthPrefixed => {
                let len = bytes.len() as u32;
                self.writer.write_all(&len.to_be_bytes()).await?;
                self.writer.write_all(bytes).await?;
            }
        }

        self.writer.flush().await?;
        Ok(())
    }

    /// Get a mutable reference to the inner writer
    pub fn inner_mut(&mut self) -> &mut W {
        &mut self.writer
    }

    /// Consume and return the inner writer
    pub fn into_inner(self) -> W {
        self.writer
    }
}

/// Async message reader
pub struct AsyncFrameReader<R> {
    reader: tokio::io::BufReader<R>,
    mode: FramingMode,
    max_size: usize,
    line_buffer: String,
    byte_buffer: Vec<u8>,
}

impl<R: AsyncRead + Unpin> AsyncFrameReader<R> {
    /// Create a new async frame reader
    pub fn new(reader: R) -> Self {
        Self {
            reader: tokio::io::BufReader::with_capacity(64 * 1024, reader),
            mode: FramingMode::default(),
            max_size: MAX_MESSAGE_SIZE,
            line_buffer: String::with_capacity(4096),
            byte_buffer: Vec::with_capacity(4096),
        }
    }

    /// Set the framing mode
    pub fn with_mode(mut self, mode: FramingMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set the maximum message size
    pub fn with_max_size(mut self, size: usize) -> Self {
        self.max_size = size;
        self
    }

    /// Read a message
    pub async fn read_message<T: serde::de::DeserializeOwned>(&mut self) -> Result<T, FramingError> {
        match self.mode {
            FramingMode::NewlineDelimited => {
                loop {
                    self.line_buffer.clear();
                    let bytes_read = self.reader.read_line(&mut self.line_buffer).await?;

                    if bytes_read == 0 {
                        return Err(FramingError::ConnectionClosed);
                    }

                    // Remove trailing newline
                    let line = self.line_buffer.trim();
                    if line.is_empty() {
                        continue;
                    }

                    if line.len() > self.max_size {
                        return Err(FramingError::MessageTooLarge {
                            size: line.len(),
                            max: self.max_size,
                        });
                    }

                    let msg = serde_json::from_str(line)?;
                    return Ok(msg);
                }
            }
            FramingMode::LengthPrefixed => {
                let mut len_bytes = [0u8; 4];
                self.reader.read_exact(&mut len_bytes).await?;
                let len = u32::from_be_bytes(len_bytes) as usize;

                if len > self.max_size {
                    return Err(FramingError::MessageTooLarge {
                        size: len,
                        max: self.max_size,
                    });
                }

                self.byte_buffer.resize(len, 0);
                self.reader.read_exact(&mut self.byte_buffer).await?;

                let msg = serde_json::from_slice(&self.byte_buffer)?;
                Ok(msg)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::io::Cursor;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct TestMessage {
        id: u32,
        content: String,
    }

    #[test]
    fn test_newline_delimited_roundtrip() {
        let msg = TestMessage {
            id: 1,
            content: "Hello, world!".to_string(),
        };

        let mut buffer = Vec::new();
        {
            let mut writer = FrameWriter::new(&mut buffer);
            writer.write_message(&msg).unwrap();
        }

        let cursor = Cursor::new(buffer);
        let mut reader = FrameReader::new(cursor);
        let received: TestMessage = reader.read_message().unwrap();

        assert_eq!(msg, received);
    }

    #[test]
    fn test_length_prefixed_roundtrip() {
        let msg = TestMessage {
            id: 42,
            content: "Length-prefixed test".to_string(),
        };

        let mut buffer = Vec::new();
        {
            let mut writer = FrameWriter::new(&mut buffer).with_mode(FramingMode::LengthPrefixed);
            writer.write_message(&msg).unwrap();
        }

        let cursor = Cursor::new(buffer);
        let mut reader = FrameReader::new(cursor).with_mode(FramingMode::LengthPrefixed);
        let received: TestMessage = reader.read_message().unwrap();

        assert_eq!(msg, received);
    }

    #[test]
    fn test_message_too_large() {
        let msg = TestMessage {
            id: 1,
            content: "x".repeat(1000),
        };

        let mut buffer = Vec::new();
        let mut writer = FrameWriter::new(&mut buffer).with_max_size(100);
        let result = writer.write_message(&msg);

        assert!(matches!(result, Err(FramingError::MessageTooLarge { .. })));
    }

    #[test]
    fn test_multiple_messages() {
        let messages = vec![
            TestMessage {
                id: 1,
                content: "First".to_string(),
            },
            TestMessage {
                id: 2,
                content: "Second".to_string(),
            },
            TestMessage {
                id: 3,
                content: "Third".to_string(),
            },
        ];

        let mut buffer = Vec::new();
        {
            let mut writer = FrameWriter::new(&mut buffer);
            for msg in &messages {
                writer.write_message(msg).unwrap();
            }
        }

        let cursor = Cursor::new(buffer);
        let mut reader = FrameReader::new(cursor);

        for expected in &messages {
            let received: TestMessage = reader.read_message().unwrap();
            assert_eq!(expected, &received);
        }
    }

    #[test]
    fn test_empty_lines_skipped() {
        let msg = TestMessage {
            id: 1,
            content: "Test".to_string(),
        };

        // Create buffer with empty lines
        let mut buffer = Vec::new();
        buffer.extend_from_slice(b"\n\n");
        buffer.extend_from_slice(serde_json::to_string(&msg).unwrap().as_bytes());
        buffer.extend_from_slice(b"\n");

        let cursor = Cursor::new(buffer);
        let mut reader = FrameReader::new(cursor);
        let received: TestMessage = reader.read_message().unwrap();

        assert_eq!(msg, received);
    }

    #[tokio::test]
    async fn test_async_newline_roundtrip() {
        let msg = TestMessage {
            id: 1,
            content: "Async test".to_string(),
        };

        let mut buffer = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buffer);
            let mut writer = AsyncFrameWriter::new(tokio::io::BufWriter::new(cursor));
            writer.write_message(&msg).await.unwrap();
        }

        let cursor = std::io::Cursor::new(buffer);
        let mut reader = AsyncFrameReader::new(cursor);
        let received: TestMessage = reader.read_message().await.unwrap();

        assert_eq!(msg, received);
    }

    #[tokio::test]
    async fn test_async_length_prefixed_roundtrip() {
        let msg = TestMessage {
            id: 42,
            content: "Async length-prefixed".to_string(),
        };

        let mut buffer = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buffer);
            let mut writer = AsyncFrameWriter::new(tokio::io::BufWriter::new(cursor))
                .with_mode(FramingMode::LengthPrefixed);
            writer.write_message(&msg).await.unwrap();
        }

        let cursor = std::io::Cursor::new(buffer);
        let mut reader = AsyncFrameReader::new(cursor).with_mode(FramingMode::LengthPrefixed);
        let received: TestMessage = reader.read_message().await.unwrap();

        assert_eq!(msg, received);
    }
}
