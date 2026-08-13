#[tokio::main]
async fn main() -> anyhow::Result<()> {
    maestro_tui::hosted_runner_conformance::run().await
}
