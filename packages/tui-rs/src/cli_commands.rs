//! Lightweight non-agent CLI helpers (sessions, cost, modes, status, hooks).
//!
//! These replace TypeScript `maestro cost|sessions|modes|status|hooks` entrypoints
//! so the Node agent bootstrap is not required.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use crate::session::{ExportFormat, ExportOptions, SessionManager};
use crate::session_transfer::{export_portable_session, import_portable_session, PortableFormat};

/// Dispatch a top-level CLI helper subcommand.
///
/// `args` is the token stream after the program name, e.g.
/// `["sessions", "list"]` or `["cost", "today"]`.
pub async fn run_cli_command(args: &[String]) -> Result<i32> {
    let Some(cmd) = args.first().map(String::as_str) else {
        bail!("missing command");
    };

    match cmd {
        "sessions" => run_sessions(&args[1..]),
        "cost" => run_cost(&args[1..]),
        "stats" => run_stats(&args[1..]),
        "models" => run_models(&args[1..]),
        "status" if args.get(1).is_some_and(|arg| is_help(arg)) => {
            println!("Usage: maestro-tui status");
            Ok(0)
        }
        "status" => run_status(),
        "hooks" => run_hooks(&args[1..]),
        "export" if args.get(1).is_some_and(|arg| is_help(arg)) => {
            println!("Usage: maestro-tui export <session-id> [output-path] [--format f]");
            Ok(0)
        }
        "export" => {
            // `maestro-tui export <id> [path] [--format json|md|html|txt|jsonl]`
            run_sessions_export(&args[1..])
        }
        "import" if args.get(1).is_some_and(|arg| is_help(arg)) => {
            println!("Usage: maestro-tui import <file.jsonl|file.json>");
            Ok(0)
        }
        "import" => run_sessions_import(&args[1..]),
        "skill" => crate::skill_cli::run_skill(&args[1..]).await,
        "update" => crate::update_cli::run_update(&args[1..]).await,
        "modes" => crate::mode_cli::run_modes(&args[1..]).await,
        "painter" => crate::painter_cli::run_painter(&args[1..]),
        other => bail!("unknown command: {other}"),
    }
}

fn is_help(arg: &str) -> bool {
    matches!(arg, "help" | "--help" | "-h")
}

fn run_sessions(args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str).unwrap_or("list");
    match sub {
        "list" | "ls" => run_sessions_list(&args[1..]),
        "path" => run_sessions_path(),
        "export" => run_sessions_export(&args[1..]),
        "import" => run_sessions_import(&args[1..]),
        "help" | "--help" | "-h" => {
            println!(
                "Usage: maestro-tui sessions [list [N]|path|export <id> [out] [--format f]|import <file>]"
            );
            Ok(0)
        }
        other => {
            eprintln!("Unknown sessions subcommand: {other}");
            eprintln!("Try: maestro-tui sessions list|export|import|path");
            Ok(1)
        }
    }
}

fn run_sessions_list(args: &[String]) -> Result<i32> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    let limit = args
        .first()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20);
    let sessions = manager
        .recent_sessions(limit)
        .context("Failed to list sessions")?;
    if sessions.is_empty() {
        println!("No sessions found for {}", cwd.display());
        return Ok(0);
    }
    println!("ID            MODEL                 MODIFIED                  TITLE");
    for s in sessions {
        let id_short = if s.id.len() > 10 {
            format!("{}…", &s.id[..8])
        } else {
            s.id.clone()
        };
        let modified = s
            .modified
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                let secs = d.as_secs();
                if secs < 3600 {
                    format!("{}m ago", secs / 60)
                } else if secs < 86400 {
                    format!("{}h ago", secs / 3600)
                } else {
                    format!("{}d ago", secs / 86400)
                }
            })
            .unwrap_or_else(|| s.timestamp.clone());
        let title = s.title();
        let title = if title.len() > 48 {
            format!("{}…", &title[..45])
        } else {
            title
        };
        println!(
            "{id_short:<12}  {:<20}  {modified:<24}  {title}",
            truncate(&s.model, 20)
        );
    }
    Ok(0)
}

