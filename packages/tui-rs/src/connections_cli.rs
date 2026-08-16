//! Native `maestro connections` credential and subscription UX.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fd_lock::RwLock as FileLock;
use serde::Serialize;

use crate::plugins::{ConnectionTypeDefinition, ConnectionTypeManifest, PluginRegistry};
use crate::service_connections::{
    keyring_secret_ref, now_ms, ConnectionAuthKind, ConnectionBroker, ConnectionPlacement,
    ConnectionSecretRef, ConnectionState, ConnectionStore, KeyringSecretBackend, SecretBackend,
    ServiceConnection,
};

#[derive(Debug, Default)]
struct Args {
    command: Option<String>,
    positionals: Vec<String>,
    label: Option<String>,
    from_env: Option<String>,
    from_file: Option<PathBuf>,
    from_one_password: Option<String>,
    delegated_profile: Option<String>,
    secret_stdin: bool,
    default: bool,
    json: bool,
    workspace: Option<PathBuf>,
    help: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTypeReport {
    #[serde(flatten)]
    definition: ConnectionTypeDefinition,
    source: String,
}

pub fn run_connections(args: &[String]) -> Result<i32> {
    let parsed = parse_args(args)?;
    if parsed.help || parsed.command.as_deref() == Some("help") {
        print_help();
        return Ok(0);
    }
    let command = parsed.command.as_deref().unwrap_or("list");
    match command {
        "types" => run_types(&parsed),
        "list" | "ls" => run_list(parsed.json),
        "add" => run_add(&parsed),
        "status" | "check" => run_status(&parsed),
        "use" | "default" => run_use(&parsed),
        "rotate" => run_rotate(&parsed),
        "remove" | "rm" | "revoke" => run_remove(&parsed),
        other => bail!("unknown connections subcommand: {other}"),
    }
}

fn run_types(args: &Args) -> Result<i32> {
    let reports = connection_types(args.workspace.as_deref())?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&reports)?);
    } else {
        println!("Connection types");
        for report in reports {
            println!(
                "- {} — {} [{}; {:?}; source={}]",
                report.definition.id,
                report.definition.display_name,
                report.definition.provider_id,
                report.definition.auth_kind,
                report.source
            );
        }
    }
    Ok(0)
}

fn run_list(json: bool) -> Result<i32> {
    let store = load_store()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&store.connections)?);
    } else if store.connections.is_empty() {
        println!("No managed connections. Run `maestro connections types` to see available types.");
    } else {
        println!("Connections");
        for connection in store.connections {
            println!(
                "- {} — {} [{}; {:?}; generation={}; {}]",
                connection.id,
                connection.label,
                connection.provider_id,
                connection.state,
                connection.generation,
                if connection.is_default {
                    "default"
                } else {
                    "available"
                }
            );
        }
    }
    Ok(0)
}

fn run_add(args: &Args) -> Result<i32> {
    let type_id = required_position(
        args,
        0,
        "Usage: maestro connections add <type> <id> [source]",
    )?;
    let id = required_position(
        args,
        1,
        "Usage: maestro connections add <type> <id> [source]",
    )?;
    let definitions = connection_types(args.workspace.as_deref())?;
    let definition = definitions
        .into_iter()
        .find(|report| report.definition.id == type_id)
        .map(|report| report.definition)
        .with_context(|| format!("unknown or untrusted connection type: {type_id}"))?;
    let path = ConnectionStore::default_path()?;
    let backend = KeyringSecretBackend;
    let connection = with_locked_store(&path, |store| {
        if store.get(id).is_some() {
            bail!("connection already exists: {id}");
        }
        let (secret_ref, stored_key) = source_for_add(args, &definition, id, &backend)?;
        let timestamp = now_ms();
        let provider_id = definition.provider_id.clone();
        let is_default = should_be_default(store, &provider_id, args.default);
        let connection = ServiceConnection {
            id: id.to_owned(),
            type_id: definition.id.clone(),
            provider_id,
            label: args.label.clone().unwrap_or_else(|| id.to_owned()),
            auth_kind: definition.auth_kind,
            env_var: definition.env_var.clone(),
            secret_ref,
            placement: definition.placement,
            state: ConnectionState::Active,
            capabilities: definition.capabilities.clone(),
            generation: 1,
            is_default,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        };
        if let Err(error) = store
            .upsert(connection.clone())
            .and_then(|()| store.save(&path))
        {
            if let Some((service, account)) = stored_key {
                let _ = backend.delete(&service, &account);
            }
            return Err(error);
        }
        Ok(connection)
    })?;
    print_connection(&connection, args.json)?;
    Ok(0)
}

