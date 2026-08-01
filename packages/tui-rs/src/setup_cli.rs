//! First-run onboarding built on the typed maestro doctor checks.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::doctor::{CheckStatus, DoctorCheck, DoctorReport};

pub const SETUP_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStep {
    pub id: String,
    pub command: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupReport {
    pub schema_version: u32,
    pub ready: bool,
    pub doctor: DoctorReport,
    pub next_steps: Vec<SetupStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SetupOptions {
    json: bool,
    live: bool,
    model: Option<String>,
}

fn parse_options(args: &[String]) -> Result<SetupOptions> {
    let mut options = SetupOptions {
        json: false,
        live: false,
        model: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => options.json = true,
            "--live" => options.live = true,
            "--model" => {
                index += 1;
                options.model = Some(args.get(index).context("--model requires a value")?.clone());
            }
            value if value.starts_with("--model=") => {
                options.model = Some(value[8..].to_owned());
            }
            "--help" | "-h" | "help" => bail!("help"),
            other => bail!("unknown setup option: {other}"),
        }
        index += 1;
    }
    Ok(options)
}

pub fn build_setup_report(doctor: DoctorReport) -> SetupReport {
    let selected_provider = doctor.selected_model.provider.as_str();
    let selected_codex = matches!(selected_provider, "openai-codex" | "codex");
    let selected_auth_ready = doctor.checks.iter().any(|check| {
        check.id == "auth_health"
            && check.status == CheckStatus::Pass
            && selected_provider_matches_summary(selected_provider, check)
    });
    let mut next_steps = Vec::new();

    for check in &doctor.checks {
        match check.id.as_str() {
            "provider" if is_actionable(check.status) && !selected_auth_ready => {
                let command = if selected_codex {
                    "maestro codex login".to_owned()
                } else {
                    credential_command(check)
                };
                push_step(
                    &mut next_steps,
                    if selected_codex {
                        "codex-login"
                    } else {
                        "credentials"
                    },
                    &command,
                    check.summary.clone(),
                );
            }
            "auth_health"
                if is_actionable(check.status)
                    && selected_provider_matches_summary(selected_provider, check) =>
            {
                let command = if selected_codex {
                    "maestro codex login".to_owned()
                } else {
                    credential_command(check)
                };
                push_step(
                    &mut next_steps,
                    if selected_codex {
                        "codex-login"
                    } else {
                        "credentials"
                    },
                    &command,
                    check.summary.clone(),
                );
            }
            "codex_login" | "codex_app_server" if selected_codex && is_actionable(check.status) => {
                push_step(
                    &mut next_steps,
                    "codex-login",
                    "maestro codex login",
                    check.summary.clone(),
                );
            }
            "config" if check.status == CheckStatus::Fail => push_step(
                &mut next_steps,
                "config",
                "maestro config validate",
                check.summary.clone(),
            ),
            "model_catalog" if check.status == CheckStatus::Fail => push_step(
                &mut next_steps,
                "model",
                "maestro models",
                check.summary.clone(),
            ),
            "codex_tools" if check.status == CheckStatus::Fail => push_step(
                &mut next_steps,
                "codex-tools",
                "maestro codex doctor",
                check.summary.clone(),
            ),
            "live_metadata" if check.status == CheckStatus::Fail => push_step(
                &mut next_steps,
                "live-metadata",
                "maestro doctor --live",
                check.summary.clone(),
            ),
            _ => {}
        }
    }

    SetupReport {
        schema_version: SETUP_SCHEMA_VERSION,
        ready: next_steps.is_empty(),
        doctor,
        next_steps,
    }
}

fn is_actionable(status: CheckStatus) -> bool {
    matches!(status, CheckStatus::Warning | CheckStatus::Fail)
}

fn selected_provider_matches_summary(provider: &str, check: &DoctorCheck) -> bool {
    check
        .summary
        .strip_prefix(provider)
        .is_some_and(|rest| rest.starts_with(':'))
        || (provider == "openai-codex"
            && check
                .summary
                .strip_prefix("codex")
                .is_some_and(|rest| rest.starts_with(':')))
        || (provider == "codex"
            && check
                .summary
                .strip_prefix("openai-codex")
                .is_some_and(|rest| rest.starts_with(':')))
}

fn credential_command(check: &DoctorCheck) -> String {
    check
        .detail
        .as_deref()
        .and_then(first_env_name)
        .map(|name| format!("export {name}=<your-key>"))
        .unwrap_or_else(|| "maestro config show".to_owned())
}

fn first_env_name(detail: &str) -> Option<&str> {
    detail
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .find(|token| {
            token.len() > 2
                && token.chars().all(|character| {
                    character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
                })
                && token
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_uppercase())
        })
}

