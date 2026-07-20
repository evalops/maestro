//! Native `maestro skill` command surface.

use std::collections::BTreeMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::skills::{LoadedSkill, SkillLoadError, SkillLoader, SkillSource};

const BODY_MAX_LINES: usize = 500;
const BODY_MAX_CHARS: usize = 20_000;

#[derive(Debug, Default)]
struct SkillArgs {
    command: Option<String>,
    positionals: Vec<String>,
    json: bool,
    directory: Option<PathBuf>,
    description: Option<String>,
    force: bool,
    describe_toolbox: bool,
    scope: Option<String>,
    profile: Option<String>,
    help: bool,
}

#[derive(Debug, Clone, Serialize)]
struct LintIssue {
    code: String,
    severity: &'static str,
    message: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct LintResult {
    path: String,
    issues: Vec<LintIssue>,
}

#[derive(Debug, Clone, Serialize)]
struct SkillLoadIssue {
    code: &'static str,
    message: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalAssertion {
    code: &'static str,
    status: &'static str,
    message: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalResult {
    id: String,
    path: String,
    expected_outcome: &'static str,
    observed_outcome: &'static str,
    matched_expectation: bool,
    assertions: Vec<EvalAssertion>,
    issues: Vec<LintIssue>,
}

fn parse_args(args: &[String]) -> Result<SkillArgs> {
    let mut parsed = SkillArgs::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--json" => parsed.json = true,
            "--force" => parsed.force = true,
            "--describe-toolbox" => parsed.describe_toolbox = true,
            "--help" | "-h" => parsed.help = true,
            "--dir" | "--description" | "--scope" | "--profile" => {
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.starts_with('-'))
                    .with_context(|| format!("{arg} requires a value"))?;
                match arg.as_str() {
                    "--dir" => parsed.directory = Some(PathBuf::from(value)),
                    "--description" => parsed.description = Some(value.clone()),
                    "--scope" => {
                        if !matches!(value.as_str(), "local" | "project" | "user") {
                            bail!("--scope must be local, project, or user");
                        }
                        parsed.scope = Some(value.clone());
                    }
                    "--profile" => parsed.profile = Some(value.clone()),
                    _ => unreachable!(),
                }
                index += 1;
            }
            value if value.starts_with('-') => bail!("Unknown maestro skill option: {value}"),
            value if parsed.command.is_none() => parsed.command = Some(value.to_owned()),
            value => parsed.positionals.push(value.to_owned()),
        }
        index += 1;
    }
    Ok(parsed)
}

fn print_help() {
    println!(
        "maestro skill <command> [options]\n\nCommands:\n  list                         List available system, user, and project skills\n  inspect <name>               Print one skill package manifest\n  install <source>             Validate and install an OSS skill package\n  publish-check <source>       Validate an OSS skill package before publishing\n  lint [path...]               Validate skill packages\n  eval [path...]               Score skill packages against Agent Core constraints\n  new <name>                   Scaffold a skill package\n\nOptions:\n  --json                       Emit machine-readable JSON\n  --scope <local|project|user> Install scope for 'install' (default: local)\n  --dir <path>                 Base directory for 'new' (default: .maestro/skills)\n  --description <text>         Description for 'new'\n  --force                      Allow 'new' to overwrite an existing directory\n  --describe-toolbox           Eval/publish-check run describe; lint ignores it\n  --help, -h                   Show this help"
    );
}

fn skill_load_issue(error: &SkillLoadError) -> SkillLoadIssue {
    let (code, path) = match error {
        SkillLoadError::ReadError { path, .. } => ("READ_ERROR", path),
        SkillLoadError::YamlParseError { path, .. } => ("INVALID_YAML", path),
        SkillLoadError::MissingFrontmatter { path } => ("MISSING_FRONTMATTER", path),
        SkillLoadError::InvalidSkill { path, message }
            if message.to_ascii_lowercase().contains("description") =>
        {
            ("INVALID_DESCRIPTION", path)
        }
        SkillLoadError::InvalidSkill { path, message }
            if message.to_ascii_lowercase().contains("compatibility") =>
        {
            ("INVALID_COMPATIBILITY", path)
        }
        SkillLoadError::InvalidSkill { path, message }
            if message.to_ascii_lowercase().contains("tool") =>
        {
            ("INVALID_TOOL_LIST", path)
        }
        SkillLoadError::InvalidSkill { path, .. } => ("INVALID_DESCRIPTION", path),
        SkillLoadError::InvalidName { path, .. } => ("INVALID_NAME", path),
        SkillLoadError::NameMismatch { path, .. } => ("NAME_MISMATCH", path),
        SkillLoadError::UnexpectedFields { path, .. } => ("UNEXPECTED_FIELDS", path),
    };
    SkillLoadIssue {
        code,
        message: error.to_string(),
        path: path.display().to_string(),
    }
}

fn loaded_skills() -> (Vec<LoadedSkill>, Vec<SkillLoadIssue>) {
    let mut by_name = BTreeMap::new();
    let mut errors = Vec::new();
    for result in SkillLoader::new().load_all() {
        match result {
            Ok(skill) => {
                by_name.insert(skill.definition.name.to_ascii_lowercase(), skill);
            }
            Err(error) => errors.push(skill_load_issue(&error)),
        }
    }
    (by_name.into_values().collect(), errors)
}

