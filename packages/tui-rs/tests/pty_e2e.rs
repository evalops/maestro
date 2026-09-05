//! PTY end-to-end tests for the interactive TUI.
//!
//! Adopted from grok-build's mock-model PTY harness
//! (`crates/codegen/xai-grok-pager-pty-harness`): spawn the real `maestro-tui`
//! binary in a pseudo-terminal, point the agent at a mock OpenAI-compatible
//! server that serves scripted streaming responses, poll the terminal output
//! until expected content appears, and dump the captured output on failure.
//!
//! Unlike the reference harness we do not model a full virtual screen
//! (alacritty_terminal) or YAML scenario files; assertions run against the
//! accumulated ANSI-stripped PTY stream, which is sufficient for these
//! scenarios. Those remain possible follow-ups.
//!
//! The tests need no network access, no real API key, and no display; they
//! only require a Unix PTY.

#![cfg(unix)]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};

/// Generous ceiling for binary startup (first frame + agent init).
const READY_TIMEOUT: Duration = Duration::from_mins(1);
/// Ceiling for a single agent turn against the local mock server.
const TURN_TIMEOUT: Duration = Duration::from_secs(30);

// ─────────────────────────────────────────────────────────────────────────────
// Mock OpenAI-compatible server
// ─────────────────────────────────────────────────────────────────────────────

/// One scripted streaming response: the raw SSE body to serve for a single
/// `POST /v1/chat/completions` request.
struct ScriptedTurn {
    sse_body: String,
}

/// Serve `data:` lines, one JSON chunk each, terminated by `[DONE]`.
fn sse_body(chunks: &[serde_json::Value]) -> String {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str("data: ");
        body.push_str(&chunk.to_string());
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    body
}

fn chunk(delta: serde_json::Value, finish_reason: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-pty-e2e",
        "object": "chat.completion.chunk",
        "created": 1_700_000_000,
        "model": "gpt-4o",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
        "usage": null,
    })
}

/// A streamed assistant text answer.
fn text_turn(text: &str) -> ScriptedTurn {
    ScriptedTurn {
        sse_body: sse_body(&[
            chunk(
                serde_json::json!({"role": "assistant", "content": text}),
                None,
            ),
            chunk(serde_json::json!({}), Some("stop")),
        ]),
    }
}

/// A streamed assistant tool call (Chat Completions `tool_calls` deltas).
fn tool_call_turn(name: &str, arguments: &serde_json::Value) -> ScriptedTurn {
    ScriptedTurn {
        sse_body: sse_body(&[
            chunk(
                serde_json::json!({
                    "role": "assistant",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_pty_e2e_1",
                        "type": "function",
                        "function": { "name": name, "arguments": arguments.to_string() },
                    }],
                }),
                None,
            ),
            chunk(serde_json::json!({}), Some("tool_calls")),
        ]),
    }
}

struct MockState {
    script: VecDeque<ScriptedTurn>,
    /// Bodies of every `chat/completions` request received, in order.
    requests: Vec<String>,
}

/// Minimal HTTP/1.1 stub serving scripted SSE responses from a queue.
///
/// Each request pops the next scripted turn; when the script is exhausted the
/// server answers 500 so a stuck test fails fast with a clear cause instead of
/// hanging on a dead agent.
struct MockOpenAiServer {
    base_url: String,
    identity_base_url: String,
    state: Arc<Mutex<MockState>>,
}

impl MockOpenAiServer {
    fn start(script: Vec<ScriptedTurn>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("mock server addr");
        let state = Arc::new(Mutex::new(MockState {
            script: script.into(),
            requests: Vec::new(),
        }));
        let thread_state = Arc::clone(&state);
        std::thread::Builder::new()
            .name("pty-e2e-mock-openai".to_owned())
            .spawn(move || {
                for stream in listener.incoming() {
                    match stream {
                        Ok(stream) => Self::serve(stream, &thread_state),
                        Err(_) => break,
                    }
                }
            })
            .expect("spawn mock server thread");
        Self {
            base_url: format!("http://{addr}/v1"),
            identity_base_url: start_mock_identity_server(),
            state,
        }
    }

