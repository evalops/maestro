import type { CommandEntry, CommandRegistryOptions } from "./types.js";

const equals = (name: string) => (input: string) => input === `/${name}`;

const withArgs = (name: string) => (input: string) =>
	input === `/${name}` || input.startsWith(`/${name} `);

const matchDiagnostics = (input: string) =>
	input === "/diag" || input.startsWith("/diag ") || input === "/diagnostics";

const matchQuit = (input: string) => input === "/quit" || input === "/exit";

export function createCommandRegistry({
	getRunScriptCompletions,
	handlers,
}: CommandRegistryOptions): CommandEntry[] {
	const entries: CommandEntry[] = [
		{
			command: {
				name: "thinking",
				description: "Select reasoning level (opens selector UI)",
			},
			matches: equals("thinking"),
			execute: () => handlers.thinking(),
		},
		{
			command: {
				name: "model",
				description: "Select model (opens selector UI)",
			},
			matches: equals("model"),
			execute: () => handlers.model(),
		},
		{
			command: {
				name: "export",
				description: "Export session to HTML file",
			},
			matches: withArgs("export"),
			execute: (input) => handlers.exportSession(input),
		},
		{
			command: {
				name: "tools",
				description: "Show available tools, failures, or clear logs",
			},
			matches: withArgs("tools"),
			execute: (input) => handlers.tools(input),
		},
		{
			command: {
				name: "import",
				description: "Import configuration (e.g. /import factory)",
			},
			matches: withArgs("import"),
			execute: (input) => handlers.importConfig(input),
		},
		{
			command: { name: "session", description: "Show session info and stats" },
			matches: equals("session"),
			execute: () => handlers.sessionInfo(),
		},
		{
			command: {
				name: "sessions",
				description: "List or load recent sessions",
			},
			matches: withArgs("sessions"),
			execute: (input) => handlers.sessions(input),
		},
		{
			command: {
				name: "bug",
				description: "Copy session info for bug reports",
			},
			matches: equals("bug"),
			execute: () => handlers.reportBug(),
		},
		{
			command: { name: "plan", description: "Show saved plans/checklists" },
			matches: withArgs("plan"),
			execute: (input) => handlers.plan(input),
		},
		{
			command: {
				name: "preview",
				description: "Preview git diff for a file",
			},
			matches: withArgs("preview"),
			execute: (input) => handlers.preview(input),
		},
		{
			command: {
				name: "diff",
				description: "Show git diff for a file",
			},
			matches: withArgs("diff"),
			execute: (input) => handlers.preview(input),
		},
		{
			command: {
				name: "status",
				description: "Show health snapshot (model, git, plan, telemetry)",
			},
			matches: equals("status"),
			execute: () => handlers.status(),
		},
		{
			command: {
				name: "review",
				description: "Summarize git status and diff stats",
			},
			matches: equals("review"),
			execute: () => handlers.review(),
		},
		{
			command: {
				name: "undo",
				description: "Discard local changes in files via git checkout",
			},
			matches: withArgs("undo"),
			execute: (input) => handlers.undoChanges(input),
		},
		{
			command: {
				name: "feedback",
				description: "Copy a feedback template with session context",
			},
			matches: equals("feedback"),
			execute: () => handlers.shareFeedback(),
		},
		{
			command: {
				name: "mention",
				description: "Search files to mention (same as @ search)",
			},
			matches: withArgs("mention"),
			execute: (input) => handlers.mention(input),
		},
		{
			command: {
				name: "run",
				description: "Run npm script (e.g. /run test --watch)",
				getArgumentCompletions: getRunScriptCompletions,
			},
			matches: withArgs("run"),
			execute: (input) => handlers.run(input),
		},
		{
			command: {
				name: "why",
				description: "Explain the last response/tools used",
			},
			matches: equals("why"),
			execute: () => handlers.why(),
		},
		{
			command: { name: "help", description: "List available slash commands" },
			matches: equals("help"),
			execute: () => handlers.help(),
		},
		{
			command: {
				name: "update",
				description: "Check for Composer CLI updates",
			},
			matches: equals("update"),
			execute: () => handlers.update(),
		},
		{
			command: {
				name: "telemetry",
				description: "Show telemetry status or toggle (on/off/reset)",
			},
			matches: withArgs("telemetry"),
			execute: (input) => handlers.telemetry(input),
		},
		{
			command: {
				name: "config",
				description: "Validate and inspect Composer configuration",
			},
			matches: withArgs("config"),
			execute: (input) => handlers.config(input),
		},
		{
			command: {
				name: "cost",
				description: "Show usage and cost summary (/cost today, /cost week)",
			},
			matches: withArgs("cost"),
			execute: (input) => handlers.cost(input),
		},
		{
			command: {
				name: "stats",
				description: "Show combined status and cost overview",
			},
			matches: equals("stats"),
			execute: () => handlers.stats(),
		},
		{
			command: {
				name: "diag",
				description: "Show provider/model/API key diagnostics",
			},
			matches: matchDiagnostics,
			execute: (input) => handlers.diagnostics(input),
		},
		{
			command: {
				name: "compact",
				description: "Summarize older messages to reclaim context",
			},
			matches: equals("compact"),
			execute: () => handlers.compact(),
		},
		{
			command: {
				name: "compact-tools",
				description: "Toggle folding of tool outputs",
			},
			matches: withArgs("compact-tools"),
			execute: (input) => handlers.compactTools(input),
		},
		{
			command: {
				name: "quit",
				description: "Exit composer (same as ctrl+c twice)",
			},
			matches: matchQuit,
			execute: () => handlers.quit(),
		},
	];

	return entries;
}
