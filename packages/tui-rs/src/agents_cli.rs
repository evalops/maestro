//! Native implementation of `maestro agents`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_yaml::{Mapping, Value};
use similar::TextDiff;

const MAX_RULE_BYTES: usize = 12_000;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
    "tmp",
];
const TEMPLATE: &str = r"# Repository Guidelines

Use this as the contributor quickstart for **{{PROJECT_NAME}}**.

## Project Structure
- Map the main source, test, docs, scripts, and config paths.
- Call out generated, vendored, or build-output directories agents should not edit.

## Commands
- Install: `npm install` (or the repo's package manager).
- Develop: `npm run dev`; Build: `npm run build`.
- Quality: `npm run lint`, `npm run format`, and `npm test`.

## Style
- Follow the checked-in formatter and linter; keep naming consistent with nearby code.
- Prefer small, focused changes and comments only for non-obvious behavior.

## Testing
- Add or update tests beside changed behavior.
- Cover success, error, and boundary cases with deterministic fixtures.

## Pull Requests
- Use imperative commit subjects and keep PRs scoped.
- Include behavior changes, linked issues, validation steps, and screenshots for UI changes.

## Security
- Do not commit secrets; document new environment variables and migrations.
";
const GENERATION_PROMPT: &str = r#"Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section. Follow the outline below, but adapt as needed—add sections if relevant, and omit those that do not apply to this project.

Document Requirements:
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise; about 20 lines and 150-250 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections:
- Project Structure & Module Organization: Outline where source code, tests, docs, configs, and assets live.
- Build, Test, and Development Commands: List key commands for installing, building, testing, and running locally with short explanations.
- Coding Style & Naming Conventions: Indentation rules, style preferences, naming patterns, formatting/linting tools.
- Testing Guidelines: Frameworks, coverage expectations, naming conventions, and how to run tests.
- Commit & Pull Request Guidelines: Commit message conventions, PR requirements (descriptions, linked issues, screenshots), and pre-review checks.
- (Optional) Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions if applicable.

Instructions:
- Use the available tools to inspect this repository as needed (e.g., list directories, read configs, inspect scripts) before writing.
- If existing AI tool rule files are supplied below, preserve their intent in the generated AGENTS.md instead of ignoring or mechanically concatenating them.
- If an existing AGENTS.md or AGENT.md is supplied below, update its guidance instead of discarding hand-written project specifics.
- Add a short HTML comment near the top noting which AI rule sources contributed.
- Overwrite the entire contents of AGENTS.md at the target path.
- Keep output scoped to the single Markdown file; do not create extra files.
- Write the final document directly to the AGENTS.md file and return a brief confirmation when done."#;

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Exit(i32),
    Generate { prompt: String, target: PathBuf },
}

#[derive(Clone)]
struct RuleSource {
    relative_path: String,
    label: &'static str,
    content: String,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Project,
    User,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    pub(crate) prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    pub(crate) scope: Scope,
    pub(crate) path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) updated_at: Option<String>,
}

#[derive(Serialize)]
struct DeleteResult<'a> {
    name: &'a str,
    scope: &'static str,
    deleted: bool,
}

pub fn run(args: &[String]) -> Result<Outcome> {
    let mut json = false;
    let mut force = false;
    let mut filtered = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => json = true,
            "--force" => force = true,
            "--provider" | "--session" | "--format" | "--api-key" => index += 1,
            value
                if value.starts_with("--provider=")
                    || value.starts_with("--session=")
                    || value.starts_with("--format=")
                    || value.starts_with("--api-key=") => {}
            _ => filtered.push(args[index].clone()),
        }
        index += 1;
    }
    let args = filtered;
    match args.first().map(String::as_str).unwrap_or("init") {
        "init" => init(&strip_init_global_flags(&args[1..]), force),
        "profile" => {
            profile(&args[1..], json, force)?;
            Ok(Outcome::Exit(0))
        }
        "help" | "--help" | "-h" => {
            println!(
                "Usage: maestro agents [init [path] [--force]|profile <list|show|create|delete>]"
            );
            Ok(Outcome::Exit(0))
        }
        value => bail!(
            "Unknown agents subcommand: {value}. Try \"maestro agents init\" or \"maestro agents profile list\""
        ),
    }
}