fn resource_directories_json(skill: &LoadedSkill, include_mcp: bool) -> serde_json::Value {
    let mut directories = serde_json::Map::new();
    for (name, path) in [
        ("scripts", skill.resources.scripts_dir.as_ref()),
        ("reference", skill.resources.reference_dir.as_ref()),
        ("references", skill.resources.references_dir.as_ref()),
        ("assets", skill.resources.assets_dir.as_ref()),
        ("toolbox", skill.resources.toolbox_dir.as_ref()),
    ] {
        if let Some(path) = path {
            directories.insert(name.to_owned(), serde_json::json!(path));
        }
    }
    if include_mcp {
        if let Some(path) = &skill.resources.mcp_json_path {
            directories.insert("mcpJsonPath".to_owned(), serde_json::json!(path));
        }
    }
    serde_json::Value::Object(directories)
}

fn top_level_resource_directories_json(skill: &LoadedSkill) -> serde_json::Value {
    let mut directories = serde_json::Map::new();
    for (name, path) in [
        ("scriptsDir", skill.resources.scripts_dir.as_ref()),
        ("referenceDir", skill.resources.reference_dir.as_ref()),
        ("referencesDir", skill.resources.references_dir.as_ref()),
        ("assetsDir", skill.resources.assets_dir.as_ref()),
        ("toolboxDir", skill.resources.toolbox_dir.as_ref()),
        ("mcpJsonPath", skill.resources.mcp_json_path.as_ref()),
    ] {
        if let Some(path) = path {
            directories.insert(name.to_owned(), serde_json::json!(path));
        }
    }
    serde_json::Value::Object(directories)
}

fn resource_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("sh" | "bash" | "py" | "js" | "ts" | "rb" | "pl") => "script",
        Some("hbs" | "ejs" | "mustache" | "j2" | "jinja" | "tmpl") => "template",
        Some("md" | "txt" | "json" | "yaml" | "yml" | "toml") => "reference",
        _ => "other",
    }
}

fn flat_resources(skill: &LoadedSkill) -> Vec<serde_json::Value> {
    const EXCLUDED: [&str; 8] = [
        "skill.md",
        "scripts",
        "reference",
        "references",
        "assets",
        "toolbox",
        "mcp.json",
        "mcp.json.example",
    ];
    let mut paths = fs::read_dir(&skill.skill_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !EXCLUDED.contains(&name.to_ascii_lowercase().as_str()))
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            serde_json::json!({
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
                "path": path,
                "type": resource_type(&path),
            })
        })
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    encode_hex(&Sha256::digest(bytes.as_ref()))
}

fn hash_file(path: &Path) -> String {
    fs::read(path).map_or_else(|_| "UNHASHABLE".to_owned(), hex_digest)
}

fn hash_directory(hash: &mut Sha256, root: &Path, current: &Path) {
    let mut entries = fs::read_dir(current)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let relative = format!("/{}", relative.to_string_lossy());
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            hash.update(format!("\0dir:{relative}\0"));
            hash_directory(hash, root, &path);
        } else if metadata.is_file() {
            hash.update(format!("\0file:{relative}\0"));
            hash.update(hash_file(&path));
        }
    }
}

fn skill_content_sha(skill: &LoadedSkill, resources: &[serde_json::Value]) -> String {
    let mut hash = Sha256::new();
    hash.update("name:");
    hash.update(&skill.definition.name);
    hash.update("\0body:");
    hash.update(
        skill
            .definition
            .system_prompt_additions
            .as_deref()
            .unwrap_or_default(),
    );
    hash.update("\0resources:");
    for resource in resources {
        let name = resource["name"].as_str().unwrap_or_default();
        let kind = resource["type"].as_str().unwrap_or_default();
        let path = Path::new(resource["path"].as_str().unwrap_or_default());
        hash.update(format!("\0{name}\0{kind}\0"));
        hash.update(hash_file(path));
    }
    hash.update("\0resourceDirs:");
    for (label, path, is_file) in [
        ("assetsDir", skill.resources.assets_dir.as_ref(), false),
        ("mcpJsonPath", skill.resources.mcp_json_path.as_ref(), true),
        (
            "referenceDir",
            skill.resources.reference_dir.as_ref(),
            false,
        ),
        (
            "referencesDir",
            skill.resources.references_dir.as_ref(),
            false,
        ),
        ("scriptsDir", skill.resources.scripts_dir.as_ref(), false),
        ("toolboxDir", skill.resources.toolbox_dir.as_ref(), false),
    ] {
        let Some(path) = path else { continue };
        hash.update(format!("\0{label}\0"));
        if is_file {
            hash.update(hash_file(path));
        } else {
            hash_directory(&mut hash, path, path);
        }
    }
    encode_hex(&hash.finalize())
}