    fn serve(mut stream: TcpStream, state: &Arc<Mutex<MockState>>) {
        let Ok(body) = read_request_body(&mut stream) else {
            return;
        };
        let next = {
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            state.requests.push(body);
            state.script.pop_front()
        };
        let (status, content_type, payload) = match next {
            Some(turn) => ("200 OK", "text/event-stream", turn.sse_body),
            None => (
                "500 Internal Server Error",
                "text/plain",
                "pty-e2e mock script exhausted".to_owned(),
            ),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }

    fn request_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .len()
    }
}

/// Serve the minimal signed-Identity projection required by the real Maestro
/// admission boundary. PTY scenarios exercise interaction behavior, but they
/// still must start through the same live verification path as production.
fn start_mock_identity_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock Identity server");
    let address = listener.local_addr().expect("mock Identity server address");
    std::thread::Builder::new()
        .name("pty-e2e-mock-identity".to_owned())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    break;
                };
                let _ = read_request_body(&mut stream);
                let body = r#"{"active":true,"subject":"pty-e2e-user","token_type":"access","organization_id":"pty-e2e-org","workspace_id":"pty-e2e-workspace","scopes":["llm_gateway:invoke"]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        })
        .expect("spawn mock Identity server thread");
    format!("http://{address}")
}

/// Read one HTTP request and return its body. Only the small, well-formed
/// requests `reqwest` sends to this stub are supported.
fn read_request_body(stream: &mut TcpStream) -> std::io::Result<String> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 8192];
    let headers_end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed before headers completed",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let headers = String::from_utf8_lossy(&buf[..headers_end]).to_lowercase();
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = headers_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let end = (body_start + content_length).min(buf.len());
    Ok(String::from_utf8_lossy(&buf[body_start..end]).into_owned())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ─────────────────────────────────────────────────────────────────────────────
// PTY session driving the real binary
// ─────────────────────────────────────────────────────────────────────────────

struct PtySession {
    child: Box<dyn Child + Send + Sync>,
    // Kept alive so the PTY master (and the reader thread's source) stays open.
    _master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
}

impl PtySession {
    /// Spawn `maestro-tui` in a 120x36 PTY, wired to the mock server and an
    /// isolated HOME/MAESTRO_HOME so user config, history, and keychains are
    /// never touched.
    ///
    /// `initial_prompt` is passed as trailing argv: the app submits it itself
    /// once the agent reports ready, which gives a deterministic readiness
    /// signal no typed-first-prompt race can match. Interactive keys (`y`,
    /// Ctrl+C, follow-up prompts) still go through the real PTY input path.
    fn spawn(mock: &MockOpenAiServer, workdir: &std::path::Path, initial_prompt: &str) -> Self {
        Self::spawn_with_args(
            mock,
            workdir,
            &[
                "--model",
                "gpt-4o",
                "--api-key",
                "pty-e2e-key",
                initial_prompt,
            ],
        )
    }