fn should_be_default(store: &ConnectionStore, provider_id: &str, requested: bool) -> bool {
    requested
        || !store.connections.iter().any(|connection| {
            connection.provider_id == provider_id
                && connection.state == ConnectionState::Active
                && connection.is_default
        })
}

fn run_status(args: &Args) -> Result<i32> {
    let id = required_position(args, 0, "Usage: maestro connections status <id>")?;
    let store = load_store()?;
    let connection = store
        .get(id)
        .with_context(|| format!("connection not found: {id}"))?;
    let broker = ConnectionBroker::new(store.clone(), KeyringSecretBackend);
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let result = broker.check(id, &env);
    let status = if connection.state == ConnectionState::Revoked {
        "revoked"
    } else if result.is_err() {
        "unavailable"
    } else if matches!(connection.secret_ref, ConnectionSecretRef::Delegated { .. }) {
        "ready_delegated"
    } else {
        "ready"
    };
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "id": id,
                "status": status,
                "providerId": connection.provider_id,
                "generation": connection.generation,
                "detail": result.err().map(|error| error.to_string()),
            }))?
        );
    } else {
        println!("{id}: {status}");
        if let Err(error) = result {
            eprintln!("{error}");
        }
    }
    Ok(i32::from(status == "unavailable" || status == "revoked"))
}

fn run_use(args: &Args) -> Result<i32> {
    let id = required_position(args, 0, "Usage: maestro connections use <id>")?;
    let path = ConnectionStore::default_path()?;
    with_locked_store(&path, |store| {
        store.set_default(id)?;
        store.save(&path)
    })?;
    println!("{id}: default connection for its provider");
    Ok(0)
}

fn run_rotate(args: &Args) -> Result<i32> {
    let id = required_position(
        args,
        0,
        "Usage: maestro connections rotate <id> [--secret-stdin]",
    )?;
    let path = ConnectionStore::default_path()?;
    let backend = KeyringSecretBackend;
    let replacement = read_secret(args.secret_stdin)?;
    let generation = with_locked_store(&path, |store| {
        let (old_service, old_account, next_generation) = match &store
            .get(id)
            .with_context(|| format!("connection not found: {id}"))?
        {
            ServiceConnection {
                secret_ref: ConnectionSecretRef::Keyring { service, account },
                generation,
                ..
            } => (
                service.clone(),
                account.clone(),
                generation
                    .checked_add(1)
                    .context("connection generation overflow")?,
            ),
            _ => bail!("only OS-credential-store connections can be rotated; update the referenced source instead"),
        };
        let new_secret_ref = keyring_secret_ref(id, next_generation);
        let (new_service, new_account) = match &new_secret_ref {
            ConnectionSecretRef::Keyring { service, account } => (service.clone(), account.clone()),
            _ => unreachable!("keyring_secret_ref always returns a keyring reference"),
        };
        backend.set(&new_service, &new_account, &replacement)?;
        let connection = store
            .connections
            .iter_mut()
            .find(|connection| connection.id == id)
            .expect("connection checked above");
        connection.generation = next_generation;
        connection.secret_ref = new_secret_ref;
        connection.state = ConnectionState::Active;
        connection.updated_at_ms = now_ms();
        let generation = connection.generation;
        if let Err(error) = store.save(&path) {
            let _ = backend.delete(&new_service, &new_account);
            return Err(error);
        }
        if let Err(error) = backend.delete(&old_service, &old_account) {
            eprintln!(
                "warning: rotated connection is active, but the obsolete generation could not be deleted: {error}"
            );
        }
        Ok(generation)
    })?;
    println!("{id}: rotated; generation={generation}");
    Ok(0)
}

