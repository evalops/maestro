#!/usr/bin/env node

/**
 * Slack Agent - Entry Point
 *
 * A Slack bot that runs an AI coding agent in a sandboxed environment.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { DateTime } from "luxon";
import { type AgentRunner, createAgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval.js";
import { ConnectorManager } from "./connectors/connector-manager.js";
import {
	CredentialManager,
	createCredentialGetter,
} from "./connectors/credentials.js";
import { registerBuiltInConnectors } from "./connectors/index.js";
import { WebhookTriggerManager } from "./connectors/webhook-triggers.js";
import { CostTracker } from "./cost-tracker.js";
import { FeedbackTracker } from "./feedback.js";
import * as logger from "./logger.js";
import { WorkspaceManager } from "./oauth.js";
import {
	PermissionManager,
	type SlackRole,
	getAllowedToolsForRole,
} from "./permissions.js";
import { RateLimiter, formatRateLimitMessage } from "./rate-limiter.js";
import {
	type Executor,
	type SandboxConfig,
	createExecutor,
	parseSandboxArg,
	validateSandbox,
} from "./sandbox.js";
import { type ScheduledTask, Scheduler, isValidTimezone } from "./scheduler.js";
import {
	type ReactionContext,
	SlackBot,
	type SlackContext,
} from "./slack/bot.js";
import { FileStorageBackend } from "./storage.js";
import { ChannelStore } from "./store.js";
import { ThreadMemoryManager } from "./thread-memory.js";
import { createApiServer } from "./ui/api-server.js";
import { DashboardRegistry } from "./ui/dashboard-registry.js";
import { createWebhookServer } from "./webhooks.js";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;
const SLACK_AGENT_DEFAULT_TIMEZONE =
	process.env.SLACK_AGENT_DEFAULT_TIMEZONE || "UTC";
const SLACK_AGENT_DEFAULT_ROLE = process.env.SLACK_AGENT_DEFAULT_ROLE;
const SLACK_AGENT_HISTORY_LIMIT = process.env.SLACK_AGENT_HISTORY_LIMIT;
const SLACK_AGENT_HISTORY_PAGES = process.env.SLACK_AGENT_HISTORY_PAGES;
const SLACK_AGENT_BACKFILL_ON_STARTUP =
	process.env.SLACK_AGENT_BACKFILL_ON_STARTUP;
const SLACK_AGENT_BACKFILL_CHANNELS = process.env.SLACK_AGENT_BACKFILL_CHANNELS;
const SLACK_AGENT_BACKFILL_EXCLUDE_CHANNELS =
	process.env.SLACK_AGENT_BACKFILL_EXCLUDE_CHANNELS;
const SLACK_AGENT_BACKFILL_CONCURRENCY =
	process.env.SLACK_AGENT_BACKFILL_CONCURRENCY;
const SLACK_AGENT_UI_PUBLIC_URL = process.env.SLACK_AGENT_UI_PUBLIC_URL;

type ConnectorCapabilityCategory = "read" | "write" | "delete";

function getConnectorAllowedCategoriesForRole(
	role: SlackRole,
): ConnectorCapabilityCategory[] | undefined {
	// Default: allow all categories for elevated users, read-only for regular users/viewers.
	if (role === "admin" || role === "power_user") return undefined;
	return ["read"];
}

function formatNextRun(
	task: Pick<ScheduledTask, "nextRun" | "timezone">,
): string {
	const dt = DateTime.fromISO(task.nextRun, { zone: "utc" }).setZone(
		task.timezone,
	);
	const formatted = dt.toLocaleString(DateTime.DATETIME_MED);
	return `${formatted} (${task.timezone})`;
}

function getSandboxDescription(sandbox: SandboxConfig): string {
	if (sandbox.type === "host") {
		return "host";
	}
	if (sandbox.type === "daytona") {
		const detail = sandbox.snapshot ? `:${sandbox.snapshot}` : "";
		return `daytona${detail}`;
	}
	if ("autoCreate" in sandbox && sandbox.autoCreate) {
		return `docker:auto (${sandbox.image || "node:20-slim"})`;
	}
	return `docker:${sandbox.container}`;
}

function parseDefaultRole(value?: string): SlackRole | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "admin" ||
		normalized === "power_user" ||
		normalized === "user" ||
		normalized === "viewer"
	) {
		return normalized as SlackRole;
	}
	logger.logWarning("Invalid SLACK_AGENT_DEFAULT_ROLE", value);
	return undefined;
}

function parsePositiveInt(value?: string): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

function parseBoolean(value?: string, label = "value"): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
	if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
	logger.logWarning(`Invalid ${label}`, value);
	return undefined;
}

function parseCommaList(value?: string): string[] | undefined {
	if (!value) return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

function parseArgs(): { workingDir: string; sandbox: SandboxConfig } {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			const next = args[++i];
			if (!next) {
				console.error(
					"Error: --sandbox requires a value (host, docker:<name>, or docker:auto)",
				);
				process.exit(1);
			}
			sandbox = parseSandboxArg(next);
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		} else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}

	if (!workingDir) {
		printUsage();
		process.exit(1);
	}

	return { workingDir: resolve(workingDir), sandbox };
}

function printUsage(): void {
	console.error("Usage: slack-agent [--sandbox=<mode>] <working-directory>");
	console.error("");
	console.error("Options:");
	console.error(
		"  --sandbox=host                  Run tools directly on host (default, not recommended)",
	);
	console.error(
		"  --sandbox=docker:<container>    Run tools in existing Docker container",
	);
	console.error(
		"  --sandbox=docker:auto           Auto-create Docker container (recommended)",
	);
	console.error(
		"  --sandbox=docker:auto:<image>   Auto-create with specific image",
	);
	console.error(
		"  --sandbox=daytona               Cloud sandbox via Daytona (default snapshot)",
	);
	console.error(
		"  --sandbox=daytona:<snapshot>     Cloud sandbox with specific Daytona snapshot",
	);
	console.error("");
	console.error("Examples:");
	console.error("  slack-agent --sandbox=docker:auto ./data");
	console.error("  slack-agent --sandbox=docker:slack-agent-sandbox ./data");
	console.error("  slack-agent --sandbox=docker:auto:python:3.12-slim ./data");
	console.error("  slack-agent --sandbox=daytona ./data");
	console.error("  slack-agent --sandbox=daytona:my-snapshot ./data");
	console.error("");
	console.error("Environment variables:");
	console.error("  SLACK_APP_TOKEN       Slack app token (xapp-...)");
	console.error("  SLACK_BOT_TOKEN       Slack bot token (xoxb-...)");
	console.error("  ANTHROPIC_API_KEY     Anthropic API key");
	console.error("  ANTHROPIC_OAUTH_TOKEN Anthropic OAuth token (alternative)");
	console.error(
		"  DAYTONA_API_KEY       Daytona API key (required for --sandbox=daytona)",
	);
	console.error(
		"  DAYTONA_API_URL       Daytona API URL (default: https://app.daytona.io/api)",
	);
	console.error(
		"  SLACK_AGENT_DEFAULT_TIMEZONE Default timezone for schedules (IANA name, default: UTC)",
	);
	console.error(
		"  SLACK_AGENT_DEFAULT_ROLE Default role for new users (admin, power_user, user, viewer)",
	);
	console.error(
		"  SLACK_AGENT_HISTORY_LIMIT Max messages per conversations.history request (default: 15)",
	);
	console.error(
		"  SLACK_AGENT_HISTORY_PAGES Max backfill pages per channel (default: 3)",
	);
	console.error(
		"  SLACK_AGENT_BACKFILL_ON_STARTUP Toggle backfill on startup (default: true)",
	);
	console.error(
		"  SLACK_AGENT_BACKFILL_CHANNELS Comma-separated channel IDs or names to include",
	);
	console.error(
		"  SLACK_AGENT_BACKFILL_EXCLUDE_CHANNELS Comma-separated channel IDs or names to exclude",
	);
	console.error(
		"  SLACK_AGENT_BACKFILL_CONCURRENCY Number of concurrent channel backfills (default: 1)",
	);
	console.error(
		"  SLACK_AGENT_WEBHOOK_PORT         Port for webhook ingestion server (disabled if not set)",
	);
	console.error(
		"  SLACK_AGENT_WEBHOOK_CHANNEL      Default Slack channel for webhook events",
	);
	console.error(
		"  GITHUB_WEBHOOK_SECRET            Secret for verifying GitHub webhook signatures",
	);
	console.error(
		"  STRIPE_WEBHOOK_SECRET            Secret for verifying Stripe webhook signatures",
	);
	console.error(
		"  LINEAR_WEBHOOK_SECRET            Secret for verifying Linear webhook signatures",
	);
}

const { workingDir, sandbox } = parseArgs();

logger.logStartup(workingDir, getSandboxDescription(sandbox));

const workspaceManager = new WorkspaceManager(workingDir);

const uiPort = process.env.SLACK_AGENT_UI_PORT
	? Number(process.env.SLACK_AGENT_UI_PORT)
	: undefined;
const slackClientId = process.env.SLACK_CLIENT_ID;
const slackClientSecret = process.env.SLACK_CLIENT_SECRET;
const canInstallViaUi = !!(uiPort && slackClientId && slackClientSecret);

const forceMulti =
	parseBoolean(
		process.env.SLACK_AGENT_MULTI_WORKSPACE,
		"SLACK_AGENT_MULTI_WORKSPACE",
	) === true;
const hasSingleWorkspaceToken = !!SLACK_BOT_TOKEN;
const useMultiWorkspace = forceMulti || !hasSingleWorkspaceToken;
const hasAnyWorkspaceInstalled = workspaceManager.list().length > 0;

if (!SLACK_APP_TOKEN || (!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)) {
	console.error("Missing required environment variables:");
	if (!SLACK_APP_TOKEN) console.error("  - SLACK_APP_TOKEN (xapp-...)");
	if (!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)
		console.error("  - ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN");
	process.exit(1);
}

if (!useMultiWorkspace && !SLACK_BOT_TOKEN) {
	console.error("Missing required environment variables:");
	console.error("  - SLACK_BOT_TOKEN (xoxb-...)");
	console.error(
		"Or run multi-workspace mode by unsetting SLACK_BOT_TOKEN and installing via OAuth.",
	);
	process.exit(1);
}

if (useMultiWorkspace && !hasAnyWorkspaceInstalled && !canInstallViaUi) {
	console.error("Multi-workspace mode requires either:");
	console.error(
		"  - an existing workspaces.json (at least one workspace installed), or",
	);
	console.error(
		"  - SLACK_AGENT_UI_PORT + SLACK_CLIENT_ID + SLACK_CLIENT_SECRET to install via the UI.",
	);
	process.exit(1);
}

await validateSandbox(sandbox);

// Create the executor (manages container lifecycle for auto mode)
const executor: Executor = createExecutor(sandbox);

// Register built-in connector factories (explicit init, no import side effects)
registerBuiltInConnectors();

const defaultRole = parseDefaultRole(SLACK_AGENT_DEFAULT_ROLE);

type WorkspaceRuntime = {
	teamId: string;
	workingDir: string;
	botToken: string;
	store: ChannelStore;

	permissionManager: PermissionManager;
	rateLimiter: RateLimiter;
	costTracker: CostTracker;
	feedbackTracker: FeedbackTracker;
	approvalManager: ApprovalManager;
	threadMemoryManager: ThreadMemoryManager;

	credentialManager: CredentialManager;
	getConnectorCredentials: ReturnType<typeof createCredentialGetter>;
	connectorMgr: ConnectorManager;
	triggerManager: WebhookTriggerManager;
	dashboardRegistry: DashboardRegistry;
	scheduler: Scheduler;

	activeRuns: Map<
		string,
		{ runner: AgentRunner; context: SlackContext; stopContext?: SlackContext }
	>;
	startingRuns: Set<string>;
	lastContexts: Map<string, SlackContext>;
	thinkingEnabled: Map<string, boolean>;
};

const runtimes = new Map<string, WorkspaceRuntime>();
let runtimeSchedulersEnabled = false;

function resolveWorkspaceDir(teamId: string): string {
	return useMultiWorkspace
		? join(workingDir, "workspaces", teamId)
		: workingDir;
}

function resolveBotToken(teamId: string): string | null {
	if (!useMultiWorkspace) {
		return SLACK_BOT_TOKEN ?? null;
	}
	const ws = workspaceManager.get(teamId);
	if (!ws || ws.status !== "active") return null;
	return ws.botToken;
}

function getRuntime(teamId: string): WorkspaceRuntime {
	const existing = runtimes.get(teamId);
	if (existing) return existing;

	const botToken = resolveBotToken(teamId);
	if (!botToken) {
		throw new Error(`Workspace not active or not installed: ${teamId}`);
	}

	const runtimeDir = resolveWorkspaceDir(teamId);
	const permissionManager = new PermissionManager(runtimeDir, {
		...(defaultRole ? { defaultRole } : {}),
	});
	const rateLimiter = new RateLimiter({
		maxPerUser: Number(process.env.SLACK_RATE_LIMIT_USER) || 10,
		maxPerChannel: Number(process.env.SLACK_RATE_LIMIT_CHANNEL) || 30,
		windowMs: Number(process.env.SLACK_RATE_LIMIT_WINDOW_MS) || 60000,
		persistPath: join(runtimeDir, "cache", "rate-limits.json"),
	});
	const costTracker = new CostTracker(runtimeDir);
	const feedbackTracker = new FeedbackTracker(runtimeDir);
	const approvalManager = new ApprovalManager();
	approvalManager.start();
	const threadMemoryManager = new ThreadMemoryManager(runtimeDir);

	const store = new ChannelStore({ workingDir: runtimeDir, botToken });

	const credentialStorage = new FileStorageBackend(
		join(runtimeDir, ".credentials"),
	);
	const credentialManager = new CredentialManager(credentialStorage);
	const getConnectorCredentials = createCredentialGetter(credentialManager);
	const connectorMgr = new ConnectorManager({
		workingDir: runtimeDir,
		credentialManager,
	});
	const triggerManager = new WebhookTriggerManager(runtimeDir);
	const dashboardRegistry = new DashboardRegistry(runtimeDir);

	const rt: WorkspaceRuntime = {
		teamId,
		workingDir: runtimeDir,
		botToken,
		store,
		permissionManager,
		rateLimiter,
		costTracker,
		feedbackTracker,
		approvalManager,
		threadMemoryManager,
		credentialManager,
		getConnectorCredentials,
		connectorMgr,
		triggerManager,
		dashboardRegistry,
		scheduler: new Scheduler({
			workingDir: runtimeDir,
			onTaskDue: (task) => handleScheduledTask(rt, task),
			onNotify: (task, minutesUntil) =>
				handleTaskNotification(rt, task, minutesUntil),
			defaultTimezone: SLACK_AGENT_DEFAULT_TIMEZONE,
		}),
		activeRuns: new Map(),
		startingRuns: new Set(),
		lastContexts: new Map(),
		thinkingEnabled: new Map(),
	};

	// Webhook triggers (per workspace)
	rt.triggerManager.setRunCallback(async (channel, prompt) => {
		await handleTriggerPrompt(rt, channel, prompt);
	});

	// Scheduler (per workspace)
	if (runtimeSchedulersEnabled) {
		rt.scheduler.start();
	}

	runtimes.set(teamId, rt);
	return rt;
}

function tryStartRun(rt: WorkspaceRuntime, channelId: string): boolean {
	if (rt.activeRuns.has(channelId) || rt.startingRuns.has(channelId)) {
		return false;
	}
	rt.startingRuns.add(channelId);
	return true;
}

function markRunActive(
	rt: WorkspaceRuntime,
	channelId: string,
	runner: AgentRunner,
	context: SlackContext,
): void {
	rt.startingRuns.delete(channelId);
	rt.activeRuns.set(channelId, { runner, context });
}

function clearRunState(rt: WorkspaceRuntime, channelId: string): void {
	rt.startingRuns.delete(channelId);
	rt.activeRuns.delete(channelId);
}

function formatPermissionDenied(check: {
	reason?: string;
	role: string;
}): string {
	const reason = check.reason ? `: ${check.reason}` : "";
	return `_Permission denied${reason}_`;
}

async function requirePermission(
	rt: WorkspaceRuntime,
	userId: string,
	action: string,
	respond: (text: string) => Promise<void>,
	resource?: string,
): Promise<boolean> {
	const check = rt.permissionManager.check(userId, action, resource);
	if (!check.allowed) {
		await respond(formatPermissionDenied(check));
		return false;
	}
	return true;
}

async function ensureNotBlocked(
	rt: WorkspaceRuntime,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<boolean> {
	const user = rt.permissionManager.getUser(userId);
	if (user.isBlocked) {
		await respond(
			`_Access denied: ${user.blockedReason ?? "User is blocked"}_`,
		);
		return false;
	}
	return true;
}

function canViewCosts(
	rt: WorkspaceRuntime,
	userId: string,
): { allowed: boolean; reason?: string } {
	const full = rt.permissionManager.check(userId, "view_costs");
	if (full.allowed) {
		return { allowed: true };
	}
	const own = rt.permissionManager.check(userId, "view_own_costs");
	return own.allowed
		? { allowed: true }
		: { allowed: false, reason: own.reason };
}

function readMemoryFile(
	filePath: string,
	label: string,
	maxChars = 3500,
): string | null {
	if (!existsSync(filePath)) return null;
	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return null;
		const truncated =
			content.length > maxChars
				? `${content.slice(0, maxChars)}\n... (truncated)`
				: content;
		return `*${label}*\n${truncated}`;
	} catch (error) {
		logger.logWarning("Failed to read memory file", String(error));
		return null;
	}
}

function clearSummaryCache(rt: WorkspaceRuntime, channelId: string): void {
	const channelDir = join(rt.workingDir, channelId);
	const files = ["context_summary.json", "context_summary_llm.json"];
	for (const file of files) {
		const filePath = join(channelDir, file);
		if (existsSync(filePath)) {
			try {
				rmSync(filePath);
			} catch (error) {
				logger.logWarning("Failed to clear summary cache", String(error));
			}
		}
	}
}

/**
 * Create an approval callback for a specific channel context.
 * Posts an approval request to Slack and waits for user reaction.
 */