    /// Spawn the real binary with an explicit argv vector.
    ///
    /// Fork is a fast-path subcommand and therefore cannot use the regular
    /// interactive flags prepended by [`Self::spawn`].
    fn spawn_with_args(mock: &MockOpenAiServer, workdir: &std::path::Path, args: &[&str]) -> Self {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 36,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open PTY");

        let maestro_home = workdir.join("maestro-home");
        std::fs::create_dir_all(&maestro_home).expect("create MAESTRO_HOME");

        let mut command = CommandBuilder::new(
            std::env::var_os("CARGO_BIN_EXE_maestro-tui")
                .expect("Cargo must provide the maestro-tui integration-test binary"),
        );
        command.args(args);
        command.cwd(workdir);
        // CommandBuilder starts from an empty environment; pass through only
        // what the child needs and pin everything else explicitly.
        for key in ["PATH", "LANG", "USER", "LOGNAME", "TMPDIR"] {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
        command.env("TERM", "xterm-256color");
        command.env("HOME", workdir);
        command.env("MAESTRO_HOME", &maestro_home);
        command.env("OPENAI_BASE_URL", &mock.base_url);
        command.env("OPENAI_API_KEY", "pty-e2e-key");
        command.env("MAESTRO_IDENTITY_URL", &mock.identity_base_url);
        command.env(maestro_tui::init_cli::TEST_IDENTITY_AUTHORITY_ENV, "1");
        command.env(
            maestro_tui::credential_mode::ACCESS_TOKEN_ENV,
            "pty-e2e-identity-token",
        );
        command.env(maestro_tui::credential_mode::ORG_ID_ENV, "pty-e2e-org");
        command.env("MAESTRO_DISABLE_KEYCHAIN", "1");
        command.env(
            "MAESTRO_PROMPT_HISTORY_FILE",
            workdir.join("prompt-history.json"),
        );

        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn maestro-tui");
        drop(pair.slave);

        let output = Arc::new(Mutex::new(Vec::new()));
        let mut reader = pair.master.try_clone_reader().expect("clone PTY reader");
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().expect("take PTY writer") as Box<dyn Write + Send>,
        ));
        let reader_output = Arc::clone(&output);
        let reader_writer = Arc::clone(&writer);
        std::thread::Builder::new()
            .name("pty-e2e-reader".to_owned())
            .spawn(move || {
                // The TUI probes the "terminal" with a cursor-position
                // report (DSR, ESC[6n) at startup and on each inline-viewport
                // frame; a real terminal answers, so we must too, or init
                // fails with "cursor position could not be read". Init moves
                // the cursor to the last row before the first query, so the
                // truthful answer for this 36-row PTY is the bottom row.
                const DSR_QUERY: &[u8] = b"\x1b[6n";
                const DSR_REPLY: &[u8] = b"\x1b[36;1R";
                let mut tail: Vec<u8> = Vec::new();
                let mut buf = [0_u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            reader_output
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .extend_from_slice(&buf[..n]);
                            let mut window = std::mem::take(&mut tail);
                            window.extend_from_slice(&buf[..n]);
                            let query_count = window
                                .windows(DSR_QUERY.len())
                                .filter(|window| *window == DSR_QUERY)
                                .count();
                            if query_count > 0 {
                                let mut writer =
                                    reader_writer.lock().unwrap_or_else(|e| e.into_inner());
                                for _ in 0..query_count {
                                    let _ = writer.write_all(DSR_REPLY);
                                }
                                let _ = writer.flush();
                            }
                            tail = window
                                .get(window.len().saturating_sub(DSR_QUERY.len() - 1)..)
                                .unwrap_or_default()
                                .to_vec();
                        }
                    }
                }
            })
            .expect("spawn PTY reader thread");

        Self {
            child,
            _master: pair.master,
            writer,
            output,
        }
    }

    /// Everything the child wrote so far, ANSI escapes stripped.
    fn screen_text(&self) -> String {
        let output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        strip_ansi(&output)
    }

    /// Poll until `needle` appears in the stripped output; panic with a dump
    /// of the captured output on timeout (grok-build's screen dump on failure).
    fn wait_for_text(&mut self, needle: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let screen = self.screen_text();
            if screen.contains(needle) {
                return;
            }
            if Instant::now() >= deadline {
                let tail: String = screen
                    .chars()
                    .rev()
                    .take(12_000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let alive = self
                    .child
                    .try_wait()
                    .map(|status| status.is_none())
                    .unwrap_or(false);
                panic!(
                    "timed out after {timeout:?} waiting for {needle:?}\n\
                     child still running: {alive}\n\
                     --- captured output (tail) ---\n{tail}\n\
                     --- end captured output ---"
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn send_bytes(&mut self, bytes: &[u8]) {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(bytes).expect("write to PTY");
        writer.flush().expect("flush PTY");
    }

    /// Send `bytes` (1s apart) until `needle` appears on screen.
    ///
    /// The TUI reads cursor-position replies straight from stdin; a key that
    /// lands in that read window is consumed as probe noise and lost, exactly
    /// like a keystroke raced by a real terminal's reply. Re-pressing is what
    /// a user would do, so the harness does the same instead of flaking.
    fn send_bytes_until(&mut self, bytes: &[u8], needle: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            self.send_bytes(bytes);
            let resend_at = Instant::now() + Duration::from_secs(1);
            while Instant::now() < resend_at {
                if self.screen_text().contains(needle) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if Instant::now() >= deadline {
                // Reuse the dump-on-failure path.
                self.wait_for_text(needle, Duration::ZERO);
            }
        }
    }

    /// Type a prompt and submit it.
    fn submit_prompt(&mut self, prompt: &str) {
        self.send_bytes(prompt.as_bytes());
        self.send_bytes(b"\r");
    }

    fn ctrl_c(&mut self) {
        self.send_bytes(b"\x03");
    }

    /// Deliver a real Unix signal and wait for the process to terminate.
    fn signal_and_wait(
        &mut self,
        signal: libc::c_int,
        timeout: Duration,
    ) -> portable_pty::ExitStatus {
        let pid = self.child.process_id().expect("PTY child process id");
        // SAFETY: `pid` is the live child owned by this harness and `signal`
        // is supplied by the test as a standard Unix process signal.
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, signal) },
            0,
            "deliver signal {signal} to PTY child {pid}"
        );

        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    let screen = self.screen_text();
                    panic!(
                        "PTY child {pid} did not exit within {timeout:?} after signal {signal}\n\
                         --- captured output ---\n{screen}\n--- end captured output ---"
                    );
                }
                Err(error) => panic!("wait for PTY child {pid}: {error}"),
            }
        }
    }

    /// True if a descendant of the TUI process has `needle` in its command
    /// line. Used to prove a tool call is actually executing: the transcript
    /// line keeps its pre-approval `Pending · …` label while the tool runs,
    /// so the process table is the only reliable execution signal.
    fn has_running_tool(&self, needle: &str) -> bool {
        let Some(root) = self.child.process_id() else {
            return false;
        };
        let table = process_table();
        table
            .iter()
            .any(|(pid, _, args)| args.contains(needle) && is_descendant(&table, *pid, root))
    }

    /// Ask the TUI to quit (Ctrl+D), then fall back to killing the child.
    fn shutdown(mut self) {
        self.send_bytes(b"\x04");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
            }
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort cleanup so a failed scenario leaves no tool processes
        // (e.g. a `sleep 600` the interrupted bash call spawned) behind.
        if let Some(root) = self.child.process_id() {
            let table = process_table();
            for (pid, _, _) in table
                .iter()
                .filter(|(pid, _, _)| is_descendant(&table, *pid, root))
            {
                let _ = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .status();
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Snapshot of `ps` as `(pid, ppid, args)` rows.
fn process_table() -> Vec<(u32, u32, String)> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-eo", "pid=,ppid=,args"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            Some((pid, ppid, parts.collect::<Vec<_>>().join(" ")))
        })
        .collect()
}