fn toolbox_activation(skill: &LoadedSkill) -> Option<serde_json::Value> {
    let directory = skill.resources.toolbox_dir.as_ref()?;
    let mut entries = fs::read_dir(directory)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            path.is_file()
                && !name.starts_with('.')
                && !name.eq_ignore_ascii_case("README.md")
                && platform_toolbox_entry(path)
                && executable(path)
        })
        .map(|path| {
            serde_json::json!({
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
                "path": path,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Some(serde_json::json!({"directory": directory, "entries": entries}))
}

fn mcp_activation(skill: &LoadedSkill) -> Option<serde_json::Value> {
    let path = skill.resources.mcp_json_path.as_ref()?;
    let mut warnings = Vec::new();
    let parsed = match fs::metadata(path) {
        Ok(metadata) if metadata.len() > 1024 * 1024 => {
            warnings.push(format!(
                "mcp.json is too large to load: {} bytes exceeds 1048576 byte limit.",
                metadata.len()
            ));
            None
        }
        _ => fs::read_to_string(path).ok().and_then(|content| {
            serde_json::from_str::<serde_json::Value>(&content).map_or_else(
                |error| {
                    warnings.push(format!("mcp.json could not be parsed: {error}"));
                    None
                },
                Some,
            )
        }),
    };
    let mut servers = Vec::new();
    if let Some(object) = parsed.as_ref().and_then(serde_json::Value::as_object) {
        let mut names = object.keys().collect::<Vec<_>>();
        names.sort();
        for name in names {
            let Some(server) = object[name].as_object() else {
                warnings.push(format!("MCP server '{name}' must be an object."));
                continue;
            };
            let Some(command) = server
                .get("command")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
            else {
                warnings.push(format!("MCP server '{name}' requires a non-empty command."));
                continue;
            };
            let Some(include_tools) = server
                .get("includeTools")
                .and_then(serde_json::Value::as_array)
                .filter(|values| {
                    !values.is_empty()
                        && values.iter().all(|value| {
                            value.as_str().is_some_and(|value| !value.trim().is_empty())
                        })
                })
            else {
                warnings.push(format!(
                    "MCP server '{name}' does not declare bounded includeTools."
                ));
                continue;
            };
            if server.get("args").is_some_and(|args| {
                !args
                    .as_array()
                    .is_some_and(|args| args.iter().all(serde_json::Value::is_string))
            }) {
                warnings.push(format!("MCP server '{name}' args entries must be strings."));
                continue;
            }
            if server.get("env").is_some_and(|environment| {
                !environment.as_object().is_some_and(|environment| {
                    environment.values().all(serde_json::Value::is_string)
                })
            }) {
                warnings.push(format!("MCP server '{name}' env values must be strings."));
                continue;
            }
            servers.push(serde_json::json!({
                "name": name,
                "command": command,
                "includeTools": include_tools,
            }));
        }
    } else if warnings.is_empty() {
        warnings.push("mcp.json must be an object keyed by server name.".to_owned());
    }
    let mut activation = serde_json::json!({"configPath": path, "servers": servers});
    if !warnings.is_empty() {
        activation["warnings"] = serde_json::json!(warnings);
    }
    Some(activation)
}

fn runtime_activation(skill: &LoadedSkill, resources: &[serde_json::Value]) -> serde_json::Value {
    let metadata = &skill.definition.metadata;
    let mut profile = serde_json::Map::new();
    for (output, key) in [
        ("argumentHint", "argument-hint"),
        ("compatibility", "compatibility"),
        ("isolatedContext", "isolatedContext"),
        ("mode", "mode"),
        ("model", "model"),
    ] {
        if let Some(value) = metadata.get(key) {
            profile.insert(output.to_owned(), value.clone());
        }
    }
    let mut tool_package = serde_json::Map::new();
    if let Some(toolbox) = toolbox_activation(skill) {
        tool_package.insert("toolbox".to_owned(), toolbox);
    }
    if let Some(mcp) = mcp_activation(skill) {
        tool_package.insert("mcp".to_owned(), mcp);
    }
    serde_json::json!({
        "name": skill.definition.name,
        "contentSha": skill_content_sha(skill, resources),
        "source": skill.definition.source,
        "sourcePath": skill.skill_dir,
        "profile": profile,
        "tools": {
            "allowed": skill.definition.provided_tools,
            "builtin": metadata.get("builtin-tools").cloned().unwrap_or_else(|| serde_json::json!([])),
        },
        "resources": {
            "files": resources,
            "directories": resource_directories_json(skill, false),
        },
        "toolPackage": tool_package,
    })
}

fn skill_json(skill: &LoadedSkill, inspect: bool) -> serde_json::Value {
    let metadata = &skill.definition.metadata;
    let mut object = serde_json::Map::new();
    object.insert("name".into(), serde_json::json!(skill.definition.name));
    object.insert(
        "description".into(),
        serde_json::json!(skill.definition.description),
    );
    for key in ["license", "compatibility"] {
        if let Some(value) = metadata.get(key) {
            object.insert(key.to_owned(), value.clone());
        }
    }
    if !skill.definition.provided_tools.is_empty() {
        object.insert(
            "allowed-tools".into(),
            serde_json::json!(skill.definition.provided_tools),
        );
    }
    for key in [
        "builtin-tools",
        "argument-hint",
        "model",
        "mode",
        "isolatedContext",
    ] {
        if let Some(value) = metadata.get(key) {
            object.insert(key.to_owned(), value.clone());
        }
    }
    let reserved = [
        "license",
        "compatibility",
        "builtin-tools",
        "argument-hint",
        "when-to-use",
        "disable-model-invocation",
        "model",
        "mode",
        "isolatedContext",
        "effort",
        "tags",
    ];
    let custom_metadata = metadata
        .iter()
        .filter(|(key, _)| !reserved.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    if !custom_metadata.is_empty() {
        object.insert(
            "metadata".into(),
            serde_json::Value::Object(custom_metadata),
        );
    }
    object.insert(
        "sourceType".into(),
        serde_json::json!(skill.definition.source),
    );
    object.insert("sourcePath".into(), serde_json::json!(skill.skill_dir));
    if inspect {
        let resources = flat_resources(skill);
        object.insert("resources".into(), serde_json::json!(resources));
        object.insert(
            "resourceDirs".into(),
            top_level_resource_directories_json(skill),
        );
        object.insert(
            "runtimeActivation".into(),
            runtime_activation(skill, &resources),
        );
    }
    serde_json::Value::Object(object)
}

fn list_skills(json: bool) -> Result<i32> {
    let (skills, errors) = loaded_skills();
    if json {
        let payload = serde_json::json!({
            "skills": skills.iter().map(|skill| skill_json(skill, false)).collect::<Vec<_>>(),
            "errors": errors,
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if skills.is_empty() {
        println!("No skills found.");
    } else {
        for skill in &skills {
            println!(
                "{} - {} ({:?})",
                skill.definition.name, skill.definition.description, skill.definition.source
            );
        }
        if !errors.is_empty() {
            eprintln!("\n{} skill load warning(s).", errors.len());
        }
    }
    Ok(0)
}

fn inspect_skill(name: Option<&str>, _json: bool) -> Result<i32> {
    let name = name.context("maestro skill inspect requires a skill name")?;
    let (skills, _) = loaded_skills();
    let skill = skills
        .iter()
        .find(|skill| skill.definition.name.eq_ignore_ascii_case(name))
        .with_context(|| format!("Skill '{name}' not found"))?;
    let payload = skill_json(skill, true);
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(0)
}

fn lint_issue(
    code: impl Into<String>,
    severity: &'static str,
    path: &Path,
    message: impl Into<String>,
) -> LintIssue {
    LintIssue {
        code: code.into(),
        severity,
        message: message.into(),
        path: path.display().to_string(),
    }
}

fn find_skill_file(directory: &Path) -> Option<PathBuf> {
    ["SKILL.md", "skill.md"]
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.is_file())
}

fn load_error_issue(error: &SkillLoadError, path: &Path) -> LintIssue {
    let code = match error {
        SkillLoadError::MissingFrontmatter { .. } | SkillLoadError::YamlParseError { .. } => {
            "invalid_skill_md"
        }
        SkillLoadError::InvalidName { reason, .. } if reason.contains("64") => "name_too_long",
        SkillLoadError::InvalidName { .. } => "invalid_name",
        SkillLoadError::NameMismatch { .. } => "name_mismatch",
        SkillLoadError::UnexpectedFields { .. } => "unexpected_field",
        SkillLoadError::InvalidSkill { message, .. } if message.contains("Description") => {
            "missing_description"
        }
        SkillLoadError::InvalidSkill { message, .. }
            if message.contains("must be a string or a list of strings") =>
        {
            "invalid_string_list"
        }
        _ => "invalid_skill_md",
    };
    lint_issue(code, "error", path, error.to_string())
}

fn body_from_skill_markdown(content: &str) -> &str {
    let mut delimiters = content.match_indices("---");
    let Some((first, _)) = delimiters.next() else {
        return content;
    };
    let Some((second, _)) = delimiters.next() else {
        return content;
    };
    if first == 0 {
        content.get(second + 3..).unwrap_or_default().trim_start()
    } else {
        content
    }
}

fn validate_mcp_json(directory: &Path, issues: &mut Vec<LintIssue>) {
    let path = directory.join("mcp.json");
    if !path.is_file() {
        return;
    }
    let value = match fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        Some(value) => value,
        None => {
            issues.push(lint_issue(
                "invalid_mcp_json",
                "error",
                &path,
                "mcp.json must be valid JSON.",
            ));
            return;
        }
    };
    let Some(servers) = value.as_object() else {
        issues.push(lint_issue(
            "invalid_mcp_json",
            "error",
            &path,
            "mcp.json must be an object keyed by server name.",
        ));
        return;
    };
    for (name, value) in servers {
        let server_path = PathBuf::from(format!("{}#{name}", path.display()));
        let Some(server) = value.as_object() else {
            issues.push(lint_issue(
                "invalid_mcp_server",
                "error",
                &server_path,
                "MCP server config must be an object.",
            ));
            continue;
        };
        if server
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|command| command.trim().is_empty())
        {
            issues.push(lint_issue(
                "invalid_mcp_command",
                "error",
                &server_path,
                "MCP server requires a non-empty command.",
            ));
        }
        let tools = server
            .get("includeTools")
            .and_then(serde_json::Value::as_array);
        if tools.is_none_or(Vec::is_empty) {
            issues.push(lint_issue(
                "mcp_tools_unfiltered",
                "error",
                &server_path,
                "MCP server must declare includeTools with at least one tool.",
            ));
        } else if tools.is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool.as_str().is_none_or(|tool| tool.trim().is_empty()))
        }) {
            issues.push(lint_issue(
                "invalid_mcp_include_tools",
                "error",
                &server_path,
                "includeTools entries must be non-empty strings.",
            ));
        }
        if server.get("args").is_some_and(|args| {
            args.as_array()
                .is_none_or(|args| args.iter().any(|arg| !arg.is_string()))
        }) {
            issues.push(lint_issue(
                "invalid_mcp_args",
                "error",
                &server_path,
                "MCP args must be a list of strings.",
            ));
        }
        if server.get("env").is_some_and(|environment| {
            environment
                .as_object()
                .is_none_or(|environment| environment.values().any(|value| !value.is_string()))
        }) {
            issues.push(lint_issue(
                "invalid_mcp_env",
                "error",
                &server_path,
                "MCP env must be an object of string values.",
            ));
        }
    }
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "com" | "exe" | "bat" | "cmd" | "ps1"
                )
            })
    }
}