fn run_sessions_path() -> Result<i32> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    println!("cwd: {}", cwd.display());
    println!("sessions dir: {}", manager.sessions_dir().display());
    if let Ok(sessions) = manager.recent_sessions(1) {
        if let Some(s) = sessions.first() {
            println!("latest: {}", s.path.display());
        }
    }
    Ok(0)
}

fn run_sessions_export(args: &[String]) -> Result<i32> {
    let mut session_id: Option<String> = None;
    let mut output: Option<PathBuf> = None;
    let mut format = ExportFormat::Json;
    let mut format_name = "json".to_string();
    let mut redact_secrets = false;
    let mut i = 0usize;
    while i < args.len() {
        let a = &args[i];
        if a == "--format" || a == "-f" {
            i += 1;
            let Some(f) = args.get(i) else {
                bail!("--format requires a value (json|md|html|txt|jsonl|markdown)");
            };
            format = parse_export_format(f)?;
            format_name = f.to_ascii_lowercase();
        } else if let Some(rest) = a.strip_prefix("--format=") {
            format = parse_export_format(rest)?;
            format_name = rest.to_ascii_lowercase();
        } else if a == "--redact-secrets" {
            redact_secrets = true;
        } else if a.starts_with('-') {
            bail!("unknown export flag: {a}");
        } else if session_id.is_none() {
            session_id = Some(a.clone());
        } else if output.is_none() {
            output = Some(PathBuf::from(a));
        }
        i += 1;
    }

    let Some(id) = session_id else {
        eprintln!("Usage: maestro-tui sessions export <session-id> [output-path] [--format json|md|html|txt|jsonl]");
        return Ok(2);
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    if matches!(format_name.as_str(), "json" | "jsonl") {
        let portable_format = if format_name == "jsonl" {
            PortableFormat::Jsonl
        } else {
            PortableFormat::Json
        };
        let out_path = export_portable_session(
            &manager,
            &id,
            output.as_deref(),
            portable_format,
            redact_secrets,
        )?;
        println!(
            "Exported session {id} to {} ({}).",
            out_path.display(),
            format_name
        );
        return Ok(0);
    }
    if redact_secrets {
        bail!("--redact-secrets is supported for json and jsonl exports");
    }
    let session = manager
        .load_session(&id)
        .with_context(|| format!("Session not found: {id}"))?;

    let out_path = output.unwrap_or_else(|| {
        let ext = if matches!(format, ExportFormat::Json) {
            "json".to_string()
        } else {
            format.extension().to_string()
        };
        PathBuf::from(format!("session-{}.{}", &id[..id.len().min(8)], ext))
    });

    let options = ExportOptions {
        format,
        ..ExportOptions::default()
    };
    let content = {
        let exporter = crate::session::SessionExporter::from_session(&session, options);
        exporter.export_to_string()
    };

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(&out_path, content)
        .with_context(|| format!("write export to {}", out_path.display()))?;
    println!(
        "Exported session {} to {} ({}).",
        session.header.id,
        out_path.display(),
        format.extension()
    );
    Ok(0)
}

fn parse_export_format(s: &str) -> Result<ExportFormat> {
    match s.to_ascii_lowercase().as_str() {
        "json" => Ok(ExportFormat::Json),
        "md" | "markdown" => Ok(ExportFormat::Markdown),
        "html" | "htm" => Ok(ExportFormat::Html),
        "txt" | "text" | "plain" => Ok(ExportFormat::PlainText),
        "jsonl" => Ok(ExportFormat::Json), // handled specially above for raw copy
        other => bail!("unsupported export format: {other} (use json|md|html|txt|jsonl)"),
    }
}

fn run_sessions_import(args: &[String]) -> Result<i32> {
    let Some(source) = args.first() else {
        eprintln!("Usage: maestro-tui sessions import <file.jsonl|file.json>");
        return Ok(2);
    };
    let src = PathBuf::from(source);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    let imported = import_portable_session(&manager, &src)?;
    if imported.imported_count > 1 {
        println!(
            "Imported {} sessions from {}. Active session: {}.",
            imported.imported_count,
            src.display(),
            imported.session_id
        );
    } else {
        println!(
            "Imported session {} from {}.",
            imported.session_id,
            src.display()
        );
    }
    println!("Stored at {}", imported.session_file.display());
    Ok(0)
}

fn run_cost(args: &[String]) -> Result<i32> {
    let period = args.first().map(String::as_str).unwrap_or("today");
    match period {
        "clear" => run_cost_clear(args),
        "breakdown" => run_cost_breakdown(),
        "help" | "--help" | "-h" => {
            println!("Usage: maestro-tui cost [today|week|month|all|breakdown|clear]");
            Ok(0)
        }
        "today" | "yesterday" | "week" | "7d" | "month" | "30d" | "all" | "total" => {
            run_cost_summary(period)
        }
        other => {
            eprintln!("Unknown cost subcommand: {other}");
            eprintln!("Try: maestro-tui cost today|yesterday|week|month|all|breakdown|clear");
            Ok(1)
        }
    }
}

fn run_cost_summary(period: &str) -> Result<i32> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    let sessions = manager
        .recent_sessions(200)
        .context("Failed to load sessions for cost summary")?;

    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut total_cost = 0.0f64;
    let mut session_count = 0usize;

    for s in &sessions {
        session_count += 1;
        input_tokens = input_tokens.saturating_add(s.stats.total_input_tokens);
        output_tokens = output_tokens.saturating_add(s.stats.total_output_tokens);
        total_cost += s.stats.total_cost;
    }

    let label = match period {
        "today" => "Recent sessions (local, last 200)",
        "yesterday" => "Recent sessions (local, last 200)",
        "week" | "7d" => "Recent sessions (local, last 200)",
        "month" | "30d" => "Recent sessions (local, last 200)",
        "all" | "total" => "Recent sessions (local, last 200)",
        other => other,
    };

    println!("Maestro cost — {label}");
    println!("  Sessions scanned: {session_count}");
    println!("  Input tokens:     {input_tokens}");
    println!("  Output tokens:    {output_tokens}");
    println!("  Total tokens:     {}", input_tokens + output_tokens);
    println!("  Est. cost (USD):  {total_cost:.4}");
    println!();
    println!("Note: native cost reads local session stats (not the legacy TS usage DB).");
    Ok(0)
}