fn is_descendant(table: &[(u32, u32, String)], mut pid: u32, root: u32) -> bool {
    while let Some(&(_, ppid, _)) = table.iter().find(|(p, _, _)| *p == pid) {
        if ppid == root {
            return true;
        }
        if ppid <= 1 {
            return false;
        }
        pid = ppid;
    }
    false
}

/// Create one source session in the exact directory `SessionManager::new`
/// derives from the isolated PTY HOME and current working directory.
fn write_fork_fixture(workdir: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let sanitized_cwd = workdir
        .to_string_lossy()
        .replace(['/', '\\', ':'], "-")
        .trim_matches('-')
        .to_owned();
    let sessions_dir = workdir
        .join(".composer")
        .join("agent")
        .join("sessions")
        .join(format!("--{sanitized_cwd}--"));
    std::fs::create_dir_all(&sessions_dir).expect("create fixture sessions directory");
    let path = sessions_dir.join(format!("2026-07-29T00-00-00-000Z_{session_id}.jsonl"));
    let header = serde_json::json!({
        "type": "session",
        "version": 2,
        "id": session_id,
        "timestamp": "2026-07-29T00:00:00Z",
        "cwd": workdir,
        "model": "gpt-4o",
        "thinkingLevel": "medium"
    });
    let message = serde_json::json!({
        "type": "message",
        "timestamp": "2026-07-29T00:00:01Z",
        "message": {
            "role": "user",
            "content": "PTY_FORK_SOURCE_READY",
            "timestamp": 1
        }
    });
    std::fs::write(&path, format!("{header}\n{message}\n")).expect("write fork fixture");
    path
}