function createApprovalCallback(
	rt: WorkspaceRuntime,
	channelId: string,
	postMessage: (text: string) => Promise<string | null>,
): (command: string, description: string) => Promise<boolean> {
	return async (command: string, description: string): Promise<boolean> => {
		// Post approval request
		const truncatedCmd =
			command.length > 100 ? `${command.substring(0, 100)}...` : command;
		const messageTs = await postMessage(
			`⚠️ *Approval Required*\nOperation: ${description}\nCommand: \`${truncatedCmd}\`\n\nReact with ✅ to approve or ❌ to reject (expires in 5 minutes)`,
		);

		if (!messageTs) {
			logger.logWarning(
				"Failed to post approval request",
				`channel: ${channelId}`,
			);
			return false;
		}

		// Register with approval manager and wait for response
		return new Promise((resolve) => {
			rt.approvalManager.requestApproval(
				channelId,
				messageTs,
				command,
				description,
				async () => resolve(true),
				async () => resolve(false),
			);
		});
	};
}

/**
 * Create schedule callbacks for a specific channel.
 * Wires up to the global scheduler instance.
 */
function createScheduleCallbacks(
	rt: WorkspaceRuntime,
	channelId: string,
	userId: string,
) {
	return {
		onSchedule: async (
			description: string,
			prompt: string,
			when: string,
		): Promise<{
			success: boolean;
			taskId?: string;
			nextRun?: string;
			warning?: string;
			error?: string;
		}> => {
			const canSchedule = rt.permissionManager.check(userId, "schedule_task");
			if (!canSchedule.allowed) {
				return {
					success: false,
					error: canSchedule.reason ?? "Permission denied",
				};
			}
			const task = await rt.scheduler.schedule(
				channelId,
				userId,
				description,
				prompt,
				when,
			);
			if (task) {
				const warning =
					!isValidTimezone(SLACK_AGENT_DEFAULT_TIMEZONE) &&
					task.timezone === "UTC"
						? `Default timezone "${SLACK_AGENT_DEFAULT_TIMEZONE}" is invalid; using UTC. Set SLACK_AGENT_DEFAULT_TIMEZONE to a valid IANA zone.`
						: undefined;
				return {
					success: true,
					taskId: task.id,
					nextRun: formatNextRun(task),
					...(warning && { warning }),
				};
			}
			return {
				success: false,
				error:
					"Could not parse time expression. Try: 'in 2 hours', 'tomorrow at 9am', 'every day at 9am'",
			};
		},
		onListTasks: async () => {
			const canView = rt.permissionManager.check(
				userId,
				"view_scheduled_tasks",
			);
			if (!canView.allowed) {
				logger.logWarning(
					"Scheduled task listing denied",
					canView.reason ?? "Permission denied",
				);
				return [];
			}
			const tasks = rt.scheduler.listTasks(channelId);
			return tasks.map((t) => ({
				id: t.id,
				description: t.description,
				nextRun: formatNextRun(t),
				recurring: t.schedule !== null,
			}));
		},
		onCancelTask: async (
			taskId: string,
		): Promise<{ success: boolean; error?: string }> => {
			const task = rt.scheduler
				.listTasks(channelId)
				.find((t) => t.id === taskId);
			if (!task) {
				return { success: false, error: "Task not found" };
			}
			const canCancel = rt.permissionManager.canCancelTask(
				userId,
				task.createdBy,
			);
			if (!canCancel.allowed) {
				return {
					success: false,
					error: canCancel.reason ?? "Permission denied",
				};
			}
			const cancelled = await rt.scheduler.cancel(taskId);
			return cancelled
				? { success: true }
				: { success: false, error: "Task not found" };
		},
	};
}

