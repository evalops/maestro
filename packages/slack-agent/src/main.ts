#!/usr/bin/env node

/**
 * Slack Agent - Entry Point
 *
 * A Slack bot that runs an AI coding agent in a sandboxed environment.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DateTime } from "luxon";
import { type AgentRunner, createAgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval.js";
import { CostTracker } from "./cost-tracker.js";
import { FeedbackTracker } from "./feedback.js";
import * as logger from "./logger.js";
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
import { ThreadMemoryManager } from "./thread-memory.js";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;
const SLACK_AGENT_DEFAULT_TIMEZONE =
	process.env.SLACK_AGENT_DEFAULT_TIMEZONE || "UTC";
const SLACK_AGENT_DEFAULT_ROLE = process.env.SLACK_AGENT_DEFAULT_ROLE;
const SLACK_AGENT_HISTORY_LIMIT = process.env.SLACK_AGENT_HISTORY_LIMIT;
const SLACK_AGENT_HISTORY_PAGES = process.env.SLACK_AGENT_HISTORY_PAGES;

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

function parseArgs(): { workingDir: string; sandbox: SandboxConfig } {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
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
	console.error("");
	console.error("Examples:");
	console.error("  slack-agent --sandbox=docker:auto ./data");
	console.error("  slack-agent --sandbox=docker:slack-agent-sandbox ./data");
	console.error("  slack-agent --sandbox=docker:auto:python:3.12-slim ./data");
	console.error("");
	console.error("Environment variables:");
	console.error("  SLACK_APP_TOKEN       Slack app token (xapp-...)");
	console.error("  SLACK_BOT_TOKEN       Slack bot token (xoxb-...)");
	console.error("  ANTHROPIC_API_KEY     Anthropic API key");
	console.error("  ANTHROPIC_OAUTH_TOKEN Anthropic OAuth token (alternative)");
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
}

const { workingDir, sandbox } = parseArgs();

logger.logStartup(workingDir, getSandboxDescription(sandbox));

if (
	!SLACK_APP_TOKEN ||
	!SLACK_BOT_TOKEN ||
	(!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)
) {
	console.error("Missing required environment variables:");
	if (!SLACK_APP_TOKEN) console.error("  - SLACK_APP_TOKEN (xapp-...)");
	if (!SLACK_BOT_TOKEN) console.error("  - SLACK_BOT_TOKEN (xoxb-...)");
	if (!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)
		console.error("  - ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox);

// Create the executor (manages container lifecycle for auto mode)
const executor: Executor = createExecutor(sandbox);

const defaultRole = parseDefaultRole(SLACK_AGENT_DEFAULT_ROLE);
const permissionManager = new PermissionManager(workingDir, {
	...(defaultRole ? { defaultRole } : {}),
});

// Rate limiter - configurable via environment
const rateLimiter = new RateLimiter({
	maxPerUser: Number(process.env.SLACK_RATE_LIMIT_USER) || 10,
	maxPerChannel: Number(process.env.SLACK_RATE_LIMIT_CHANNEL) || 30,
	windowMs: Number(process.env.SLACK_RATE_LIMIT_WINDOW_MS) || 60000,
	persistPath: join(workingDir, "cache", "rate-limits.json"),
});

// Cost tracker for usage reporting
const costTracker = new CostTracker(workingDir);

// Feedback tracker for reaction-based feedback
const feedbackTracker = new FeedbackTracker(workingDir);

// Approval manager for destructive operations
const approvalManager = new ApprovalManager();
approvalManager.start();

const threadMemoryManager = new ThreadMemoryManager(workingDir);

// Scheduler placeholder (initialized after bot creation)
const schedulerHolder: { instance: Scheduler | null } = { instance: null };

// Track active runs per channel
const activeRuns = new Map<
	string,
	{ runner: AgentRunner; context: SlackContext; stopContext?: SlackContext }
>();

// Track channels that are starting (to prevent race conditions)
// This is checked synchronously before any async work to prevent double-starts
const startingRuns = new Set<string>();

/**
 * Check if a channel is available for a new run.
 * Returns true if available and marks it as starting.
 * This is atomic - the check and mark happen synchronously.
 */
function tryStartRun(channelId: string): boolean {
	if (activeRuns.has(channelId) || startingRuns.has(channelId)) {
		return false;
	}
	startingRuns.add(channelId);
	return true;
}

/**
 * Mark a run as fully started (move from starting to active).
 */