fn platform_toolbox_entry(path: &Path) -> bool {
    #[cfg(unix)]
    {
        !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "com" | "exe" | "bat" | "cmd" | "ps1"
                )
            })
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "com" | "exe" | "bat" | "cmd" | "ps1"
                )
            })
    }
}

fn validate_toolbox(directory: &Path, describe: bool, issues: &mut Vec<LintIssue>) {
    let toolbox = directory.join("toolbox");
    let Ok(entries) = fs::read_dir(&toolbox) else {
        return;
    };
    let mut has_entries = false;
    let mut runnable_entries = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.eq_ignore_ascii_case("README.md") || !path.is_file() {
            continue;
        }
        has_entries = true;
        if !platform_toolbox_entry(&path) {
            continue;
        }
        if !executable(&path) {
            issues.push(lint_issue(
                "toolbox_not_executable",
                "error",
                &path,
                "Toolbox entries must be executable files.",
            ));
            continue;
        }
        runnable_entries += 1;
        if describe {
            use std::time::Duration;
            use wait_timeout::ChildExt;
            let passed = Command::new(&path)
                .env("MAESTRO_TOOLBOX_ACTION", "describe")
                .spawn()
                .ok()
                .and_then(|mut child| {
                    let status = child.wait_timeout(Duration::from_secs(5)).ok().flatten();
                    if status.is_none() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    status
                })
                .is_some_and(|status| status.success());
            if !passed {
                issues.push(lint_issue(
                    "toolbox_describe_failed",
                    "error",
                    &path,
                    "Toolbox describe failed.",
                ));
            }
        }
    }
    if has_entries && runnable_entries == 0 {
        issues.push(lint_issue(
            "toolbox_no_runnable_entries",
            "error",
            &toolbox,
            "Toolbox has no runnable entries for this platform.",
        ));
    }
}

