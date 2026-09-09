//! Navigation over existing settings and runtime owners; opening a view has no effects.
use super::*;
use crate::commands::ControlPanel;
use crate::palette_resource::{PaletteResource, PaletteResourceKind};
use crate::state::OutputDetail;

impl App {
    pub(super) fn apply_language(&mut self, locale: crate::localization::Locale) {
        let mut prefs = crate::ui_prefs::UiPrefs::load_default();
        prefs.display_language = Some(locale.code().into());
        if let Err(error) = prefs.save_default() {
            self.state.error = Some(format!(
                "{}: {error}",
                self.state
                    .locale
                    .text(crate::localization::TextKey::SaveFailed)
            ));
            return;
        }
        self.state.locale = locale;
        self.mcp_manager.locale = locale;
        self.ui_prefs = prefs;
        self.state.error = None;
        self.show_control_panel(ControlPanel::Language);
    }

    pub(super) fn apply_output_detail(&mut self, detail: OutputDetail) {
        let mut prefs = crate::ui_prefs::UiPrefs::load_default();
        prefs.set_output_detail(detail);
        if let Err(error) = prefs.save_default() {
            self.state.error = Some(format!("Could not save output detail: {error}"));
            return;
        }
        self.state.set_output_detail(detail);
        self.ui_prefs = prefs;
        self.state.error = None;
        self.state.status = Some(format!("Output detail: {} (saved)", detail.as_str()));
    }