fn strip_init_global_flags(args: &[String]) -> Vec<String> {
    const WITH_VALUES: &[&str] = &[
        "--mode",
        "--provider",
        "--model",
        "-m",
        "--task-budget",
        "--models",
        "--models-file",
        "--api-key",
        "--port",
        "--system-prompt",
        "--append-system-prompt",
        "--session",
        "--approval-mode",
        "--auth",
        "--sandbox",
        "--output-schema",
        "--output-last-message",
        "--tools",
        "--composer",
        "--format",
        "--output-dir",
        "--profile",
        "--config",
        "--junit",
        "--replay",
        "--record-scenario",
    ];
    const BOOLEAN: &[&str] = &[
        "--headless",
        "--continue",
        "-c",
        "--no-session",
        "--safe-mode",
        "--stream-json",
        "--full-auto",
        "--read-only",
        "--readonly",
        "--read-only-mode",
        "--redact-secrets",
        "--live-mcp",
    ];
    let mut filtered = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--worktree" => {
                if args
                    .get(index + 1)
                    .is_some_and(|value| !value.starts_with('-'))
                {
                    index += 1;
                }
            }
            value if WITH_VALUES.contains(&value) => {
                index += usize::from(args.get(index + 1).is_some());
            }
            value
                if WITH_VALUES
                    .iter()
                    .any(|flag| value.starts_with(&format!("{flag}=")))
                    || value.starts_with("--worktree=") => {}
            value if BOOLEAN.contains(&value) => {}
            _ => filtered.push(args[index].clone()),
        }
        index += 1;
    }
    filtered
}

#[derive(Debug, PartialEq, Eq)]
pub enum InitWorkspaceResult {
    Created {
        path: PathBuf,
        prompt: String,
    },
    Updated {
        path: PathBuf,
    },
    Exists {
        path: PathBuf,
        preview: String,
        rerun: String,
    },
}

fn init(args: &[String], force: bool) -> Result<Outcome> {
    if args.len() > 1 {
        bail!("agents init accepts at most one target path");
    }
    let cwd = std::env::current_dir()?;
    match init_workspace(&cwd, args.first().map(String::as_str), force)? {
        InitWorkspaceResult::Created { path, prompt } => Ok(Outcome::Generate {
            prompt,
            target: path,
        }),
        InitWorkspaceResult::Updated { path } => {
            println!("Updated AGENTS instructions at {}.", path.display());
            Ok(Outcome::Exit(0))
        }
        InitWorkspaceResult::Exists {
            path,
            preview,
            rerun,
        } => {
            println!(
                "AGENTS instructions already exist at {}.\nPreview the proposed update below, then re-run with `{rerun}` to apply it.\n\n{}",
                path.display(),
                preview
            );
            Ok(Outcome::Exit(0))
        }
    }
}

/// Scaffold `AGENTS.md` for a workspace. Shared by `maestro agents init` and `/init`.
pub fn init_workspace(
    cwd: &Path,
    target_arg: Option<&str>,
    force: bool,
) -> Result<InitWorkspaceResult> {
    let target = match target_arg {
        None => cwd.join("AGENTS.md"),
        Some(value) => {
            let path = absolute(cwd, Path::new(value));
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                path
            } else {
                path.join("AGENTS.md")
            }
        }
    };
    let root = target
        .parent()
        .context("AGENTS target has no parent directory")?;
    fs::create_dir_all(root)?;
    let existed = target.exists();
    let sources = discover_rules(root, Some(&target), existed)?;
    let project = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository");
    let content = scaffold(project, &sources);
    if existed && !force {
        let old = fs::read_to_string(&target)?;
        let diff = TextDiff::from_lines(&old, &content)
            .unified_diff()
            .header("current", "proposed")
            .to_string();
        let rerun = target_arg.map_or_else(
            || "maestro agents init --force".to_string(),
            |path| format!("maestro agents init {} --force", shell_quote(path)),
        );
        return Ok(InitWorkspaceResult::Exists {
            path: target,
            preview: sanitize_preview(&diff),
            rerun,
        });
    }
    crate::skill_cli::write_atomic(&target, &content)?;
    if existed {
        return Ok(InitWorkspaceResult::Updated { path: target });
    }
    Ok(InitWorkspaceResult::Created {
        prompt: generation_prompt(&target, &sources),
        path: target,
    })
}

