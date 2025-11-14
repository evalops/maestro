import chalk from "chalk";

export function printHelp(version: string) {
	console.log(`${chalk.bold("Playwright")} v${version} by EvalOps - AI coding assistant with read, bash, edit, write, list tools

${chalk.bold("Usage:")}
  playwright [options] [messages...]

${chalk.bold("Options:")}
  --provider <name>       Provider name (default: anthropic)
  --model <id>            Model ID (default: claude-sonnet-4-5)
  --api-key <key>         API key (defaults to env vars)
  --system-prompt <text>  System prompt (default: coding assistant prompt)
  --mode <mode>           Output mode: text (default), json, or rpc
  --continue, -c          Continue previous session
  --resume, -r            Select a session to resume
  --session <path>        Use specific session file
  --no-session            Don't save session (ephemeral)
  --help, -h              Show this help

${chalk.bold("Examples:")}
  # Interactive mode (no messages = interactive TUI)
  playwright

  # Single message
  playwright "List all .ts files in src/"

  # Multiple messages
  playwright "Read package.json" "What dependencies do we have?"

  # Continue previous session
  playwright --continue "What did we discuss?"

  # Use different model
  playwright --provider openai --model gpt-4o-mini "Help me refactor this code"

${chalk.bold("Environment Variables:")}
  GEMINI_API_KEY          - Google Gemini API key
  OPENAI_API_KEY          - OpenAI API key
  ANTHROPIC_API_KEY       - Anthropic API key
  PLAYWRIGHT_AGENT_DIR    - Session storage directory (default: ~/.playwright/agent)
  CODING_AGENT_DIR        - Legacy session directory override (fallback)

${chalk.bold("Available Tools:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  list   - List files in a directory
`);
}
