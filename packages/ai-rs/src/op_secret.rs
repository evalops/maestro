//! 1Password `op://` secret reference resolution for provider credentials.
//!
//! When a provider API key environment variable holds an `op://` reference
//! instead of a literal key, the value is resolved by shelling out to the
//! 1Password CLI (`op read <reference>`) with a short timeout. Resolved values
//! are cached for the lifetime of the process. Secret values are never
//! included in log output or error messages.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use wait_timeout::ChildExt;

pub const OP_REFERENCE_PREFIX: &str = "op://";

#[cfg(not(test))]
const OP_READ_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const OP_READ_TIMEOUT: Duration = Duration::from_secs(2);

#[must_use]
pub fn is_op_reference(value: &str) -> bool {
    value.trim_start().starts_with(OP_REFERENCE_PREFIX)
}

/// Resolve a credential value for `env_var`. Literal values are returned
/// unchanged; `op://` references are resolved through the 1Password CLI and
/// cached for the process lifetime.
///
/// # Errors
/// Returns an error mentioning the `op` CLI when the reference cannot be
/// resolved (missing CLI, non-zero exit, timeout). The secret value itself is
/// never included in the error.
pub fn resolve_credential(env_var: &str, value: &str) -> Result<String> {
    let value = value.trim();
    if !is_op_reference(value) {
        return Ok(value.to_owned());
    }
    resolve_op_reference(env_var, value)
}

/// Read the first set variable from `names` and resolve it like
/// [`resolve_credential`] would. Used by `*_from_env` client constructors.
///
/// # Errors
/// Returns an error when none of the variables is set or when an `op://`
/// reference cannot be resolved.
pub fn env_credential(names: &[&str]) -> Result<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            return resolve_credential(name, &value);
        }
    }
    let label = if names.len() == 1 {
        names[0].to_owned()
    } else {
        format!("{} (or {})", names[0], names[1..].join(", "))
    };
    bail!("{label} environment variable not set")
}

fn resolve_op_reference(env_var: &str, reference: &str) -> Result<String> {
    let cache = op_cache();
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(cached) = cache.get(reference) {
        return Ok(cached.clone());
    }
    let resolved = read_op_reference(env_var, reference)?;
    cache.insert(reference.to_owned(), resolved.clone());
    Ok(resolved)
}

fn op_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_op_reference(env_var: &str, reference: &str) -> Result<String> {
    let mut child = Command::new("op")
        .arg("read")
        .arg(reference)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!("failed to resolve {env_var}: 1Password CLI `op` could not be started (is it installed and on PATH?)")
        })?;
    match child.wait_timeout(OP_READ_TIMEOUT) {
        Ok(Some(status)) if status.success() => {
            let mut stdout = String::new();
            if let Some(mut pipe) = child.stdout.take() {
                let _ = pipe.read_to_string(&mut stdout);
            }
            let secret = stdout.trim_end_matches(['\r', '\n']).to_owned();
            if secret.is_empty() {
                bail!(
                    "failed to resolve {env_var}: 1Password CLI `op read` returned an empty value for {reference}"
                );
            }
            Ok(secret)
        }
        Ok(Some(status)) => {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            let stderr = stderr.trim();
            if stderr.is_empty() {
                bail!(
                    "failed to resolve {env_var}: 1Password CLI `op read {reference}` exited with {status}"
                );
            }
            bail!(
                "failed to resolve {env_var}: 1Password CLI `op read {reference}` failed: {stderr}"
            )
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "failed to resolve {env_var}: 1Password CLI `op read` timed out after {}s",
                OP_READ_TIMEOUT.as_secs()
            )
        }
        Err(error) => Err(error).with_context(|| {
            format!("failed to resolve {env_var}: 1Password CLI `op read` could not be awaited")
        }),
    }
}