fn run_remove(args: &Args) -> Result<i32> {
    let id = required_position(args, 0, "Usage: maestro connections remove <id>")?;
    let path = ConnectionStore::default_path()?;
    let backend = KeyringSecretBackend;
    remove_connection(&path, id, &backend)?;
    println!("{id}: removed and revoked");
    Ok(0)
}

fn remove_connection(path: &Path, id: &str, backend: &impl SecretBackend) -> Result<()> {
    with_locked_store(path, |store| {
        let connection = store
            .remove(id)
            .with_context(|| format!("connection not found: {id}"))?;
        store.save(path)?;
        if let ConnectionSecretRef::Keyring { service, account } = &connection.secret_ref {
            if let Err(error) = backend.delete(service, account) {
                eprintln!(
                    "warning: connection metadata was removed, but the obsolete credential could not be deleted: {error}"
                );
            }
        }
        Ok(())
    })
}

fn source_for_add(
    args: &Args,
    definition: &ConnectionTypeDefinition,
    id: &str,
    backend: &impl SecretBackend,
) -> Result<(ConnectionSecretRef, Option<(String, String)>)> {
    if definition.placement == ConnectionPlacement::Platform {
        bail!(
            "platform-only connection types must be configured by the Platform credential broker"
        );
    }
    let configured = usize::from(args.from_env.is_some())
        + usize::from(args.from_file.is_some())
        + usize::from(args.from_one_password.is_some())
        + usize::from(args.delegated_profile.is_some())
        + usize::from(args.secret_stdin);
    if configured > 1 {
        bail!("choose exactly one credential source");
    }
    if definition.auth_kind != ConnectionAuthKind::ApiKey {
        if configured > 0 && args.delegated_profile.is_none() {
            bail!("subscription and OAuth connection types use delegated authentication");
        }
        if definition.provider_id != "openai-codex" {
            bail!(
                "no verified delegated authentication transport is available for provider {}",
                definition.provider_id
            );
        }
        return Ok((
            ConnectionSecretRef::Delegated {
                provider: definition.provider_id.clone(),
                profile: args.delegated_profile.clone(),
            },
            None,
        ));
    }
    if args.delegated_profile.is_some() {
        bail!("--delegated-profile is only valid for subscription and OAuth connection types");
    }
    if let Some(name) = &args.from_env {
        return Ok((
            ConnectionSecretRef::Environment { name: name.clone() },
            None,
        ));
    }
    if let Some(path) = &args.from_file {
        let path = dunce::canonicalize(path).with_context(|| {
            format!(
                "failed to resolve connection source file {}",
                path.display()
            )
        })?;
        if !path.is_file() {
            bail!("connection source file is not a regular file");
        }
        return Ok((ConnectionSecretRef::File { path }, None));
    }
    if let Some(reference) = &args.from_one_password {
        if !crate::ai::op_secret::is_op_reference(reference) {
            bail!("--from-1password requires an op:// reference");
        }
        return Ok((
            ConnectionSecretRef::OnePassword {
                reference: reference.clone(),
            },
            None,
        ));
    }
    let secret = read_secret(args.secret_stdin)?;
    let secret_ref = keyring_secret_ref(id, 1);
    let ConnectionSecretRef::Keyring { service, account } = &secret_ref else {
        unreachable!("keyring_secret_ref always returns a keyring reference");
    };
    backend.set(service, account, &secret)?;
    let stored_key = Some((service.clone(), account.clone()));
    Ok((secret_ref, stored_key))
}

fn read_secret(force_stdin: bool) -> Result<zeroize::Zeroizing<String>> {
    let value = if force_stdin || !io::stdin().is_terminal() {
        let mut value = String::new();
        io::stdin().read_to_string(&mut value)?;
        value
    } else {
        rpassword::prompt_password("Credential (stored in OS credential store): ")?
    };
    let value = value.trim().to_owned();
    if value.is_empty() {
        bail!("credential value must not be empty");
    }
    Ok(zeroize::Zeroizing::new(value))
}

fn load_store() -> Result<ConnectionStore> {
    ConnectionStore::load(&ConnectionStore::default_path()?)
}

