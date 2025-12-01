export type WebSlashCommand = {
	name: string;
	description: string;
	usage: string;
	tags?: string[];
};

export const WEB_SLASH_COMMANDS: WebSlashCommand[] = [
	{
		name: "help",
		description: "List commands",
		usage: "/help",
		tags: ["support"],
	},
	{
		name: "run",
		description: "Run npm script",
		usage: "/run <script>",
		tags: ["automation"],
	},
	{
		name: "diff",
		description: "Show git diff",
		usage: "/diff <path>",
		tags: ["git"],
	},
	{
		name: "review",
		description: "Summarize git status/diff",
		usage: "/review",
		tags: ["git"],
	},
	{
		name: "plan",
		description: "Show saved plans",
		usage: "/plan",
		tags: ["planning"],
	},
	{
		name: "model",
		description: "Select model",
		usage: "/model",
		tags: ["session"],
	},
	{ name: "theme", description: "Select theme", usage: "/theme", tags: ["ui"] },
	{
		name: "config",
		description: "Inspect config",
		usage: "/config",
		tags: ["config"],
	},
	{
		name: "cost",
		description: "Show usage/cost",
		usage: "/cost",
		tags: ["usage"],
	},
	{
		name: "telemetry",
		description: "Toggle telemetry",
		usage: "/telemetry [on|off]",
		tags: ["diagnostics"],
	},
	{
		name: "approvals",
		description: "Set approval mode",
		usage: "/approvals [auto|prompt|fail]",
		tags: ["safety"],
	},
	{
		name: "queue",
		description: "Manage prompt queue",
		usage: "/queue [list|mode]",
		tags: ["planning"],
	},
	{ name: "new", description: "New session", usage: "/new", tags: ["session"] },
];
