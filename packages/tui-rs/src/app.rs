//! Native Composer TUI Application
//!
//! This is the main entry point for the native Rust TUI.
//! It spawns a Node.js agent subprocess for AI interactions
//! and handles all terminal rendering natively.

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers as CrosstermModifiers};
use ratatui::prelude::*;

use crate::agent::AgentProcess;
use crate::components::ChatView;
use crate::state::AppState;
use crate::terminal::{self, TerminalCapabilities};

/// Main application
pub struct App {
    state: AppState,
    agent: Option<AgentProcess>,
    terminal: terminal::Terminal,
    should_quit: bool,
    /// Arguments to pass to the Node.js agent
    agent_args: Vec<String>,
    /// Terminal capabilities including viewport position
    capabilities: TerminalCapabilities,
}

impl App {
    /// Create a new application
    pub fn new() -> Result<Self> {
        Self::with_args(Vec::new())
    }

    /// Create a new application with CLI arguments to pass to the agent
    pub fn with_args(agent_args: Vec<String>) -> Result<Self> {
        let (terminal, capabilities) = terminal::init().context("Failed to initialize terminal")?;

        Ok(Self {
            state: AppState::new(),
            agent: None,
            terminal,
            should_quit: false,
            agent_args,
            capabilities,
        })
    }

    /// Get the current viewport top position (for history push)
    pub fn viewport_top(&self) -> u16 {
        self.capabilities.viewport_top
    }

    /// Run the main event loop
    pub async fn run(mut self) -> Result<i32> {
        // Spawn the agent
        self.spawn_agent().await?;

        // Main loop
        loop {
            // Render
            self.render()?;

            // Handle events with a timeout so we can check for agent messages
            if event::poll(std::time::Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press {
                        self.handle_key(key.code, key.modifiers).await?;
                    }
                }
            }

            // Check for agent messages
            self.poll_agent().await?;

            if self.should_quit {
                break;
            }
        }

        // Cleanup
        if let Some(mut agent) = self.agent.take() {
            let _ = agent.shutdown().await;
        }
        terminal::restore()?;

