//! Skill package source resolution and publish/install contract.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
enum PackageSource {
    Local(PathBuf),
    Git {
        url: String,
        reference: Option<String>,
    },
    Npm {
        name: String,
        version: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfiguredPackageSpec {
    source: String,
    skills: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    name: Option<String>,
    version: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    maestro: Option<PackageManifest>,
}

#[derive(Debug, Default, Deserialize)]
struct PackageManifest {
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    prompts: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    themes: Vec<String>,
}

fn parse_source(spec: &str, cwd: &Path) -> Result<PackageSource> {
    if let Some(path) = spec.strip_prefix("local:") {
        return Ok(PackageSource::Local(resolve_from(cwd, path)));
    }
    if let Some(value) = spec
        .strip_prefix("git:")
        .filter(|_| !spec.starts_with("git://"))
    {
        return parse_git(value);
    }
    if let Some(value) = spec.strip_prefix("npm:") {
        return parse_npm(value);
    }
    if spec.starts_with("./") || spec.starts_with("../") || Path::new(spec).is_absolute() {
        return Ok(PackageSource::Local(resolve_from(cwd, spec)));
    }
    if spec.starts_with("git://")
        || spec.contains("github.com/")
        || spec.contains("gitlab.com/")
        || spec.contains("bitbucket.org/")
        || (spec.ends_with(".git") && !spec.starts_with('@'))
    {
        return parse_git(spec);
    }
    if spec.starts_with('@')
        || spec
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return parse_npm(spec);
    }
    bail!("Invalid package source format: {spec}")
}

fn resolve_from(cwd: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn parse_npm(value: &str) -> Result<PackageSource> {
    if value.trim().is_empty() {
        bail!("Invalid npm package source");
    }
    let split = value.rfind('@').filter(|index| *index > 0);
    let (name, version) = split.map_or((value, None), |index| {
        (&value[..index], Some(value[index + 1..].to_owned()))
    });
    Ok(PackageSource::Npm {
        name: name.to_owned(),
        version,
    })
}

fn parse_git(value: &str) -> Result<PackageSource> {
    if value.trim().is_empty() {
        bail!("Invalid git package source");
    }
    let split = value.rfind('@').filter(|index| {
        *index > 0
            && !(value.starts_with("git@") && *index == 3)
            && value.find("://").is_none_or(|scheme| {
                value[scheme + 3..]
                    .find('/')
                    .is_some_and(|slash| *index > scheme + 3 + slash)
            })
    });
    let (url, reference) = split.map_or((value, None), |index| {
        (&value[..index], Some(value[index + 1..].to_owned()))
    });
    if let Some(reference) = &reference {
        let safe = !reference.starts_with('-')
            && reference.chars().all(|ch| {
                ch.is_ascii_alphanumeric()
                    || matches!(
                        ch,
                        '_' | '.' | '/' | '+' | '%' | ',' | '=' | '~' | '^' | '-'
                    )
            });
        if !safe {
            bail!("Invalid git package ref in source: {value}");
        }
    }
    Ok(PackageSource::Git {
        url: url.to_owned(),
        reference,
    })
}

fn format_source(source: &PackageSource) -> String {
    match source {
        PackageSource::Local(path) => format!("local:{}", path.display()),
        PackageSource::Git { url, reference } => format!(
            "git:{url}{}",
            reference
                .as_ref()
                .map_or(String::new(), |value| format!("@{value}"))
        ),
        PackageSource::Npm { name, version } => format!(
            "npm:{name}{}",
            version
                .as_ref()
                .map_or(String::new(), |value| format!("@{value}"))
        ),
    }
}

fn cache_dir() -> PathBuf {
    env::var_os("MAESTRO_PACKAGE_CACHE_DIR").map_or_else(
        || {
            crate::path_utils::maestro_home_dir()
                .unwrap_or_else(|| PathBuf::from(".maestro"))
                .join("packages")
        },
        PathBuf::from,
    )
}

fn cache_path(kind: &str, identity: &str) -> PathBuf {
    let digest = Sha256::digest(format!("{kind}:{identity}").as_bytes());
    let hash = digest[..8].iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    });
    cache_dir().join(format!("{kind}-{hash}"))
}