fn lint_directory(directory: &Path, describe: bool) -> LintResult {
    let directory = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let mut issues = Vec::new();
    let Some(skill_file) = find_skill_file(&directory) else {
        return LintResult {
            path: directory.display().to_string(),
            issues: vec![lint_issue(
                "missing_skill_md",
                "error",
                &directory,
                "Skill package requires SKILL.md.",
            )],
        };
    };
    match SkillLoader::with_paths(Vec::new()).load_skill_file(&skill_file, SkillSource::Project) {
        Ok(skill) => {
            let description = &skill.definition.description;
            if !description
                .to_ascii_lowercase()
                .split_whitespace()
                .any(|word| {
                    matches!(
                        word.trim_matches(|ch: char| !ch.is_alphanumeric()),
                        "use" | "when"
                    )
                })
            {
                issues.push(lint_issue(
                    "description_missing_when",
                    "warning",
                    &skill_file,
                    "Description should include when to use the skill, for example \"Use when ...\".",
                ));
            }
        }
        Err(error) => issues.push(load_error_issue(&error, &skill_file)),
    }
    if let Ok(content) = fs::read_to_string(&skill_file) {
        let body = body_from_skill_markdown(&content);
        let lines = body.lines().count().max(1);
        if lines > BODY_MAX_LINES {
            issues.push(lint_issue(
                "skill_oversize",
                "error",
                &skill_file,
                format!("SKILL.md body has {lines} lines; maximum is {BODY_MAX_LINES}."),
            ));
        }
        if body.len() > BODY_MAX_CHARS {
            issues.push(lint_issue(
                "skill_oversize",
                "error",
                &skill_file,
                format!(
                    "SKILL.md body has {} chars; maximum is {BODY_MAX_CHARS}.",
                    body.len()
                ),
            ));
        }
    }
    if directory.join("reference").exists() && directory.join("references").exists() {
        issues.push(lint_issue(
            "duplicate_reference_dirs",
            "warning",
            &directory,
            "Use either reference/ or references/; reference/ is preferred.",
        ));
    }
    validate_mcp_json(&directory, &mut issues);
    validate_toolbox(&directory, describe, &mut issues);
    LintResult {
        path: directory.display().to_string(),
        issues,
    }
}

fn lint_paths(paths: &[PathBuf], describe: bool) -> Vec<LintResult> {
    let mut results = Vec::new();
    for path in paths {
        let path = if path.is_absolute() {
            path.clone()
        } else {
            env::current_dir().unwrap_or_default().join(path)
        };
        if !path.exists() {
            results.push(LintResult {
                path: path.display().to_string(),
                issues: vec![lint_issue(
                    "missing_path",
                    "error",
                    &path,
                    "Skill path does not exist.",
                )],
            });
        } else if !path.is_dir() {
            results.push(LintResult {
                path: path.display().to_string(),
                issues: vec![lint_issue(
                    "invalid_path",
                    "error",
                    &path,
                    "Skill path must be a directory.",
                )],
            });
        } else if find_skill_file(&path).is_some() {
            results.push(lint_directory(&path, describe));
        } else if let Ok(entries) = fs::read_dir(&path) {
            for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
                results.push(lint_directory(&entry.path(), describe));
            }
        }
    }
    results
}