fn with_locked_store<T>(
    path: &Path,
    operation: impl FnOnce(&mut ConnectionStore) -> Result<T>,
) -> Result<T> {
    let parent = path
        .parent()
        .context("connection store path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let mut lock_name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    lock_name.push(".lock");
    let lock_path = path.with_file_name(lock_name);
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&lock_path).with_context(|| {
        format!(
            "failed to open connection store lock {}",
            lock_path.display()
        )
    })?;
    let mut lock = FileLock::new(file);
    let _guard = lock
        .write()
        .with_context(|| format!("failed to lock connection store {}", path.display()))?;
    let mut store = ConnectionStore::load(path)?;
    operation(&mut store)
}

fn print_connection(connection: &ServiceConnection, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(connection)?);
    } else {
        println!(
            "{}: added {} connection for {} (generation={})",
            connection.id, connection.type_id, connection.provider_id, connection.generation
        );
    }
    Ok(())
}

fn required_position<'a>(args: &'a Args, index: usize, usage: &str) -> Result<&'a str> {
    args.positionals
        .get(index)
        .map(String::as_str)
        .context(usage.to_owned())
}

fn connection_types(workspace: Option<&Path>) -> Result<Vec<ConnectionTypeReport>> {
    let mut definitions = BTreeMap::<String, ConnectionTypeReport>::new();
    for definition in builtin_connection_types() {
        definitions.insert(
            definition.id.clone(),
            ConnectionTypeReport {
                definition,
                source: "maestro".to_owned(),
            },
        );
    }
    let registry = match workspace {
        Some(workspace) => PluginRegistry::discover_for_workspace(workspace),
        None => PluginRegistry::discover(),
    };
    for plugin in registry.plugins() {
        let Some(path) = &plugin.components.connections_path else {
            continue;
        };
        for definition in ConnectionTypeManifest::load(path)?.connection_types {
            if definitions.contains_key(&definition.id) {
                bail!(
                    "plugin {} connection type {} conflicts with an existing type",
                    plugin.name,
                    definition.id
                );
            }
            definitions.insert(
                definition.id.clone(),
                ConnectionTypeReport {
                    definition,
                    source: format!("plugin:{}", plugin.name),
                },
            );
        }
    }
    Ok(definitions.into_values().collect())
}

fn builtin_connection_types() -> Vec<ConnectionTypeDefinition> {
    let mut values = Vec::new();
    for (provider_id, display_name) in [
        ("anthropic", "Anthropic"),
        ("dashscope", "DashScope"),
        ("deepseek", "DeepSeek"),
        ("google", "Google Gemini"),
        ("groq", "Groq"),
        ("minimax", "MiniMax"),
        ("mistral", "Mistral"),
        ("moonshot", "Moonshot/Kimi"),
        ("openai", "OpenAI"),
        ("openrouter", "OpenRouter"),
        ("zai", "Z.ai"),
    ] {
        let Some(provider) = crate::ai::ProviderRegistry::descriptor(provider_id) else {
            continue;
        };
        let Some(env_var) = provider.auth_env.first() else {
            continue;
        };
        values.push(ConnectionTypeDefinition {
            id: format!("{provider_id}-api-key"),
            display_name: format!("{display_name} API key"),
            provider_id: provider.id.to_owned(),
            auth_kind: ConnectionAuthKind::ApiKey,
            placement: ConnectionPlacement::Either,
            env_var: Some((*env_var).to_owned()),
            capabilities: vec!["models.invoke".to_owned()],
            documentation_url: None,
        });
    }
    values.push(ConnectionTypeDefinition {
        id: "codex-subscription".into(),
        display_name: "ChatGPT/Codex subscription".into(),
        provider_id: "openai-codex".into(),
        auth_kind: ConnectionAuthKind::Subscription,
        placement: ConnectionPlacement::Local,
        env_var: None,
        capabilities: vec!["models.invoke".into()],
        documentation_url: None,
    });
    values.sort_by(|left, right| left.id.cmp(&right.id));
    values
}