fn sanitized_command(program: &str) -> Command {
    let mut command = Command::new(program);
    for (key, _) in env::vars_os() {
        let text = key.to_string_lossy();
        let lower = text.to_ascii_lowercase();
        let blocked = matches!(
            text.as_ref(),
            "NODE_OPTIONS" | "NPM_TOKEN" | "NODE_AUTH_TOKEN"
        );
        let package_setting = lower.starts_with("npm_config_")
            || lower.starts_with("bun_config_")
            || lower.starts_with("yarn_")
            || lower.starts_with("pnpm_");
        if blocked || (package_setting && lower != "npm_config_prefix") {
            command.env_remove(key);
        }
    }
    command
}

fn clone_git_source(clone_url: &str, reference: Option<&str>, path: &Path) -> Result<()> {
    let mut command = sanitized_command("git");
    command.args([
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=user",
        "clone",
        "--depth",
        "1",
    ]);
    if let Some(reference) = reference {
        command.args(["--branch", reference]);
    }
    let mut status = command.arg(clone_url).arg(path).status()?;
    if !status.success() && reference.is_some() {
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        status = sanitized_command("git")
            .args([
                "-c",
                "protocol.ext.allow=never",
                "-c",
                "protocol.file.allow=user",
                "clone",
            ])
            .arg(clone_url)
            .arg(path)
            .status()?;
        if status.success() {
            status = sanitized_command("git")
                .arg("-C")
                .arg(path)
                .args(["checkout", "-f", reference.unwrap_or_default()])
                .status()?;
        }
    }
    if !status.success() {
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        bail!("git clone or checkout failed for {clone_url}");
    }
    Ok(())
}

fn resolve_source(source: &PackageSource) -> Result<PathBuf> {
    match source {
        PackageSource::Local(path) => Ok(path.clone()),
        PackageSource::Git { url, reference } => {
            let path = cache_path(
                "git",
                &format!("{url}@{}", reference.as_deref().unwrap_or("")),
            );
            if path.join(".git").is_dir() {
                return Ok(path);
            }
            if path.exists() {
                fs::remove_dir_all(&path)?;
            }
            fs::create_dir_all(cache_dir())?;
            let clone_url = if url.starts_with("github.com/")
                || url.starts_with("gitlab.com/")
                || url.starts_with("bitbucket.org/")
            {
                format!("https://{url}")
            } else {
                url.clone()
            };
            clone_git_source(&clone_url, reference.as_deref(), &path)?;
            Ok(path)
        }
        PackageSource::Npm { name, version } => {
            let identity = format!("{name}@{}", version.as_deref().unwrap_or(""));
            let cache = cache_path("npm", &identity);
            let package = cache.join("node_modules").join(name);
            if package.is_dir() {
                return Ok(package);
            }
            if cache.exists() {
                fs::remove_dir_all(&cache)?;
            }
            fs::create_dir_all(&cache)?;
            let spec = version
                .as_ref()
                .map_or_else(|| name.clone(), |version| format!("{name}@{version}"));
            let status = sanitized_command("npm")
                .args([
                    "install",
                    "--prefix",
                    cache.to_string_lossy().as_ref(),
                    "--no-save",
                    "--ignore-scripts",
                    "--no-package-lock",
                    "--no-audit",
                    "--no-fund",
                    "--install-links=false",
                    "--silent",
                    &spec,
                ])
                .status()?;
            if !status.success() || !package.is_dir() {
                if cache.exists() {
                    fs::remove_dir_all(&cache)?;
                }
                bail!("npm install failed for {spec}");
            }
            Ok(package)
        }
    }
}

