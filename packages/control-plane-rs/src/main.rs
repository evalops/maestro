use maestro_control_plane::{
    parse_cli_action, print_cli_help, print_cli_version, serve, CliAction, ControlPlaneConfig,
};
use std::{env, process};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match parse_cli_action(env::args().skip(1)) {
        Ok(CliAction::Serve) => serve(ControlPlaneConfig::from_env()).await,
        Ok(CliAction::Help) => {
            print_cli_help();
            Ok(())
        }
        Ok(CliAction::Version) => {
            print_cli_version();
            Ok(())
        }
        Err(error) => {
            eprintln!("{error}\nRun `maestro-control-plane --help` for usage.");
            process::exit(2);
        }
    }
}