fn default_skill_paths() -> Vec<PathBuf> {
    let cwd = env::current_dir().unwrap_or_default();
    let mut candidates = vec![cwd.join("skills"), cwd.join(".maestro/skills")];
    if let Some(home) = crate::path_utils::maestro_home_dir() {
        candidates.push(home.join("skills"));
    }
    let existing = candidates
        .iter()
        .filter(|path| path.exists())
        .cloned()
        .collect::<Vec<_>>();
    if existing.is_empty() {
        vec![cwd.join("skills")]
    } else {
        existing
    }
}

fn lint_command(paths: &[String], json: bool) -> Result<i32> {
    let paths = if paths.is_empty() {
        default_skill_paths()
    } else {
        paths.iter().map(PathBuf::from).collect()
    };
    let results = lint_paths(&paths, false);
    let failed = results
        .iter()
        .any(|result| result.issues.iter().any(|issue| issue.severity == "error"));
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "results": results }))?
        );
    } else {
        print_lint_text(&results);
    }
    Ok(i32::from(failed))
}

fn print_lint_text(results: &[LintResult]) {
    let mut errors = 0;
    let mut warnings = 0;
    for result in results {
        if result.issues.is_empty() {
            println!("OK {}", result.path);
            continue;
        }
        println!("{}", result.path);
        for issue in &result.issues {
            errors += usize::from(issue.severity == "error");
            warnings += usize::from(issue.severity == "warning");
            println!(
                "  {} {}: {}",
                issue.severity.to_ascii_uppercase(),
                issue.code,
                issue.message
            );
            if issue.path != result.path {
                println!("    {}", issue.path);
            }
        }
    }
    println!("\n{errors} errors, {warnings} warnings");
}

fn assertions_for(result: &LintResult) -> Vec<EvalAssertion> {
    let has = |codes: &[&str]| {
        result
            .issues
            .iter()
            .any(|issue| codes.contains(&issue.code.as_str()))
    };
    let lint = !result.issues.iter().any(|issue| issue.severity == "error");
    let loadable = !has(&[
        "missing_skill_md",
        "invalid_skill_md",
        "missing_name",
        "invalid_name",
        "name_mismatch",
        "missing_description",
    ]);
    let mcp = !has(&[
        "mcp_tools_unfiltered",
        "invalid_mcp_include_tools",
        "invalid_mcp_json",
        "invalid_mcp_server",
        "invalid_mcp_command",
        "invalid_mcp_args",
        "invalid_mcp_env",
    ]);
    let toolbox = !result
        .issues
        .iter()
        .any(|issue| issue.code.starts_with("toolbox_"));
    let budget = !has(&["skill_oversize"]);
    [
        (
            "lint_passes",
            lint,
            "Package has no blocking lint issues.",
            "Package has blocking lint issues.",
        ),
        (
            "skill_md_loadable",
            loadable,
            "SKILL.md frontmatter is loadable.",
            "SKILL.md frontmatter is not loadable.",
        ),
        (
            "mcp_tools_bounded",
            mcp,
            "Bundled MCP servers are filtered and well-formed.",
            "Bundled MCP servers are missing bounded includeTools or are malformed.",
        ),
        (
            "toolbox_runnable",
            toolbox,
            "Toolbox entries are executable for the target platform.",
            "Toolbox entries are not executable or fail describe checks.",
        ),
        (
            "progressive_disclosure_budget",
            budget,
            "SKILL.md stays within progressive-disclosure budget.",
            "SKILL.md exceeds progressive-disclosure budget.",
        ),
    ]
    .into_iter()
    .map(|(code, passed, ok, failed)| EvalAssertion {
        code,
        status: if passed { "pass" } else { "fail" },
        message: if passed { ok } else { failed },
    })
    .collect()
}

pub(crate) fn eval_report(paths: &[PathBuf], describe: bool) -> serde_json::Value {
    let lint = lint_paths(paths, describe);
    let results = lint
        .into_iter()
        .map(|result| {
            let assertions = assertions_for(&result);
            let observed = if assertions
                .iter()
                .any(|assertion| assertion.status == "fail")
            {
                "fail"
            } else {
                "pass"
            };
            EvalResult {
                id: Path::new(&result.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&result.path)
                    .to_owned(),
                path: result.path,
                expected_outcome: "pass",
                observed_outcome: observed,
                matched_expectation: observed == "pass",
                assertions,
                issues: result.issues,
            }
        })
        .collect::<Vec<_>>();
    let passed = results
        .iter()
        .filter(|result| result.matched_expectation)
        .count();
    let total = results.len();
    serde_json::json!({
        "schemaVersion": "evalops.maestro.skill-package-eval.v1",
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "score": if total == 0 { 1.0 } else { passed as f64 / total as f64 },
        },
        "results": results,
    })
}