fn resource_directories(
    root: &Path,
    paths: &[String],
    kind: &str,
    issues: &mut Vec<serde_json::Value>,
) -> Vec<PathBuf> {
    let mut resources = Vec::new();
    for path in paths {
        let directory = root.join(path);
        if !directory.exists() {
            issues.push(serde_json::json!({
                "code": "package_validation",
                "message": format!("{kind} path does not exist: {path}"),
            }));
        } else if !directory.is_dir() {
            issues.push(serde_json::json!({
                "code": "package_validation",
                "message": format!("{kind} path is not a directory: {path}"),
            }));
        } else if let Ok(entries) = fs::read_dir(directory) {
            resources.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir()),
            );
        }
    }
    resources
}

fn contract(source_spec: &str, describe: bool) -> Result<serde_json::Value> {
    let cwd = env::current_dir()?;
    let source = parse_source(source_spec, &cwd)?;
    let root = resolve_source(&source)?;
    let mut issues = Vec::new();
    let package: Option<PackageJson> = fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok());
    if package.is_none() {
        issues.push(serde_json::json!({
            "code": "package_validation",
            "message": format!("No valid package.json found at {}.", root.display()),
        }));
    }
    if package.as_ref().is_some_and(|package| {
        !package
            .keywords
            .iter()
            .any(|keyword| keyword == "maestro-package")
    }) {
        issues.push(serde_json::json!({
            "code": "missing_maestro_package_keyword",
            "message": "Missing \"maestro-package\" keyword.",
        }));
    }
    if package.as_ref().is_some_and(|package| {
        !package
            .keywords
            .iter()
            .any(|keyword| keyword == "maestro-skill-package")
    }) {
        issues.push(serde_json::json!({
            "code": "missing_maestro_skill_package_keyword",
            "message": "package.json keywords must include \"maestro-skill-package\" for OSS skill registry discovery.",
        }));
    }
    if package
        .as_ref()
        .is_some_and(|package| package.maestro.is_none())
    {
        issues.push(serde_json::json!({
            "code": "package_validation",
            "message": "Missing \"maestro\" section in package.json.",
        }));
    }
    let empty_manifest = PackageManifest::default();
    let manifest = package
        .as_ref()
        .and_then(|package| package.maestro.as_ref())
        .unwrap_or(&empty_manifest);
    let skills = resource_directories(&root, &manifest.skills, "skills", &mut issues);
    let prompts = resource_directories(&root, &manifest.prompts, "prompts", &mut issues);
    let extensions = resource_directories(&root, &manifest.extensions, "extensions", &mut issues);
    let themes = resource_directories(&root, &manifest.themes, "themes", &mut issues);
    if skills.is_empty() {
        issues.push(serde_json::json!({
            "code": "missing_skill_resources",
            "message": "package.json maestro.skills must expose at least one skill directory.",
        }));
    }
    let report = (!skills.is_empty()).then(|| crate::skill_cli::eval_report(&skills, describe));
    if report
        .as_ref()
        .is_some_and(|report| report["summary"]["failed"].as_u64().unwrap_or(0) > 0)
    {
        issues.push(serde_json::json!({
            "code": "skill_package_eval_failed",
            "message": "One or more bundled skills failed the Agent Core package eval contract.",
        }));
    }
    let formatted = format_source(&source);
    let install_source = match &source {
        PackageSource::Local(path) => path.strip_prefix(&cwd).map_or_else(
            |_| formatted.clone(),
            |relative| format!("local:./{}", relative.display()),
        ),
        _ => formatted.clone(),
    };
    let install_command = format!(
        "deixic-code skill install {}",
        quote_install_source(&install_source)
    );
    let source_kind = match source {
        PackageSource::Local(_) => "local",
        PackageSource::Git { .. } => "git",
        PackageSource::Npm { .. } => "npm",
    };
    let mut install = serde_json::Map::new();
    install.insert("source".into(), serde_json::json!(install_command.clone()));
    install.insert(source_kind.into(), serde_json::json!(install_command));
    Ok(serde_json::json!({
        "schemaVersion": "evalops.maestro.skill-package-publish-contract.v1",
        "sourceSpec": source_spec,
        "resolvedSource": formatted,
        "resolvedPath": root,
        "package": {
            "name": package.as_ref().and_then(|package| package.name.as_ref()),
            "version": package.as_ref().and_then(|package| package.version.as_ref()),
            "keywords": package.as_ref().map_or(&[][..], |package| package.keywords.as_slice()),
        },
        "resources": {
            "skills": skills,
            "prompts": prompts,
            "extensions": extensions,
            "themes": themes,
        },
        "install": install,
        "evalReport": report,
        "issues": issues,
    }))
}

