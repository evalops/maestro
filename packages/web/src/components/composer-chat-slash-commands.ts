import type {
	ApiClient,
	McpOfficialRegistryEntry,
	McpRegistryImportRequest,
	McpRegistryImportResponse,
	McpStatus,
} from "../services/api-client.js";
import {
	WEB_SLASH_COMMANDS,
	type WebSlashCommand,
	findCustomWebSlashCommand,
	renderCustomWebSlashCommand,
} from "./slash-commands.js";

type WebSlashCommandApiClient = Pick<
	ApiClient,
	| "cancelQueuedPrompt"
	| "createBranch"
	| "enterPlanMode"
	| "exitPlanMode"
	| "getApprovalMode"
	| "getConfig"
	| "getDiagnostics"
	| "getFiles"
	| "getMcpStatus"
	| "getPlan"
	| "getPreview"
	| "getQueueStatus"
	| "getReview"
	| "getRunScripts"
	| "importMcpRegistry"
	| "getStats"
	| "getStatus"
	| "getTelemetryStatus"
	| "getUsage"
	| "listBranchOptions"
	| "listQueue"
	| "runScript"
	| "saveConfig"
	| "searchMcpRegistry"
	| "setApprovalMode"
	| "setCleanMode"
	| "setFooterMode"
	| "setModel"
	| "setQueueMode"
	| "setTelemetry"
	| "setZenMode"
	| "updatePlan"
>;

type CommandOutputAppender = (output: string, isError?: boolean) => void;

type ApprovalModeStatusUpdate = {
	mode: "auto" | "prompt" | "fail";
	message?: string;
	notify?: boolean;
	sessionId?: string | null;
};

export interface WebSlashCommandContext {
	apiClient: WebSlashCommandApiClient;
	appendCommandOutput: CommandOutputAppender;
	applyTheme: (theme: "dark" | "light") => void;
	applyZenMode: (enabled: boolean) => void;
	commands: WebSlashCommand[];
	createNewSession: () => Promise<void>;
	currentSessionId: string | null;
	isSharedSession: boolean;
	openCommandDrawer: () => void;
	openModelSelector: () => void;
	selectSession: (sessionId: string) => Promise<void>;
	setApprovalModeStatus: (status: ApprovalModeStatusUpdate) => void;
	setCleanMode: (mode: "off" | "soft" | "aggressive") => void;
	setCurrentModel: (model: string) => void;
	setFooterMode: (mode: "ensemble" | "solo") => void;
	setInputValue: (text: string) => void;
	setQueueMode: (mode: "one" | "all") => void;
	setTransportPreference: (mode: "auto" | "sse" | "ws") => void;
	theme: "dark" | "light";
	updateModelMeta: () => Promise<void> | void;
	zenMode: boolean;
}

function formatSlashCommandSummary(command: WebSlashCommand): string {
	const suffix =
		command.source === "custom"
			? " [custom]"
			: command.supported === false
				? " [CLI only]"
				: "";
	return `/${command.name} — ${command.description}${suffix}`;
}

function runCustomSlashCommand(
	command: WebSlashCommand,
	args: string,
	context: WebSlashCommandContext,
): boolean {
	const rendered = renderCustomWebSlashCommand(command, args);
	if (!rendered.ok) {
		context.appendCommandOutput(rendered.error, true);
		return true;
	}
	context.setInputValue(rendered.prompt);
	context.appendCommandOutput(
		`Inserted command "${command.name}". Edit then submit.`,
	);
	return true;
}

function getPreviewDiffText(
	preview: Record<string, unknown> | null | undefined,
) {
	return typeof preview?.diff === "string" && preview.diff.length > 0
		? preview.diff
		: typeof preview?.message === "string"
			? preview.message
			: "No changes.";
}

export function formatCommandCodeBlock(
	content: string,
	language = "text",
	maxLen = 20000,
): string {
	const trimmed =
		content.length > maxLen
			? `${content.slice(0, maxLen)}\n... (truncated)`
			: content;
	return `\`\`\`${language}\n${trimmed}\n\`\`\``;
}