fn absolute(cwd: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.into()
    } else {
        cwd.join(path)
    };
    let mut clean = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            value => clean.push(value.as_os_str()),
        }
    }
    clean
}

fn discover_rules(
    root: &Path,
    target: Option<&Path>,
    include_target: bool,
) -> Result<Vec<RuleSource>> {
    let canonical_root = dunce::canonicalize(root)?;
    let mut found = BTreeMap::new();
    let mut add = |path: PathBuf, label| {
        if let Some(source) = read_rule(&canonical_root, &path, label) {
            found.insert(source.relative_path.clone(), source);
        }
    };
    if include_target {
        if let Some(path) = target {
            add(path.into(), "Existing AGENTS.md");
        }
    }
    for name in ["AGENTS.md", "AGENT.md"] {
        let path = root.join(name);
        if target.is_none_or(|target| target != path) {
            add(path, "Existing Maestro agent instructions");
        }
    }
    for path in walk(&root.join(".cursor/rules"), &|name| {
        let name = name.to_ascii_lowercase();
        name.ends_with(".md") || name.ends_with(".mdc")
    }) {
        add(path, "Cursor rule");
    }
    add(root.join(".cursorrules"), "Cursor rules");
    for path in walk(root, &|name| name == "CLAUDE.md") {
        add(path, "Claude instructions");
    }
    for (path, label) in [
        (".windsurfrules", "Windsurf rules"),
        (".clinerules", "Cline rules"),
        (".goosehints", "Goose hints"),
        (".github/copilot-instructions.md", "Copilot instructions"),
    ] {
        add(root.join(path), label);
    }
    Ok(found.into_values().collect())
}

fn read_rule(root: &Path, path: &Path, label: &'static str) -> Option<RuleSource> {
    if !fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let real = dunce::canonicalize(path).ok()?;
    if !real.starts_with(root) {
        return None;
    }
    let raw = fs::read(path).ok()?;
    let truncated = raw.len() > MAX_RULE_BYTES;
    let end = if truncated {
        let mut end = MAX_RULE_BYTES;
        while end > 0 && std::str::from_utf8(&raw[..end]).is_err() {
            end -= 1;
        }
        end
    } else {
        raw.len()
    };
    Some(RuleSource {
        relative_path: real.strip_prefix(root).ok()?.to_string_lossy().into_owned(),
        label,
        content: String::from_utf8_lossy(&raw[..end]).into_owned(),
        truncated,
    })
}

fn walk(dir: &Path, predicate: &dyn Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && !IGNORED_DIRS.contains(&name.as_str()) {
            paths.extend(walk(&entry.path(), predicate));
        } else if kind.is_file() && predicate(&name) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    paths
}