fn run_cost_breakdown() -> Result<i32> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manager = SessionManager::new(cwd.to_string_lossy().to_string());
    let sessions = manager
        .recent_sessions(200)
        .context("Failed to load sessions for cost breakdown")?;

    let mut by_model: BTreeMap<String, (usize, u64, u64, f64)> = BTreeMap::new();
    for s in &sessions {
        let entry = by_model.entry(s.model.clone()).or_insert((0, 0, 0, 0.0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(s.stats.total_input_tokens);
        entry.2 = entry.2.saturating_add(s.stats.total_output_tokens);
        entry.3 += s.stats.total_cost;
    }

    println!("Maestro cost breakdown (by model, last 200 sessions)");
    if by_model.is_empty() {
        println!("  No session usage found.");
        return Ok(0);
    }
    println!(
        "{:<32} {:>8} {:>12} {:>12} {:>12}",
        "MODEL", "SESSIONS", "INPUT", "OUTPUT", "COST"
    );
    for (model, (n, inn, out, cost)) in by_model {
        println!(
            "{:<32} {:>8} {:>12} {:>12} {:>12.4}",
            truncate(&model, 32),
            n,
            inn,
            out,
            cost
        );
    }
    Ok(0)
}

fn run_cost_clear(args: &[String]) -> Result<i32> {
    let force = args.iter().any(|a| a == "--yes" || a == "-y" || a == "yes");
    if !force {
        eprint!("Clear local usage.json files? [y/N] ");
        let _ = io::stderr().flush();
        let mut line = String::new();
        io::stdin().read_line(&mut line)?;
        let answer = line.trim().to_ascii_lowercase();
        if answer != "y" && answer != "yes" {
            println!("Aborted.");
            return Ok(0);
        }
    }

    let mut removed = 0usize;
    for path in usage_file_candidates() {
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
            println!("Removed {}", path.display());
            removed += 1;
        }
    }
    if removed == 0 {
        println!("No usage files found to clear.");
    } else {
        println!("Cleared {removed} usage file(s).");
    }
    Ok(0)
}