        Ok(0)
    }

    /// Spawn the Node.js agent subprocess
    async fn spawn_agent(&mut self) -> Result<()> {
        // Find the composer script to run
        let node_path = std::env::var("NODE_PATH").unwrap_or_else(|_| "node".to_string());

        // Try to find the composer entry point
        let script_path = std::env::var("COMPOSER_AGENT_SCRIPT")
            .unwrap_or_else(|_| {
                // Default: look for local development path
                let cwd = std::env::current_dir().unwrap_or_default();
                cwd.join("dist/cli.js")
                    .to_string_lossy()
                    .to_string()
            });

        // Check if script exists
        if !std::path::Path::new(&script_path).exists() {
            // For now, just set status and continue without agent
            self.state.error = Some(format!("Agent script not found: {}", script_path));
            return Ok(());
        }

        self.state.status = Some(format!("Spawning: {} {}", node_path, script_path));

        // Pass CLI arguments to the agent
        match AgentProcess::spawn(&node_path, &script_path, &self.agent_args).await {
            Ok(agent) => {
                self.agent = Some(agent);
                self.state.status = Some("Agent spawned, waiting for ready...".to_string());
            }
            Err(e) => {
                self.state.error = Some(format!("Failed to spawn agent: {}", e));
            }
        }

        Ok(())
    }

    /// Poll for messages from the agent
    async fn poll_agent(&mut self) -> Result<()> {
        if let Some(agent) = &mut self.agent {
            // Non-blocking receive
            while let Ok(msg) = agent.rx.try_recv() {
                // Update status to show we received a message
                match &msg {
                    crate::agent::FromAgent::Ready { model, provider } => {
                        self.state.status = Some(format!("Connected: {} via {}", model, provider));
                    }
                    crate::agent::FromAgent::SessionInfo { cwd, .. } => {
                        self.state.status = Some(format!("Session in: {}", cwd));
                    }
                    _ => {}
                }
                self.state.handle_agent_message(msg);
            }
        }
        Ok(())
    }

    /// Handle a key press
    async fn handle_key(&mut self, code: KeyCode, modifiers: CrosstermModifiers) -> Result<()> {
        let ctrl = modifiers.contains(CrosstermModifiers::CONTROL);
        let _alt = modifiers.contains(CrosstermModifiers::ALT);

        match code {
            // Quit
            KeyCode::Char('c') if ctrl => {
                if self.state.busy {
                    // Interrupt the agent
                    if let Some(agent) = &mut self.agent {
                        let _ = agent.interrupt().await;
                    }
                    self.state.busy = false;
                } else {
                    self.should_quit = true;
                }
            }
            KeyCode::Char('d') if ctrl => {
                self.should_quit = true;
            }

            // Navigation
            KeyCode::Up => {
                self.state.scroll_up(1);
            }
            KeyCode::Down => {
                self.state.scroll_down(1);
            }
            KeyCode::PageUp => {
                self.state.scroll_up(10);
            }
            KeyCode::PageDown => {
                self.state.scroll_down(10);
            }

            // Input editing
            KeyCode::Char(c) if !ctrl => {
                if !self.state.busy {
                    self.state.insert_char(c);
                }
            }
            KeyCode::Backspace => {
                if !self.state.busy {
                    self.state.backspace();
                }
            }
            KeyCode::Delete => {
                if !self.state.busy {
                    self.state.delete();
                }
            }
            KeyCode::Left => {
                self.state.move_left();
            }
            KeyCode::Right => {
                self.state.move_right();
            }
            KeyCode::Home => {
                self.state.move_home();
            }
            KeyCode::End => {
                self.state.move_end();
            }

            // Submit
            KeyCode::Enter => {
                if !self.state.busy && !self.state.input.is_empty() {
                    let input = self.state.take_input();
                    self.submit_prompt(input).await?;
                }
            }

            // Clear input
            KeyCode::Char('u') if ctrl => {
                if !self.state.busy {
                    self.state.input.clear();
                    self.state.cursor = 0;
                }
            }

            // Clear screen
            KeyCode::Char('l') if ctrl => {
                // Clear messages
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }

            _ => {}
        }

        Ok(())
    }

    /// Submit a prompt to the agent
    async fn submit_prompt(&mut self, content: String) -> Result<()> {
        // Add user message to state
        self.state.add_user_message(content.clone());

        // Send to agent
        if let Some(agent) = &mut self.agent {
            agent.prompt(content, vec![]).await?;
        } else {
            // No agent connected - show error
            self.state.error = Some("Agent not connected".to_string());
            self.state.busy = false;
        }

        Ok(())
    }

    /// Render the UI
    fn render(&mut self) -> Result<()> {
        self.terminal.draw(|frame| {
            let area = frame.area();
            let view = ChatView::new(&self.state);
            frame.render_widget(view, area);

            // Show error if any
            if let Some(error) = &self.state.error {
                let error_area = Rect {
                    x: area.x + 1,
                    y: area.height.saturating_sub(5),
                    width: area.width.saturating_sub(2),
                    height: 2,
                };
                let error_widget = ratatui::widgets::Paragraph::new(error.as_str())
                    .style(Style::default().fg(Color::Red));
                frame.render_widget(error_widget, error_area);
            }

            // Position cursor in input area
            if !self.state.busy {
                // Input is at bottom - 3 lines for input box, 1 for status
                // Cursor inside input box (with 1 char padding for border)
                let cursor_x = area.x + 1 + (self.state.cursor as u16).min(area.width.saturating_sub(3));
                let cursor_y = area.height.saturating_sub(3);
                frame.set_cursor_position((cursor_x, cursor_y));
            }
        })?;

        Ok(())
    }
}

impl Default for App {
    fn default() -> Self {
        Self::with_args(Vec::new()).expect("Failed to create App")
    }
}