fn print_contract(contract: &serde_json::Value) {
    let package = contract["package"]["name"].as_str().unwrap_or("(unknown)");
    let version = contract["package"]["version"]
        .as_str()
        .map_or(String::new(), |version| format!("@{version}"));
    println!("Skill package: {package}{version}");
    println!(
        "Source: {}",
        contract["resolvedSource"].as_str().unwrap_or("unknown")
    );
    println!(
        "Skills: {}",
        contract["resources"]["skills"]
            .as_array()
            .map_or(0, Vec::len)
    );
    println!("Install:");
    println!(
        "  {}",
        contract["install"]["source"]
            .as_str()
            .unwrap_or("deixic-code skill install")
    );
    if let Some(issues) = contract["issues"]
        .as_array()
        .filter(|issues| !issues.is_empty())
    {
        println!("\nIssues:");
        for issue in issues {
            println!(
                "- {}: {}",
                issue["code"].as_str().unwrap_or("package_validation"),
                issue["message"].as_str().unwrap_or("validation failed")
            );
        }
    } else {
        println!("\nResult: publish/install contract passed.");
    }
}

fn quote_install_source(value: &str) -> String {
    if value.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '_' | '@' | '%' | '+' | '=' | ':' | ',' | '.' | '/' | '\\' | '-'
            )
    }) {
        value.to_owned()
    } else if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn workspace_trusted_in_config(value: &toml::Value, cwd: &Path, profile: Option<&str>) -> bool {
    fn trust_level<'a>(projects: Option<&'a toml::Value>, project_key: &str) -> Option<&'a str> {
        projects
            .and_then(|projects| projects.get(project_key))
            .and_then(|project| project.get("trust_level"))
            .and_then(toml::Value::as_str)
    }

    let canonical = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let project_key = canonical.to_string_lossy();
    profile
        .and_then(|profile| {
            value
                .get("profiles")
                .and_then(|profiles| profiles.get(profile))
        })
        .and_then(|profile| trust_level(profile.get("projects"), project_key.as_ref()))
        .or_else(|| trust_level(value.get("projects"), project_key.as_ref()))
        == Some("trusted")
}

fn split_override_key(key: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaping = false;
    for character in key.chars() {
        if quote == Some('"') && escaping {
            current.push(character);
            escaping = false;
        } else if quote == Some('"') && character == '\\' {
            escaping = true;
        } else if quote.is_some_and(|active| active == character) {
            quote = None;
        } else if quote.is_none() && matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if quote.is_none() && character == '.' {
            if !current.trim().is_empty() {
                parts.push(current.trim().to_owned());
            }
            current.clear();
        } else {
            current.push(character);
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_owned());
    }
    parts
}

fn cli_workspace_trust_override_from(
    overrides: &str,
    cwd: &Path,
    profile: Option<&str>,
) -> Option<bool> {
    let canonical = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let project_key = canonical.to_string_lossy();
    overrides
        .split('\u{1f}')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('=')?;
            let parts = split_override_key(key);
            let top_level = parts.as_slice() == ["projects", project_key.as_ref(), "trust_level"];
            let profile_level = profile.is_some_and(|profile| {
                parts.as_slice()
                    == [
                        "profiles",
                        profile,
                        "projects",
                        project_key.as_ref(),
                        "trust_level",
                    ]
            });
            if !top_level && !profile_level {
                return None;
            }
            match value.trim().trim_matches(['\'', '"']) {
                "trusted" => Some(true),
                "untrusted" => Some(false),
                _ => None,
            }
        })
        .next_back()
}

