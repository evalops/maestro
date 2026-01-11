//! Message framing protocol for reliable IPC.
//!
//! This module provides reliable message framing for the headless protocol, solving
//! the fundamental problem of message boundaries in stream-oriented communication.
//! When sending messages over pipes or sockets, the receiver needs a way to determine
//! where one message ends and the next begins.
//!
//! # The Framing Problem
//!
//! Consider sending two JSON messages over a pipe:
//!
//! ```text
//! {"type":"prompt","content":"Hello"}{"type":"interrupt"}
//! ```
//!
//! Without framing, the receiver sees a continuous byte stream and cannot determine
//! the message boundaries. Framing solves this by adding delimiters or length information.
//!
//! # Framing Modes
//!
//! ## Newline-Delimited JSON (Default)
//!
//! Each message is terminated by a newline (`\n`):
//!
//! ```text
//! {"type":"prompt","content":"Hello"}\n
//! {"type":"interrupt"}\n
//! ```
//!
//! **Advantages:**
//! - Simple to implement and debug
//! - Human-readable in logs
//! - Self-synchronizing (lost frames don't corrupt stream)
//! - Compatible with line-buffered I/O
//!
//! **Limitations:**
//! - Requires scanning for newlines
//! - JSON content cannot contain literal newlines (must escape as `\n`)
//!
//! ## Length-Prefixed Binary
//!
//! Each message is prefixed with its length as a 4-byte big-endian integer:
//!
//! ```text
//! [0x00, 0x00, 0x00, 0x2A][...42 bytes of JSON...]
//! [0x00, 0x00, 0x00, 0x15][...21 bytes of JSON...]
//! ```
//!
//! **Advantages:**
//! - No scanning required - O(1) framing overhead
//! - Supports binary data (base64-encoded in JSON)
//! - Predictable performance for large messages
//!
//! **Limitations:**
//! - Not human-readable
//! - Lost synchronization corrupts the stream
//!
//! # Buffered I/O
//!
//! Both sync and async implementations use buffered readers/writers to minimize
//! system calls. A `BufReader` with 64KB capacity reduces read syscalls by batching
//! multiple messages into a single buffer.
//!
//! ## Buffer Size Selection
//!
//! The default 64KB buffer is chosen because:
//! - Most messages are < 10KB, so multiple messages fit in one buffer
//! - Larger buffers increase latency for small messages
//! - 64KB is typical for TCP buffers and works well for stdio
//!
//! # Async vs Sync
//!
//! This module provides both synchronous and asynchronous implementations:
//!
//! - **Sync** - `FrameReader`/`FrameWriter` for use with `std::io` types
//! - **Async** - `AsyncFrameReader`/`AsyncFrameWriter` for use with `tokio::io` types
//!
//! The async versions use the same framing logic but integrate with Tokio's
//! async runtime, allowing concurrent I/O without blocking threads.

use std::io::{self, BufRead, BufReader, Read, Write};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Framing mode for message transport.
///
/// Determines how messages are delimited in the byte stream. The choice of framing
/// mode affects performance, debuggability, and robustness.
///
/// # Mode Selection
///
/// - Use `NewlineDelimited` (default) for:
///   - Interactive debugging (messages are human-readable)
///   - Cross-platform compatibility
///   - Self-synchronizing streams
///
/// - Use `LengthPrefixed` for:
///   - High-throughput scenarios with large messages
///   - Binary data transport
///   - Predictable performance characteristics
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FramingMode {
    /// Newline-delimited JSON (default).
    ///
    /// Each message is a single line of JSON followed by `\n`.
    /// Empty lines are skipped automatically.
    #[default]
    NewlineDelimited,

    /// Length-prefixed binary.
    ///
    /// Format: `[4-byte big-endian length][JSON bytes]`
    ///
    /// The length field specifies the number of bytes in the JSON payload,
    /// not including the length prefix itself.
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
            FramingError::Io(e) => write!(f, "IO error: {e}"),
            FramingError::Json(e) => write!(f, "JSON error: {e}"),
            FramingError::MessageTooLarge { size, max } => {
                write!(f, "Message too large: {size} bytes (max: {max})")
            }
            FramingError::InvalidFrame(msg) => write!(f, "Invalid frame: {msg}"),
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

/// Maximum message size (10MB).
///
/// Messages larger than this limit are rejected to prevent memory exhaustion
/// and ensure bounded processing time.
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Synchronous message writer.
///
/// Serializes messages to JSON and writes them with appropriate framing to an
/// underlying `Write` implementation. Automatically flushes after each message
/// to ensure immediate delivery.
///
/// # Type Parameters
///
/// - `W: Write` - Any type implementing `std::io::Write`, such as:
///   - `std::process::ChildStdin` - Write to subprocess stdin
///   - `std::net::TcpStream` - Write to network socket
///   - `std::io::Cursor<Vec<u8>>` - Write to in-memory buffer
///
/// # Examples
///
/// ```rust,ignore
/// use composer_tui::headless::framing::FrameWriter;
/// use serde::{Serialize, Deserialize};
///
/// #[derive(Serialize)]
/// struct Message {
///     content: String,
/// }
///
/// let mut buffer = Vec::new();
/// let mut writer = FrameWriter::new(&mut buffer);
///
/// writer.write_message(&Message {
///     content: "Hello".to_string()
/// })?;
///
/// // Buffer now contains: {"content":"Hello"}\n
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
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

/// Synchronous message reader.
///
/// Reads framed messages from an underlying `Read` implementation, deserializing
/// them from JSON. Uses buffered I/O to minimize system calls.
///
/// # Type Parameters
///
/// - `R: Read` - Any type implementing `std::io::Read`, such as:
///   - `std::process::ChildStdout` - Read from subprocess stdout
///   - `std::net::TcpStream` - Read from network socket
///   - `std::io::Cursor<Vec<u8>>` - Read from in-memory buffer
///
/// # Buffering Strategy
///
/// Internally uses a `BufReader` with 64KB capacity. This batches multiple
/// small messages into fewer system calls, significantly improving throughput
/// for high-frequency message streams.
///
/// # Empty Line Handling
///
/// In `NewlineDelimited` mode, empty lines are automatically skipped. This
/// provides robustness against debugging output or protocol extensions that
/// insert blank lines.
///
/// # Examples
///
/// ```rust,ignore
/// use composer_tui::headless::framing::FrameReader;
/// use serde::Deserialize;
/// use std::io::Cursor;
///
/// #[derive(Deserialize)]
/// struct Message {
///     content: String,
/// }
///
/// let data = b"{\"content\":\"Hello\"}\n";
/// let cursor = Cursor::new(data);
/// let mut reader = FrameReader::new(cursor);
///
/// let msg: Message = reader.read_message()?;
/// assert_eq!(msg.content, "Hello");
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
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
    pub async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
    ) -> Result<T, FramingError> {
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