fn parse_args(args: &[String]) -> Result<Args> {
    let mut parsed = Args::default();
    let mut index = 0;
    while index < args.len() {
        let value = &args[index];
        let take_value = |index: &mut usize| -> Result<String> {
            *index += 1;
            args.get(*index)
                .filter(|value| !value.starts_with('-'))
                .cloned()
                .with_context(|| format!("{} requires a value", args[*index - 1]))
        };
        match value.as_str() {
            "--json" => parsed.json = true,
            "--default" => parsed.default = true,
            "--secret-stdin" => parsed.secret_stdin = true,
            "--help" | "-h" => parsed.help = true,
            "--label" => parsed.label = Some(take_value(&mut index)?),
            "--from-env" => parsed.from_env = Some(take_value(&mut index)?),
            "--from-file" => parsed.from_file = Some(PathBuf::from(take_value(&mut index)?)),
            "--from-1password" => parsed.from_one_password = Some(take_value(&mut index)?),
            "--delegated-profile" => parsed.delegated_profile = Some(take_value(&mut index)?),
            "--workspace" | "--cwd" => {
                parsed.workspace = Some(PathBuf::from(take_value(&mut index)?));
            }
            unknown if unknown.starts_with('-') => bail!("unknown connections option: {unknown}"),
            command if parsed.command.is_none() => parsed.command = Some(command.to_owned()),
            positional => parsed.positionals.push(positional.to_owned()),
        }
        index += 1;
    }
    Ok(parsed)
}