fn cli_workspace_trust_override(cwd: &Path, profile: Option<&str>) -> Option<bool> {
    env::var("MAESTRO_CLI_CONFIG_OVERRIDES")
        .ok()
        .and_then(|overrides| cli_workspace_trust_override_from(&overrides, cwd, profile))
}

fn workspace_trusted(cwd: &Path) -> bool {
    let value = crate::path_utils::maestro_home_dir()
        .and_then(|home| fs::read_to_string(home.join("config.toml")).ok())
        .and_then(|content| content.parse::<toml::Value>().ok())
        .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()));
    let profile = env::var("MAESTRO_PROFILE").ok().or_else(|| {
        value
            .get("profile")
            .and_then(toml::Value::as_str)
            .map(str::to_owned)
    });
    cli_workspace_trust_override(cwd, profile.as_deref())
        .unwrap_or_else(|| workspace_trusted_in_config(&value, cwd, profile.as_deref()))
}

fn ensure_workspace_trusted(cwd: &Path, scope: &str) -> Result<()> {
    if scope != "user" && !workspace_trusted(cwd) {
        bail!(
            "deixic-code skill install --scope {scope} requires a trusted workspace because {scope} package config is ignored until trust is granted. Use --scope user or trust this workspace in global config."
        );
    }
    Ok(())
}

fn configured_package_specs(
    config_path: &Path,
    profile: Option<&str>,
) -> Vec<ConfiguredPackageSpec> {
    let Ok(content) = fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let Ok(value) = content.parse::<toml::Value>() else {
        return Vec::new();
    };
    let mut configured = value
        .get("packages")
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if let Some(profile) = profile {
        configured.extend(
            value
                .get("profiles")
                .and_then(|profiles| profiles.get(profile))
                .and_then(|profile| profile.get("packages"))
                .and_then(toml::Value::as_array)
                .into_iter()
                .flatten(),
        );
    }
    configured
        .into_iter()
        .filter_map(|value| {
            if let Some(source) = value.as_str() {
                return Some(ConfiguredPackageSpec {
                    source: source.to_owned(),
                    skills: None,
                });
            }
            let table = value.as_table()?;
            let source = table.get("source")?.as_str()?.to_owned();
            let skills = table
                .get("skills")
                .and_then(toml::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(toml::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                });
            Some(ConfiguredPackageSpec { source, skills })
        })
        .collect()
}

fn matches_resource_filter(name: &str, patterns: &[String]) -> bool {
    let (exclusions, inclusions): (Vec<_>, Vec<_>) = patterns
        .iter()
        .partition(|pattern| pattern.starts_with('!'));
    let included = inclusions.is_empty()
        || inclusions
            .iter()
            .any(|pattern| glob::Pattern::new(pattern).is_ok_and(|pattern| pattern.matches(name)));
    included
        && !exclusions.iter().any(|pattern| {
            glob::Pattern::new(pattern.trim_start_matches('!'))
                .is_ok_and(|pattern| pattern.matches(name))
        })
}

fn package_skill_roots(spec: &ConfiguredPackageSpec, cwd: &Path) -> Vec<PathBuf> {
    let Ok(source) = parse_source(&spec.source, cwd) else {
        return Vec::new();
    };
    let Ok(root) = resolve_source(&source) else {
        return Vec::new();
    };
    let validation_source = format!("local:{}", root.display());
    let Ok(validation) = contract(&validation_source, false) else {
        return Vec::new();
    };
    if validation["issues"]
        .as_array()
        .is_none_or(|issues| !issues.is_empty())
    {
        return Vec::new();
    }
    let Ok(content) = fs::read_to_string(root.join("package.json")) else {
        return Vec::new();
    };
    let Ok(package) = serde_json::from_str::<PackageJson>(&content) else {
        return Vec::new();
    };
    let roots = package
        .maestro
        .into_iter()
        .flat_map(|manifest| manifest.skills)
        .map(|path| root.join(path))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    let Some(filters) = spec.skills.as_ref().filter(|filters| !filters.is_empty()) else {
        return roots;
    };
    roots
        .into_iter()
        .flat_map(|root| {
            fs::read_dir(root)
                .ok()
                .into_iter()
                .flat_map(|entries| entries.flatten())
                .map(|entry| entry.path())
        })
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches_resource_filter(name, filters))
        })
        .collect()
}

