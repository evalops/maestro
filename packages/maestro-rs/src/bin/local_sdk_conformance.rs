//! Deterministic local-SDK stdio fixture.
//!
//! Cargo builds this binary only with `maestro --features test-support`. It
//! uses the production headless parser and event bridge with a scripted native
//! provider, so language SDKs can exercise a child process without a network
//! credential or a hosted authority path.

fn main() -> anyhow::Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let accepts_headless = match arguments.as_slice() {
        [] => true,
        [argument] => argument.as_os_str() == std::ffi::OsStr::new("--headless"),
        _ => false,
    };
    if !accepts_headless {
        anyhow::bail!("maestro-local-sdk-conformance accepts only --headless");
    }
    let status = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(maestro_tui::headless_server::run_scripted_local_sdk_conformance_server())?;
    std::process::exit(status);
}