fn usage_file_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(p) = crate::path_utils::env_path("MAESTRO_USAGE_FILE") {
        paths.push(p);
    }
    if let Some(home) = crate::path_utils::maestro_home_dir() {
        paths.push(home.join("usage.json"));
    }
    if let Some(legacy) = crate::path_utils::legacy_composer_home_dir() {
        paths.push(legacy.join("usage.json"));
    }
    crate::path_utils::dedupe_paths(paths)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    timestamp: i64,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default, alias = "tokensInput")]
    tokens_input: u64,
    #[serde(default, alias = "tokensOutput")]
    tokens_output: u64,
    #[serde(default, alias = "tokensCacheRead")]
    tokens_cache_read: Option<u64>,
    #[serde(default, alias = "tokensCacheWrite")]
    tokens_cache_write: Option<u64>,
    #[serde(default)]
    cost: f64,
}

fn load_usage_entries() -> Vec<UsageEntry> {
    for path in usage_file_candidates() {
        if !path.exists() {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Vec<UsageEntry>>(&raw) {
                Ok(entries) => return entries,
                Err(err) => {
                    eprintln!("warning: failed to parse {}: {err}", path.display());
                }
            },
            Err(err) => {
                eprintln!("warning: failed to read {}: {err}", path.display());
            }
        }
    }
    Vec::new()
}

fn period_range_ms(period: &str) -> (Option<i64>, &'static str) {
    let now = chrono::Utc::now().timestamp_millis();
    let day = 86_400_000i64;
    match period {
        "today" => {
            // Local midnight approximation via UTC midnight is good enough for CLI.
            let secs = now / 1000;
            let midnight = (secs - (secs % 86_400)) * 1000;
            (Some(midnight), "Today")
        }
        "yesterday" => {
            let secs = now / 1000;
            let midnight = (secs - (secs % 86_400)) * 1000;
            (Some(midnight - day), "Yesterday")
        }
        "week" | "7d" => (Some(now - 7 * day), "Last 7 Days"),
        "month" | "30d" => (Some(now - 30 * day), "Last 30 Days"),
        "all" | "total" => (None, "All Time"),
        _ => (Some(now - 7 * day), "Last 7 Days"),
    }
}