    pub(super) fn show_control_panel(&mut self, panel: ControlPanel) {
        let mut rows = Vec::new();
        let mut add = |command: &str, label: &str, description: String| {
            rows.push(
                PaletteResource::new(PaletteResourceKind::Command, command, label)
                    .description(description),
            );
        };
        let locale = self.state.locale;
        use crate::localization::TextKey;
        let title = match panel {
            ControlPanel::Language => {
                for choice in crate::localization::Locale::ALL {
                    add(
                        &format!("language {}", choice.code()),
                        choice.name(),
                        format!(
                            "{}{}",
                            choice.code(),
                            if choice == locale { " ✓" } else { "" }
                        ),
                    );
                }
                locale.text(TextKey::Language).to_string()
            }

            ControlPanel::Settings => {
                add(
                    "settings account",
                    "Account and inference",
                    "Sign-in, workspace, model, usage".into(),
                );
                add(
                    "settings permissions",
                    "Permissions",
                    self.state.approval_mode.label().into(),
                );
                add(
                    "settings capabilities",
                    "Connections and capabilities",
                    "Tools, skills, plugins, hooks".into(),
                );
                add(
                    "settings appearance",
                    locale.text(TextKey::Appearance),
                    format!("Output: {}", self.state.output_detail().as_str()),
                );
                add(
                    "settings advanced",
                    "Advanced",
                    "Diagnostics and runtime limits".into(),
                );
                locale.text(TextKey::Settings).into()
            }
            ControlPanel::Account => {
                add(
                    "setup",
                    "Sign-in and inference",
                    "Manage account and provider setup".into(),
                );
                add("model", "Model and effort", self.current_model.clone());
                add("cost", "Usage", "Recorded tokens and cost".into());
                add(
                    "status",
                    "Connection status",
                    "Effective session configuration".into(),
                );
                "Account and inference".into()
            }
            ControlPanel::Permissions => {
                add(
                    "approvals safe",
                    "Apply: ask for every tool",
                    "Session approval policy".into(),
                );
                add(
                    "approvals selective",
                    "Apply: ask for risky tools",
                    "Session approval policy".into(),
                );
                add(
                    "approvals yolo",
                    "Apply: auto-approve tools",
                    "Tools run without approval prompts".into(),
                );
                add(
                    "sandbox",
                    "Sandbox policy",
                    "Inspect effective execution restrictions".into(),
                );
                add(
                    "trust status",
                    "Workspace trust",
                    "Inspect the workspace and admitted extensions".into(),
                );
                add(
                    "trust grant",
                    "Grant workspace trust",
                    "Allow this workspace's skills, plugins, and hooks".into(),
                );
                add(
                    "trust revoke",
                    "Revoke workspace trust",
                    "Stop admitting workspace extensions".into(),
                );
                format!("Permissions · {}", self.state.approval_mode.label())
            }
            ControlPanel::Appearance => {
                add(
                    "language",
                    locale.text(TextKey::Language),
                    locale.name().into(),
                );
                add(
                    "settings output",
                    "Output detail",
                    format!("{} · saved preference", self.state.output_detail().as_str()),
                );
                add("theme", "Theme", "Preview and select a color theme".into());
                add(
                    "zen",
                    "Toggle minimal layout",
                    format!(
                        "{} · this session",
                        if self.state.zen_mode { "On" } else { "Off" }
                    ),
                );
                add(
                    "settings footer",
                    "Status bar",
                    format!("{} · saved preference", self.footer_style.as_str()),
                );
                add(
                    "dex appearance",
                    "Dex appearance",
                    "Avatar, accent, and reactions".into(),
                );
                add(
                    "hotkeys",
                    "Keyboard shortcuts",
                    "Effective bindings and customization".into(),
                );
                "Appearance and keyboard".into()
            }
            ControlPanel::Output => {
                for detail in [
                    OutputDetail::Summary,
                    OutputDetail::Compact,
                    OutputDetail::Expanded,
                ] {
                    let command = format!("output {}", detail.as_str());
                    let label = format!("Apply: {}", detail.as_str());
                    add(
                        &command,
                        &label,
                        match detail {
                            OutputDetail::Summary => "Summarize tool turns; expand individually",
                            OutputDetail::Compact => "Fold individual tool output",
                            OutputDetail::Expanded => "Show tool output; leave summary mode",
                        }
                        .into(),
                    );
                }
                format!(
                    "Output · {} · saved preference",
                    self.state.output_detail().as_str()
                )
            }
            ControlPanel::Footer => {
                for style in [
                    FooterStyle::Rich,
                    FooterStyle::Solo,
                    FooterStyle::History,
                    FooterStyle::Clear,
                ] {
                    let style = style.as_str();
                    add(
                        &format!("footer {style}"),
                        &format!("Apply: {style}"),
                        "Saved status-bar preference".into(),
                    );
                }
                format!("Status bar · {}", self.footer_style.as_str())
            }
            ControlPanel::Capabilities => {
                add(
                    "mcp",
                    "Connections",
                    "Connected systems, authentication, and tools".into(),
                );
                add(
                    "tools",
                    "Effective tools",
                    "Built-in and connected capabilities".into(),
                );
                add(
                    "skills",
                    "Skills",
                    "Inspect and manage specialized instructions".into(),
                );
                add(
                    "plugins",
                    "Plugins",
                    "Inspect installed extensions and catalog".into(),
                );
                add("hooks", "Hooks", "Advanced extension configuration".into());
                add(
                    "a2a peers",
                    "Agent connections",
                    "Inspect paired peers".into(),
                );
                "Connections and capabilities".into()
            }
            ControlPanel::Advanced => {
                add(
                    "diag",
                    "Diagnostics",
                    "Session health and configuration".into(),
                );
                add("alerts", "Errors", "Recorded agent and API errors".into());
                add(
                    "limits",
                    "Runtime limits",
                    "Effective values; environment changes require restart".into(),
                );
                add(
                    "context audit",
                    "Prompt provenance",
                    "Inspect context sources and effective tools".into(),
                );
                add(
                    "about",
                    "Build information",
                    "Version and environment".into(),
                );
                "Advanced".into()
            }
            ControlPanel::Tasks => {
                add(
                    "operations",
                    "Activity",
                    "Persisted tool executions and approvals".into(),
                );
                add(
                    "workers",
                    "Workers",
                    "Inspect, redirect, cancel, or resume existing work".into(),
                );
                add(
                    "queue",
                    "Queued prompts",
                    format!("{} pending", self.queued_prompts.len()),
                );
                add(
                    "decision",
                    "Pending decisions",
                    "Answer or cancel background decisions".into(),
                );
                add(
                    "goal",
                    "Objective and budget",
                    "Inspect explicit goals and continuation bounds".into(),
                );
                add(
                    "workflow",
                    "Workflows",
                    "Durable runs and their controls".into(),
                );
                add(
                    "loop",
                    "Schedules",
                    "Inspect recurring prompts; creation stays explicit".into(),
                );
                add(
                    "monitor",
                    "Background output",
                    "Inspect existing task monitors".into(),
                );
                add(
                    "computer",
                    "Computer tasks",
                    "Inspect hosted work and availability".into(),
                );
                add(
                    "a2a tasks",
                    "Delegated tasks",
                    "Inspect work accepted by connected peers".into(),
                );
                add(
                    "mailbox",
                    "Task messages",
                    "Inspect pending inter-agent messages".into(),
                );
                add(
                    "settings session",
                    "Session actions",
                    "Fork, recover, summarize, and export".into(),
                );
                "Tasks".into()
            }
            ControlPanel::Context => {
                add(
                    "context usage",
                    "Included context",
                    "Token budget, sources, and tools".into(),
                );
                add(
                    "context audit",
                    "Provenance",
                    "Inspect effective prompt sources".into(),
                );
                add(
                    "memory",
                    "Memory",
                    "Review, save, edit, or forget notes explicitly".into(),
                );
                add(
                    "harness review",
                    "Instruction proposals",
                    "Review before applying durable changes".into(),
                );
                add(
                    "harness",
                    "Instructions",
                    "Inspect revisions and rollback controls".into(),
                );
                add(
                    "rlm",
                    "Advanced variables",
                    "Inspect named context values".into(),
                );
                add(
                    "compact",
                    "Compact now",
                    "Manual override; automatic compaction remains enabled".into(),
                );
                "Context".into()
            }
            ControlPanel::Model => {
                add(
                    "model select",
                    "Choose model",
                    format!("{} · this session", self.current_model),
                );
                add(
                    "thinking",
                    "Effort",
                    format!("{} · this session", self.current_thinking_level.label()),
                );
                add(
                    "boost",
                    "Boost this task",
                    "One-task intelligence override".into(),
                );
                add(
                    &format!("model default {}", self.current_model),
                    "Save current as default",
                    "Applies to new sessions".into(),
                );
                add(
                    "setup",
                    "Account and provider setup",
                    "Configure an available inference route".into(),
                );
                "Model and effort".into()
            }
            ControlPanel::Effort => {
                for level in supported_efforts(&self.current_model) {
                    let name = level.label().to_lowercase();
                    add(
                        &format!("thinking {name}"),
                        &format!("Apply: {name}"),
                        "This session; next model request".into(),
                    );
                }
                format!(
                    "Effort · {} · {}",
                    self.current_thinking_level.label(),
                    self.current_model
                )
            }
            ControlPanel::Review => {
                add(
                    "git review",
                    "Changes",
                    "Git status and staged/worktree summary".into(),
                );
                add("diff", "Diff", "Inspect the working tree diff".into());
                add(
                    "rubber-duck",
                    "Request second opinion",
                    "Run model review of uncommitted changes".into(),
                );
                "Review".into()
            }
            ControlPanel::Help => {
                add(
                    "help commands",
                    "Commands",
                    "Generated command help and usage".into(),
                );
                add(
                    "hotkeys",
                    "Keyboard shortcuts",
                    "Effective keybindings".into(),
                );
                add(
                    "settings advanced",
                    "Diagnostics",
                    "Errors, limits, and build information".into(),
                );
                add("cost", "Usage", "Recorded tokens and cost".into());
                add(
                    "bug",
                    "Report a bug",
                    "Draft and review before sending".into(),
                );
                add(
                    "settings session",
                    "Session actions",
                    "History, recovery, and export".into(),
                );
                "Help".into()
            }
            ControlPanel::Session => {
                add(
                    "session",
                    "Session details",
                    "Workspace, model, and permission state".into(),
                );
                add(
                    "resume",
                    "Resume a session",
                    "Browse saved conversations".into(),
                );
                add(
                    "continue",
                    "Continue most recent",
                    "Most recent conversation in this workspace".into(),
                );
                add(
                    "fork",
                    "Fork conversation",
                    "Create a separate conversation branch".into(),
                );
                add(
                    "rewind",
                    "Rewind",
                    "Preview conversation or file recovery".into(),
                );
                add(
                    "summarize",
                    "Summarize selected turns",
                    "Create a saved conversation".into(),
                );
                add("export", "Export", "Choose a format and destination".into());
                add(
                    "history",
                    "Prompt history",
                    "Search previous prompts".into(),
                );
                add("view-plan", "View plan", "Current plan artifact".into());
                "Session actions".into()
            }
        };
        self.command_palette.show_panel(title, rows);
        self.active_modal = ActiveModal::CommandPalette;
    }
}

fn supported_efforts(model: &str) -> Vec<ThinkingLevel> {
    [
        ThinkingLevel::Off,
        ThinkingLevel::Minimal,
        ThinkingLevel::Low,
        ThinkingLevel::Medium,
        ThinkingLevel::High,
        ThinkingLevel::Max,
    ]
    .into_iter()
    .filter(|level| crate::model_dynamics::normalize_thinking(model, *level) == *level)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn effort_choices_match_the_model_request_contract() {
        assert_eq!(supported_efforts("gpt-4o"), vec![ThinkingLevel::Off]);
        assert_eq!(
            supported_efforts("anthropic/claude-fable-5-1"),
            vec![
                ThinkingLevel::Low,
                ThinkingLevel::Medium,
                ThinkingLevel::High,
                ThinkingLevel::Max
            ]
        );
        for level in supported_efforts("o1") {
            assert_eq!(
                crate::model_dynamics::normalize_thinking("o1", level),
                level
            );
        }
    }
}