fn scaffold(project: &str, sources: &[RuleSource]) -> String {
    let template = TEMPLATE.replace("{{PROJECT_NAME}}", project);
    if sources.is_empty() {
        return format!("{}\n\n", template.trim_end());
    }
    let paths = sources
        .iter()
        .map(|s| html_path(&s.relative_path))
        .collect::<Vec<_>>()
        .join(", ");
    let list = sources
        .iter()
        .map(|s| {
            format!(
                "- {}: {}{}",
                json_path(&s.relative_path),
                s.label,
                if s.truncated { " (truncated)" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{}\n\n## Imported AI Tooling Rules\n<!-- Imported by maestro /init from: {paths} -->\n\nReview and fold these existing AI-tool instructions into the sections above:\n\n{list}\n",
        template.trim_end()
    )
}

fn generation_prompt(target: &Path, sources: &[RuleSource]) -> String {
    let mut result = format!("{GENERATION_PROMPT}\n\nTarget path: {}", target.display());
    if sources.is_empty() {
        return result;
    }
    result.push_str("\n\nExisting AI tool rule files to merge:\n");
    for source in sources {
        let fence = "`".repeat(3.max(longest_ticks(&source.content) + 1));
        result.push_str(&format!(
            "\n### {} ({})\n",
            json_path(&source.relative_path),
            source.label
        ));
        if source.truncated {
            result.push_str(&format!(
                "The content below was truncated to {MAX_RULE_BYTES} bytes.\n"
            ));
        }
        result.push_str(&format!(
            "{fence}md\n{}\n{fence}\n",
            source.content.trim_end()
        ));
    }
    result
}

fn longest_ticks(value: &str) -> usize {
    value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0)
}
fn json_path(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
fn html_path(value: &str) -> String {
    let encoded = json_path(value);
    let mut escaped = String::with_capacity(encoded.len());
    let mut characters = encoded.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '-' {
            escaped.push(character);
            continue;
        }
        let mut count = 1;
        while characters.next_if_eq(&'-').is_some() {
            count += 1;
        }
        if count == 1 {
            escaped.push('-');
        } else {
            escaped.push_str(&vec!["-"; count].join(" "));
        }
    }
    escaped
}
fn sanitize_preview(value: &str) -> String {
    value
        .chars()
        .filter(|c| matches!(c, '\n' | '\r' | '\t') || !c.is_control())
        .collect()
}
fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_./:=@+-".contains(c))
    {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn profile(args: &[String], json: bool, force: bool) -> Result<()> {
    match args.first().map(String::as_str).unwrap_or("list") {
        "list" => profile_list(json),
        "show" => profile_show(args.get(1), json),
        "create" => profile_create(&args[1..], json, force),
        "delete" => profile_delete(&args[1..], json),
        action => {
            bail!("Unknown agents profile action: {action}. Use list, show, create, or delete.")
        }
    }
}

fn profile_list(json: bool) -> Result<()> {
    let profiles = profiles()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&profiles)?);
    } else if profiles.is_empty() {
        println!("No specialist profiles found.");
    } else {
        for p in profiles {
            println!(
                "{} ({}){}",
                p.name,
                scope_name(p.scope),
                p.description.map_or(String::new(), |d| format!(" - {d}"))
            );
        }
    }
    Ok(())
}

fn profile_show(name: Option<&String>, json: bool) -> Result<()> {
    let name = name.context("agents profile show requires a name")?;
    let normalized = normalize_name(name)?;
    let p = profiles()?
        .into_iter()
        .find(|p| p.name == normalized)
        .with_context(|| format!("specialist profile not found: {name}"))?;
    if json {
        println!("{}", serde_json::to_string_pretty(&p)?);
    } else {
        println!("# {}", p.name);
        if let Some(description) = p.description {
            println!("\n{description}");
        }
        println!(
            "\nScope: {}\nPath: {}\n\n{}",
            scope_name(p.scope),
            p.path.display(),
            p.prompt
        );
    }
    Ok(())
}

