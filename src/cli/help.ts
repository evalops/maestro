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

interface CliHelpOption {
	text: string;
	hidden?: boolean;
}

const CLI_OPTIONS: CliHelpOption[] = [
	{ text: "--provider <name>       Provider name (default: anthropic)" },
	{ text: "-m, --model <id>        Model ID (default: claude-sonnet-4-5)" },
	{ text: "--task-budget <tokens> API-side Anthropic task budget in tokens" },
	{
		text: "--models <patterns>     Comma-separated patterns for Ctrl+P model cycling",
	},
	{
		text: "--tools <names>         Comma-separated tool names to enable (e.g., read,search,list,find)",
	},
	{ text: "--api-key <key>         API key (defaults to env vars)" },
	{
		text: "--system-prompt <text>  System prompt (default: coding assistant prompt)",
	},
	{
		text: "--append-system-prompt <text>  Append instructions to the system prompt",
	},
	{ text: "--mode <mode>           Output mode: text (default), json, or rpc" },
	{
		text: "--auth <mode>           Credential mode: auto (default), api-key, claude",
	},
	{
		text: "--approval-mode <mode>  Action approvals: prompt (default in TUI), auto, fail",
	},
	{
		text: "--sandbox <mode>        Sandbox mode: read-only, workspace-write, danger-full-access, native, docker, local, none",
	},
	{
		text: "--port <n>              Port for `maestro web` (defaults to PORT env or 8080)",
	},
	{ text: "--continue, -c          Continue previous session" },
	{ text: "--resume, -r            Select a session to resume" },
	{ text: "--session <path>        Use specific session file" },
	{ text: "--no-session            Don't save session (ephemeral)" },
	{ text: "--safe-mode             Enable extra safety restrictions" },
	{
		text: "--replay <path|uri>     Open a scripted deterministic replay session",
	},
	{
		text: "--record-scenario <path> Record assistant turns as a replay fixture",
	},
	{ text: "--help, -h              Show this help" },
	{
		text: "--help-hidden          Show hidden support and staged-rollout flags",
		hidden: true,
	},
	{
		text: "--list-modes-all       List visible and hidden agent modes",
		hidden: true,
	},
];