export function formatCommandJsonBlock(data: unknown): string {
	return formatCommandCodeBlock(JSON.stringify(data, null, 2), "json");
}

function tokenizeSlashArgs(input: string): string[] {
	const matches = input.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) ?? [];
	return matches.map((token) => {
		if (
			(token.startsWith('"') && token.endsWith('"')) ||
			(token.startsWith("'") && token.endsWith("'"))
		) {
			return token.slice(1, -1);
		}
		return token;
	});
}

function formatMcpStatusBlock(status: McpStatus): string {
	if (status.servers.length === 0) {
		return "No MCP servers configured.";
	}

	const lines: string[] = ["MCP Servers", ""];
	for (const server of status.servers) {
		lines.push(
			`- ${server.name}: ${server.connected ? "connected" : "disconnected"}`,
		);
		if (server.transport) {
			lines.push(`  transport: ${server.transport}`);
		}
		if (server.scope) {
			lines.push(`  scope: ${server.scope}`);
		}
		if (server.remoteUrl) {
			lines.push(`  remote: ${server.remoteUrl}`);
		}
		if (server.remoteTrust) {
			lines.push(`  trust: ${server.remoteTrust}`);
		}
		if (server.officialRegistry?.displayName) {
			lines.push(`  official: ${server.officialRegistry.displayName}`);
		}
		if (server.error) {
			lines.push(`  error: ${server.error}`);
		}
	}

	return lines.join("\n");
}

function getRegistryEntryId(
	entry: Pick<McpOfficialRegistryEntry, "slug" | "serverName">,
): string | undefined {
	return entry.slug ?? entry.serverName;
}