fn eval_command(paths: &[String], json: bool, describe: bool) -> Result<i32> {
    let paths = if paths.is_empty() {
        default_skill_paths()
    } else {
        paths.iter().map(PathBuf::from).collect()
    };
    let report = eval_report(&paths, describe);
    let failed = report["summary"]["failed"].as_u64().unwrap_or(0) > 0;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for result in report["results"].as_array().into_iter().flatten() {
            println!(
                "{} {} expected={} observed={}",
                if result["matchedExpectation"].as_bool().unwrap_or(false) {
                    "PASS"
                } else {
                    "FAIL"
                },
                result["id"].as_str().unwrap_or("skill"),
                result["expectedOutcome"].as_str().unwrap_or("pass"),
                result["observedOutcome"].as_str().unwrap_or("fail"),
            );
        }
        println!(
            "\n{} passed, {} failed, score {:.2}",
            report["summary"]["passed"].as_u64().unwrap_or(0),
            report["summary"]["failed"].as_u64().unwrap_or(0),
            report["summary"]["score"].as_f64().unwrap_or(0.0),
        );
    }
    Ok(i32::from(failed))
}

fn yaml_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

pub(crate) fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let parent = path.parent().context("output path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill"),
        std::process::id()
    ));
    fs::write(&temporary, content)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn scaffold(name: Option<&str>, args: &SkillArgs) -> Result<i32> {
    let name = name.context("maestro skill new requires a skill name")?;
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        });
    if !valid {
        bail!("Skill name must use lowercase letters, numbers, and single hyphens.");
    }
    let cwd = env::current_dir()?;
    let base = args
        .directory
        .clone()
        .unwrap_or_else(|| PathBuf::from(".maestro/skills"));
    let base = if base.is_absolute() {
        base
    } else {
        cwd.join(base)
    };
    let directory = base.join(name);
    if directory.exists() && !args.force {
        bail!("Skill already exists at {}", directory.display());
    }
    let description = args.description.clone().unwrap_or_else(|| {
        format!(
            "{}. Use when a task needs this packaged workflow.",
            name.replace('-', " ")
        )
    });
    fs::create_dir_all(directory.join("reference"))?;
    fs::create_dir_all(directory.join("scripts"))?;
    fs::create_dir_all(directory.join("toolbox"))?;
    let files = [
        (
            directory.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: {}\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\n---\n\n# {name}\n\n## Workflow\n\n1. State the task-specific outcome.\n2. Load only the reference files needed for the request.\n3. Use bundled scripts or toolbox executables when they are more reliable than retyping long commands.\n\n## References\n\n- Read `reference/overview.md` when the user asks for implementation detail.\n",
                yaml_quote(&description)
            ),
        ),
        (
            directory.join("reference/overview.md"),
            format!("# {name} Reference\n\nAdd deeper examples, protocol notes, and troubleshooting details here. Keep this out of SKILL.md until needed.\n"),
        ),
        (
            directory.join("scripts/README.md"),
            "# Scripts\n\nPut deterministic helper scripts here. Agents should run these instead of retyping long workflows.\n".to_owned(),
        ),
        (
            directory.join("toolbox/README.md"),
            "# Toolbox\n\nPut executable Toolbox protocol commands here. Each executable should support `MAESTRO_TOOLBOX_ACTION=describe`.\n".to_owned(),
        ),
        (
            directory.join("mcp.json.example"),
            "{\n  \"example-server\": {\n    \"command\": \"npx\",\n    \"args\": [\"-y\", \"example-mcp-server\"],\n    \"includeTools\": [\"example_tool\"]\n  }\n}\n".to_owned(),
        ),
    ];
    for (path, content) in &files {
        write_atomic(path, content)?;
    }
    let file_names = files
        .iter()
        .map(|(path, _)| path.display().to_string())
        .collect::<Vec<_>>();
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "name": name,
                "directory": directory,
                "files": file_names,
            }))?
        );
    } else {
        println!("Created skill {name}");
        println!("{}", directory.display());
        for file in file_names {
            println!("  {file}");
        }
    }
    Ok(0)
}

