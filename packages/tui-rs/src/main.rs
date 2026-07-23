use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    maestro_tui::run_cli(std::env::args_os().collect()).await
}
