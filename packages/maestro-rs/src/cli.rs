use std::ffi::OsString;

const UTILITY_COMMANDS: &[&str] = &[
    "a2a",
    "agents",
    "anthropic",
    "codex",
    "config",
    "context",
    "doctor",
    "cost",
    "evalops",
    "export",
    "hooks",
    "import",
    "import-claude",
    "init",
    "memory",
    "mission",
    "models",
    "modes",
    "openai",
    "operating-plane",
    "painter",
    "plugin",
    "plugins",
    "remote",
    "run",
    "scenario",
    "sessions",
    "skill",
    "stats",
    "status",
    "update",
    "value",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentMode {
    Interactive,
    Print,
    Exec,
    Headless,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Web { port: Option<u16> },
    Agent(AgentMode),
    HostedRunner(Vec<OsString>),
    Utility(Vec<OsString>),
    Help,
    Version,
}

pub fn classify<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let strings = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>();
    let first = strings.first().map(|value| value.as_ref());

    if first.is_none() {
        return Ok(Command::Agent(AgentMode::Interactive));
    }
    if matches!(first, Some("--version" | "-V" | "-v")) {
        return Ok(Command::Version);
    }
    if matches!(
        first,
        Some("--help" | "-h" | "--help-hidden" | "--help-all")
    ) {
        return Ok(Command::Help);
    }
    if first == Some("web") {
        let mut port = None;
        let mut index = 1;
        while index < strings.len() {
            let argument = strings[index].as_ref();
            if argument == "--port" {
                index += 1;
                let value = strings.get(index).ok_or("--port requires a value")?;
                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| format!("invalid web port: {value}"))?,
                );
            } else if let Some(value) = argument.strip_prefix("--port=") {
                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| format!("invalid web port: {value}"))?,
                );
            } else {
                return Err(format!(
                    "`maestro web` does not accept prompt arguments or option `{argument}`"
                ));
            }
            index += 1;
        }
        return Ok(Command::Web { port });
    }
    if first == Some("hosted-runner") {
        return Ok(Command::HostedRunner(args));
    }
    if matches!(first, Some("headless" | "rpc"))
        || strings
            .iter()
            .any(|arg| matches!(arg.as_ref(), "--headless" | "--rpc" | "--mode=headless"))
        || strings
            .windows(2)
            .any(|pair| pair[0] == "--mode" && pair[1] == "headless")
    {
        return Ok(Command::Agent(AgentMode::Headless));
    }
    if first == Some("exec") {
        return Ok(Command::Agent(AgentMode::Exec));
    }
    if first == Some("print")
        || strings
            .iter()
            .any(|arg| matches!(arg.as_ref(), "--print" | "-p"))
    {
        return Ok(Command::Agent(AgentMode::Print));
    }
    if first.is_some_and(|command| UTILITY_COMMANDS.contains(&command)) {
        return Ok(Command::Utility(args));
    }

    Ok(Command::Agent(AgentMode::Interactive))
}
