/**
 * @fileoverview CLI Help Output Module
 *
 * This module generates and displays the `--help` output for the Maestro CLI.
 * It provides a comprehensive overview of:
 *
 * - **Usage syntax** and common invocation patterns
 * - **Command-line options** for provider, model, session management, etc.
 * - **Environment variables** for API keys and configuration
 * - **Available tools** and their capabilities
 * - **Subcommands** like `maestro exec` for headless execution
 * - **Session management** commands and workflows
 *
 * ## Styling
 *
 * The output uses the application's theme system for consistent terminal styling:
 * - `heading()` - Main title styling
 * - `sectionHeading()` - Section headers
 * - `muted()` - De-emphasized text for descriptions
 * - `badge()` - Highlighted tips and hints
 *
 * @module cli/help
 */
import { badge, heading, muted, sectionHeading } from "../style/theme.js";

/**
 * Prints the complete CLI help message to stdout.
 *
 * This function is invoked when the user runs `maestro --help` or `maestro -h`.
 * It formats and displays all available options, commands, and usage examples
 * using the terminal theme for consistent styling.
 *
 * @param version - The current Maestro version string (e.g., "1.2.3")
 *
 * @example
 * ```typescript
 * import { printHelp } from "./help.js";
 * import { version } from "../../package.json";
 *
 * if (args.includes("--help")) {
 *   printHelp(version);
 *   process.exit(0);
 * }
 * ```
 */