fn profile_create(args: &[String], json: bool, force: bool) -> Result<()> {
    let name = normalize_name(
        args.first()
            .context("agents profile create requires a name")?,
    )?;
    let (mut description, mut tools, mut model, mut scope) = (None, None, None, Scope::Project);
    let mut prompt = Vec::new();
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--description" => description = Some(next(args, &mut index, "--description")?),
            "--tools" => {
                tools = Some(
                    next(args, &mut index, "--tools")?
                        .split(',')
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_string)
                        .collect(),
                );
            }
            "--model" => model = Some(next(args, &mut index, "--model")?),
            "--scope" => scope = parse_scope(&next(args, &mut index, "--scope")?)?,
            value => prompt.push(value.to_string()),
        }
        index += 1;
    }
    let prompt = prompt.join(" ").trim().to_string();
    if prompt.is_empty() {
        bail!("agents profile create requires prompt text");
    }
    let path = profile_path(&name, scope)?;
    if path.exists() && !force {
        bail!("specialist profile already exists: {name}");
    }
    fs::create_dir_all(path.parent().context("profile path has no parent")?)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut meta = Mapping::new();
    meta.insert(Value::from("name"), Value::from(name.clone()));
    if let Some(v) = &description {
        meta.insert(Value::from("description"), Value::from(v.clone()));
    }
    if let Some(v) = &tools {
        meta.insert(Value::from("tools"), serde_yaml::to_value(v)?);
    }
    if let Some(v) = &model {
        meta.insert(Value::from("model"), Value::from(v.clone()));
    }
    meta.insert(Value::from("createdAt"), Value::from(now.clone()));
    meta.insert(Value::from("updatedAt"), Value::from(now.clone()));
    crate::skill_cli::write_atomic(
        &path,
        &format!("---\n{}---\n\n{prompt}\n", serde_yaml::to_string(&meta)?),
    )?;
    let p = Profile {
        name,
        description,
        prompt,
        tools,
        model,
        scope,
        path,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&p)?);
    } else {
        println!(
            "Created specialist profile {} at {}.",
            p.name,
            p.path.display()
        );
    }
    Ok(())
}

fn profile_delete(args: &[String], json: bool) -> Result<()> {
    let raw_name = args
        .first()
        .context("agents profile delete requires a name")?;
    let name = normalize_name(raw_name)?;
    let mut scope = Scope::Project;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--scope" {
            scope = parse_scope(&next(args, &mut index, "--scope")?)?;
        } else if let Some(value) = args[index].strip_prefix("--scope=") {
            scope = parse_scope(value)?;
        } else {
            bail!("unexpected agents profile delete argument: {}", args[index]);
        }
        index += 1;
    }
    let path = profile_path(&name, scope)?;
    let deleted = path.exists();
    if deleted {
        fs::remove_file(path)?;
    }
    if json {
        let payload = DeleteResult {
            name: raw_name,
            scope: scope_name(scope),
            deleted,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if deleted {
        println!(
            "Deleted specialist profile {raw_name} ({}).",
            scope_name(scope)
        );
    } else {
        println!(
            "No specialist profile {raw_name} found in {} scope.",
            scope_name(scope)
        );
    }
    Ok(())
}

fn profiles() -> Result<Vec<Profile>> {
    profiles_for_workspace(&std::env::current_dir()?)
}

/// Load specialist profiles using an explicit project workspace. Native child
/// agents may run from a worktree, so they must not depend on the process cwd.
pub(crate) fn profiles_for_workspace(cwd: &Path) -> Result<Vec<Profile>> {
    profiles_for_workspace_with_agent_dirs(cwd, &[])
}

/// Load project/user profiles plus plugin-provided agent directories.
pub(crate) fn profiles_for_workspace_with_agent_dirs(
    cwd: &Path,
    agent_dirs: &[PathBuf],
) -> Result<Vec<Profile>> {
    let mut found = BTreeMap::new();
    for dir in agent_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.path().extension().is_some_and(|ext| ext == "md")
            {
                if let Ok(profile) = read_profile(&entry.path(), Scope::Project) {
                    found.insert(profile.name.clone(), profile);
                }
            }
        }
    }
    for scope in [Scope::User, Scope::Project] {
        let Ok(entries) = fs::read_dir(profile_dir_for(cwd, scope)?) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.path().extension().is_some_and(|ext| ext == "md")
            {
                if let Ok(profile) = read_profile(&entry.path(), scope) {
                    found.insert(profile.name.clone(), profile);
                }
            }
        }
    }
    Ok(found.into_values().collect())
}

