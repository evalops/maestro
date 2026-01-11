//! Welcome/Onboarding Screen Component
//!
//! Displays a welcome screen with ASCII art animation and getting started info.
//! Used for first-time setup and new session starts.
//!
//! # Features
//!
//! - Animated ASCII art
//! - Getting started tips
//! - Version and status display
//! - Keyboard hints
//!
//! # Example
//!
//! ```rust,ignore
//! use composer_tui::components::WelcomeScreen;
//!
//! let welcome = WelcomeScreen::new()
//!     .with_version("0.1.0")
//!     .with_model("claude-sonnet-4-20250514");
//!
//! // Render in your UI
//! welcome.render(frame, area);
//! ```

use ratatui::{
    prelude::*,
    widgets::{Clear, Paragraph, Widget, Wrap},
};

use super::ascii_animation::{logos, AsciiAnimation};

/// Minimum dimensions for showing animation
const MIN_ANIMATION_HEIGHT: u16 = 15;
const MIN_ANIMATION_WIDTH: u16 = 50;

/// Welcome screen widget
#[derive(Debug, Clone)]
pub struct WelcomeScreen {
    /// ASCII animation
    animation: Option<AsciiAnimation>,
    /// Whether animations are enabled
    animations_enabled: bool,
    /// Application version
    version: Option<String>,
    /// Current model name
    model: Option<String>,
    /// Whether user is authenticated
    is_authenticated: bool,
    /// Custom welcome message
    welcome_message: Option<String>,
    /// Show keyboard hints
    show_hints: bool,
}

impl Default for WelcomeScreen {
    fn default() -> Self {
        Self::new()
    }
}

impl WelcomeScreen {
    /// Create a new welcome screen
    #[must_use]
    pub fn new() -> Self {
        Self {
            animation: Some(AsciiAnimation::new()),
            animations_enabled: true,
            version: None,
            model: None,
            is_authenticated: false,
            welcome_message: None,
            show_hints: true,
        }
    }

    /// Set the version string
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    /// Set the current model
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Set authentication status
    #[must_use]
    pub fn authenticated(mut self, is_authenticated: bool) -> Self {
        self.is_authenticated = is_authenticated;
        self
    }

    /// Set custom welcome message
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.welcome_message = Some(message.into());
        self
    }

    /// Enable/disable animations
    #[must_use]
    pub fn animations(mut self, enabled: bool) -> Self {
        self.animations_enabled = enabled;
        self
    }

    /// Enable/disable keyboard hints
    #[must_use]
    pub fn show_hints(mut self, show: bool) -> Self {
        self.show_hints = show;
        self
    }

    /// Handle keyboard event (for animation variant switching)
    pub fn handle_key(&mut self, key: char) {
        if key == '.' && self.animations_enabled {
            if let Some(ref mut anim) = self.animation {
                anim.pick_random_variant();
            }
        }
    }

    /// Build the content lines
    fn build_content(&self, area: Rect) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = Vec::new();

        // Show animation if space permits
        let show_animation = self.animations_enabled
            && area.height >= MIN_ANIMATION_HEIGHT
            && area.width >= MIN_ANIMATION_WIDTH;

        if show_animation {
            if let Some(ref anim) = self.animation {
                let frame = anim.current_frame();
                for line in frame.lines() {
                    lines.push(Line::from(line.to_string()));
                }
                lines.push(Line::from(""));
            }
        } else {
            // Show small logo instead
            for line in logos::COMPOSER_SMALL.lines() {
                lines.push(Line::from(Span::styled(
                    line.to_string(),
                    Style::default().fg(Color::Cyan),
                )));
            }
            lines.push(Line::from(""));
        }

        // Welcome message
        let welcome_text = self
            .welcome_message
            .clone()
            .unwrap_or_else(|| "Welcome to".to_string());
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::raw(welcome_text),
            Span::raw(" "),
            Span::styled(
                "Composer",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));

        // Version
        if let Some(ref version) = self.version {
            lines.push(Line::from(vec![
                Span::raw("  Version "),
                Span::styled(version.clone(), Style::default().fg(Color::Green)),
            ]));
        }

        lines.push(Line::from(""));

        // Model info
        if let Some(ref model) = self.model {
            lines.push(Line::from(vec![
                Span::raw("  Model: "),
                Span::styled(model.clone(), Style::default().fg(Color::Yellow)),
            ]));
        }

        // Auth status
        let auth_text = if self.is_authenticated {
            Span::styled("✓ Authenticated", Style::default().fg(Color::Green))
        } else {
            Span::styled("○ Not authenticated", Style::default().fg(Color::DarkGray))
        };
        lines.push(Line::from(vec![Span::raw("  "), auth_text]));

        lines.push(Line::from(""));

        // Getting started section
        lines.push(Line::from(Span::styled(
            "  Getting Started",
            Style::default()
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::UNDERLINED),
        )));
        lines.push(Line::from(""));

        let tips = [
            ("Type a message", "to start chatting"),
            ("Use /help", "to see available commands"),
            ("Press ?", "for keyboard shortcuts"),
            ("Press Ctrl+P", "to open command palette"),
        ];

        for (key, desc) in tips {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(key, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(desc, Style::default().fg(Color::DarkGray)),
            ]));
        }

        // Keyboard hints
        if self.show_hints {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  Press Ctrl+. to change animation",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::DIM),
            )));
        }

        lines
    }
}