// Handle notification before scheduled task
async function handleTaskNotification(
	rt: WorkspaceRuntime,
	task: ScheduledTask,
	minutesUntil: number,
): Promise<void> {
	try {
		await bot.postMessageTeam(
			rt.teamId,
			task.channelId,
			`_Reminder: "${task.description}" will run in ${minutesUntil} minute${minutesUntil > 1 ? "s" : ""}_`,
		);
	} catch (error) {
		logger.logWarning(
			`Failed to send task notification for ${task.id}`,
			String(error),
		);
	}
}

// Handle scheduled task execution
async function handleScheduledTask(
	rt: WorkspaceRuntime,
	task: ScheduledTask,
): Promise<{ success: boolean; error?: string }> {
	const channelId = task.channelId;
	const creator = rt.permissionManager.getUser(task.createdBy);
	if (creator.isBlocked) {
		const reason = creator.blockedReason ?? "User is blocked";
		logger.logWarning(
			`Skipping scheduled task ${task.id} - creator blocked`,
			reason,
		);
		return { success: false, error: reason };
	}

	// Check if already running in this channel (atomic check-and-mark)
	if (!tryStartRun(rt, channelId)) {
		logger.logWarning(
			`Skipping scheduled task ${task.id} - channel ${channelId} is busy`,
			task.description,
		);
		return { success: false, error: "Channel is busy" };
	}

	logger.logInfo(`Executing scheduled task: ${task.description}`);

	// Post notification about scheduled task
	try {
		await bot.postMessageTeam(
			rt.teamId,
			channelId,
			`_Running scheduled task: ${task.description}_`,
		);

		// Create a minimal context for the scheduled task
		const channelDir = join(rt.workingDir, channelId);
		const useThinking = rt.thinkingEnabled.get(channelId) ?? false;
		const allowedTools = getAllowedToolsForRole(creator.role);
		const connectorAllowedCategories = getConnectorAllowedCategoriesForRole(
			creator.role,
		);
		const canSchedule = rt.permissionManager.check(
			task.createdBy,
			"schedule_task",
		).allowed;

		// Create approval callback for this channel
		const onApprovalNeeded = createApprovalCallback(rt, channelId, (text) =>
			bot.postMessageTeam(rt.teamId, channelId, text),
		);

		// Create schedule callbacks for this channel
		const scheduleCallbacks = canSchedule
			? createScheduleCallbacks(rt, channelId, task.createdBy)
			: undefined;

		const runner = createAgentRunner(sandbox, rt.workingDir, {
			executor,
			thinking: useThinking,
			onApprovalNeeded,
			scheduleCallbacks,
			allowedTools,
			connectorAllowedCategories,
			getConnectorCredentials: rt.getConnectorCredentials,
			dashboardRegistry: rt.dashboardRegistry,
			controlPlaneBaseUrl: SLACK_AGENT_UI_PUBLIC_URL,
			onDeploy: (label, details) => {
				const expiresIn = details.expiresIn ?? 3600;
				rt.dashboardRegistry.register({
					label,
					url: details.url,
					directory: details.directory,
					port: details.port,
					expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
					spec: details.spec,
				});
			},
		});

		// Create a simplified context for scheduled tasks
		const scheduledCtx = await bot.createScheduledContextTeam(
			rt.teamId,
			channelId,
			task.prompt,
		);
		const runId = `run_${Date.now().toString(36)}_${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		scheduledCtx.runId = runId;
		scheduledCtx.taskId = task.id;
		scheduledCtx.source = "scheduled";

		const logCtx: logger.LogContext = {
			channelId,
			userName: scheduledCtx.message.userName,
			channelName: scheduledCtx.channelName,
			runId,
			taskId: task.id,
			source: "scheduled",
		};
		markRunActive(rt, channelId, runner, scheduledCtx);

		await scheduledCtx.setTyping(true);
		await scheduledCtx.setWorking(true);

		try {
			const result = await runner.run(
				scheduledCtx,
				channelDir,
				scheduledCtx.store,
			);
			logger.logRunSummary(logCtx, result);
			if (result.stopReason === "error") {
				return { success: false, error: "Agent stopped with error" };
			}
			return { success: true };
		} finally {
			await scheduledCtx.setWorking(false);
			clearRunState(rt, channelId);
		}
	} catch (error) {
		// Clear starting state if we fail before marking active
		clearRunState(rt, channelId);
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.logWarning(`Scheduled task failed: ${task.id}`, errorMsg);
		return { success: false, error: errorMsg };
	}
}

async function handleTriggerPrompt(
	rt: WorkspaceRuntime,
	channelId: string,
	prompt: string,
): Promise<void> {
	// Skip if already running in this channel (atomic check-and-mark)
	if (!tryStartRun(rt, channelId)) {
		await bot.postMessageTeam(
			rt.teamId,
			channelId,
			"_Trigger skipped: channel is busy._",
		);
		return;
	}

	const runId = `run_${Date.now().toString(36)}_${Math.random()
		.toString(36)
		.slice(2, 6)}`;

	const channelDir = join(rt.workingDir, channelId);
	const useThinking = rt.thinkingEnabled.get(channelId) ?? false;

	// Triggers run "headless" (no user). Use power_user tool access by default.
	const allowedTools = getAllowedToolsForRole("power_user");
	const connectorAllowedCategories =
		getConnectorAllowedCategoriesForRole("power_user");

	const runner = createAgentRunner(sandbox, rt.workingDir, {
		executor,
		thinking: useThinking,
		allowedTools,
		connectorAllowedCategories,
		getConnectorCredentials: rt.getConnectorCredentials,
		dashboardRegistry: rt.dashboardRegistry,
		controlPlaneBaseUrl: SLACK_AGENT_UI_PUBLIC_URL,
		onDeploy: (label, details) => {
			const expiresIn = details.expiresIn ?? 3600;
			rt.dashboardRegistry.register({
				label,
				url: details.url,
				directory: details.directory,
				port: details.port,
				expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
				spec: details.spec,
			});
		},
	});

	const triggerCtx = await bot.createScheduledContextTeam(
		rt.teamId,
		channelId,
		prompt,
	);
	triggerCtx.source = "trigger";
	triggerCtx.runId = runId;
	triggerCtx.message.user = "trigger";
	triggerCtx.message.userName = "Webhook Trigger";

	markRunActive(rt, channelId, runner, triggerCtx);

	await triggerCtx.setTyping(true);
	await triggerCtx.setWorking(true);

	try {
		const result = await runner.run(triggerCtx, channelDir, triggerCtx.store);
		if (result.stopReason === "error") {
			await triggerCtx.respond("_Trigger run failed._");
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await triggerCtx.respond(`_Trigger error: ${msg}_`);
	} finally {
		await triggerCtx.setWorking(false);
		clearRunState(rt, channelId);
	}
}

async function handleMessage(
	rt: WorkspaceRuntime,
	ctx: SlackContext,
	source: "channel" | "dm",
): Promise<void> {
	ctx.source = source;
	const channelId = ctx.message.channel;
	const messageText = ctx.message.text.toLowerCase().trim();
	const userId = ctx.message.user;

	if (!(await ensureNotBlocked(rt, userId, ctx.respond))) {
		return;
	}

	// Handle simple /tasks text commands (not Slack-registered slash commands).
	if (await handleTasksCommand(rt, ctx)) {
		return;
	}

	const runId = `run_${Date.now().toString(36)}_${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	ctx.runId = runId;

	const logCtx: logger.LogContext = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
		threadTs: ctx.message.threadTs,
		runId,
		taskId: ctx.taskId,
		source: ctx.source,
	};

	// Check for stop command
	if (messageText === "stop") {
		if (!(await requirePermission(rt, userId, "stop", ctx.respond))) {
			return;
		}
		const active = rt.activeRuns.get(channelId);
		if (active) {
			await ctx.respond("_Stopping..._");
			active.stopContext = ctx;
			active.runner.abort();
		} else {
			await ctx.respond("_Nothing running._");
		}
		return;
	}

	// Check if already running in this channel (atomic check-and-mark)
	if (!tryStartRun(rt, channelId)) {
		await ctx.respond("_Already working on something. Say `stop` to cancel._");
		return;
	}

	// Check rate limit
	const rateCheck = rt.rateLimiter.check(ctx.message.user, channelId);
	if (!rateCheck.allowed) {
		clearRunState(rt, channelId); // Clear starting state since we're not proceeding
		const msg = formatRateLimitMessage(rateCheck);
		logger.logWarning(
			`Rate limited: ${ctx.message.userName} in ${channelId}`,
			rateCheck.limitedBy || "unknown",
		);
		await ctx.respond(msg);
		return;
	}

	logger.logUserMessage(logCtx, ctx.message.text);
	const channelDir = join(rt.workingDir, channelId);

	// Save context for retry
	rt.lastContexts.set(channelId, ctx);

	// Check if thinking mode is enabled for this channel
	const useThinking = rt.thinkingEnabled.get(channelId) ?? false;
	const role = rt.permissionManager.getUser(userId).role;
	const allowedTools = getAllowedToolsForRole(role);
	const connectorAllowedCategories = getConnectorAllowedCategoriesForRole(role);

	// Create approval callback for this channel
	const onApprovalNeeded = createApprovalCallback(rt, channelId, (text) =>
		bot.postMessageTeam(rt.teamId, channelId, text),
	);

	// Create schedule callbacks for this channel
	const scheduleCallbacks = rt.permissionManager.check(userId, "schedule_task")
		.allowed
		? createScheduleCallbacks(rt, channelId, ctx.message.user)
		: undefined;

	const runner = createAgentRunner(sandbox, rt.workingDir, {
		executor,
		thinking: useThinking,
		onApprovalNeeded,
		scheduleCallbacks,
		allowedTools,
		connectorAllowedCategories,
		getConnectorCredentials: rt.getConnectorCredentials,
		dashboardRegistry: rt.dashboardRegistry,
		controlPlaneBaseUrl: SLACK_AGENT_UI_PUBLIC_URL,
		onDeploy: (label, details) => {
			const expiresIn = details.expiresIn ?? 3600;
			rt.dashboardRegistry.register({
				label,
				url: details.url,
				directory: details.directory,
				port: details.port,
				expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
				spec: details.spec,
			});
		},
	});
	markRunActive(rt, channelId, runner, ctx);

	await ctx.setTyping(true);
	await ctx.setWorking(true);

	try {
		const result = await runner.run(ctx, channelDir, ctx.store);

		// Handle different stop reasons
		const active = rt.activeRuns.get(channelId);
		if (result.stopReason === "aborted") {
			if (active?.stopContext) {
				await active.stopContext.setWorking(false);
				await active.stopContext.replaceMessage("_Stopped_");
			}
		} else if (result.stopReason === "error") {
			logger.logAgentError(logCtx, "Agent stopped with error");
		}
		logger.logRunSummary(logCtx, result);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.logAgentError(logCtx, errorMsg);
		await ctx.respond(`_Error: ${errorMsg}_`);
	} finally {
		await ctx.setWorking(false);
		clearRunState(rt, channelId);
	}
}

async function handleTasksCommand(
	rt: WorkspaceRuntime,
	ctx: SlackContext,
): Promise<boolean> {
	const raw = ctx.message.text.trim();
	const match = raw.match(/^\/tasks\b\s*(.*)$/i);
	if (!match) return false;

	const userId = ctx.message.user;
	if (!(await ensureNotBlocked(rt, userId, ctx.respond))) {
		return true;
	}

	const channelId = ctx.message.channel;

	const rest = match[1]?.trim() || "";
	const [subRaw, ...args] = rest.split(/\s+/).filter(Boolean);
	const sub = (subRaw || "list").toLowerCase();

	const usage = "_Usage: /tasks [list|pause|resume|cancel|run|help] <taskId>_";

	switch (sub) {
		case "help": {
			await ctx.respond(
				`${usage}\nExamples:\n• /tasks list\n• /tasks pause task_123\n• /tasks resume task_123\n• /tasks cancel task_123\n• /tasks run task_123`,
			);
			return true;
		}
		case "list": {
			if (
				!(await requirePermission(
					rt,
					userId,
					"view_scheduled_tasks",
					ctx.respond,
				))
			) {
				return true;
			}
			const tasks = rt.scheduler.listTasks(channelId);
			if (tasks.length === 0) {
				await ctx.respond("_No scheduled tasks for this channel._");
				return true;
			}
			const lines = tasks.map((t) => {
				const recurring = t.schedule ? " (recurring)" : "";
				const paused = t.paused ? " (paused)" : "";
				return `• ${t.description}${recurring}${paused}\n  ID: ${t.id}\n  Next: ${formatNextRun(t)}`;
			});
			await ctx.respond(`*Scheduled Tasks:*\n\n${lines.join("\n\n")}`);
			return true;
		}
		case "pause":
		case "resume":
		case "cancel":
		case "delete":
		case "run": {
			const taskId = args[0];
			if (!taskId) {
				await ctx.respond(usage);
				return true;
			}

			const task = rt.scheduler
				.listTasks(channelId)
				.find((t) => t.id === taskId);
			if (!task) {
				await ctx.respond(`_Task ${taskId} not found in this channel._`);
				return true;
			}

			const canManage = rt.permissionManager.canCancelTask(
				userId,
				task.createdBy,
			);
			if (!canManage.allowed) {
				await ctx.respond(formatPermissionDenied(canManage));
				return true;
			}

			if (sub === "pause") {
				const ok = await rt.scheduler.pause(taskId);
				await ctx.respond(
					ok
						? `_Paused task ${taskId}._`
						: `_Could not pause ${taskId}. Only recurring tasks can be paused._`,
				);
				return true;
			}

			if (sub === "resume") {
				const ok = await rt.scheduler.resume(taskId);
				await ctx.respond(
					ok
						? `_Resumed task ${taskId}._`
						: `_Could not resume ${taskId}. Only recurring tasks can be resumed._`,
				);
				return true;
			}

			if (sub === "cancel" || sub === "delete") {
				const ok = await rt.scheduler.cancel(taskId);
				await ctx.respond(
					ok ? `_Cancelled task ${taskId}._` : `_Task ${taskId} not found._`,
				);
				return true;
			}

			// run
			if (rt.activeRuns.has(channelId) || rt.startingRuns.has(channelId)) {
				await ctx.respond(
					"_This channel is busy. Say `stop` first before running a task now._",
				);
				return true;
			}
			void rt.scheduler.runNow(taskId).catch((error: unknown) => {
				logger.logWarning(
					`Failed to run task ${taskId} immediately`,
					error instanceof Error ? error.message : String(error),
				);
			});
			await ctx.respond(`_Triggered task ${taskId}. Running now..._`);
			return true;
		}
		default: {
			await ctx.respond(usage);
			return true;
		}
	}
}

async function handleStatusRequest(
	rt: WorkspaceRuntime,
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	if (!(await requirePermission(rt, userId, "view_status", respond))) {
		return;
	}

	const busy = rt.activeRuns.has(channelId) || rt.startingRuns.has(channelId);
	const thinking = rt.thinkingEnabled.get(channelId) ?? false;
	const stats = rt.rateLimiter.getStats(userId, channelId);

	const lines: string[] = [];
	lines.push("*Status*");
	lines.push(busy ? "_Working on a task_" : "_Idle_");
	lines.push(`Thinking: ${thinking ? "on" : "off"}`);
	lines.push(
		`Rate limit: ${stats.userRequests}/${stats.userLimit} user | ${stats.channelRequests}/${stats.channelLimit} channel`,
	);

	await respond(lines.join("\n"));
}

async function handleCostRequest(
	rt: WorkspaceRuntime,
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	const canView = canViewCosts(rt, userId);
	if (!canView.allowed) {
		await respond(
			`_Permission denied${canView.reason ? `: ${canView.reason}` : ""}_`,
		);
		return;
	}

	const summary = rt.costTracker.getSummary(channelId);
	const formatted = rt.costTracker.formatSummary(summary);
	await respond(formatted);
}

async function handleClearRequest(
	rt: WorkspaceRuntime,
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	if (!(await requirePermission(rt, userId, "clear_context", respond))) {
		return;
	}
	if (rt.activeRuns.has(channelId) || rt.startingRuns.has(channelId)) {
		await respond("_Can't clear while working. Say `stop` first._");
		return;
	}

	await rt.store.clearHistory(channelId);
	await rt.threadMemoryManager.clearChannel(channelId);
	clearSummaryCache(rt, channelId);
	rt.lastContexts.delete(channelId);
	logger.logInfo(`Context cleared in ${channelId}`);
	await respond("_Conversation history cleared. Starting fresh!_");
}

async function handleMemoryRequest(
	rt: WorkspaceRuntime,
	ctx: SlackContext,
): Promise<void> {
	const userId = ctx.message.user;
	if (!(await requirePermission(rt, userId, "manage_memory", ctx.respond))) {
		return;
	}

	const channelId = ctx.message.channel;
	const channelDir = join(rt.workingDir, channelId);
	const sections: string[] = [];

	const globalMemory = readMemoryFile(
		join(channelDir, "..", "MEMORY.md"),
		"Global Workspace Memory",
	);
	if (globalMemory) sections.push(globalMemory);

	const channelMemory = readMemoryFile(
		join(channelDir, "MEMORY.md"),
		"Channel Memory",
	);
	if (channelMemory) sections.push(channelMemory);

	try {
		const summary = await rt.threadMemoryManager.getThreadSummary(
			channelId,
			ctx.threadKey,
		);
		if (summary.messageCount > 0) {
			sections.push(
				`*Thread Memory*\nMessages: ${summary.messageCount}\nTokens: ${summary.totalTokens}`,
			);
		}
	} catch (error) {
		logger.logWarning("Failed to read thread memory summary", String(error));
	}

	if (sections.length === 0) {
		await ctx.respond("_No memory stored yet._");
		return;
	}

	await ctx.respond(sections.join("\n\n"));
}

async function handleBackfillCommand(
	rt: WorkspaceRuntime,
	ctx: SlackContext,
	text: string,
): Promise<void> {
	const userId = ctx.message.user;
	if (!(await requirePermission(rt, userId, "backfill_history", ctx.respond))) {
		return;
	}

	const trimmed = text.trim().toLowerCase();
	const backfillAll =
		trimmed === "all" || trimmed === "everything" || trimmed === "channels";
	const targetLabel = backfillAll
		? "all channels"
		: (ctx.channelName ?? ctx.message.channel);

	await ctx.respond(`_Starting backfill for ${targetLabel}..._`);

	const notifySuccess = async () => {
		try {
			await ctx.respond("_Backfill complete._");
		} catch (error) {
			logger.logWarning(
				"Backfill finished but failed to send completion message",
				String(error),
			);
		}
	};

	void (async () => {
		try {
			await bot.backfillTeam(
				rt.teamId,
				backfillAll ? undefined : [ctx.message.channel],
			);
			await notifySuccess();
		} catch (error) {
			logger.logWarning("Backfill failed", String(error));
			try {
				await ctx.respond("_Backfill failed. Check logs for details._");
			} catch (notifyError) {
				logger.logWarning(
					"Failed to send backfill failure message",
					String(notifyError),
				);
			}
		}
	})();
}

// Reaction command handlers
// 🛑 octagonal_sign - Stop current run
// 👀 eyes - Check status
// 💰 moneybag - Check usage/costs
// 📊 bar_chart - View feedback summary
// 🔄 arrows_counterclockwise - Retry last request
// ☕ coffee - Toggle extended thinking
// 🧹 broom - Clear conversation context
// 📅 calendar - List scheduled tasks
// 👍/👎 thumbsup/thumbsdown - Record feedback (tracked automatically)
async function handleReaction(ctx: ReactionContext): Promise<void> {
	const channelId = ctx.channel;
	const rt = getRuntime(ctx.teamId);
	const active = rt.activeRuns.get(channelId);
	const respond = (text: string) => ctx.postMessage(channelId, text);

	if (!(await ensureNotBlocked(rt, ctx.user, respond))) {
		return;
	}

	switch (ctx.reaction) {
		case "octagonal_sign": {
			// 🛑 Stop command
			if (!(await requirePermission(rt, ctx.user, "stop", respond))) {
				break;
			}
			if (active) {
				logger.logInfo(`Stop requested via reaction in ${channelId}`);
				await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
				active.runner.abort();
				await ctx.postMessage(channelId, "_Stopping (via 🛑 reaction)..._");
			}
			break;
		}

		case "eyes": {
			// 👀 Status check
			if (!(await requirePermission(rt, ctx.user, "view_status", respond))) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleStatusRequest(rt, channelId, ctx.user, respond);
			break;
		}

		case "moneybag":
		case "chart_with_upwards_trend": {
			// 💰 or 📈 Usage/cost check
			const canView = canViewCosts(rt, ctx.user);
			if (!canView.allowed) {
				await respond(
					`_Permission denied${canView.reason ? `: ${canView.reason}` : ""}_`,
				);
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleCostRequest(rt, channelId, ctx.user, respond);
			break;
		}

		case "bar_chart":
		case "clipboard": {
			// 📊 or 📋 Feedback summary
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const feedbackSummary = rt.feedbackTracker.getSummary(channelId);
			const feedbackFormatted =
				rt.feedbackTracker.formatSummary(feedbackSummary);
			await ctx.postMessage(channelId, feedbackFormatted);
			break;
		}

		case "arrows_counterclockwise":
		case "repeat": {
			// 🔄 Retry last request
			if (!(await requirePermission(rt, ctx.user, "retry", respond))) {
				break;
			}
			if (active) {
				await ctx.postMessage(
					channelId,
					"_Already working. React with 🛑 to stop first._",
				);
				break;
			}

			const lastCtx = rt.lastContexts.get(channelId);
			if (!lastCtx) {
				await ctx.postMessage(channelId, "_No previous request to retry._");
				break;
			}

			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			logger.logInfo(`Retry requested via reaction in ${channelId}`);
			await ctx.postMessage(channelId, "_Retrying last request..._");

			// Re-run with the last context
			await handleMessage(rt, lastCtx, "channel");
			break;
		}

		case "coffee":
		case "brain": {
			// ☕ or 🧠 Toggle extended thinking
			if (
				!(await requirePermission(rt, ctx.user, "toggle_thinking", respond))
			) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const current = rt.thinkingEnabled.get(channelId) ?? false;
			rt.thinkingEnabled.set(channelId, !current);

			if (!current) {
				await ctx.postMessage(
					channelId,
					"_Extended thinking enabled ☕ I'll think more carefully on complex tasks._",
				);
			} else {
				await ctx.postMessage(
					channelId,
					"_Extended thinking disabled. Back to quick responses._",
				);
			}
			break;
		}

		case "broom":
		case "wastebasket": {
			// 🧹 or 🗑️ Clear conversation context
			if (!(await requirePermission(rt, ctx.user, "clear_context", respond))) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleClearRequest(rt, channelId, ctx.user, respond);
			break;
		}

		case "calendar":
		case "alarm_clock": {
			// 📅 or ⏰ List scheduled tasks
			if (
				!(await requirePermission(
					rt,
					ctx.user,
					"view_scheduled_tasks",
					respond,
				))
			) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const tasks = rt.scheduler.listTasks(channelId);
			if (tasks.length === 0) {
				await ctx.postMessage(
					channelId,
					"_No scheduled tasks for this channel._",
				);
			} else {
				const taskList = tasks
					.map((t) => {
						const nextRun = formatNextRun(t);
						const recurring = t.schedule ? " (recurring)" : "";
						return `• ${t.description}${recurring} - next: ${nextRun}`;
					})
					.join("\n");
				await ctx.postMessage(channelId, `*Scheduled Tasks:*\n${taskList}`);
			}
			break;
		}

		default: {
			// Check if this is an approval reaction
			const handled = await rt.approvalManager.handleReaction(
				channelId,
				ctx.messageTs,
				ctx.reaction,
			);
			if (handled) {
				await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
				break;
			}

			// Track feedback reactions (👍/👎) on any message
			const feedback = rt.feedbackTracker.record(
				channelId,
				ctx.messageTs,
				ctx.user,
				ctx.reaction,
			);
			if (feedback) {
				logger.logInfo(
					`Feedback recorded: ${feedback.reaction} (${feedback.emoji}) in ${channelId}`,
				);
			}
			break;
		}
	}
}

async function resolveTeamIdForBotToken(botToken: string): Promise<string> {
	try {
		const client = new WebClient(botToken);
		const auth = await client.auth.test();
		const teamId = (auth as { team_id?: string }).team_id;
		if (teamId) return teamId;
	} catch (error) {
		logger.logWarning(
			"Failed to resolve Slack team ID via auth.test",
			error instanceof Error ? error.message : String(error),
		);
	}
	return "default";
}

const defaultTeamId =
	!useMultiWorkspace && SLACK_BOT_TOKEN
		? await resolveTeamIdForBotToken(SLACK_BOT_TOKEN)
		: undefined;

const bot = new SlackBot(
	{
		async onChannelMention(ctx) {
			const rt = getRuntime(ctx.teamId);
			await handleMessage(rt, ctx, "channel");
		},

		async onDirectMessage(ctx) {
			const rt = getRuntime(ctx.teamId);
			await handleMessage(rt, ctx, "dm");
		},

		async onSlashCommand(ctx, command, text) {
			const rt = getRuntime(ctx.teamId);
			ctx.source = "slash";
			const cmd = command.toLowerCase();
			if (!(await ensureNotBlocked(rt, ctx.message.user, ctx.respond))) {
				return;
			}

			switch (cmd) {
				case "/tasks":
					await handleTasksCommand(rt, ctx);
					return;
				case "/status":
					await handleStatusRequest(
						rt,
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
					);
					return;
				case "/cost":
					await handleCostRequest(
						rt,
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
					);
					return;
				case "/memory":
					await handleMemoryRequest(rt, ctx);
					return;
				case "/backfill":
					await handleBackfillCommand(rt, ctx, text);
					return;
				case "/clear":
					await handleClearRequest(
						rt,
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
					);
					return;
				case "/connect":
					await ctx.respond(
						await rt.connectorMgr.handleConnect(text, ctx.message.user),
					);
					return;
				case "/connect-credentials":
					await ctx.respond(
						await rt.connectorMgr.handleSetCredentials(text, ctx.message.user),
					);
					return;
				case "/disconnect":
					await ctx.respond(
						await rt.connectorMgr.handleDisconnect(text, ctx.message.user),
					);
					return;
				case "/connectors":
					await ctx.respond(await rt.connectorMgr.handleList());
					return;
				case "/triggers":
					await ctx.respond(
						rt.triggerManager.handleTriggersCommand(text, ctx.message.user),
					);
					return;
				default:
					await ctx.respond(
						`_Unsupported slash command: ${command}. Try /tasks help._`,
					);
			}
		},

		async onReaction(ctx) {
			await handleReaction(ctx);
		},
	},
	(() => {
		const cfg = {
			appToken: SLACK_APP_TOKEN,
			workingDir,
			...(defaultTeamId ? { defaultTeamId } : {}),
			historyLimit: parsePositiveInt(SLACK_AGENT_HISTORY_LIMIT),
			historyMaxPages: parsePositiveInt(SLACK_AGENT_HISTORY_PAGES),
			backfillOnStartup: parseBoolean(
				SLACK_AGENT_BACKFILL_ON_STARTUP,
				"SLACK_AGENT_BACKFILL_ON_STARTUP",
			),
			backfillInclude: parseCommaList(SLACK_AGENT_BACKFILL_CHANNELS),
			backfillExclude: parseCommaList(SLACK_AGENT_BACKFILL_EXCLUDE_CHANNELS),
			backfillConcurrency: parsePositiveInt(SLACK_AGENT_BACKFILL_CONCURRENCY),
		};

		if (useMultiWorkspace) {
			return {
				...cfg,
				resolveWorkspace: (teamId: string) => {
					const botToken = resolveBotToken(teamId);
					if (!botToken) return null;
					return { botToken, workingDir: resolveWorkspaceDir(teamId) };
				},
			};
		}

		return {
			...cfg,
			botToken: SLACK_BOT_TOKEN,
		};
	})(),
);

let shuttingDown = false;
async function shutdownWithCleanup(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;

	console.log(`\nReceived ${signal}, shutting down...`);

	try {
		await bot.stop();
	} catch {
		// ignore
	}

	for (const rt of runtimes.values()) {
		try {
			await rt.scheduler.stop();
		} catch {
			// ignore
		}
		try {
			rt.approvalManager.stop();
		} catch {
			// ignore
		}
		try {
			await rt.threadMemoryManager.shutdown();
		} catch {
			// ignore
		}

		for (const [channelId, active] of rt.activeRuns) {
			console.log(
				`Aborting run in channel ${channelId} (team ${rt.teamId})...`,
			);
			active.runner.abort();
		}
	}

	// Dispose executor (stops auto-created containers)
	await executor.dispose();

	console.log("Shutdown complete.");
	process.exit(0);
}

process.on("SIGINT", () => void shutdownWithCleanup("SIGINT"));
process.on("SIGTERM", () => void shutdownWithCleanup("SIGTERM"));

// Start schedulers once the SlackBot instance exists (scheduled tasks may post via bot).
runtimeSchedulersEnabled = true;
for (const rt of runtimes.values()) {
	rt.scheduler.start();
}

// Pre-initialize runtimes so schedules and triggers are live even before first Slack event.
if (useMultiWorkspace) {
	for (const ws of workspaceManager.getAll()) {
		try {
			getRuntime(ws.teamId);
		} catch (error) {
			logger.logWarning(
				"Failed to initialize workspace runtime",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
} else if (defaultTeamId) {
	try {
		getRuntime(defaultTeamId);
	} catch (error) {
		logger.logWarning(
			"Failed to initialize default workspace runtime",
			error instanceof Error ? error.message : String(error),
		);
	}
}

await bot.start();

// Start webhook server if port is configured
const webhookPort = process.env.SLACK_AGENT_WEBHOOK_PORT
	? Number(process.env.SLACK_AGENT_WEBHOOK_PORT)
	: undefined;
if (webhookPort) {
	const webhookSecrets: Record<string, string> = {};
	if (process.env.GITHUB_WEBHOOK_SECRET)
		webhookSecrets.github = process.env.GITHUB_WEBHOOK_SECRET;
	if (process.env.STRIPE_WEBHOOK_SECRET)
		webhookSecrets.stripe = process.env.STRIPE_WEBHOOK_SECRET;
	if (process.env.LINEAR_WEBHOOK_SECRET)
		webhookSecrets.linear = process.env.LINEAR_WEBHOOK_SECRET;

	const webhookServer = createWebhookServer(
		{
			port: webhookPort,
			secrets:
				Object.keys(webhookSecrets).length > 0 ? webhookSecrets : undefined,
			defaultTeamId: defaultTeamId,
			defaultChannel: process.env.SLACK_AGENT_WEBHOOK_CHANNEL,
		},
		async (event) => {
			const rt = getRuntime(event.teamId);

			// First, try to fire any matching triggers (agent runs)
			const triggered = await rt.triggerManager.processEvent(event);

			// Then post summary to the configured channel
			const channel = event.channel ?? process.env.SLACK_AGENT_WEBHOOK_CHANNEL;
			if (!channel) {
				if (triggered === 0) {
					logger.logWarning(
						"Webhook event has no target channel and no triggers fired",
						event.source,
					);
				}
				return;
			}
			await bot.postMessageTeam(
				rt.teamId,
				channel,
				`*[${event.source}]* ${event.summary}`,
			);
		},
	);

	webhookServer.start().catch((err) => {
		logger.logWarning(
			"Failed to start webhook server",
			err instanceof Error ? err.message : String(err),
		);
	});
}

// Start UI API server if port is configured
if (uiPort) {
	const slackOAuth =
		slackClientId && slackClientSecret
			? {
					clientId: slackClientId,
					clientSecret: slackClientSecret,
					scopes: parseCommaList(process.env.SLACK_OAUTH_SCOPES),
					redirectUri: process.env.SLACK_OAUTH_REDIRECT_URI,
					stateSecret: process.env.SLACK_OAUTH_STATE_SECRET,
				}
			: undefined;

	const apiServer = createApiServer({
		port: uiPort,
		workingDir,
		workspaceManager,
		staticDir: process.env.SLACK_AGENT_UI_DIR,
		authToken: process.env.SLACK_AGENT_UI_TOKEN || undefined,
		slackOAuth,
	});

	apiServer.start().catch((err) => {
		logger.logWarning(
			"Failed to start UI API server",
			err instanceof Error ? err.message : String(err),
		);
	});
}