pub(crate) fn read_profile(path: &Path, scope: Scope) -> Result<Profile> {
    let content = fs::read_to_string(path)?;
    let (meta, body) = if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let value = serde_yaml::from_str::<Value>(&rest[..end])?;
            let meta = value.as_mapping().cloned().unwrap_or_default();
            (
                meta,
                rest[end + 4..]
                    .strip_prefix('\n')
                    .unwrap_or(&rest[end + 4..]),
            )
        } else {
            (Mapping::new(), content.as_str())
        }
    } else {
        (Mapping::new(), content.as_str())
    };
    let string = |key| {
        meta.get(Value::from(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let fallback = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
    Ok(Profile {
        name: normalize_name(string("name").as_deref().unwrap_or(fallback))?,
        description: string("description"),
        prompt: body.trim().into(),
        tools: meta
            .get(Value::from("tools"))
            .and_then(Value::as_sequence)
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
        model: string("model"),
        scope,
        path: path.into(),
        created_at: string("createdAt"),
        updated_at: string("updatedAt"),
    })
}

fn next(args: &[String], index: &mut usize, flag: &str) -> Result<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .with_context(|| format!("{flag} requires a value"))
}
fn normalize_name(value: &str) -> Result<String> {
    let mut name = String::new();
    let mut in_invalid_run = false;
    for c in value.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            name.push(c);
            in_invalid_run = false;
        } else if !in_invalid_run {
            name.push('-');
            in_invalid_run = true;
        }
    }
    let name = name.trim_matches('-').to_string();
    if name.is_empty() || name.len() > 64 {
        bail!("profile name must be 1-64 lowercase letters, numbers, or hyphens");
    }
    Ok(name)
}
fn parse_scope(value: &str) -> Result<Scope> {
    match value {
        "project" => Ok(Scope::Project),
        "user" => Ok(Scope::User),
        _ => bail!("invalid profile scope: {value}"),
    }
}
fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::Project => "project",
        Scope::User => "user",
    }
}
fn profile_dir(scope: Scope) -> Result<PathBuf> {
    profile_dir_for(&std::env::current_dir()?, scope)
}