impl Widget for WelcomeScreen {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Clear area
        Clear.render(area, buf);

        // Build content
        let content = self.build_content(area);

        // Center vertically
        let content_height = content.len() as u16;
        let y_offset = if area.height > content_height {
            (area.height - content_height) / 2
        } else {
            0
        };

        let content_area = Rect::new(
            area.x,
            area.y + y_offset,
            area.width,
            content_height.min(area.height),
        );

        Paragraph::new(content)
            .wrap(Wrap { trim: false })
            .render(content_area, buf);
    }
}

/// Onboarding step state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardingStep {
    /// Welcome screen
    Welcome,
    /// Authentication
    Auth,
    /// Directory trust
    TrustDirectory,
    /// Configuration
    Configure,
    /// Complete
    Complete,
}

impl OnboardingStep {
    /// Get the next step
    #[must_use]
    pub fn next(self) -> Self {
        match self {
            Self::Welcome => Self::Auth,
            Self::Auth => Self::TrustDirectory,
            Self::TrustDirectory => Self::Configure,
            Self::Configure => Self::Complete,
            Self::Complete => Self::Complete,
        }
    }

    /// Get the previous step
    #[must_use]
    pub fn prev(self) -> Self {
        match self {
            Self::Welcome => Self::Welcome,
            Self::Auth => Self::Welcome,
            Self::TrustDirectory => Self::Auth,
            Self::Configure => Self::TrustDirectory,
            Self::Complete => Self::Configure,
        }
    }

    /// Get step index (0-based)
    #[must_use]
    pub fn index(self) -> usize {
        match self {
            Self::Welcome => 0,
            Self::Auth => 1,
            Self::TrustDirectory => 2,
            Self::Configure => 3,
            Self::Complete => 4,
        }
    }

    /// Get total number of steps
    #[must_use]
    pub fn total() -> usize {
        5
    }

    /// Get step label
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Welcome => "Welcome",
            Self::Auth => "Authentication",
            Self::TrustDirectory => "Trust Directory",
            Self::Configure => "Configuration",
            Self::Complete => "Complete",
        }
    }
}

/// Onboarding flow manager
#[derive(Debug)]
pub struct OnboardingFlow {
    /// Current step
    pub current_step: OnboardingStep,
    /// Whether auth is complete
    pub auth_complete: bool,
    /// Whether directory is trusted
    pub directory_trusted: bool,
    /// Welcome screen instance
    pub welcome: WelcomeScreen,
}

impl Default for OnboardingFlow {
    fn default() -> Self {
        Self::new()
    }
}

impl OnboardingFlow {
    /// Create a new onboarding flow
    #[must_use]
    pub fn new() -> Self {
        Self {
            current_step: OnboardingStep::Welcome,
            auth_complete: false,
            directory_trusted: false,
            welcome: WelcomeScreen::new(),
        }
    }

    /// Advance to next step
    pub fn next(&mut self) {
        self.current_step = self.current_step.next();
    }

    /// Go to previous step
    pub fn prev(&mut self) {
        self.current_step = self.current_step.prev();
    }

    /// Skip to end
    pub fn skip(&mut self) {
        self.current_step = OnboardingStep::Complete;
    }