export function printHelp(version: string) {
	const header = `${heading("Maestro")} ${muted(
		`v${version} by EvalOps — AI coding assistant with read, list, search, diff, bash, edit, write, todo tools`,
	)}`;
	const usage = `${sectionHeading("Usage")}${muted(
		"maestro [options] [messages...]",
	)}`;
	const options = `${sectionHeading("Options")}${[
		"--provider <name>       Provider name (default: anthropic)",
		"-m, --model <id>        Model ID (default: claude-sonnet-4-5)",
		"--task-budget <tokens> API-side Anthropic task budget in tokens",
		"--models <patterns>     Comma-separated patterns for Ctrl+P model cycling",
		"--tools <names>         Comma-separated tool names to enable (e.g., read,search,list,find)",
		"--api-key <key>         API key (defaults to env vars)",
		"--system-prompt <text>  System prompt (default: coding assistant prompt)",
		"--append-system-prompt <text>  Append instructions to the system prompt",
		"--mode <mode>           Output mode: text (default), json, or rpc",
		"--auth <mode>           Credential mode: auto (default), api-key, claude",
		"--approval-mode <mode>  Action approvals: prompt (default in TUI), auto, fail",
		"--sandbox <mode>        Sandbox mode: docker, local, none (see docs/SAFETY.md)",
		"--port <n>              Port for `maestro web` (defaults to PORT env or 8080)",
		"--continue, -c          Continue previous session",
		"--resume, -r            Select a session to resume",
		"--session <path>        Use specific session file",
		"--no-session            Don't save session (ephemeral)",
		"--safe-mode             Enable extra safety restrictions",
		"--help, -h              Show this help",
	]
		.map((line) => `  ${muted(line)}`)
		.join("\n")}`;
	const examples = `${sectionHeading("Examples")}${muted(
		`  # Interactive mode (no messages = interactive TUI)
  maestro

  # Single message
  maestro "List all .ts files in src/"

  # Multiple messages
  maestro "Read package.json" "What dependencies do we have?"

  # Continue previous session
  maestro --continue "What did we discuss?"

  # Use different model
  maestro --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Export a portable session log
  maestro export <session-id> ./session.jsonl --format jsonl

  # Import a portable session log into this workspace
  maestro import ./session.jsonl`,
	)}`;
	const env = `${sectionHeading("Environment Variables:")}${muted(
		`  GEMINI_API_KEY          - Google Gemini API key
  OPENAI_API_KEY          - OpenAI API key
  ANTHROPIC_API_KEY       - Anthropic API key
  CLAUDE_CODE_TOKEN       - Claude Code access token for --auth claude
  ANTHROPIC_OAUTH_TOKEN   - Alternate env for Claude Code bearer tokens
  MAESTRO_AGENT_DIR      - Session storage directory (default: ~/.maestro/agent)
  MAESTRO_SANDBOX_MODE   - Sandbox mode: docker, local, none (default: none)
  MAESTRO_CHANGELOG      - Set to off/false/hide/hidden/skip/0 to hide startup changelog banner
  MAESTRO_TUI_MINIMAL    - Set to 1/true to disable animations and reduce TUI effects (SSH-friendly)
  MAESTRO_TUI_TOOL_MAX_CHARS - Max chars shown per tool output panel (0 = unlimited)
  MAESTRO_TUI_TOOL_MAX_LINES - Max lines shown per tool output panel (0 = unlimited)
  MAESTRO_MEMORY_BASE - Durable memory service base URL
  MAESTRO_MEMORY_ACCESS_TOKEN - Override bearer token for durable memory service
  MAESTRO_MEMORY_TEAM_ID - Optional team scope for durable memory service
  MAESTRO_SHARED_MEMORY_BASE - Shared memory base URL (Cloudflare Durable Objects worker)
  MAESTRO_SHARED_MEMORY_API_KEY - API key for shared memory service
  CODING_AGENT_DIR        - Legacy session directory override (fallback)`,
	)}`;
	const execSection = `${sectionHeading("maestro exec")}${muted(
		`  maestro exec "Summarize recent changes" --json

  Flags:
    --json                      Stream JSONL thread/turn events
    --output-schema <file|json> Validate final assistant JSON against a schema
    --output-last-message <path> Write the final assistant message to disk
    --full-auto | --read-only   Force approval policy (auto or fail)
    --sandbox <mode>            Run in sandbox: docker, local, none
    --resume <sessionId>        Resume a prior exec session by id
    --last                      Resume the most recent exec session`,
	)}`;
	const webSection = `${sectionHeading("maestro web")}${muted(
		`  # Start the bundled web UI + API server
  maestro web

  # Use a custom port
  maestro web --port 3000`,
	)}`;
	const portabilitySection = `${sectionHeading("Session Portability")}${muted(
		`  maestro export <session-id> [output-path] --format jsonl
  maestro import <file.jsonl>

  Notes:
    - export currently supports jsonl for full-fidelity session transfer
    - import restores the session into the current workspace session directory`,
	)}`;
	const memorySection = `${sectionHeading("maestro memory")}${muted(
		`  maestro memory [status]         Show shared memory service status
  maestro memory session <id>     Show per-session metrics
  maestro memory audit <id> [n]   Show recent sync audit entries
  maestro memory export <id>      Export metrics log as JSONL
  maestro memory watch [id] [ms]  Poll status/metrics continuously`,
	)}`;
	const sessionsSection = `${sectionHeading("Session Metadata")}${muted(
		`  /session favorite|unfavorite      Toggle favorite for current session
  /session summary "<text>"         Save a manual summary for current session
  /sessions summarize <id>          Auto-summarize a saved session`,
	)}`;
	const sessionsDiscovery = `${sectionHeading("Session Commands")}${muted(
		`  /session [info|favorite|unfavorite|summary "<text>"]
  /sessions [list|load <id>|favorite <id>|unfavorite <id>|summarize <id>]
  (Also available via TUI command palette)`,
	)}`;
	const tools = `${sectionHeading("Available Tools")}${muted(
		`  read   - Read file contents
  list   - List files in a directory
  find   - Fast file search using fd (glob patterns)
  search - Search files with ripgrep-style filtering
  parallel_ripgrep - Run multiple ripgrep patterns in parallel and merge line ranges
  diff   - Show git diffs (workspace, staged, or ranges)
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  todo   - Create TodoWrite-style checklists

  Read-only tools: read,list,find,search,parallel_ripgrep,diff,status
  Example: maestro --tools read,list,find,search,parallel_ripgrep,diff "Analyze this code"`,
	)}`;

	const frameworkSection = `${sectionHeading("Framework Preference")}${muted(
		`  /framework <id>            Set default stack (fastapi, express, node)
  /framework <id> --workspace  Set workspace-scoped default
  /framework list              Show available options
  Precedence: policy (locked) > policy > env override > env default > workspace > user file > none`,
	)}`;

	console.log(
		[
			header,
			usage,
			options,
			examples,
			env,
			execSection,
			webSection,
			portabilitySection,
			memorySection,
			sessionsSection,
			sessionsDiscovery,
			`${sectionHeading("Tips")}${badge(
				"Need models?",
				"maestro models list",
				"info",
			)}`,
			frameworkSection,
			tools,
		].join("\n\n"),
	);
}