fn run_stats(args: &[String]) -> Result<i32> {
    let mut period = "week";
    let mut format = "text";
    let mut session_id: Option<&str> = None;
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "--json" => format = "json",
            "--csv" => format = "csv",
            "--format" | "-f" => {
                i += 1;
                if let Some(f) = args.get(i) {
                    format = f.as_str();
                }
            }
            s if s.starts_with("--format=") => {
                format = s.trim_start_matches("--format=");
            }
            "--session" | "-s" => {
                i += 1;
                session_id = args.get(i).map(String::as_str);
            }
            s if s.starts_with("--session=") => {
                session_id = Some(s.trim_start_matches("--session="));
            }
            "help" | "--help" | "-h" => {
                println!(
                    "Usage: maestro-tui stats [today|yesterday|week|month|all] [--json|--csv] [--session <id>]"
                );
                return Ok(0);
            }
            "today" | "yesterday" | "week" | "7d" | "month" | "30d" | "all" | "total" => {
                period = a;
            }
            _ => {}
        }
        i += 1;
    }

    let (since, label) = period_range_ms(period);
    let mut entries = load_usage_entries();
    if let Some(since) = since {
        entries.retain(|e| e.timestamp >= since);
        if period == "yesterday" {
            let end = since + 86_400_000;
            entries.retain(|e| e.timestamp < end);
        }
    }
    if let Some(sid) = session_id {
        entries.retain(|e| e.session_id.as_deref() == Some(sid));
    }

    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(0);
    }
    if format == "csv" {
        println!("timestamp,sessionId,provider,model,tokensInput,tokensOutput,cost");
        for e in &entries {
            println!(
                "{},{},{},{},{},{},{:.6}",
                e.timestamp,
                e.session_id.as_deref().unwrap_or(""),
                e.provider,
                e.model,
                e.tokens_input,
                e.tokens_output,
                e.cost
            );
        }
        return Ok(0);
    }

    let mut total_cost = 0.0f64;
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut by_provider: BTreeMap<String, (usize, u64, f64)> = BTreeMap::new();
    let mut by_model: BTreeMap<String, (usize, u64, f64)> = BTreeMap::new();
    for e in &entries {
        total_cost += e.cost;
        total_in = total_in.saturating_add(e.tokens_input);
        total_out = total_out.saturating_add(e.tokens_output);
        let p = by_provider.entry(e.provider.clone()).or_insert((0, 0, 0.0));
        p.0 += 1;
        p.1 = p.1.saturating_add(e.tokens_input + e.tokens_output);
        p.2 += e.cost;
        let m = by_model.entry(e.model.clone()).or_insert((0, 0, 0.0));
        m.0 += 1;
        m.1 = m.1.saturating_add(e.tokens_input + e.tokens_output);
        m.2 += e.cost;
    }

    println!("Maestro stats — {label} (native usage.json)");
    if entries.is_empty() {
        // Fall back to session rollups when no usage DB.
        println!("  No usage.json entries; showing local session rollup instead.");
        return run_cost_summary(if period == "week" { "all" } else { period });
    }
    println!("  Requests:      {}", entries.len());
    println!("  Input tokens:  {total_in}");
    println!("  Output tokens: {total_out}");
    println!("  Total tokens:  {}", total_in + total_out);
    println!("  Est. cost:     ${total_cost:.4}");
    if !by_provider.is_empty() {
        println!();
        println!("  By provider:");
        for (name, (n, tok, cost)) in by_provider {
            println!(
                "    {:<16} req={n:<5} tok={tok:<10} cost=${cost:.4}",
                truncate(&name, 16)
            );
        }
    }
    if !by_model.is_empty() {
        println!();
        println!("  By model:");
        for (name, (n, tok, cost)) in by_model {
            println!(
                "    {:<28} req={n:<5} tok={tok:<10} cost=${cost:.4}",
                truncate(&name, 28)
            );
        }
    }
    Ok(0)
}