fn default_profile(config_path: &Path) -> Option<String> {
    fs::read_to_string(config_path)
        .ok()
        .and_then(|content| content.parse::<toml::Value>().ok())
        .and_then(|value| {
            value
                .get("profile")
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        })
}

pub(crate) fn configured_skill_search_paths() -> Vec<(PathBuf, bool)> {
    let cwd = env::current_dir().unwrap_or_default();
    let Some(home) = crate::path_utils::maestro_home_dir() else {
        return Vec::new();
    };
    let global_config = home.join("config.toml");
    let active_profile = env::var("MAESTRO_PROFILE")
        .ok()
        .or_else(|| default_profile(&global_config));
    let mut paths = configured_package_specs(&global_config, active_profile.as_deref())
        .into_iter()
        .flat_map(|spec| package_skill_roots(&spec, &home))
        .map(|path| (path, true))
        .collect::<Vec<_>>();
    if workspace_trusted(&cwd) {
        for config in [
            cwd.join(".maestro/config.toml"),
            cwd.join(".maestro/config.local.toml"),
        ] {
            let config_dir = config.parent().unwrap_or(&cwd);
            paths.extend(
                configured_package_specs(&config, active_profile.as_deref())
                    .into_iter()
                    .flat_map(|spec| package_skill_roots(&spec, config_dir))
                    .map(|path| (path, false)),
            );
        }
    }
    paths
}

fn store_package(source_spec: &str, scope: &str) -> Result<(PathBuf, String)> {
    let cwd = env::current_dir()?;
    ensure_workspace_trusted(&cwd, scope)?;
    let home = crate::path_utils::maestro_home_dir().context("Maestro home is unavailable")?;
    let path = match scope {
        "user" => home.join("config.toml"),
        "project" => cwd.join(".maestro/config.toml"),
        _ => cwd.join(".maestro/config.local.toml"),
    };
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|content| content.parse::<toml::Value>().ok())
        .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()));
    let table = value
        .as_table_mut()
        .context("Maestro config root must be a table")?;
    let packages = table
        .entry("packages")
        .or_insert_with(|| toml::Value::Array(Vec::new()))
        .as_array_mut()
        .context("Maestro config packages must be an array")?;
    let source = parse_source(source_spec, &cwd)?;
    let stored = match source {
        PackageSource::Local(path) if scope == "user" => path.display().to_string(),
        PackageSource::Local(package_path) => {
            let config_dir = path.parent().unwrap_or(&cwd);
            let relative = pathdiff::diff_paths(&package_path, config_dir)
                .unwrap_or_else(|| package_path.clone());
            let rendered = relative.display().to_string();
            if rendered.starts_with('.') || relative.is_absolute() {
                rendered
            } else {
                format!("./{rendered}")
            }
        }
        source => format_source(&source),
    };
    if packages.iter().any(|value| value.as_str() == Some(&stored)) {
        bail!("Package \"{stored}\" already exists in {}.", path.display());
    }
    packages.push(toml::Value::String(stored.clone()));
    crate::skill_cli::write_atomic(&path, &toml::to_string_pretty(&value)?)?;
    Ok((path, stored))
}

pub fn publish_check(source: Option<&str>, json: bool, describe: bool) -> Result<i32> {
    let source = source.context("deixic-code skill publish-check requires a package source")?;
    let contract = contract(source, describe)?;
    let failed = contract["issues"]
        .as_array()
        .is_some_and(|issues| !issues.is_empty());
    if json {
        println!("{}", serde_json::to_string_pretty(&contract)?);
    } else {
        print_contract(&contract);
    }
    Ok(i32::from(failed))
}

