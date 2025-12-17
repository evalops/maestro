/**
 * @fileoverview CLI Help Output Module
 *
 * This module generates and displays the `--help` output for the Composer CLI.
 * It provides a comprehensive overview of:
 *
 * - **Usage syntax** and common invocation patterns
 * - **Command-line options** for provider, model, session management, etc.
 * - **Environment variables** for API keys and configuration
 * - **Available tools** and their capabilities
 * - **Subcommands** like `composer exec` for headless execution
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
 * This function is invoked when the user runs `composer --help` or `composer -h`.
 * It formats and displays all available options, commands, and usage examples
 * using the terminal theme for consistent styling.
 *
 * @param version - The current Composer version string (e.g., "1.2.3")
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
	const header = `${heading("Composer")} ${muted(
		`v${version} by EvalOps — AI coding assistant with read, list, search, diff, bash, edit, write, todo tools`,
	)}`;
	const usage = `${sectionHeading("Usage")}${muted(
		"composer [options] [messages...]",
	)}`;
	const options = `${sectionHeading("Options")}${[
		"--provider <name>       Provider name (default: anthropic)",
		"-m, --model <id>        Model ID (default: claude-sonnet-4-5)",
		"--models <patterns>     Comma-separated patterns for Ctrl+P model cycling",
		"--tools <names>         Comma-separated tool names to enable (e.g., read,search,list,find)",
		"--api-key <key>         API key (defaults to env vars)",
		"--system-prompt <text>  System prompt (default: coding assistant prompt)",
		"--mode <mode>           Output mode: text (default), json, or rpc",
		"--auth <mode>           Credential mode: auto (default), api-key, claude",
		"--approval-mode <mode>  Action approvals: prompt (default in TUI), auto, fail",
		"--sandbox <mode>        Sandbox mode: docker, local, none (see docs/SAFETY.md)",
		"--port <n>              Port for `composer web` (defaults to PORT env or 8080)",
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
  composer

  # Single message
  composer "List all .ts files in src/"

  # Multiple messages
  composer "Read package.json" "What dependencies do we have?"

  # Continue previous session
  composer --continue "What did we discuss?"

  # Use different model
  composer --provider openai --model gpt-4o-mini "Help me refactor this code"`,
	)}`;
	const env = `${sectionHeading("Environment Variables:")}${muted(
		`  GEMINI_API_KEY          - Google Gemini API key
  OPENAI_API_KEY          - OpenAI API key
  ANTHROPIC_API_KEY       - Anthropic API key
  CLAUDE_CODE_TOKEN       - Claude Code access token for --auth claude
  ANTHROPIC_OAUTH_TOKEN   - Alternate env for Claude Code bearer tokens
  COMPOSER_AGENT_DIR      - Session storage directory (default: ~/.composer/agent)
  COMPOSER_SANDBOX_MODE   - Sandbox mode: docker, local, none (default: none)
  COMPOSER_CHANGELOG      - Set to off/false/hide/hidden/skip/0 to hide startup changelog banner
  COMPOSER_TUI_MINIMAL    - Set to 1/true to disable animations and reduce TUI effects (SSH-friendly)
  CODING_AGENT_DIR        - Legacy session directory override (fallback)`,
	)}`;
	const execSection = `${sectionHeading("composer exec")}${muted(
		`  composer exec "Summarize recent changes" --json

  Flags:
    --json                      Stream JSONL thread/turn events
    --output-schema <file|json> Validate final assistant JSON against a schema
    --output-last-message <path> Write the final assistant message to disk
    --full-auto | --read-only   Force approval policy (auto or fail)
    --sandbox <mode>            Run in sandbox: docker, local, none
    --resume <sessionId>        Resume a prior exec session by id
    --last                      Resume the most recent exec session`,
	)}`;
	const webSection = `${sectionHeading("composer web")}${muted(
		`  # Start the bundled web UI + API server
  composer web

  # Use a custom port
  composer web --port 3000`,
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
  Example: composer --tools read,list,find,search,parallel_ripgrep,diff "Analyze this code"`,
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
			sessionsSection,
			sessionsDiscovery,
			`${sectionHeading("Tips")}${badge(
				"Need models?",
				"composer models list",
				"info",
			)}`,
			frameworkSection,
			tools,
		].join("\n\n"),
	);
}