function formatMcpRegistrySearchBlock(
	query: string,
	entries: McpOfficialRegistryEntry[],
): string {
	if (entries.length === 0) {
		return query
			? `No official MCP registry matches for "${query}".`
			: "No official MCP registry entries available.";
	}

	const lines: string[] = [
		query
			? `Official MCP registry matches for "${query}"`
			: "Official MCP registry",
		"",
	];

	for (const [index, entry] of entries.entries()) {
		lines.push(`${index + 1}. ${entry.displayName}`);
		const entryId = getRegistryEntryId(entry);
		if (entryId) {
			lines.push(`   id: ${entryId}`);
		}
		if (entry.transport) {
			lines.push(`   transport: ${entry.transport}`);
		}
		if (entry.url) {
			lines.push(`   url: ${entry.url}`);
		} else if (entry.urlOptions?.[0]?.url) {
			lines.push(`   url: ${entry.urlOptions[0].url}`);
		}
		if (entry.oneLiner) {
			lines.push(`   summary: ${entry.oneLiner}`);
		}
		if (entry.documentationUrl) {
			lines.push(`   docs: ${entry.documentationUrl}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

function formatMcpImportResult(result: McpRegistryImportResponse): string {
	return [
		`Imported official MCP server "${result.name}"`,
		`scope: ${result.scope}`,
		`path: ${result.path}`,
		`source: ${result.entry.displayName}`,
		`remote: ${result.server.url}`,
		`transport: ${result.server.transport}`,
	].join("\n");
}

function parseMcpImportArgs(
	args: string,
):
	| { ok: true; request: McpRegistryImportRequest }
	| { ok: false; error: string } {
	const tokens = tokenizeSlashArgs(args);
	if (tokens[0]?.toLowerCase() !== "import") {
		return {
			ok: false,
			error:
				"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
		};
	}

	let query: string | undefined;
	let name: string | undefined;
	let scope: McpRegistryImportRequest["scope"];
	let url: string | undefined;
	let transport: McpRegistryImportRequest["transport"];

	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--scope") {
			const value = tokens[index + 1];
			if (!value || !["local", "project", "user"].includes(value)) {
				return {
					ok: false,
					error:
						"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
				};
			}
			scope = value as McpRegistryImportRequest["scope"];
			index += 1;
			continue;
		}
		if (token === "--url") {
			const value = tokens[index + 1];
			if (!value) {
				return {
					ok: false,
					error:
						"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
				};
			}
			url = value;
			index += 1;
			continue;
		}
		if (token === "--transport") {
			const value = tokens[index + 1];
			if (!value || !["http", "sse"].includes(value)) {
				return {
					ok: false,
					error:
						"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
				};
			}
			transport = value as McpRegistryImportRequest["transport"];
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return {
				ok: false,
				error:
					"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
			};
		}
		if (!query) {
			query = token;
			continue;
		}
		if (!name) {
			name = token;
			continue;
		}
		return {
			ok: false,
			error:
				"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
		};
	}

	if (!query) {
		return {
			ok: false,
			error:
				"Usage: /mcp import <id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse]",
		};
	}

	return {
		ok: true,
		request: {
			query,
			name,
			scope,
			url,
			transport,
		},
	};
}

export async function executeWebSlashCommand(
	command: string,
	args: string,
	context: WebSlashCommandContext,
) {
	const sessionId = context.currentSessionId ?? "default";

	const requireWritableSession = (label: string): boolean => {
		if (!context.isSharedSession) return true;
		context.appendCommandOutput(
			`${label} is disabled in shared sessions.`,
			true,
		);
		return false;
	};

	const customCommand = findCustomWebSlashCommand(context.commands, command);
	if (customCommand) {
		runCustomSlashCommand(customCommand, args, context);
		return;
	}

	try {
		switch (command) {
			case "help": {
				const commands = context.commands.length
					? context.commands
					: WEB_SLASH_COMMANDS;
				const lines = commands.map(formatSlashCommandSummary);
				context.appendCommandOutput(formatCommandCodeBlock(lines.join("\n")));
				break;
			}
			case "stats": {
				let stats: Record<string, unknown> | null = null;
				try {
					stats = await context.apiClient.getStats();
				} catch {
					stats = null;
				}
				const hasStats =
					stats &&
					typeof stats === "object" &&
					("status" in stats || "usage" in stats);
				if (hasStats) {
					context.appendCommandOutput(formatCommandJsonBlock(stats));
					break;
				}
				const [status, usage] = await Promise.all([
					context.apiClient.getStatus(),
					context.apiClient.getUsage(),
				]);
				context.appendCommandOutput(
					formatCommandJsonBlock({
						status,
						usage,
						updatedAt: Date.now(),
					}),
				);
				break;
			}
			case "status": {
				const status = await context.apiClient.getStatus();
				context.appendCommandOutput(formatCommandJsonBlock(status));
				break;
			}
			case "diag": {
				const sub = args || "status";
				const diag = await context.apiClient.getDiagnostics(sub);
				context.appendCommandOutput(formatCommandJsonBlock(diag));
				break;
			}
			case "run": {
				if (!requireWritableSession("Run commands")) break;
				if (!args) {
					const scripts = await context.apiClient.getRunScripts();
					context.appendCommandOutput(
						scripts.length
							? formatCommandCodeBlock(scripts.join("\n"))
							: "No scripts found in package.json.",
					);
					break;
				}
				const [script, ...argParts] = args.split(/\s+/);
				if (!script) {
					context.appendCommandOutput("Usage: /run <script> [-- args]", true);
					break;
				}
				const result = await context.apiClient.runScript(
					script,
					argParts.join(" ").trim() || undefined,
				);
				const outputParts = [
					`Command: ${result.command ?? `npm run ${script}`}`,
					`Exit: ${result.exitCode}`,
				];
				if (result.stdout) {
					outputParts.push("", "stdout:", result.stdout);
				}
				if (result.stderr) {
					outputParts.push("", "stderr:", result.stderr);
				}
				context.appendCommandOutput(
					formatCommandCodeBlock(outputParts.join("\n")),
					!result.success,
				);
				break;
			}
			case "mcp": {
				const tokens = tokenizeSlashArgs(args);
				const sub = tokens[0]?.toLowerCase() ?? "status";

				if (["", "status", "st", "list"].includes(sub)) {
					const status = await context.apiClient.getMcpStatus();
					context.appendCommandOutput(
						formatCommandCodeBlock(formatMcpStatusBlock(status)),
					);
					break;
				}

				if (sub === "search") {
					const query = args.replace(/^search\b/i, "").trim();
					const result = await context.apiClient.searchMcpRegistry(query);
					context.appendCommandOutput(
						formatCommandCodeBlock(
							formatMcpRegistrySearchBlock(result.query, result.entries),
						),
					);
					break;
				}

				if (sub === "import") {
					if (!requireWritableSession("MCP import")) break;
					const parsed = parseMcpImportArgs(args);
					if (!parsed.ok) {
						context.appendCommandOutput(parsed.error, true);
						break;
					}
					const result = await context.apiClient.importMcpRegistry(
						parsed.request,
					);
					context.appendCommandOutput(
						formatCommandCodeBlock(formatMcpImportResult(result)),
					);
					break;
				}

				if (["help", "-h", "--help", "?"].includes(sub)) {
					context.appendCommandOutput(
						formatCommandCodeBlock(
							[
								"/mcp",
								"/mcp status",
								"/mcp search [query]",
								"/mcp import <id> [name] [--scope local|project|user]",
							].join("\n"),
						),
					);
					break;
				}

				context.appendCommandOutput(
					"Usage: /mcp [status|search <query>|import <id> [name]]",
					true,
				);
				break;
			}
			case "diff": {
				if (!requireWritableSession("Diff")) break;
				if (args) {
					const preview = await context.apiClient.getPreview(args);
					context.appendCommandOutput(
						formatCommandCodeBlock(getPreviewDiffText(preview), "diff"),
					);
				} else {
					const review = await context.apiClient.getReview();
					const parts = [
						typeof review.status === "string" ? `Status: ${review.status}` : "",
						typeof review.diffStat === "string"
							? `Diff stat:\n${review.diffStat}`
							: "",
						typeof review.worktreeDiff === "string"
							? `Worktree diff:\n${review.worktreeDiff}`
							: "",
					].filter(Boolean);
					context.appendCommandOutput(
						formatCommandCodeBlock(parts.join("\n\n")),
					);
				}
				break;
			}
			case "review": {
				if (!requireWritableSession("Review")) break;
				const review = await context.apiClient.getReview();
				const parts = [
					typeof review.status === "string" ? `Status:\n${review.status}` : "",
					typeof review.diffStat === "string"
						? `Diff stat:\n${review.diffStat}`
						: "",
					typeof review.stagedDiff === "string"
						? `Staged diff:\n${review.stagedDiff}`
						: "",
					typeof review.worktreeDiff === "string"
						? `Worktree diff:\n${review.worktreeDiff}`
						: "",
				].filter(Boolean);
				context.appendCommandOutput(formatCommandCodeBlock(parts.join("\n\n")));
				break;
			}
			case "git": {
				if (!requireWritableSession("Git")) break;
				const tokens = args.split(/\s+/).filter(Boolean);
				const sub = tokens[0]?.toLowerCase() ?? "status";
				if (["", "status", "st"].includes(sub)) {
					const review = await context.apiClient.getReview();
					const status =
						typeof review.status === "string" && review.status
							? review.status
							: "No git status available.";
					context.appendCommandOutput(formatCommandCodeBlock(status, "text"));
					break;
				}
				if (["diff", "d"].includes(sub)) {
					const path = tokens.slice(1).join(" ").trim();
					if (path) {
						const preview = await context.apiClient.getPreview(path);
						context.appendCommandOutput(
							formatCommandCodeBlock(getPreviewDiffText(preview), "diff"),
						);
					} else {
						const review = await context.apiClient.getReview();
						const parts = [
							typeof review.status === "string"
								? `Status: ${review.status}`
								: "",
							typeof review.diffStat === "string"
								? `Diff stat:\n${review.diffStat}`
								: "",
							typeof review.worktreeDiff === "string"
								? `Worktree diff:\n${review.worktreeDiff}`
								: "",
						].filter(Boolean);
						context.appendCommandOutput(
							formatCommandCodeBlock(parts.join("\n\n")),
						);
					}
					break;
				}
				if (["review", "summary"].includes(sub)) {
					const review = await context.apiClient.getReview();
					const parts = [
						typeof review.status === "string"
							? `Status:\n${review.status}`
							: "",
						typeof review.diffStat === "string"
							? `Diff stat:\n${review.diffStat}`
							: "",
						typeof review.stagedDiff === "string"
							? `Staged diff:\n${review.stagedDiff}`
							: "",
						typeof review.worktreeDiff === "string"
							? `Worktree diff:\n${review.worktreeDiff}`
							: "",
					].filter(Boolean);
					context.appendCommandOutput(
						formatCommandCodeBlock(parts.join("\n\n")),
					);
					break;
				}
				if (["help", "-h", "--help", "?"].includes(sub)) {
					context.appendCommandOutput(
						formatCommandCodeBlock(
							["/git", "/git status", "/git diff [path]", "/git review"].join(
								"\n",
							),
						),
					);
					break;
				}
				context.appendCommandOutput(
					"Usage: /git [status|diff <path>|review]",
					true,
				);
				break;
			}
			case "plan": {
				if (!requireWritableSession("Plan")) break;
				const tokens = args.split(/\s+/).filter(Boolean);
				if (tokens[0] === "on" || tokens[0] === "enter") {
					const name = tokens.slice(1).join(" ") || undefined;
					const result = await context.apiClient.enterPlanMode(name, sessionId);
					context.appendCommandOutput(formatCommandJsonBlock(result));
					break;
				}
				if (tokens[0] === "off" || tokens[0] === "exit") {
					const result = await context.apiClient.exitPlanMode();
					context.appendCommandOutput(formatCommandJsonBlock(result));
					break;
				}
				if (tokens[0] === "update") {
					const content = tokens.slice(1).join(" ");
					if (!content) {
						context.appendCommandOutput("Usage: /plan update <content>", true);
						break;
					}
					const result = await context.apiClient.updatePlan(content);
					context.appendCommandOutput(formatCommandJsonBlock(result));
					break;
				}
				const plan = await context.apiClient.getPlan();
				const summary = [
					plan.state?.active
						? `Active: ${plan.state.name ?? plan.state.filePath}`
						: "Inactive",
					plan.content ? plan.content : "",
				].filter(Boolean);
				context.appendCommandOutput(
					formatCommandCodeBlock(summary.join("\n\n")),
				);
				break;
			}
			case "branch": {
				if (!requireWritableSession("Branching")) break;
				if (!context.currentSessionId) {
					context.appendCommandOutput("Select a session first.", true);
					break;
				}
				if (!args || args === "list") {
					const options = await context.apiClient.listBranchOptions(
						context.currentSessionId,
					);
					const lines = options.userMessages.map(
						(entry) => `#${entry.number} (${entry.index}): ${entry.snippet}`,
					);
					context.appendCommandOutput(
						lines.length
							? formatCommandCodeBlock(lines.join("\n"))
							: "No branch points found.",
					);
					break;
				}
				const parsed = Number.parseInt(args, 10);
				if (Number.isNaN(parsed)) {
					context.appendCommandOutput("Usage: /branch [list|<message#>]", true);
					break;
				}
				const result = await context.apiClient.createBranch(
					context.currentSessionId,
					{
						userMessageNumber: parsed,
					},
				);
				context.appendCommandOutput(formatCommandJsonBlock(result));
				if (result?.newSessionId) {
					await context.selectSession(result.newSessionId);
				}
				break;
			}
			case "model": {
				if (!requireWritableSession("Model selection")) break;
				if (args) {
					await context.apiClient.setModel(args);
					context.setCurrentModel(args);
					await context.updateModelMeta();
					context.appendCommandOutput(`Model set to ${args}`);
				} else {
					context.openModelSelector();
				}
				break;
			}
			case "theme": {
				const next =
					args === "light" || args === "dark"
						? (args as "light" | "dark")
						: context.theme === "dark"
							? "light"
							: "dark";
				context.applyTheme(next);
				context.appendCommandOutput(`Theme set to ${next}.`);
				break;
			}
			case "zen": {
				if (!requireWritableSession("Zen mode")) break;
				const next =
					args === "on" ? true : args === "off" ? false : !context.zenMode;
				const result = await context.apiClient.setZenMode(sessionId, next);
				const enabled =
					typeof result?.enabled === "boolean" ? result.enabled : next;
				context.applyZenMode(enabled);
				context.appendCommandOutput(
					`Zen mode ${enabled ? "enabled" : "disabled"}.`,
				);
				break;
			}
			case "clean": {
				if (!requireWritableSession("Clean mode")) break;
				const mode = (args || "off").toLowerCase() as
					| "off"
					| "soft"
					| "aggressive";
				if (!["off", "soft", "aggressive"].includes(mode)) {
					context.appendCommandOutput(
						"Usage: /clean [off|soft|aggressive]",
						true,
					);
					break;
				}
				const result = await context.apiClient.setCleanMode(mode, sessionId);
				context.setCleanMode(result.cleanMode);
				context.appendCommandOutput(`Clean mode set to ${result.cleanMode}.`);
				break;
			}
			case "footer": {
				if (!requireWritableSession("Footer mode")) break;
				const mode = (args || "").toLowerCase() as "ensemble" | "solo";
				if (!["ensemble", "solo"].includes(mode)) {
					context.appendCommandOutput("Usage: /footer [ensemble|solo]", true);
					break;
				}
				const result = await context.apiClient.setFooterMode(mode, sessionId);
				context.setFooterMode(result.footerMode);
				context.appendCommandOutput(`Footer mode set to ${result.footerMode}.`);
				break;
			}
			case "config": {
				if (!requireWritableSession("Config")) break;
				if (args.startsWith("set ")) {
					const jsonText = args.replace(/^set\s+/, "");
					let config: Record<string, unknown>;
					try {
						config = JSON.parse(jsonText) as Record<string, unknown>;
					} catch {
						context.appendCommandOutput(
							'Usage: /config set {"key":"value"}',
							true,
						);
						break;
					}
					try {
						await context.apiClient.saveConfig({ config });
						context.appendCommandOutput("Config updated.");
					} catch (error) {
						const message =
							error instanceof Error && error.message
								? error.message
								: "Failed to update config.";
						context.appendCommandOutput(message, true);
					}
					break;
				}
				const config = await context.apiClient.getConfig();
				context.appendCommandOutput(
					formatCommandCodeBlock(
						[
							`Config path: ${config.configPath}`,
							"",
							JSON.stringify(config.config, null, 2),
						].join("\n"),
						"json",
					),
				);
				break;
			}
			case "files": {
				const files = await context.apiClient.getFiles();
				const listed = args
					? files.filter((file) =>
							file.toLowerCase().includes(args.toLowerCase()),
						)
					: files;
				const limited = listed.slice(0, 200);
				context.appendCommandOutput(
					limited.length
						? formatCommandCodeBlock(limited.join("\n"))
						: "No files found.",
				);
				break;
			}
			case "commands": {
				const tokens = args.split(/\s+/).filter(Boolean);
				const customCommands = context.commands.filter(
					(command) => command.source === "custom",
				);
				if (tokens.length === 0) {
					context.openCommandDrawer();
					break;
				}
				if (tokens[0] === "list") {
					if (customCommands.length === 0) {
						context.appendCommandOutput("No custom commands available.");
						break;
					}
					const lines = customCommands.map(
						(command) => `• ${command.name} — ${command.description}`,
					);
					context.appendCommandOutput(formatCommandCodeBlock(lines.join("\n")));
					break;
				}
				if (tokens[0] === "run") {
					const name = tokens[1];
					if (!name) {
						context.appendCommandOutput(
							"Usage: /commands run <name> arg=value ...",
							true,
						);
						break;
					}
					const target = findCustomWebSlashCommand(context.commands, name);
					if (!target) {
						context.appendCommandOutput(`Command ${name} not found.`, true);
						break;
					}
					runCustomSlashCommand(target, tokens.slice(2).join(" "), context);
					break;
				}
				context.appendCommandOutput(
					"Usage: /commands | /commands list | /commands run <name> arg=value ...",
					true,
				);
				break;
			}
			case "history":
			case "toolhistory":
			case "skills":
			case "limits": {
				context.appendCommandOutput(
					"Not supported in the web UI yet. Use the CLI/TUI for this command.",
					true,
				);
				break;
			}
			case "cost": {
				const usage = await context.apiClient.getUsage();
				context.appendCommandOutput(
					usage ? formatCommandJsonBlock(usage) : "No usage data.",
				);
				break;
			}
			case "telemetry": {
				if (!requireWritableSession("Telemetry")) break;
				if (args === "on" || args === "off" || args === "reset") {
					const result = await context.apiClient.setTelemetry(args);
					context.appendCommandOutput(formatCommandJsonBlock(result));
				} else {
					const status = await context.apiClient.getTelemetryStatus();
					context.appendCommandOutput(formatCommandJsonBlock(status));
				}
				break;
			}
			case "approvals": {
				if (!requireWritableSession("Approvals")) break;
				if (args === "auto" || args === "prompt" || args === "fail") {
					const result = await context.apiClient.setApprovalMode(
						args,
						context.currentSessionId ?? "default",
					);
					context.setApprovalModeStatus({
						mode: result.mode,
						message: result.message,
						notify: true,
						sessionId: context.currentSessionId,
					});
					context.appendCommandOutput(formatCommandJsonBlock(result));
				} else {
					const status = await context.apiClient.getApprovalMode(
						context.currentSessionId ?? "default",
					);
					context.setApprovalModeStatus({
						mode: status.mode,
						sessionId: context.currentSessionId,
					});
					context.appendCommandOutput(formatCommandJsonBlock(status));
				}
				break;
			}
			case "queue": {
				if (!requireWritableSession("Queue")) break;
				const tokens = args.split(/\s+/).filter(Boolean);
				if (tokens[0] === "list") {
					const list = await context.apiClient.listQueue(sessionId);
					const lines = list.pending.map((item) =>
						`#${item.id} ${item.text ?? ""}`.trim(),
					);
					context.appendCommandOutput(
						lines.length
							? formatCommandCodeBlock(lines.join("\n"))
							: "Queue empty.",
					);
					break;
				}
				if (tokens[0] === "mode" && tokens[1]) {
					const mode = tokens[1] === "one" ? "one" : "all";
					const result = await context.apiClient.setQueueMode(mode, sessionId);
					context.setQueueMode(result.mode);
					context.appendCommandOutput(formatCommandJsonBlock(result));
					break;
				}
				if (tokens[0] === "cancel" && tokens[1]) {
					const id = Number.parseInt(tokens[1], 10);
					if (Number.isNaN(id)) {
						context.appendCommandOutput("Usage: /queue cancel <id>", true);
						break;
					}
					const result = await context.apiClient.cancelQueuedPrompt(
						id,
						sessionId,
					);
					context.appendCommandOutput(formatCommandJsonBlock(result));
					break;
				}
				const status = await context.apiClient.getQueueStatus(sessionId);
				context.setQueueMode(status.mode);
				context.appendCommandOutput(formatCommandJsonBlock(status));
				break;
			}
			case "transport": {
				const mode = (args || "auto").toLowerCase();
				if (!["auto", "sse", "ws"].includes(mode)) {
					context.appendCommandOutput("Usage: /transport [auto|sse|ws]", true);
					break;
				}
				context.setTransportPreference(mode as "auto" | "sse" | "ws");
				context.appendCommandOutput(`Transport set to ${mode}.`);
				break;
			}
			case "new": {
				if (!requireWritableSession("New session")) break;
				await context.createNewSession();
				context.appendCommandOutput("New session created.");
				break;
			}
			default: {
				context.appendCommandOutput(
					`Unknown command: /${command}. Try /help for a list.`,
					true,
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Command failed";
		context.appendCommandOutput(message, true);
	}
}
