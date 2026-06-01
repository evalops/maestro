use anyhow::Result;
use maestro_tui::hosted_runner_cli::run_hosted_runner_cli_from_env;

#[tokio::main]
async fn main() -> Result<()> {
    run_hosted_runner_cli_from_env(std::env::args_os()).await
}