fn run_models(args: &[String]) -> Result<i32> {
    let mut sub = "list";
    let mut provider_filter: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "list" | "ls" => sub = "list",
            "providers" => sub = "providers",
            "help" | "--help" | "-h" => {
                println!("Usage: maestro-tui models [list|providers] [--provider <name>]");
                return Ok(0);
            }
            "--provider" | "-p" => {
                i += 1;
                if let Some(v) = args.get(i) {
                    provider_filter = Some(v.clone());
                }
            }
            s if s.starts_with("--provider=") => {
                provider_filter = Some(s.trim_start_matches("--provider=").to_string());
            }
            other if !other.starts_with('-') && provider_filter.is_none() => {
                // bare provider name: `maestro-tui models openai`
                provider_filter = Some(other.to_string());
            }
            _ => {}
        }
        i += 1;
    }

    let models = crate::components::available_models();
    let filtered: Vec<_> = models
        .into_iter()
        .filter(|m| {
            provider_filter.as_ref().is_none_or(|p| {
                m.provider.eq_ignore_ascii_case(p)
                    || m.id.to_lowercase().contains(&p.to_lowercase())
            })
        })
        .collect();

    if sub == "providers" {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for m in &filtered {
            *counts.entry(m.provider.clone()).or_default() += 1;
        }
        println!("Providers (native catalog)");
        if counts.is_empty() {
            println!("  (none)");
            return Ok(0);
        }
        for (p, n) in counts {
            println!("  {p:<16} {n} model(s)");
        }
        return Ok(0);
    }

    println!("Registered models (native catalog)");
    if let Some(p) = &provider_filter {
        println!("  Filter: {p}");
    }
    if filtered.is_empty() {
        println!("  No models matched.");
        return Ok(1);
    }
    let mut by_provider: BTreeMap<String, Vec<_>> = BTreeMap::new();
    for m in filtered {
        by_provider.entry(m.provider.clone()).or_default().push(m);
    }
    for (provider, entries) in by_provider {
        println!();
        println!("{provider}  ({} models)", entries.len());
        for m in entries {
            println!("  • {:<28}  {}", m.id, m.description);
            println!("    {}", m.name);
        }
    }
    Ok(0)
}

fn run_status() -> Result<i32> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let version = env!("CARGO_PKG_VERSION");
    println!("Maestro status (native)");
    println!("  Binary:     maestro-tui {version}");
    println!("  Cwd:        {}", cwd.display());
    println!(
        "  Git:        {}",
        crate::git::current_branch(&cwd).unwrap_or_else(|| "(not a repo)".into())
    );
    if let Some(home) = crate::path_utils::maestro_home_dir() {
        println!("  Home:       {}", home.display());
    }
    println!(
        "  Model env:  {}",
        std::env::var("MAESTRO_MODEL").unwrap_or_else(|_| "(default)".into())
    );
    println!(
        "  Plan mode:  {}",
        if crate::safety::is_plan_mode() {
            "on"
        } else {
            "off"
        }
    );
    Ok(0)
}

fn run_hooks(args: &[String]) -> Result<i32> {
    let sub = args.first().map(String::as_str).unwrap_or("status");
    if sub != "status" && sub != "list" {
        eprintln!("Unknown hooks subcommand: {sub}");
        eprintln!("Try: maestro hooks status");
        return Ok(1);
    }

    println!("Hook status (native summary)");
    println!("  Runtime:    native TUI hooks (Lua/WASM/native + optional Node bridge)");
    println!(
        "  Config:     ~/.maestro/hooks.toml and project hooks (see packages/tui-rs hooks docs)"
    );
    if std::env::var("MAESTRO_HOOKS_DISABLED").ok().as_deref() == Some("1") {
        println!("  State:      disabled (MAESTRO_HOOKS_DISABLED=1)");
    } else {
        println!("  State:      enabled (default)");
    }
    println!();
    println!("Inspect hooks from the interactive TUI (/hooks) for live concurrency stats.");
    Ok(0)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[tokio::test]
    async fn native_utility_help_exits_cleanly() {
        for args in [
            argv(&["status", "--help"]),
            argv(&["export", "--help"]),
            argv(&["import", "--help"]),
            argv(&["update", "--help"]),
        ] {
            assert_eq!(run_cli_command(&args).await.expect("help command"), 0);
        }
    }

    #[tokio::test]
    async fn unknown_cost_subcommand_is_rejected() {
        assert_eq!(
            run_cli_command(&argv(&["cost", "nonsense"]))
                .await
                .expect("cost command"),
            1
        );
    }
}