/// Strip ANSI escape sequences (CSI, OSC, charset selection, and two-byte
/// escapes) and carriage returns from the raw PTY stream so substring
/// assertions see roughly what a user would read.
fn strip_ansi(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let pattern = regex::Regex::new(
        r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z%]|\x1b[@-Z\\-_]",
    )
    .expect("valid ANSI strip pattern");
    pattern.replace_all(&text, "").replace('\r', "")
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

/// PTY scenarios run one at a time: concurrent TUI spinners (each repainting
/// at ~30fps, every frame a cursor-position probe) starve the harness reader
/// thread, stretching the probe-reply window until keystrokes get eaten by
/// the app's position reads.
static PTY_TEST_SERIAL: Mutex<()> = Mutex::new(());

/// prompt → streamed answer renders on screen.
#[test]
fn pty_prompt_streams_answer() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![text_turn("PTY_E2E_ANSWER_OK")]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let mut session = PtySession::spawn(&mock, workdir.path(), "say the token");

    session.wait_for_text("PTY_E2E_ANSWER_OK", READY_TIMEOUT);
    assert_eq!(
        mock.request_count(),
        1,
        "a plain answer turn should hit the mock exactly once"
    );

    session.shutdown();
}

/// `/mcp` opens the native manager and returning to chat remains responsive.
/// The disabled fixture proves the manager lists configured servers without
/// dialing an external process during the scenario.
#[test]
fn pty_mcp_manager_opens_and_returns_to_chat() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![
        text_turn("PTY_MCP_READY"),
        text_turn("PTY_MCP_CHAT_STILL_RESPONSIVE"),
    ]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let config_dir = workdir.path().join(".composer");
    std::fs::create_dir_all(&config_dir).expect("create MCP config directory");
    std::fs::write(
        config_dir.join("mcp.json"),
        r#"{"mcpServers":{"demo":{"command":"demo-mcp","disabled":true}}}"#,
    )
    .expect("write MCP fixture");
    let mut session = PtySession::spawn(&mock, workdir.path(), "start MCP scenario");

    session.wait_for_text("PTY_MCP_READY", READY_TIMEOUT);
    session.submit_prompt("/mcp");
    session.wait_for_text("MCP servers", TURN_TIMEOUT);
    session.wait_for_text("demo", TURN_TIMEOUT);

    // Use the manager's explicit custom-add exit as a visible synchronization
    // point. A lone Escape can be consumed by the terminal DSR probe.
    session.send_bytes_until(b"a", "/mcp config add ", TURN_TIMEOUT);
    session.send_bytes(b"\x15");
    session.submit_prompt("confirm chat still works");
    session.wait_for_text("PTY_MCP_CHAT_STILL_RESPONSIVE", TURN_TIMEOUT);
    assert_eq!(
        mock.request_count(),
        2,
        "slash command must not call the model"
    );

    session.shutdown();
}