    /// Check if complete
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.current_step == OnboardingStep::Complete
    }

    /// Get progress percentage
    #[must_use]
    pub fn progress(&self) -> f64 {
        (self.current_step.index() as f64 / (OnboardingStep::total() - 1) as f64) * 100.0
    }
}

/// Simple splash screen for quick display
#[derive(Debug, Clone)]
pub struct SplashScreen {
    /// Title text
    pub title: String,
    /// Subtitle text
    pub subtitle: Option<String>,
    /// Show logo
    pub show_logo: bool,
}

impl Default for SplashScreen {
    fn default() -> Self {
        Self {
            title: "Composer".to_string(),
            subtitle: None,
            show_logo: true,
        }
    }
}

impl SplashScreen {
    /// Create a new splash screen
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..Default::default()
        }
    }

    /// Set subtitle
    pub fn with_subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// Show/hide logo
    #[must_use]
    pub fn show_logo(mut self, show: bool) -> Self {
        self.show_logo = show;
        self
    }
}

impl Widget for SplashScreen {
    fn render(self, area: Rect, buf: &mut Buffer) {
        Clear.render(area, buf);

        let mut lines: Vec<Line<'static>> = Vec::new();

        if self.show_logo {
            for line in logos::COMPOSER_SMALL.lines() {
                lines.push(Line::from(Span::styled(
                    line.to_string(),
                    Style::default().fg(Color::Cyan),
                )));
            }
            lines.push(Line::from(""));
        }

        lines.push(Line::from(Span::styled(
            self.title.clone(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )));

        if let Some(subtitle) = self.subtitle {
            lines.push(Line::from(Span::styled(
                subtitle,
                Style::default().fg(Color::DarkGray),
            )));
        }

        // Center
        let content_height = lines.len() as u16;
        let y_offset = if area.height > content_height {
            (area.height - content_height) / 2
        } else {
            0
        };

        let content_area = Rect::new(
            area.x,
            area.y + y_offset,
            area.width,
            content_height.min(area.height),
        );

        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .render(content_area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_welcome_screen_default() {
        let welcome = WelcomeScreen::new();
        assert!(welcome.animations_enabled);
        assert!(welcome.show_hints);
        assert!(!welcome.is_authenticated);
    }

    #[test]
    fn test_welcome_screen_builder() {
        let welcome = WelcomeScreen::new()
            .with_version("1.0.0")
            .with_model("claude-sonnet")
            .authenticated(true)
            .with_message("Hello!")
            .animations(false);

        assert_eq!(welcome.version.as_deref(), Some("1.0.0"));
        assert_eq!(welcome.model.as_deref(), Some("claude-sonnet"));
        assert!(welcome.is_authenticated);
        assert_eq!(welcome.welcome_message.as_deref(), Some("Hello!"));
        assert!(!welcome.animations_enabled);
    }

    #[test]
    fn test_onboarding_step_navigation() {
        assert_eq!(OnboardingStep::Welcome.next(), OnboardingStep::Auth);
        assert_eq!(OnboardingStep::Auth.prev(), OnboardingStep::Welcome);
        assert_eq!(OnboardingStep::Complete.next(), OnboardingStep::Complete);
        assert_eq!(OnboardingStep::Welcome.prev(), OnboardingStep::Welcome);
    }

    #[test]
    fn test_onboarding_step_index() {
        assert_eq!(OnboardingStep::Welcome.index(), 0);
        assert_eq!(OnboardingStep::Complete.index(), 4);
    }

    #[test]
    fn test_onboarding_flow() {
        let mut flow = OnboardingFlow::new();
        assert_eq!(flow.current_step, OnboardingStep::Welcome);
        assert!(!flow.is_complete());

        flow.next();
        assert_eq!(flow.current_step, OnboardingStep::Auth);

        flow.skip();
        assert!(flow.is_complete());
    }

    #[test]
    fn test_onboarding_progress() {
        let mut flow = OnboardingFlow::new();
        assert_eq!(flow.progress(), 0.0);

        flow.current_step = OnboardingStep::Complete;
        assert_eq!(flow.progress(), 100.0);
    }

    #[test]
    fn test_splash_screen() {
        let splash = SplashScreen::new("Test")
            .with_subtitle("Loading...")
            .show_logo(false);

        assert_eq!(splash.title, "Test");
        assert_eq!(splash.subtitle.as_deref(), Some("Loading..."));
        assert!(!splash.show_logo);
    }
}