pub async fn run_skill(args: &[String]) -> Result<i32> {
    let parsed = parse_args(args)?;
    if let Some(profile) = &parsed.profile {
        env::set_var("MAESTRO_PROFILE", profile);
    }
    let command = parsed.command.as_deref();
    if parsed.help || command.is_none() || command == Some("help") {
        print_help();
        return Ok(0);
    }
    match command.expect("checked command") {
        "list" => list_skills(parsed.json),
        "inspect" => inspect_skill(parsed.positionals.first().map(String::as_str), parsed.json),
        "lint" => lint_command(&parsed.positionals, parsed.json),
        "eval" => eval_command(&parsed.positionals, parsed.json, parsed.describe_toolbox),
        "new" => scaffold(parsed.positionals.first().map(String::as_str), &parsed),
        "install" => crate::skill_package_cli::install(
            parsed.positionals.first().map(String::as_str),
            parsed.json,
            parsed.scope.as_deref().unwrap_or("local"),
        ),
        "publish-check" => crate::skill_package_cli::publish_check(
            parsed.positionals.first().map(String::as_str),
            parsed.json,
            parsed.describe_toolbox,
        ),
        other => bail!("Unknown maestro skill command: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillSource;

    #[test]
    fn parses_skill_options() {
        let parsed = parse_args(&[
            "new".into(),
            "my-skill".into(),
            "--description".into(),
            "Use when testing".into(),
            "--json".into(),
        ])
        .expect("parse skill arguments");
        assert_eq!(parsed.command.as_deref(), Some("new"));
        assert_eq!(parsed.positionals, ["my-skill"]);
        assert!(parsed.json);
    }

    #[test]
    fn scaffolds_and_lints_skill() {
        let temp = tempfile::tempdir().expect("temporary skill directory");
        let args = SkillArgs {
            directory: Some(temp.path().to_path_buf()),
            description: Some("Use when verifying native skill commands".into()),
            ..SkillArgs::default()
        };
        assert_eq!(scaffold(Some("native-skill"), &args).expect("scaffold"), 0);
        let results = lint_paths(&[temp.path().join("native-skill")], false);
        assert_eq!(results.len(), 1);
        assert!(
            !results[0]
                .issues
                .iter()
                .any(|issue| issue.severity == "error"),
            "{:?}",
            results[0].issues
        );
    }

    #[test]
    #[cfg(unix)]
    fn unix_toolbox_ignores_windows_companions() {
        let temp = tempfile::tempdir().expect("temporary toolbox");
        let skill = temp.path().join("platform-skill");
        fs::create_dir_all(skill.join("toolbox")).expect("toolbox");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: platform-skill\ndescription: Use when testing platform tools\n---\nBody.\n",
        )
        .expect("skill");
        fs::write(skill.join("toolbox/run.cmd"), "@echo off\n").expect("Windows companion");
        fs::write(skill.join("toolbox/run"), "#!/bin/sh\nexit 0\n").expect("Unix tool");
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(skill.join("toolbox/run"))
            .expect("metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(skill.join("toolbox/run"), permissions).expect("permissions");
        let result = lint_directory(&skill, false);
        assert!(
            !result
                .issues
                .iter()
                .any(|issue| issue.code.starts_with("toolbox_")),
            "{:?}",
            result.issues
        );
    }

    #[test]
    fn inspect_preserves_runtime_activation_contract() {
        let temp = tempfile::tempdir().expect("temporary skill");
        let skill_dir = temp.path().join("contract-skill");
        fs::create_dir_all(skill_dir.join("toolbox")).expect("toolbox directory");
        fs::create_dir_all(skill_dir.join("reference")).expect("reference directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: contract-skill\ndescription: Contract fixture\ncompatibility: Requires tests\nallowed-tools: [read]\nbuiltin-tools: [search]\nargument-hint: <incident>\nmode: incident\nisolatedContext: true\n---\n\n# Contract\n",
        )
        .expect("skill manifest");
        fs::write(skill_dir.join("notes.md"), "notes\n").expect("flat resource");
        fs::write(
            skill_dir.join("mcp.json"),
            r#"{"github":{"command":"npx","includeTools":["issues_get"]}}"#,
        )
        .expect("mcp config");
        let toolbox = skill_dir.join("toolbox/run");
        fs::write(&toolbox, "#!/bin/sh\nexit 0\n").expect("toolbox entry");
        fs::write(skill_dir.join("toolbox/not-executable"), "fixture\n")
            .expect("non-executable toolbox entry");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&toolbox).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&toolbox, permissions).expect("permissions");
        }
        let loaded = SkillLoader::new()
            .load_skill_file(&skill_dir.join("SKILL.md"), SkillSource::Project)
            .expect("loaded skill");

        let payload = skill_json(&loaded, true);
        let activation = &payload["runtimeActivation"];
        assert_eq!(activation["name"], "contract-skill");
        assert_eq!(activation["contentSha"].as_str().map(str::len), Some(64));
        assert_eq!(activation["profile"]["argumentHint"], "<incident>");
        assert_eq!(activation["profile"]["isolatedContext"], true);
        assert_eq!(activation["tools"]["allowed"], serde_json::json!(["read"]));
        assert_eq!(
            activation["tools"]["builtin"],
            serde_json::json!(["search"])
        );
        assert_eq!(activation["resources"]["files"][0]["name"], "notes.md");
        assert_eq!(
            activation["toolPackage"]["toolbox"]["entries"][0]["name"],
            "run"
        );
        assert_eq!(
            activation["toolPackage"]["toolbox"]["entries"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            activation["toolPackage"]["mcp"]["servers"][0]["includeTools"],
            serde_json::json!(["issues_get"])
        );
        assert!(activation.get("prompt").is_none());
        assert_eq!(payload["allowed-tools"], serde_json::json!(["read"]));
        assert_eq!(payload["builtin-tools"], serde_json::json!(["search"]));
        assert!(payload["resourceDirs"]["mcpJsonPath"].is_string());
    }

    #[test]
    fn load_errors_preserve_machine_readable_contract() {
        let issue = skill_load_issue(&SkillLoadError::MissingFrontmatter {
            path: PathBuf::from("/tmp/example/SKILL.md"),
        });
        let json = serde_json::to_value(issue).expect("serialize load issue");
        assert_eq!(json["code"], "MISSING_FRONTMATTER");
        assert_eq!(json["path"], "/tmp/example/SKILL.md");
        assert!(json["message"]
            .as_str()
            .is_some_and(|message| message.contains("Missing frontmatter")));
    }

    #[test]
    fn mcp_validation_rejects_whitespace_only_bounds() {
        let temp = tempfile::tempdir().expect("temporary skill");
        fs::write(
            temp.path().join("mcp.json"),
            r#"{"example":{"command":"   ","includeTools":["  "]}}"#,
        )
        .expect("mcp config");
        let mut issues = Vec::new();
        validate_mcp_json(temp.path(), &mut issues);
        let codes = issues
            .iter()
            .map(|issue| issue.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"invalid_mcp_command"));
        assert!(codes.contains(&"invalid_mcp_include_tools"));
    }
}
