import { badge, heading, muted, sectionHeading } from "../style/theme.js";

export function printHelp(version: string) {
	const header = `${heading("Composer")} ${muted(
		`v${version} by EvalOps — AI coding assistant with read, list, search, diff, bash, edit, write, todo tools`,
	)}`;
	const usage = `${sectionHeading("Usage")}${muted(
		"composer [options] [messages...]",
	)}`;
	const options = `${sectionHeading("Options")}${[
		"--provider <name>       Provider name (default: anthropic)",
		"--model <id>            Model ID (default: claude-sonnet-4-5)",
		"--api-key <key>         API key (defaults to env vars)",
		"--codex-api-key <key>   Codex/ChatGPT API token (defaults to CODEX_API_KEY)",
		"--system-prompt <text>  System prompt (default: coding assistant prompt)",
		"--mode <mode>           Output mode: text (default), json, or rpc",
		"--auth <mode>           Credential mode: auto (default), api-key, chatgpt, claude",
		"--approval-mode <mode>  Action approvals: prompt (default in TUI), auto, fail",
		"--continue, -c          Continue previous session",
		"--resume, -r            Select a session to resume",
		"--session <path>        Use specific session file",
		"--no-session            Don't save session (ephemeral)",
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
  CODEX_API_KEY           - Codex/ChatGPT API token for --auth chatgpt
  COMPOSER_AGENT_DIR      - Session storage directory (default: ~/.composer/agent)
  CODING_AGENT_DIR        - Legacy session directory override (fallback)`,
	)}`;
	const execSection = `${sectionHeading("composer exec")}${muted(
		`  composer exec "Summarize recent changes" --json

  Flags:
    --json                      Stream JSONL thread/turn events
    --output-schema <file|json> Validate final assistant JSON against a schema
    --output-last-message <path> Write the final assistant message to disk
    --full-auto | --read-only   Force approval policy (auto or fail)
    --sandbox danger-full-access Remove sandbox guardrails (default: safe)
    --resume <sessionId>        Resume a prior exec session by id
    --last                      Resume the most recent exec session`,
	)}`;
	const tools = `${sectionHeading("Available Tools")}${muted(
		`  read   - Read file contents
  list   - List files in a directory
  search - Search files with ripgrep-style filtering
  diff   - Show git diffs (workspace, staged, or ranges)
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  todo   - Create TodoWrite-style checklists`,
	)}`;

	console.log(
		[
			header,
			usage,
			options,
			examples,
			env,
			execSection,
			`${sectionHeading("Tips")}${badge(
				"Need models?",
				"composer models list",
				"info",
			)}`,
			tools,
		].join("\n\n"),
	);
}
