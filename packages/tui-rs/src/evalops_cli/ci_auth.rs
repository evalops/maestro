//! Public-build boundary for internal CI workload authentication.

use anyhow::{Result, bail};

pub(super) async fn run(_args: &[String]) -> Result<i32> {
    bail!("CI workload authentication is unavailable in public builds")
}