function markRunActive(
	channelId: string,
	runner: AgentRunner,
	context: SlackContext,
): void {
	startingRuns.delete(channelId);
	activeRuns.set(channelId, { runner, context });
}

/**
 * Clear run state for a channel.
 */
function clearRunState(channelId: string): void {
	startingRuns.delete(channelId);
	activeRuns.delete(channelId);
}

// Track last context per channel for retry
const lastContexts = new Map<string, SlackContext>();

// Track thinking mode preference per channel
const thinkingEnabled = new Map<string, boolean>();

function formatPermissionDenied(check: {
	reason?: string;
	role: string;
}): string {
	const reason = check.reason ? `: ${check.reason}` : "";
	return `_Permission denied${reason}_`;
}

async function requirePermission(
	userId: string,
	action: string,
	respond: (text: string) => Promise<void>,
	resource?: string,
): Promise<boolean> {
	const check = permissionManager.check(userId, action, resource);
	if (!check.allowed) {
		await respond(formatPermissionDenied(check));
		return false;
	}
	return true;
}

async function ensureNotBlocked(
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<boolean> {
	const user = permissionManager.getUser(userId);
	if (user.isBlocked) {
		await respond(
			`_Access denied: ${user.blockedReason ?? "User is blocked"}_`,
		);
		return false;
	}
	return true;
}

function canViewCosts(userId: string): { allowed: boolean; reason?: string } {
	const full = permissionManager.check(userId, "view_costs");
	if (full.allowed) {
		return { allowed: true };
	}
	const own = permissionManager.check(userId, "view_own_costs");
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

function clearSummaryCache(channelId: string): void {
	const channelDir = join(workingDir, channelId);
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
			approvalManager.requestApproval(
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
function createScheduleCallbacks(channelId: string, userId: string) {
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
			const canSchedule = permissionManager.check(userId, "schedule_task");
			if (!canSchedule.allowed) {
				return {
					success: false,
					error: canSchedule.reason ?? "Permission denied",
				};
			}
			if (!schedulerHolder.instance) {
				return { success: false, error: "Scheduler not initialized" };
			}
			const task = await schedulerHolder.instance.schedule(
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
			const canView = permissionManager.check(userId, "view_scheduled_tasks");
			if (!canView.allowed) {
				logger.logWarning(
					"Scheduled task listing denied",
					canView.reason ?? "Permission denied",
				);
				return [];
			}
			if (!schedulerHolder.instance) {
				return [];
			}
			const tasks = schedulerHolder.instance.listTasks(channelId);
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
			if (!schedulerHolder.instance) {
				return { success: false, error: "Scheduler not initialized" };
			}
			const task = schedulerHolder.instance
				.listTasks(channelId)
				.find((t) => t.id === taskId);
			if (!task) {
				return { success: false, error: "Task not found" };
			}
			const canCancel = permissionManager.canCancelTask(userId, task.createdBy);
			if (!canCancel.allowed) {
				return {
					success: false,
					error: canCancel.reason ?? "Permission denied",
				};
			}
			const cancelled = await schedulerHolder.instance.cancel(taskId);
			return cancelled
				? { success: true }
				: { success: false, error: "Task not found" };
		},
	};
}

// Handle notification before scheduled task
async function handleTaskNotification(
	task: ScheduledTask,
	minutesUntil: number,
): Promise<void> {
	try {
		await bot.postMessage(
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
	task: ScheduledTask,
): Promise<{ success: boolean; error?: string }> {
	const channelId = task.channelId;
	const creator = permissionManager.getUser(task.createdBy);
	if (creator.isBlocked) {
		const reason = creator.blockedReason ?? "User is blocked";
		logger.logWarning(
			`Skipping scheduled task ${task.id} - creator blocked`,
			reason,
		);
		return { success: false, error: reason };
	}

	// Check if already running in this channel (atomic check-and-mark)
	if (!tryStartRun(channelId)) {
		logger.logWarning(
			`Skipping scheduled task ${task.id} - channel ${channelId} is busy`,
			task.description,
		);
		return { success: false, error: "Channel is busy" };
	}

	logger.logInfo(`Executing scheduled task: ${task.description}`);

	// Post notification about scheduled task
	try {
		await bot.postMessage(
			channelId,
			`_Running scheduled task: ${task.description}_`,
		);

		// Create a minimal context for the scheduled task
		const channelDir = join(workingDir, channelId);
		const useThinking = thinkingEnabled.get(channelId) ?? false;
		const allowedTools = getAllowedToolsForRole(creator.role);
		const canSchedule = permissionManager.check(
			task.createdBy,
			"schedule_task",
		).allowed;

		// Create approval callback for this channel
		const onApprovalNeeded = createApprovalCallback(channelId, (text) =>
			bot.postMessage(channelId, text),
		);

		// Create schedule callbacks for this channel
		const scheduleCallbacks = canSchedule
			? createScheduleCallbacks(channelId, task.createdBy)
			: undefined;

		const runner = createAgentRunner(sandbox, workingDir, {
			thinking: useThinking,
			onApprovalNeeded,
			scheduleCallbacks,
			allowedTools,
		});

		// Create a simplified context for scheduled tasks
		const scheduledCtx = await bot.createScheduledContext(
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
		markRunActive(channelId, runner, scheduledCtx);

		await scheduledCtx.setTyping(true);
		await scheduledCtx.setWorking(true);

		try {
			const result = await runner.run(scheduledCtx, channelDir, bot.store);
			logger.logRunSummary(logCtx, result);
			if (result.stopReason === "error") {
				return { success: false, error: "Agent stopped with error" };
			}
			return { success: true };
		} finally {
			await scheduledCtx.setWorking(false);
			clearRunState(channelId);
		}
	} catch (error) {
		// Clear starting state if we fail before marking active
		clearRunState(channelId);
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.logWarning(`Scheduled task failed: ${task.id}`, errorMsg);
		return { success: false, error: errorMsg };
	}
}

async function handleMessage(
	ctx: SlackContext,
	source: "channel" | "dm",
): Promise<void> {
	ctx.source = source;
	const channelId = ctx.message.channel;
	const messageText = ctx.message.text.toLowerCase().trim();
	const userId = ctx.message.user;

	if (!(await ensureNotBlocked(userId, ctx.respond))) {
		return;
	}

	// Handle simple /tasks text commands (not Slack-registered slash commands).
	if (await handleTasksCommand(ctx)) {
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
		if (!(await requirePermission(userId, "stop", ctx.respond))) {
			return;
		}
		const active = activeRuns.get(channelId);
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
	if (!tryStartRun(channelId)) {
		await ctx.respond("_Already working on something. Say `stop` to cancel._");
		return;
	}

	// Check rate limit
	const rateCheck = rateLimiter.check(ctx.message.user, channelId);
	if (!rateCheck.allowed) {
		clearRunState(channelId); // Clear starting state since we're not proceeding
		const msg = formatRateLimitMessage(rateCheck);
		logger.logWarning(
			`Rate limited: ${ctx.message.userName} in ${channelId}`,
			rateCheck.limitedBy || "unknown",
		);
		await ctx.respond(msg);
		return;
	}

	logger.logUserMessage(logCtx, ctx.message.text);
	const channelDir = join(workingDir, channelId);

	// Save context for retry
	lastContexts.set(channelId, ctx);

	// Check if thinking mode is enabled for this channel
	const useThinking = thinkingEnabled.get(channelId) ?? false;
	const allowedTools = getAllowedToolsForRole(
		permissionManager.getUser(userId).role,
	);

	// Create approval callback for this channel
	const onApprovalNeeded = createApprovalCallback(channelId, (text) =>
		bot.postMessage(channelId, text),
	);

	// Create schedule callbacks for this channel
	const scheduleCallbacks = permissionManager.check(userId, "schedule_task")
		.allowed
		? createScheduleCallbacks(channelId, ctx.message.user)
		: undefined;

	const runner = createAgentRunner(sandbox, workingDir, {
		thinking: useThinking,
		onApprovalNeeded,
		scheduleCallbacks,
		allowedTools,
	});
	markRunActive(channelId, runner, ctx);

	await ctx.setTyping(true);
	await ctx.setWorking(true);

	try {
		const result = await runner.run(ctx, channelDir, ctx.store);

		// Handle different stop reasons
		const active = activeRuns.get(channelId);
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
		clearRunState(channelId);
	}
}

async function handleTasksCommand(ctx: SlackContext): Promise<boolean> {
	const raw = ctx.message.text.trim();
	const match = raw.match(/^\/tasks\b\s*(.*)$/i);
	if (!match) return false;

	const userId = ctx.message.user;
	if (!(await ensureNotBlocked(userId, ctx.respond))) {
		return true;
	}

	const channelId = ctx.message.channel;
	if (!schedulerHolder.instance) {
		await ctx.respond("_Scheduler not initialized._");
		return true;
	}

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
				!(await requirePermission(userId, "view_scheduled_tasks", ctx.respond))
			) {
				return true;
			}
			const tasks = schedulerHolder.instance.listTasks(channelId);
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

			const task = schedulerHolder.instance
				.listTasks(channelId)
				.find((t) => t.id === taskId);
			if (!task) {
				await ctx.respond(`_Task ${taskId} not found in this channel._`);
				return true;
			}

			const canManage = permissionManager.canCancelTask(userId, task.createdBy);
			if (!canManage.allowed) {
				await ctx.respond(formatPermissionDenied(canManage));
				return true;
			}

			if (sub === "pause") {
				const ok = await schedulerHolder.instance.pause(taskId);
				await ctx.respond(
					ok
						? `_Paused task ${taskId}._`
						: `_Could not pause ${taskId}. Only recurring tasks can be paused._`,
				);
				return true;
			}

			if (sub === "resume") {
				const ok = await schedulerHolder.instance.resume(taskId);
				await ctx.respond(
					ok
						? `_Resumed task ${taskId}._`
						: `_Could not resume ${taskId}. Only recurring tasks can be resumed._`,
				);
				return true;
			}

			if (sub === "cancel" || sub === "delete") {
				const ok = await schedulerHolder.instance.cancel(taskId);
				await ctx.respond(
					ok ? `_Cancelled task ${taskId}._` : `_Task ${taskId} not found._`,
				);
				return true;
			}

			// run
			if (activeRuns.has(channelId) || startingRuns.has(channelId)) {
				await ctx.respond(
					"_This channel is busy. Say `stop` first before running a task now._",
				);
				return true;
			}
			schedulerHolder.instance
				.runNow(taskId)
				.catch((err) =>
					logger.logWarning(
						`Failed to run task ${taskId} immediately`,
						String(err),
					),
				);
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
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	if (!(await requirePermission(userId, "view_status", respond))) {
		return;
	}

	const busy = activeRuns.has(channelId) || startingRuns.has(channelId);
	const thinking = thinkingEnabled.get(channelId) ?? false;
	const stats = rateLimiter.getStats(userId, channelId);

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
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	const full = permissionManager.check(userId, "view_costs");
	if (!full.allowed) {
		const own = permissionManager.check(userId, "view_own_costs");
		if (!own.allowed) {
			await respond(formatPermissionDenied(own));
			return;
		}
	}

	const summary = costTracker.getSummary(channelId);
	const formatted = costTracker.formatSummary(summary);
	await respond(formatted);
}

async function handleClearRequest(
	channelId: string,
	userId: string,
	respond: (text: string) => Promise<void>,
): Promise<void> {
	if (!(await requirePermission(userId, "clear_context", respond))) {
		return;
	}
	if (activeRuns.has(channelId) || startingRuns.has(channelId)) {
		await respond("_Can't clear while working. Say `stop` first._");
		return;
	}

	await bot.store.clearHistory(channelId);
	await threadMemoryManager.clearChannel(channelId);
	clearSummaryCache(channelId);
	lastContexts.delete(channelId);
	logger.logInfo(`Context cleared in ${channelId}`);
	await respond("_Conversation history cleared. Starting fresh!_");
}

async function handleMemoryRequest(ctx: SlackContext): Promise<void> {
	const userId = ctx.message.user;
	if (!(await requirePermission(userId, "manage_memory", ctx.respond))) {
		return;
	}

	const channelId = ctx.message.channel;
	const channelDir = join(workingDir, channelId);
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
		const summary = await threadMemoryManager.getThreadSummary(
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
	const active = activeRuns.get(channelId);
	const respond = (text: string) => ctx.postMessage(channelId, text);

	if (!(await ensureNotBlocked(ctx.user, respond))) {
		return;
	}

	switch (ctx.reaction) {
		case "octagonal_sign": {
			// 🛑 Stop command
			if (!(await requirePermission(ctx.user, "stop", respond))) {
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
			if (!(await requirePermission(ctx.user, "view_status", respond))) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleStatusRequest(channelId, ctx.user, respond);
			break;
		}

		case "moneybag":
		case "chart_with_upwards_trend": {
			// 💰 or 📈 Usage/cost check
			const canView = canViewCosts(ctx.user);
			if (!canView.allowed) {
				await respond(
					`_Permission denied${canView.reason ? `: ${canView.reason}` : ""}_`,
				);
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleCostRequest(channelId, ctx.user, respond);
			break;
		}

		case "bar_chart":
		case "clipboard": {
			// 📊 or 📋 Feedback summary
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const feedbackSummary = feedbackTracker.getSummary(channelId);
			const feedbackFormatted = feedbackTracker.formatSummary(feedbackSummary);
			await ctx.postMessage(channelId, feedbackFormatted);
			break;
		}

		case "arrows_counterclockwise":
		case "repeat": {
			// 🔄 Retry last request
			if (!(await requirePermission(ctx.user, "retry", respond))) {
				break;
			}
			if (active) {
				await ctx.postMessage(
					channelId,
					"_Already working. React with 🛑 to stop first._",
				);
				break;
			}

			const lastCtx = lastContexts.get(channelId);
			if (!lastCtx) {
				await ctx.postMessage(channelId, "_No previous request to retry._");
				break;
			}

			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			logger.logInfo(`Retry requested via reaction in ${channelId}`);
			await ctx.postMessage(channelId, "_Retrying last request..._");

			// Re-run with the last context
			await handleMessage(lastCtx, "channel");
			break;
		}

		case "coffee":
		case "brain": {
			// ☕ or 🧠 Toggle extended thinking
			if (!(await requirePermission(ctx.user, "toggle_thinking", respond))) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const current = thinkingEnabled.get(channelId) ?? false;
			thinkingEnabled.set(channelId, !current);

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
			if (!(await requirePermission(ctx.user, "clear_context", respond))) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await handleClearRequest(channelId, ctx.user, respond);
			break;
		}

		case "calendar":
		case "alarm_clock": {
			// 📅 or ⏰ List scheduled tasks
			if (
				!(await requirePermission(ctx.user, "view_scheduled_tasks", respond))
			) {
				break;
			}
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			if (!schedulerHolder.instance) {
				await ctx.postMessage(channelId, "_Scheduler not initialized._");
				break;
			}
			const tasks = schedulerHolder.instance.listTasks(channelId);
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
			const handled = await approvalManager.handleReaction(
				channelId,
				ctx.messageTs,
				ctx.reaction,
			);
			if (handled) {
				await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
				break;
			}

			// Track feedback reactions (👍/👎) on any message
			const feedback = feedbackTracker.record(
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

const bot = new SlackBot(
	{
		async onChannelMention(ctx) {
			await handleMessage(ctx, "channel");
		},

		async onDirectMessage(ctx) {
			await handleMessage(ctx, "dm");
		},

		async onSlashCommand(ctx, command, text) {
			ctx.source = "slash";
			const cmd = command.toLowerCase();
			if (!(await ensureNotBlocked(ctx.message.user, ctx.respond))) {
				return;
			}

			switch (cmd) {
				case "/tasks":
					await handleTasksCommand(ctx);
					return;
				case "/status":
					await handleStatusRequest(
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
					);
					return;
				case "/cost":
					await handleCostRequest(
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
					);
					return;
				case "/memory":
					await handleMemoryRequest(ctx);
					return;
				case "/clear":
					await handleClearRequest(
						ctx.message.channel,
						ctx.message.user,
						ctx.respond,
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
	{
		appToken: SLACK_APP_TOKEN,
		botToken: SLACK_BOT_TOKEN,
		workingDir,
		historyLimit: parsePositiveInt(SLACK_AGENT_HISTORY_LIMIT),
		historyMaxPages: parsePositiveInt(SLACK_AGENT_HISTORY_PAGES),
	},
);

// Initialize scheduler after bot is created
schedulerHolder.instance = new Scheduler({
	workingDir,
	onTaskDue: handleScheduledTask,
	onNotify: handleTaskNotification,
	defaultTimezone: SLACK_AGENT_DEFAULT_TIMEZONE,
});
schedulerHolder.instance.start();

// Update shutdown handler to clean up scheduler and approval manager
async function shutdownWithCleanup(signal: string): Promise<void> {
	console.log(`\nReceived ${signal}, shutting down...`);

	// Stop scheduler
	await schedulerHolder.instance?.stop();

	// Stop approval manager
	approvalManager.stop();

	// Flush thread memory storage
	await threadMemoryManager.shutdown();

	// Abort all active runs
	for (const [channelId, active] of activeRuns) {
		console.log(`Aborting run in channel ${channelId}...`);
		active.runner.abort();
	}

	// Dispose executor (stops auto-created containers)
	await executor.dispose();

	console.log("Shutdown complete.");
	process.exit(0);
}

// Replace the old shutdown handlers
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
process.on("SIGINT", () => shutdownWithCleanup("SIGINT"));
process.on("SIGTERM", () => shutdownWithCleanup("SIGTERM"));

bot.start();