/// Exposed to `maestro-tui`'s own tests (e.g. `doctor.rs` auth-health checks)
/// via the `test-support` feature; otherwise only compiled for this crate's
/// own `#[cfg(test)]` builds.
#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard, PoisonError};

    /// Serializes tests that mutate the process-global `PATH`.
    static PATH_LOCK: Mutex<()> = Mutex::new(());

    /// A fake `op` binary (shell script) installed in a tempdir that is
    /// prepended to `PATH` for the lifetime of the guard.
    pub struct FakeOp {
        _guard: MutexGuard<'static, ()>,
        saved_path: Option<std::ffi::OsString>,
        // Only read by `call_count()`, which downstream `test-support`
        // consumers (this field's only other reader) do not currently call;
        // real `#[cfg(test)]` runs of this crate do exercise it.
        #[cfg_attr(not(test), allow(dead_code))]
        dir: tempfile::TempDir,
    }

    impl FakeOp {
        pub fn install() -> Self {
            let guard = PATH_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
            let dir = tempfile::tempdir().expect("fake op tempdir");
            let binary = dir.path().join("op");
            std::fs::write(&binary, Self::script(dir.path())).expect("write fake op script");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod fake op");
            }
            let saved_path = std::env::var_os("PATH");
            let mut entries = vec![dir.path().to_path_buf()];
            if let Some(existing) = saved_path.as_deref() {
                entries.extend(std::env::split_paths(existing));
            }
            let joined = std::env::join_paths(entries).expect("join PATH");
            std::env::set_var("PATH", joined);
            Self {
                _guard: guard,
                saved_path,
                dir,
            }
        }

        // Only exercised by this crate's own `#[cfg(test)]` tests today;
        // downstream `test-support` consumers only use `install()`.
        #[cfg_attr(not(test), allow(dead_code))]
        pub(crate) fn call_count(&self) -> usize {
            std::fs::read_to_string(self.dir.path().join("calls"))
                .map(|contents| contents.lines().count())
                .unwrap_or(0)
        }

        /// Fake `op read`: records every invocation, resolves any reference
        /// except those containing `missing` (exit 1) or `slow` (hangs past
        /// the resolution timeout).
        fn script(dir: &Path) -> String {
            format!(
                "#!/bin/sh\n\
                 echo call >> \"{dir}/calls\"\n\
                 case \"$2\" in\n\
                 \x20 *missing*) echo \"[ERROR] item not found\" >&2; exit 1 ;;\n\
                 \x20 *slow*) sleep 30 ;;\n\
                 \x20 *) printf 'resolved-secret-value\\n' ;;\n\
                 esac\n",
                dir = dir.display()
            )
        }
    }

    impl Drop for FakeOp {
        fn drop(&mut self) {
            match &self.saved_path {
                Some(saved) => std::env::set_var("PATH", saved),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeOp;
    use super::*;

    #[test]
    fn literal_values_pass_through() {
        assert!(!is_op_reference("sk-literal"));
        let resolved = resolve_credential("OPENAI_API_KEY", "  sk-literal  ").expect("literal");
        assert_eq!(resolved, "sk-literal");
    }

    #[test]
    fn op_reference_detection() {
        assert!(is_op_reference("op://vault/item/key"));
        assert!(is_op_reference("  op://vault/item/key"));
        assert!(!is_op_reference("sk-op://not-a-ref"));
    }

    #[test]
    fn resolves_op_reference_via_fake_cli() {
        let fake = FakeOp::install();
        let resolved = resolve_credential("OPENAI_API_KEY", "op://vault/item/direct")
            .expect("op:// resolution");
        assert_eq!(resolved, "resolved-secret-value");
        assert_eq!(fake.call_count(), 1);
    }

    #[test]
    fn resolved_values_are_cached_for_process_lifetime() {
        let fake = FakeOp::install();
        for _ in 0..3 {
            let resolved = resolve_credential("ANTHROPIC_API_KEY", "op://vault/item/cached")
                .expect("op:// resolution");
            assert_eq!(resolved, "resolved-secret-value");
        }
        assert_eq!(fake.call_count(), 1, "second resolve must hit the cache");
    }

    #[test]
    fn failure_mentions_op_cli_without_secret() {
        let _fake = FakeOp::install();
        let error = resolve_credential("XAI_API_KEY", "op://vault/item/missing")
            .expect_err("missing item must fail");
        let message = format!("{error:#}");
        assert!(
            message.contains("1Password CLI") && message.contains("op read"),
            "error should mention the op CLI: {message}"
        );
        assert!(message.contains("XAI_API_KEY"));
        assert!(
            !message.contains("resolved-secret-value"),
            "error must not leak secrets: {message}"
        );
    }

    #[test]
    fn slow_op_read_times_out() {
        let _fake = FakeOp::install();
        let error = resolve_credential("GEMINI_API_KEY", "op://vault/item/slow")
            .expect_err("hung op read must time out");
        let message = format!("{error:#}");
        assert!(message.contains("timed out"), "unexpected error: {message}");
    }
}