function renderHelpOptions(options: CliHelpOption[], includeHidden: boolean) {
	return options
		.filter((option) => includeHidden || option.hidden !== true)
		.map((option) => `  ${muted(option.text)}`)
		.join("\n");
}

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
export function printHelp(
	version: string,
	options?: { includeHidden?: boolean },
) {
	const includeHidden = options?.includeHidden === true;
	const header = `${heading("Maestro")} ${muted(
		`v${version} by EvalOps — AI coding assistant with read, list, search, diff, bash, edit, write, todo tools`,
	)}`;
	const usage = `${sectionHeading("Usage")}${muted(
		"maestro [options] [messages...]",
	)}`;
	const renderedOptions = `${sectionHeading("Options")}${renderHelpOptions(
		CLI_OPTIONS,
		includeHidden,
	)}`;
	const hiddenSupportSection = includeHidden
		? `${sectionHeading("Hidden Support Flags")}${muted(
				"  Hidden flags are external support surfaces. Keep them in docs/CONVENTIONS/staged-rollout-registry.json with an owner, telemetry event, and promotion/removal target.",
			)}`
		: null;
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

  # Use Codex subscription models after \`maestro codex login\`
  maestro --provider openai-codex --model gpt-5.5 "Plan this migration"
  maestro codex doctor

  # Bootstrap EvalOps login, API key, and agent registration in one flow
  maestro init

  # Use EvalOps managed gateway models after \`maestro init\`
  maestro --provider evalops --model gpt-4o-mini "Say hello in one sentence"

  # Confirm managed mode sinks and EvalOps org identity
  maestro status

  # Explain which instruction files and MCP context sources are visible
  maestro context explain

  # Compare context sources between two workspaces
  maestro context diff ./before ./after

  # Include live MCP resources and prompts in context diagnostics
  maestro context explain --live-mcp

  # Export a portable session log
  maestro export <session-id> ./session.jsonl --format jsonl

  # Export a portable JSON archive with secret redaction
  maestro export <session-id> ./session.json --format json --redact-secrets

  # Import a portable session log into this workspace
  maestro import ./session.json

  # Scaffold and validate progressive skill packages
  maestro skill new processing-incidents --description "Process incident reports. Use when the user asks for incident triage."
  maestro skill lint .maestro/skills

  # Start a hosted EvalOps runner session and wait for attach readiness
  maestro remote start --workspace ws_123 --repo evalops/foo --branch main --ttl 90m --wait --verify

  # Run a single-session hosted runtime pod entrypoint
  maestro hosted-runner --runner-session-id mrs_abc --workspace-root /workspace --listen 0.0.0.0:8080

  # Show usage analytics for the last 7 days
  maestro stats

  # Show usage analytics for one session
  maestro stats --session <session-id>

  # Reconstruct the timeline, trajectory, and evidence coverage for a saved run
  maestro run inspect <session-id> --json
  maestro run promote <session-id>

  # Validate and run a deterministic scenario fixture
  maestro scenario validate ./test/fixtures/agent-trajectory-scenarios/local-diagnostic-success.json
  maestro scenario run ./test/fixtures/agent-trajectory-scenarios/local-diagnostic-success.json --junit ./tmp/scenario.xml

  # Open a real agent session backed by a scripted model fixture
  maestro --replay ./test/fixtures/scripted-replay/basic-tool-call.json
  maestro --replay gs://evalops-prod-maestro-scenario-fixtures/maestro/scenarios/example.json

  # Record a live run into a replayable scripted scenario
  maestro --record-scenario ./tmp/recorded-scenario.json "inspect package.json"`,
	)}`;
	const env = `${sectionHeading("Environment Variables:")}${muted(
		`  GEMINI_API_KEY          - Google Gemini API key
  OPENAI_API_KEY          - OpenAI API key
  OPENAI_CODEX_TOKEN      - OpenAI Codex ChatGPT access token
  OPENAI_CODEX_ACCOUNT_ID - ChatGPT account id when using a raw Codex token
  ANTHROPIC_API_KEY       - Anthropic API key
  CLAUDE_CODE_TOKEN       - Claude Code access token for --auth claude
  ANTHROPIC_OAUTH_TOKEN   - Alternate env for Claude Code bearer tokens
  MAESTRO_AGENT_DIR      - Session storage directory (default: ~/.maestro/agent)
  MAESTRO_SANDBOX_MODE   - Sandbox mode: read-only, workspace-write, danger-full-access
  MAESTRO_CHANGELOG      - Set to off/false/hide/hidden/skip/0 to hide startup changelog banner
  MAESTRO_TUI_MINIMAL    - Set to 1/true to disable animations and reduce TUI effects (SSH-friendly)
  MAESTRO_TUI_TOOL_MAX_CHARS - Max chars shown per tool output panel (0 = unlimited)
  MAESTRO_TUI_TOOL_MAX_LINES - Max lines shown per tool output panel (0 = unlimited)
  MAESTRO_MEMORY_BASE - Durable memory service base URL
  MAESTRO_MEMORY_ACCESS_TOKEN - Override bearer token for durable memory service
  MAESTRO_MEMORY_TEAM_ID - Optional team scope for durable memory service
  MAESTRO_SHARED_MEMORY_BASE - Shared memory base URL (Cloudflare Durable Objects worker)
  MAESTRO_SHARED_MEMORY_API_KEY - API key for shared memory service
  MAESTRO_REMOTE_RUNNER_URL - Hosted runner control-plane URL (default: https://runner.evalops.dev)
  MAESTRO_REMOTE_RUNNER_TOKEN - Hosted runner bearer token override
  MAESTRO_REMOTE_RUNNER_ORG_ID - EvalOps organization id for hosted runner sessions
  MAESTRO_REMOTE_RUNNER_WORKSPACE_ID - EvalOps workspace id for hosted runner sessions
  CODING_AGENT_DIR        - Legacy session directory override (fallback)`,
	)}`;
	const execSection = `${sectionHeading("maestro exec")}${muted(
		`  maestro exec "Summarize recent changes" --json

  Flags:
    --json                      Stream JSONL thread/turn events
    --output-schema <file|json> Validate final assistant JSON against a schema
    --output-last-message <path> Write the final assistant message to disk
    --full-auto | --read-only   Force approval policy (auto or fail)
    --sandbox <mode>            Run in sandbox: read-only, workspace-write, danger-full-access, native, docker, local, none
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
		`  maestro export <session-id> [output-path] --format json|jsonl [--redact-secrets]
  maestro import <file.json|file.jsonl>

  Notes:
    - json preserves the full session in a portable wrapper object
    - jsonl preserves the append-only session log verbatim unless redaction is requested
    - --redact-secrets scrubs detected credentials from exported payloads
    - import restores the session into the current workspace session directory`,
	)}`;
	const memorySection = `${sectionHeading("maestro memory")}${muted(
		`  maestro memory [status]         Show shared memory service status
  maestro memory session <id>     Show per-session metrics
  maestro memory audit <id> [n]   Show recent sync audit entries
  maestro memory export <id>      Export metrics log as JSONL
  maestro memory watch [id] [ms]  Poll status/metrics continuously`,
	)}`;
	const skillSection = `${sectionHeading("maestro skill")}${muted(
		`  maestro skill list                 List available progressive skills
  maestro skill inspect <name>       Print one skill package manifest
  maestro skill install <source>     Validate and install an OSS skill package
  maestro skill publish-check <src>  Validate an OSS skill package for publishing
  maestro skill new <name>           Scaffold SKILL.md, reference/, scripts/, toolbox/, and mcp.json.example
  maestro skill lint [path...]       Validate frontmatter, budget, mcp.json includeTools, and toolbox shape`,
	)}`;
	const remoteSection = `${sectionHeading("maestro remote")}${muted(
		`  maestro remote start --workspace <id> --repo <repo> --branch <branch> [--ttl 90m] [--wait] [--verify]
  maestro remote list --workspace <id> [--state running]
  maestro remote attach <session-id> [--verify] [--print-env]
  maestro remote extend <session-id> --ttl 2h
  maestro remote stop <session-id> [--reason <text>]`,
	)}`;
	const operatingPlaneSection = `${sectionHeading("maestro operating-plane")}${muted(
		`  maestro operating-plane status --thread-id <slack-thread> [--evidence-id <id>] [--auth-subject <subject>]
  maestro operating-plane status --trace-id <id> --json

  Fetches the Platform operating-plane ledger and prints a content-free value
  proof report with identity, model/tool/approval/trace/evidence/cost status,
  allowed evidence ids/revisions, blockers, next actions, and withheld reasons.`,
	)}`;
	const runSection = `${sectionHeading("maestro run")}${muted(
		`  maestro run inspect <session-id> [--json]
  maestro run ledger <session-id>
  maestro run replay <session-id>
  maestro run promote <session-id>

  Reconstructs a saved session into a timeline plus canonical agent trajectory
  with prompt, tool, file-change, artifact, policy, diagnostic, compaction,
  pending-wait, and MCP-context coverage. The ledger/replay/promote commands
  expose the local AgentRuntime projection and dry-run Platform promotion plan.`,
	)}`;
	const initSection = `${sectionHeading("maestro init")}${muted(
		`  maestro init                         Login, create or reuse an API key, and register this agent
  maestro init --rotate-key           Replace the stored agent MCP API key
  maestro init --mcp-url <url>        Override the EvalOps agent MCP endpoint
  maestro init --capability code:write Declare an agent-registry capability
  maestro init --json                 Emit machine-readable bootstrap output`,
	)}`;
	const hostedRunnerSection = `${sectionHeading("maestro hosted-runner")}${muted(
		`  maestro hosted-runner --runner-session-id <id> --workspace-root <path> [--listen 0.0.0.0:8080]

  Env mode:
    MAESTRO_RUNNER_SESSION_ID=mrs_abc MAESTRO_WORKSPACE_ROOT=/workspace maestro hosted-runner`,
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
			renderedOptions,
			hiddenSupportSection,
			examples,
			env,
			execSection,
			webSection,
			portabilitySection,
			memorySection,
			skillSection,
			initSection,
			runSection,
			remoteSection,
			operatingPlaneSection,
			hostedRunnerSection,
			sessionsSection,
			sessionsDiscovery,
			`${sectionHeading("Tips")}${badge(
				"Need models?",
				"maestro models list",
				"info",
			)}`,
			frameworkSection,
			tools,
		]
			.filter((section): section is string => section !== null)
			.join("\n\n"),
	);
}
