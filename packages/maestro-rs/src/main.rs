use anyhow::Result;
use maestro::{classify, Command};
use maestro_control_plane::{serve, ControlPlaneConfig};
use std::path::{Path, PathBuf};

fn web_static_root(executable: &Path) -> Option<PathBuf> {
    let executable_dir = executable.parent()?;
    let installed_assets = executable_dir.join("maestro-web");
    if installed_assets.join("index.html").is_file() {
        return Some(installed_assets);
    }

    executable_dir.ancestors().find_map(|ancestor| {
        let candidate = ancestor.join("packages/web/dist");
        candidate.join("index.html").is_file().then_some(candidate)
    })
}

fn configure_web_static_root() {
    if std::env::var_os("MAESTRO_WEB_STATIC_ROOT").is_some() {
        return;
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(root) = web_static_root(&executable) {
            std::env::set_var("MAESTRO_WEB_STATIC_ROOT", root);
        }
    }
}

const HELP: &str = "Maestro\n\nUsage:\n  maestro [options] [prompt]\n  maestro exec <prompt>\n  maestro -w <name> [prompt]\n  maestro doctor [--json] [--live] [--model <provider/model>]\n  maestro --headless\n  maestro web [--port <port>]\n  maestro hosted-runner [options]\n\nOptions:\n  -w, --worktree <name>  Run the session in a new git worktree at ../<repo>-wt-<name>\n                         on a new branch; clean worktrees are removed on exit, dirty ones kept\n\nThe product runtime is native Rust; no Node.js or Bun runtime is required.";
const VERSION: &str = concat!("maestro ", env!("CARGO_PKG_VERSION"));

fn sync_command_output(command: &Command) -> Option<&'static str> {
    match command {
        Command::Help => Some(HELP),
        Command::Version => Some(VERSION),
        _ => None,
    }
}

fn main() -> Result<()> {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    let command = classify(raw_args.iter().skip(1).cloned()).map_err(anyhow::Error::msg)?;

    if let Some(output) = sync_command_output(&command) {
        println!("{output}");
        return Ok(());
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            match command {
                Command::Web { port } => {
                    configure_web_static_root();
                    if let Some(port) = port {
                        std::env::set_var("PORT", port.to_string());
                    }
                    serve(ControlPlaneConfig::from_env()).await
                }
                Command::Agent(_) | Command::HostedRunner(_) | Command::Utility(_) => {
                    maestro_tui::run_cli(raw_args).await
                }
                Command::Help | Command::Version => unreachable!("handled before runtime startup"),
            }
        })
}

#[cfg(test)]
mod tests {
    use super::{sync_command_output, web_static_root, HELP, VERSION};
    use maestro::Command;
    use std::{fs, path::PathBuf};

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "maestro-web-root-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should follow the Unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn finds_assets_next_to_installed_binary() {
        let root = test_root("installed");
        let executable = root.join("bin/maestro");
        let assets = root.join("bin/maestro-web");
        fs::create_dir_all(&assets).expect("asset directory should be created");
        fs::write(assets.join("index.html"), "ok").expect("index should be written");

        assert_eq!(web_static_root(&executable), Some(assets));
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn finds_assets_from_native_npm_package() {
        let root = test_root("npm");
        let executable = root.join("vendor/maestro/linux-x64/maestro");
        let assets = root.join("packages/web/dist");
        fs::create_dir_all(&assets).expect("asset directory should be created");
        fs::write(assets.join("index.html"), "ok").expect("index should be written");

        assert_eq!(web_static_root(&executable), Some(assets));
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn help_and_version_are_handled_without_async_runtime() {
        assert_eq!(sync_command_output(&Command::Help), Some(HELP));
        assert_eq!(sync_command_output(&Command::Version), Some(VERSION));
    }
}