pub fn install(source: Option<&str>, json: bool, scope: &str) -> Result<i32> {
    let source = source.context("deixic-code skill install requires a package source")?;
    ensure_workspace_trusted(&env::current_dir()?, scope)?;
    let contract = contract(source, false)?;
    if contract["issues"]
        .as_array()
        .is_some_and(|issues| !issues.is_empty())
    {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "installed": false,
                    "contract": contract,
                }))?
            );
        } else {
            print_contract(&contract);
            eprintln!("Skill package install blocked by contract issues.");
        }
        return Ok(1);
    }
    let (path, stored) = store_package(source, scope)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "installed": true,
                "config": { "path": path, "scope": scope, "spec": stored },
                "contract": contract,
            }))?
        );
    } else {
        println!(
            "Installed skill package {}",
            contract["package"]["name"].as_str().unwrap_or(source)
        );
        println!("scope: {scope}");
        println!("config: {}", path.display());
        println!("Run `deixic-code skill list` to see loaded skills.");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_git_and_npm_sources() {
        let cwd = Path::new("/tmp/workspace");
        assert!(matches!(
            parse_source("./package", cwd).expect("local source"),
            PackageSource::Local(_)
        ));
        assert!(matches!(
            parse_source("npm:@scope/skill@1.2.3", cwd).expect("npm source"),
            PackageSource::Npm { .. }
        ));
        assert!(matches!(
            parse_source("git:github.com/example/skill@main", cwd).expect("git source"),
            PackageSource::Git { .. }
        ));
    }

    #[test]
    fn local_package_contract_runs_native_eval() {
        let temp = tempfile::tempdir().expect("temporary package");
        let skill = temp.path().join("skills/example");
        fs::create_dir_all(&skill).expect("skill directory");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: example\ndescription: Use when testing package contracts\n---\n\n# Example\n",
        )
        .expect("skill manifest");
        fs::write(
            temp.path().join("package.json"),
            r#"{"name":"native-skills","version":"1.0.0","keywords":["maestro-package","maestro-skill-package"],"maestro":{"skills":["skills"]}}"#,
        )
        .expect("package manifest");
        let contract =
            contract(&format!("local:{}", temp.path().display()), false).expect("package contract");
        assert_eq!(contract["issues"], serde_json::json!([]));
        assert_eq!(contract["evalReport"]["summary"]["failed"], 0);
        assert_eq!(contract["install"]["local"], contract["install"]["source"]);
        assert!(contract["install"].get("npm").is_none());
    }

    #[test]
    fn config_package_specs_include_only_the_active_profile() {
        let temp = tempfile::tempdir().expect("temporary config directory");
        let path = temp.path().join("config.toml");
        fs::write(
            &path,
            "packages = [\"local:./base\"]\n[profiles.review]\npackages = [{ source = \"npm:@scope/review\" }]\n[profiles.release]\npackages = [\"npm:@scope/release\"]\n",
        )
        .expect("config");
        assert_eq!(
            configured_package_specs(&path, Some("review")),
            [
                ConfiguredPackageSpec {
                    source: "local:./base".to_owned(),
                    skills: None,
                },
                ConfiguredPackageSpec {
                    source: "npm:@scope/review".to_owned(),
                    skills: None,
                },
            ]
        );
    }

    #[test]
    fn reads_default_profile_from_global_config() {
        let temp = tempfile::tempdir().expect("temporary config directory");
        let path = temp.path().join("config.toml");
        fs::write(&path, "profile = \"work\"\n[profiles.work]\n").expect("config");
        assert_eq!(default_profile(&path).as_deref(), Some("work"));
    }

    #[test]
    fn git_commit_refs_fall_back_to_checkout() {
        let temp = tempfile::tempdir().expect("temporary git source");
        let source = temp.path().join("source");
        let clone = temp.path().join("clone");
        fs::create_dir(&source).expect("source directory");
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .arg(&source)
                .status()
                .expect("git init")
                .success()
        );
        fs::write(source.join("package.json"), "{}\n").expect("package file");
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(["add", "package.json"])
                .status()
                .expect("git add")
                .success()
        );
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args([
                    "-c",
                    "user.name=Maestro Test",
                    "-c",
                    "user.email=maestro@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "fixture",
                ])
                .status()
                .expect("git commit")
                .success()
        );
        let revision = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("git revision");
        let revision = String::from_utf8(revision.stdout)
            .expect("utf8 revision")
            .trim()
            .to_owned();

        clone_git_source(source.to_string_lossy().as_ref(), Some(&revision), &clone)
            .expect("clone pinned revision");

        let cloned_revision = Command::new("git")
            .arg("-C")
            .arg(&clone)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("cloned revision");
        assert_eq!(
            String::from_utf8(cloned_revision.stdout)
                .expect("utf8 cloned revision")
                .trim(),
            revision
        );
    }

    #[test]
    fn profile_scoped_workspace_trust_is_honored() {
        let temp = tempfile::tempdir().expect("temporary workspace");
        let workspace = dunce::canonicalize(temp.path()).expect("canonical workspace");
        let config = format!(
            "[profiles.work.projects.\"{}\"]\ntrust_level = \"trusted\"\n",
            workspace.display()
        )
        .parse::<toml::Value>()
        .expect("trust config");

        assert!(workspace_trusted_in_config(
            &config,
            &workspace,
            Some("work")
        ));
        assert!(!workspace_trusted_in_config(
            &config,
            &workspace,
            Some("other")
        ));
    }

    #[test]
    fn cli_workspace_trust_override_honors_quoted_project_keys_and_profiles() {
        let temp = tempfile::tempdir().expect("temporary workspace");
        let workspace = dunce::canonicalize(temp.path()).expect("canonical workspace");
        let top_level = format!("projects.\"{}\".trust_level=trusted", workspace.display());
        assert_eq!(
            cli_workspace_trust_override_from(&top_level, &workspace, None),
            Some(true)
        );
        let profile = format!(
            "profiles.work.projects.\"{}\".trust_level='untrusted'\u{1f}profiles.work.projects.\"{}\".trust_level=trusted",
            workspace.display(),
            workspace.display()
        );
        assert_eq!(
            cli_workspace_trust_override_from(&profile, &workspace, Some("work")),
            Some(true)
        );
        assert_eq!(
            cli_workspace_trust_override_from(&profile, &workspace, Some("other")),
            None
        );
    }

    #[test]
    fn configured_package_skill_filters_limit_loaded_roots() {
        let temp = tempfile::tempdir().expect("temporary package");
        for name in ["safe-skill", "safe-debug", "unsafe-skill"] {
            let skill = temp.path().join("skills").join(name);
            fs::create_dir_all(&skill).expect("skill directory");
            fs::write(
                skill.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: Package fixture\n---\n\n# {name}\n"),
            )
            .expect("skill file");
        }
        fs::write(
            temp.path().join("package.json"),
            r#"{"keywords":["maestro-package","maestro-skill-package"],"maestro":{"skills":["skills"]}}"#,
        )
        .expect("package manifest");
        let spec = ConfiguredPackageSpec {
            source: format!("local:{}", temp.path().display()),
            skills: Some(vec!["safe-*".to_owned(), "!safe-debug".to_owned()]),
        };

        assert_eq!(
            package_skill_roots(&spec, temp.path()),
            [temp.path().join("skills/safe-skill")]
        );
    }

    #[test]
    fn configured_packages_must_pass_the_publish_contract() {
        let temp = tempfile::tempdir().expect("temporary package");
        let skill = temp.path().join("skills/example");
        fs::create_dir_all(&skill).expect("skill directory");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: example\ndescription: Package fixture\n---\n\n# Example\n",
        )
        .expect("skill file");
        fs::write(
            temp.path().join("package.json"),
            r#"{"maestro":{"skills":["skills"]}}"#,
        )
        .expect("package manifest");
        let spec = ConfiguredPackageSpec {
            source: format!("local:{}", temp.path().display()),
            skills: None,
        };

        assert!(package_skill_roots(&spec, temp.path()).is_empty());
    }
}