fn profile_dir_for(cwd: &Path, scope: Scope) -> Result<PathBuf> {
    match scope {
        Scope::Project => Ok(cwd.join(".maestro/agent-profiles")),
        Scope::User => crate::path_utils::maestro_home_dir()
            .map(|p| p.join("agent-profiles"))
            .context("Unable to resolve Maestro home directory"),
    }
}
fn profile_path(name: &str, scope: Scope) -> Result<PathBuf> {
    Ok(profile_dir(scope)?.join(format!("{name}.md")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_scaffold_and_generation_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        let result = init(&[target.to_string_lossy().into()], false).unwrap();
        assert!(
            fs::read_to_string(target)
                .unwrap()
                .contains("# Repository Guidelines")
        );
        assert!(matches!(result, Outcome::Generate { prompt, .. } if prompt.contains("AGENTS.md")));
    }

    #[test]
    fn loads_plugin_profiles_alongside_workspace_profiles() {
        let workspace = tempfile::tempdir().unwrap();
        let plugin_agents = workspace.path().join("plugin/agents");
        fs::create_dir_all(&plugin_agents).unwrap();
        fs::write(
            plugin_agents.join("reviewer.md"),
            "---\nname: reviewer\ntools: [read, grep]\n---\nReview only for regressions.\n",
        )
        .unwrap();

        let profiles = profiles_for_workspace_with_agent_dirs(
            workspace.path(),
            std::slice::from_ref(&plugin_agents),
        )
        .unwrap();
        let reviewer = profiles
            .into_iter()
            .find(|profile| profile.name == "reviewer")
            .expect("plugin profile should be discovered");
        assert_eq!(reviewer.scope, Scope::Project);
        assert_eq!(reviewer.prompt, "Review only for regressions.");
        assert_eq!(
            reviewer.tools,
            Some(vec!["read".to_string(), "grep".to_string()])
        );
    }
    #[test]
    fn existing_file_is_only_previewed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        fs::write(&target, "# Existing\n").unwrap();
        assert_eq!(
            init(&[target.to_string_lossy().into()], false).unwrap(),
            Outcome::Exit(0)
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "# Existing\n");
    }
    #[test]
    fn force_replaces_an_existing_file_with_the_scaffold() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        fs::write(&target, "# Existing Guidance\n").unwrap();

        let result = init(&[target.to_string_lossy().into()], true).unwrap();

        let content = fs::read_to_string(target).unwrap();
        assert_eq!(result, Outcome::Exit(0));
        assert!(content.contains("# Repository Guidelines"));
        assert!(content.contains("## Imported AI Tooling Rules"));
        assert!(!content.contains("# Existing Guidance"));
    }
    #[test]
    fn invalid_scope_is_rejected() {
        assert_eq!(
            parse_scope("team").unwrap_err().to_string(),
            "invalid profile scope: team"
        );
    }
    #[test]
    fn names_match_legacy_normalization() {
        assert_eq!(normalize_name("API reviewer").unwrap(), "api-reviewer");
        assert_eq!(normalize_name("API: Reviewer").unwrap(), "api-reviewer");
        assert_eq!(normalize_name("foo / bar").unwrap(), "foo-bar");
        assert_eq!(normalize_name("API--reviewer").unwrap(), "api--reviewer");
    }

    #[test]
    fn malformed_profile_frontmatter_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("broken.md");
        fs::write(&path, "---\nname: [invalid\n---\n\nprompt\n").unwrap();
        assert!(read_profile(&path, Scope::Project).is_err());
    }

    #[test]
    fn rule_discovery_rejects_symlinks_and_truncates_at_utf8_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "do not import").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            root.path().join(".cursorrules"),
        )
        .unwrap();
        fs::write(
            root.path().join(".goosehints"),
            format!("{}🙂overflow", "a".repeat(11_999)),
        )
        .unwrap();

        let sources = discover_rules(root.path(), None, false).unwrap();

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].relative_path, ".goosehints");
        assert!(sources[0].truncated);
        assert_eq!(sources[0].content.len(), 11_999);
        assert!(!sources[0].content.contains('�'));
        assert!(!sources[0].content.contains("overflow"));
    }

    #[test]
    fn imported_paths_are_escaped_and_markdown_fences_expand() {
        let root = tempfile::tempdir().unwrap();
        let rules = root.path().join(".cursor/rules");
        fs::create_dir_all(&rules).unwrap();
        fs::write(
            rules.join("bad--->rule.md"),
            "Use this:\n```md\n# nested\n```",
        )
        .unwrap();
        let sources = discover_rules(root.path(), None, false).unwrap();
        let content = scaffold("project", &sources);
        let prompt = generation_prompt(&root.path().join("AGENTS.md"), &sources);

        assert!(content.contains(
            "<!-- Imported by maestro /init from: \".cursor/rules/bad- - ->rule.md\" -->"
        ));
        assert!(prompt.contains("````md\nUse this:\n```md"));
    }

    #[test]
    fn forwarded_global_flags_do_not_become_init_targets() {
        let outcome = run(&[
            "help".into(),
            "--provider".into(),
            "openai".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(outcome, Outcome::Exit(0));
        assert_eq!(
            strip_init_global_flags(&[
                "--profile".into(),
                "work".into(),
                "--config=profile=work".into(),
                "--no-session".into(),
                "--safe-mode".into(),
                "--worktree".into(),
                "feature".into(),
                "./docs".into(),
            ]),
            vec!["./docs"]
        );
    }
}