fn push_step(steps: &mut Vec<SetupStep>, id: &str, command: &str, reason: String) {
    if steps.iter().any(|step| step.id == id) {
        return;
    }
    steps.push(SetupStep {
        id: id.to_owned(),
        command: command.to_owned(),
        reason,
    });
}

pub async fn run_setup(args: &[String]) -> Result<i32> {
    let options = match parse_options(args) {
        Ok(options) => options,
        Err(error) if error.to_string() == "help" => {
            println!("Usage: maestro setup [--json] [--live] [--model <provider/model>]");
            return Ok(0);
        }
        Err(error) => return Err(error),
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let doctor = crate::doctor::build_report(options.model.as_deref(), options.live, &cwd).await;
    let report = build_setup_report(doctor);
    if options.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("Maestro Setup (schema v{})", report.schema_version);
        println!(
            "Model: {} ({}, {})",
            report.doctor.selected_model.requested,
            report.doctor.selected_model.provider,
            report.doctor.selected_model.protocol
        );
        if report.ready {
            println!("Ready: authentication and local configuration checks passed.");
            println!("Run maestro to start a session.");
        } else {
            println!("Next steps:");
            for (index, step) in report.next_steps.iter().enumerate() {
                println!("  {}. {}", index + 1, step.reason);
                println!("     Run: {}", step.command);
            }
        }
    }
    Ok(i32::from(!report.ready))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doctor::SelectedModelReport;

    fn report(provider: &str, checks: Vec<DoctorCheck>) -> DoctorReport {
        DoctorReport {
            schema_version: crate::doctor::REPORT_SCHEMA_VERSION,
            ok: true,
            live_requested: false,
            selected_model: SelectedModelReport {
                requested: format!("{provider}/model"),
                provider: provider.to_owned(),
                protocol: "test".to_owned(),
                catalog: None,
            },
            checks,
        }
    }

    fn check(id: &str, status: CheckStatus, summary: &str, detail: Option<&str>) -> DoctorCheck {
        DoctorCheck {
            id: id.to_owned(),
            status,
            summary: summary.to_owned(),
            detail: detail.map(str::to_owned),
            live: false,
        }
    }

    #[test]
    fn setup_turns_missing_provider_credentials_into_one_actionable_step() {
        let result = build_setup_report(report(
            "openai",
            vec![
                check(
                    "provider",
                    CheckStatus::Warning,
                    "openai resolved; credentials not found",
                    Some("OPENAI_API_KEY"),
                ),
                check(
                    "auth_health",
                    CheckStatus::Warning,
                    "openai: no credential found",
                    Some("OPENAI_API_KEY"),
                ),
                check(
                    "auth_health",
                    CheckStatus::Warning,
                    "anthropic: no credential found",
                    Some("ANTHROPIC_API_KEY"),
                ),
            ],
        ));

        assert!(!result.ready);
        assert_eq!(result.next_steps.len(), 1);
        assert_eq!(result.next_steps[0].id, "credentials");
        assert_eq!(
            result.next_steps[0].command,
            "export OPENAI_API_KEY=<your-key>"
        );
    }

    #[test]
    fn setup_uses_codex_login_for_the_codex_provider() {
        let result = build_setup_report(report(
            "openai-codex",
            vec![
                check(
                    "provider",
                    CheckStatus::Warning,
                    "openai-codex resolved; credentials not found",
                    Some("CODEX_HOME"),
                ),
                check(
                    "codex_login",
                    CheckStatus::Warning,
                    "Codex auth not found",
                    None,
                ),
                check(
                    "codex_app_server",
                    CheckStatus::Warning,
                    "Codex app-server auth missing",
                    None,
                ),
            ],
        ));

        assert!(!result.ready);
        assert_eq!(result.next_steps.len(), 1);
        assert_eq!(result.next_steps[0].command, "maestro codex login");
    }

    #[test]
    fn unrelated_provider_warnings_do_not_block_setup() {
        let result = build_setup_report(report(
            "openai",
            vec![check(
                "auth_health",
                CheckStatus::Warning,
                "anthropic: no credential found",
                Some("ANTHROPIC_API_KEY"),
            )],
        ));

        assert!(result.ready);
        assert!(result.next_steps.is_empty());
    }

    #[test]
    fn stored_openai_oauth_credential_satisfies_provider_warning() {
        let result = build_setup_report(report(
            "openai",
            vec![
                check(
                    "provider",
                    CheckStatus::Warning,
                    "openai resolved; credentials not found",
                    Some("OPENAI_API_KEY"),
                ),
                check(
                    "auth_health",
                    CheckStatus::Pass,
                    "openai: stored OAuth credential present",
                    None,
                ),
            ],
        ));

        assert!(result.ready);
        assert!(result.next_steps.is_empty());
    }
}