fn print_help() {
    println!(
        "maestro connections <command> [options]\n\n\
Commands:\n\
  types [--json]                 List built-in and trusted-plugin connection types\n\
  list [--json]                  List non-secret connection metadata\n\
  add <type> <id> [source]       Add an API key or delegated account\n\
  status <id> [--json]           Validate that the credential source is available\n\
  use <id>                       Select the provider's default connection\n\
  rotate <id> [--secret-stdin]   Replace a keyring credential and revoke old leases\n\
  remove <id>                    Delete metadata and keyring credential\n\n\
Credential sources for add:\n\
  --from-env NAME                Resolve from an existing environment variable\n\
  --from-file PATH               Resolve from an operator-owned file\n\
  --from-1password op://...      Resolve with the 1Password CLI\n\
  --secret-stdin                 Read a literal key from stdin into the OS credential store\n\
  --delegated-profile NAME       Name a vendor-owned subscription/OAuth profile\n\n\
Literal keys are never accepted as command-line arguments or written to connections.json."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    struct DeleteFails;

    impl SecretBackend for DeleteFails {
        fn get(&self, _service: &str, _account: &str) -> Result<zeroize::Zeroizing<String>> {
            bail!("unused")
        }

        fn set(&self, _service: &str, _account: &str, _value: &str) -> Result<()> {
            bail!("unused")
        }

        fn delete(&self, _service: &str, _account: &str) -> Result<()> {
            bail!("simulated credential cleanup failure")
        }
    }

    fn test_connection(id: &str) -> ServiceConnection {
        ServiceConnection {
            id: id.into(),
            type_id: "openai-api-key".into(),
            provider_id: "openai".into(),
            label: id.into(),
            auth_kind: ConnectionAuthKind::ApiKey,
            env_var: Some("OPENAI_API_KEY".into()),
            secret_ref: keyring_secret_ref(id, 1),
            placement: ConnectionPlacement::Local,
            state: ConnectionState::Active,
            capabilities: vec!["models.invoke".into()],
            generation: 1,
            is_default: false,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn parses_reference_without_accepting_literal_secret_flag() {
        let parsed = parse_args(&[
            "add".into(),
            "openai-api-key".into(),
            "work".into(),
            "--from-env".into(),
            "WORK_OPENAI_KEY".into(),
            "--default".into(),
        ])
        .unwrap();
        assert_eq!(parsed.from_env.as_deref(), Some("WORK_OPENAI_KEY"));
        assert!(parsed.default);
        assert!(parse_args(&["add".into(), "--api-key".into(), "secret".into()]).is_err());
    }

    #[test]
    fn builtins_cover_api_keys_and_delegated_subscriptions() {
        let types = builtin_connection_types();
        assert!(types.iter().any(|item| item.id == "openai-api-key"));
        assert!(types.iter().any(|item| item.id == "anthropic-api-key"));
        assert!(types.iter().any(|item| item.id == "codex-subscription"));
        assert!(types
            .iter()
            .find(|item| item.id == "codex-subscription")
            .is_some_and(|item| item.auth_kind == ConnectionAuthKind::Subscription));
    }

    #[test]
    fn local_cli_rejects_platform_only_connection_types() {
        let definition = ConnectionTypeDefinition {
            id: "platform-api-key".into(),
            display_name: "Platform API key".into(),
            provider_id: "openai".into(),
            auth_kind: ConnectionAuthKind::ApiKey,
            placement: ConnectionPlacement::Platform,
            env_var: Some("OPENAI_API_KEY".into()),
            capabilities: vec!["models.invoke".into()],
            documentation_url: None,
        };
        let error = source_for_add(
            &Args::default(),
            &definition,
            "platform-only",
            &KeyringSecretBackend,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Platform credential broker"));
    }

    #[test]
    fn local_cli_rejects_unverified_delegated_connection_types() {
        let definition = ConnectionTypeDefinition {
            id: "vendor-oauth".into(),
            display_name: "Vendor OAuth".into(),
            provider_id: "vendor-plugin".into(),
            auth_kind: ConnectionAuthKind::OAuth,
            placement: ConnectionPlacement::Local,
            env_var: None,
            capabilities: vec!["models.invoke".into()],
            documentation_url: None,
        };
        let error = source_for_add(
            &Args::default(),
            &definition,
            "vendor-work",
            &KeyringSecretBackend,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("no verified delegated authentication transport"));
    }

    #[test]
    fn api_key_connection_rejects_a_delegated_profile_without_reading_a_secret() {
        let definition = builtin_connection_types()
            .into_iter()
            .find(|item| item.id == "openai-api-key")
            .unwrap();
        let args = Args {
            delegated_profile: Some("work".into()),
            ..Args::default()
        };

        let error = source_for_add(&args, &definition, "work", &KeyringSecretBackend).unwrap_err();
        assert!(error
            .to_string()
            .contains("only valid for subscription and OAuth"));
    }

    #[test]
    fn new_connection_defaults_when_no_active_default_exists() {
        let mut revoked_default = test_connection("revoked");
        revoked_default.state = ConnectionState::Revoked;
        let store = ConnectionStore {
            schema_version: 1,
            connections: vec![revoked_default],
        };
        assert!(should_be_default(&store, "openai", false));

        let mut active_default = test_connection("active");
        active_default.is_default = true;
        let store = ConnectionStore {
            schema_version: 1,
            connections: vec![active_default],
        };
        assert!(!should_be_default(&store, "openai", false));
        assert!(should_be_default(&store, "openai", true));
    }

    #[test]
    fn store_lock_serializes_read_modify_write_transactions() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("connections.json");
        let first_path = path.clone();
        let second_path = path.clone();
        let (first_acquired_tx, first_acquired_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let (second_acquired_tx, second_acquired_rx) = mpsc::channel();

        let first = std::thread::spawn(move || {
            with_locked_store(&first_path, |store| {
                store.upsert(test_connection("first"))?;
                first_acquired_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
                store.save(&first_path)
            })
            .unwrap();
        });
        first_acquired_rx.recv().unwrap();

        let second = std::thread::spawn(move || {
            with_locked_store(&second_path, |store| {
                second_acquired_tx.send(()).unwrap();
                store.upsert(test_connection("second"))?;
                store.save(&second_path)
            })
            .unwrap();
        });
        assert!(second_acquired_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        release_first_tx.send(()).unwrap();
        first.join().unwrap();
        second_acquired_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        second.join().unwrap();

        let store = ConnectionStore::load(&path).unwrap();
        assert!(store.get("first").is_some());
        assert!(store.get("second").is_some());
    }

    #[test]
    fn removal_is_durable_before_credential_cleanup() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("connections.json");
        ConnectionStore {
            schema_version: 1,
            connections: vec![test_connection("obsolete")],
        }
        .save(&path)
        .unwrap();

        remove_connection(&path, "obsolete", &DeleteFails).unwrap();

        assert!(ConnectionStore::load(&path)
            .unwrap()
            .get("obsolete")
            .is_none());
    }
}