/// Regression for forked interactive sessions bypassing the registered
/// shutdown lifecycle: a real fork is resumed in the PTY, accepts a new
/// turn, and must handle SIGTERM through orderly teardown rather than the
/// operating system's default immediate termination.
#[test]
fn pty_fork_sigterm_exits_143_and_flushes_fork_session() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![text_turn("PTY_FORK_RESPONSE_OK")]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let source_id = "pty-fork-source";
    let source_path = write_fork_fixture(workdir.path(), source_id);
    let sessions_dir = source_path.parent().expect("fixture sessions directory");
    let mut session = PtySession::spawn_with_args(&mock, workdir.path(), &["fork", source_id]);

    // Seeing restored history proves App construction and the fork-specific
    // startup resume both completed before the signal is delivered.
    session.wait_for_text("PTY_FORK_SOURCE_READY", READY_TIMEOUT);
    session.submit_prompt("PTY_FORK_SIGTERM_FLUSH");
    let request_deadline = Instant::now() + TURN_TIMEOUT;
    while mock.request_count() < 1 {
        assert!(
            Instant::now() < request_deadline,
            "forked session never submitted the post-resume prompt"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let status = session.signal_and_wait(libc::SIGTERM, TURN_TIMEOUT);
    assert_eq!(
        status.exit_code(),
        143,
        "registered SIGTERM path must return the conventional 128 + SIGTERM exit code"
    );
    session.wait_for_text("[shutdown] received SIGTERM", Duration::from_secs(2));

    let fork_paths: Vec<_> = std::fs::read_dir(sessions_dir)
        .expect("list sessions after fork shutdown")
        .map(|entry| entry.expect("session directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter(|path| path != &source_path)
        .collect();
    assert_eq!(
        fork_paths.len(),
        1,
        "fork command should create exactly one independent session"
    );
    let fork_contents =
        std::fs::read_to_string(&fork_paths[0]).expect("read fork after orderly shutdown");
    let fork_header: serde_json::Value =
        serde_json::from_str(fork_contents.lines().next().expect("fork session header"))
            .expect("parse fork session header");
    assert_eq!(
        fork_header["parentSession"], source_id,
        "fork must retain its durable source-session lineage"
    );
    assert!(
        fork_contents.contains("PTY_FORK_SIGTERM_FLUSH"),
        "post-resume turn was not durable after SIGTERM:\n{fork_contents}"
    );
    assert!(
        !std::fs::read_to_string(&source_path)
            .expect("read source after fork shutdown")
            .contains("PTY_FORK_SIGTERM_FLUSH"),
        "fork shutdown must never append to the source session"
    );
}

/// tool call → approval modal appears (selective mode) → approve → result
/// renders after the follow-up turn.
#[test]
fn pty_tool_call_approval_flow() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![
        tool_call_turn(
            "bash",
            &serde_json::json!({"command": "printf pty-e2e-ran"}),
        ),
        text_turn("PTY_E2E_TOOL_DONE_OK"),
    ]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let mut session = PtySession::spawn(&mock, workdir.path(), "run the printf command");

    // Default approval mode is Selective: `printf` is not on the read-only
    // safe list, so the modal must appear before anything executes.
    session.wait_for_text("Action Approval Required", READY_TIMEOUT);
    session.wait_for_text("printf pty-e2e-ran", TURN_TIMEOUT);

    session.send_bytes_until(b"y", "PTY_E2E_TOOL_DONE_OK", TURN_TIMEOUT);
    assert_eq!(
        mock.request_count(),
        2,
        "tool call turn + follow-up turn after tool result"
    );

    session.shutdown();
}

/// Regression pin for #3071: Ctrl+C cancels a long-running tool call and the
/// UI stays responsive enough to run another turn immediately.
#[test]
fn pty_ctrl_c_interrupts_long_tool_and_stays_responsive() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![
        tool_call_turn("bash", &serde_json::json!({"command": "sleep 600"})),
        text_turn("PTY_E2E_RECOVERED_OK"),
    ]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let mut session = PtySession::spawn(&mock, workdir.path(), "run the sleep command");

    session.wait_for_text("Action Approval Required", READY_TIMEOUT);

    // Approve, retrying until the tool process is actually running (a key can
    // race the terminal probe reads and get eaten; the retried keys land in
    // the input box and are cleared below before typing).
    let approve_deadline = Instant::now() + TURN_TIMEOUT;
    loop {
        session.send_bytes(b"y");
        let probe_until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < probe_until {
            if session.has_running_tool("sleep 6") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if session.has_running_tool("sleep 6") {
            break;
        }
        assert!(
            Instant::now() < approve_deadline,
            "approval never started the sleep tool"
        );
    }

    // Without the #3071 fix the interrupt only took effect after the tool
    // timed out. Ctrl+C can race terminal probe reads just like any key, so
    // retry it only while the sleep process proves the app is still busy.
    // Retrying Ctrl+C after the process exits is incorrect: once the app is
    // idle, Ctrl+C intentionally quits the TUI and closes the PTY.
    let deadline = Instant::now() + TURN_TIMEOUT;
    while session.has_running_tool("sleep 6") {
        session.ctrl_c();
        let probe_until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < probe_until && session.has_running_tool("sleep 6") {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            Instant::now() < deadline,
            "Ctrl+C did not stop the sleep tool within {TURN_TIMEOUT:?}"
        );
    }

    // The follow-up turn must complete within the same bound, far below the
    // 600s sleep. Retry only the prompt if a terminal probe consumes input.
    loop {
        // Clear any stray input-box keys before typing the follow-up.
        session.send_bytes(b"\x15");
        session.submit_prompt("are you still there");
        let probe_until = Instant::now() + Duration::from_secs(6);
        while Instant::now() < probe_until {
            if session.screen_text().contains("PTY_E2E_RECOVERED_OK") {
                session.shutdown();
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if Instant::now() >= deadline {
            // Reuse the dump-on-failure path.
            session.wait_for_text("PTY_E2E_RECOVERED_OK", Duration::ZERO);
        }
    }
}

/// The shortcut must change the next provider request, not only footer text.
#[test]
fn pty_shift_tab_changes_request_effort() {
    let _serial = PTY_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mock = MockOpenAiServer::start(vec![
        text_turn("THINKING_READY"),
        text_turn("THINKING_MEDIUM_DONE"),
        text_turn("THINKING_HIGH_DONE"),
    ]);
    let workdir = tempfile::tempdir().expect("temp workdir");
    let mut session = PtySession::spawn_with_args(
        &mock,
        workdir.path(),
        &["--model", "o1", "--api-key", "pty-e2e-key", "say ready"],
    );
    session.wait_for_text("THINKING_READY", READY_TIMEOUT);
    session.submit_prompt("/thinking low");
    session.wait_for_text("(low)", TURN_TIMEOUT);
    session.send_bytes(b"\x1b[Z");
    session.submit_prompt("say medium done");
    session.wait_for_text("THINKING_MEDIUM_DONE", TURN_TIMEOUT);
    session.send_bytes(b"\x1b[Z");
    session.submit_prompt("say high done");
    session.wait_for_text("THINKING_HIGH_DONE", TURN_TIMEOUT);
    let requests = mock.state.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(requests.requests.len(), 3);
    for (body, effort) in requests.requests[1..].iter().zip(["medium", "high"]) {
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["reasoning_effort"], effort);
    }
    drop(requests);
    session.shutdown();
}

#[test]
fn specialist_exec_applies_focus_model_and_tool_ceiling_to_the_request() {
    let mock = MockOpenAiServer::start(vec![text_turn("SPECIALIST_DONE")]);
    let workdir = tempfile::tempdir().unwrap();
    let profiles = workdir.path().join("maestro-home/agent-profiles");
    std::fs::create_dir_all(&profiles).unwrap();
    std::fs::write(
        profiles.join("billing.md"),
        "---\nname: billing\nmodel: gpt-4o\ntools: [read]\n---\nBILLING_FOCUS_CONTRACT",
    )
    .unwrap();
    let mut session = PtySession::spawn_with_args(
        &mock,
        workdir.path(),
        &[
            "exec",
            "--specialist",
            "billing",
            "Inspect the invoice journey",
        ],
    );
    session.wait_for_text("SPECIALIST_DONE", TURN_TIMEOUT);
    let state = mock.state.lock().unwrap_or_else(|error| error.into_inner());
    let request: serde_json::Value = serde_json::from_str(&state.requests[0]).unwrap();
    assert_eq!(request["model"], "gpt-4o");
    let messages = request["messages"].as_array().unwrap();
    assert!(messages.iter().any(|m| {
        m["role"] == "system"
            && m["content"]
                .as_str()
                .is_some_and(|text| text.contains("BILLING_FOCUS_CONTRACT"))
    }));
    assert!(messages.iter().any(|m| {
        m["role"] == "user"
            && m["content"]
                .to_string()
                .contains("Inspect the invoice journey")
    }));
    let tools = request["tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    assert!(tools.iter().all(|tool| tool["function"]["name"] == "read"));
}
