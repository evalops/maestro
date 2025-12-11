#!/usr/bin/env node

/**
 * Slack Agent - Entry Point
 *
 * A Slack bot that runs an AI coding agent in a sandboxed environment.
 */

import { join, resolve } from "node:path";
import { type AgentRunner, createAgentRunner } from "./agent-runner.js";
import { ApprovalManager } from "./approval.js";
import { CostTracker } from "./cost-tracker.js";
import { FeedbackTracker } from "./feedback.js";
import * as logger from "./logger.js";
import { RateLimiter, formatRateLimitMessage } from "./rate-limiter.js";
import {
	type Executor,
	type SandboxConfig,
	createExecutor,
	parseSandboxArg,
	validateSandbox,
} from "./sandbox.js";
import { type ScheduledTask, Scheduler } from "./scheduler.js";
import {
	type ReactionContext,
	SlackBot,
	type SlackContext,
} from "./slack/bot.js";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;

function getSandboxDescription(sandbox: SandboxConfig): string {
	if (sandbox.type === "host") {
		return "host";
	}
	if ("autoCreate" in sandbox && sandbox.autoCreate) {
		return `docker:auto (${sandbox.image || "node:20-slim"})`;
	}
	return `docker:${sandbox.container}`;
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

// Rate limiter - configurable via environment
const rateLimiter = new RateLimiter({
	maxPerUser: Number(process.env.SLACK_RATE_LIMIT_USER) || 10,
	maxPerChannel: Number(process.env.SLACK_RATE_LIMIT_CHANNEL) || 30,
	windowMs: Number(process.env.SLACK_RATE_LIMIT_WINDOW_MS) || 60000,
});

// Cost tracker for usage reporting
const costTracker = new CostTracker(workingDir);

// Feedback tracker for reaction-based feedback
const feedbackTracker = new FeedbackTracker(workingDir);

// Approval manager for destructive operations
const approvalManager = new ApprovalManager();
approvalManager.start();

// Scheduler placeholder (initialized after bot creation)
const schedulerHolder: { instance: Scheduler | null } = { instance: null };

// Track active runs per channel
const activeRuns = new Map<
	string,
	{ runner: AgentRunner; context: SlackContext; stopContext?: SlackContext }
>();

// Track last context per channel for retry
const lastContexts = new Map<string, SlackContext>();

// Track thinking mode preference per channel
const thinkingEnabled = new Map<string, boolean>();

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
				() => resolve(true),
				() => resolve(false),
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
			error?: string;
		}> => {
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
				return {
					success: true,
					taskId: task.id,
					nextRun: new Date(task.nextRun).toLocaleString(),
				};
			}
			return {
				success: false,
				error:
					"Could not parse time expression. Try: 'in 2 hours', 'tomorrow at 9am', 'every day at 9am'",
			};
		},
		onListTasks: async () => {
			if (!schedulerHolder.instance) {
				return [];
			}
			const tasks = schedulerHolder.instance.listTasks(channelId);
			return tasks.map((t) => ({
				id: t.id,
				description: t.description,
				nextRun: new Date(t.nextRun).toLocaleString(),
				recurring: t.schedule !== null,
			}));
		},
		onCancelTask: async (
			taskId: string,
		): Promise<{ success: boolean; error?: string }> => {
			if (!schedulerHolder.instance) {
				return { success: false, error: "Scheduler not initialized" };
			}
			const cancelled = await schedulerHolder.instance.cancel(taskId);
			return cancelled
				? { success: true }
				: { success: false, error: "Task not found" };
		},
	};
}

// Handle scheduled task execution
async function handleScheduledTask(task: ScheduledTask): Promise<void> {
	const channelId = task.channelId;

	// Check if already running in this channel
	if (activeRuns.has(channelId)) {
		logger.logWarning(
			`Skipping scheduled task ${task.id} - channel ${channelId} is busy`,
			task.description,
		);
		return;
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

		// Create approval callback for this channel
		const onApprovalNeeded = createApprovalCallback(channelId, (text) =>
			bot.postMessage(channelId, text),
		);

		// Create schedule callbacks for this channel
		const scheduleCallbacks = createScheduleCallbacks(
			channelId,
			task.createdBy,
		);

		const runner = createAgentRunner(sandbox, workingDir, {
			thinking: useThinking,
			onApprovalNeeded,
			scheduleCallbacks,
		});

		// Create a simplified context for scheduled tasks
		const scheduledCtx = await bot.createScheduledContext(
			channelId,
			task.prompt,
		);
		activeRuns.set(channelId, { runner, context: scheduledCtx });

		await scheduledCtx.setTyping(true);
		await scheduledCtx.setWorking(true);

		try {
			await runner.run(scheduledCtx, channelDir, bot.store);
		} finally {
			await scheduledCtx.setWorking(false);
			activeRuns.delete(channelId);
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.logWarning(`Scheduled task failed: ${task.id}`, errorMsg);
	}
}

async function handleMessage(
	ctx: SlackContext,
	_source: "channel" | "dm",
): Promise<void> {
	const channelId = ctx.message.channel;
	const messageText = ctx.message.text.toLowerCase().trim();

	const logCtx = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
	};

	// Check for stop command
	if (messageText === "stop") {
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

	// Check if already running in this channel
	if (activeRuns.has(channelId)) {
		await ctx.respond("_Already working on something. Say `stop` to cancel._");
		return;
	}

	// Check rate limit
	const rateCheck = rateLimiter.check(ctx.message.user, channelId);
	if (!rateCheck.allowed) {
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

	// Create approval callback for this channel
	const onApprovalNeeded = createApprovalCallback(channelId, (text) =>
		bot.postMessage(channelId, text),
	);

	// Create schedule callbacks for this channel
	const scheduleCallbacks = createScheduleCallbacks(
		channelId,
		ctx.message.user,
	);

	const runner = createAgentRunner(sandbox, workingDir, {
		thinking: useThinking,
		onApprovalNeeded,
		scheduleCallbacks,
	});
	activeRuns.set(channelId, { runner, context: ctx });

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
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.logAgentError(logCtx, errorMsg);
		await ctx.respond(`_Error: ${errorMsg}_`);
	} finally {
		await ctx.setWorking(false);
		activeRuns.delete(channelId);
	}
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

	switch (ctx.reaction) {
		case "octagonal_sign": {
			// 🛑 Stop command
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
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const thinking = thinkingEnabled.get(channelId) ?? false;
			if (active) {
				await ctx.postMessage(
					channelId,
					`_Working on a task${thinking ? " (thinking mode)" : ""}. React with 🛑 to stop._`,
				);
			} else {
				await ctx.postMessage(
					channelId,
					`_Nothing running${thinking ? " (thinking mode on)" : ""}. Mention me to start._`,
				);
			}
			break;
		}

		case "moneybag":
		case "chart_with_upwards_trend": {
			// 💰 or 📈 Usage/cost check
			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			const summary = costTracker.getSummary(channelId);
			const formatted = costTracker.formatSummary(summary);
			await ctx.postMessage(channelId, formatted);
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
			if (active) {
				await ctx.postMessage(
					channelId,
					"_Can't clear while working. React with 🛑 to stop first._",
				);
				break;
			}

			await ctx.addReaction("white_check_mark", ctx.channel, ctx.messageTs);
			await bot.store.clearHistory(channelId);
			lastContexts.delete(channelId);
			logger.logInfo(`Context cleared via reaction in ${channelId}`);
			await ctx.postMessage(
				channelId,
				"_Conversation history cleared. Starting fresh!_",
			);
			break;
		}

		case "calendar":
		case "alarm_clock": {
			// 📅 or ⏰ List scheduled tasks
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
						const nextRun = new Date(t.nextRun).toLocaleString();
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
				ctx.userId,
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

		async onReaction(ctx) {
			await handleReaction(ctx);
		},
	},
	{
		appToken: SLACK_APP_TOKEN,
		botToken: SLACK_BOT_TOKEN,
		workingDir,
	},
);

// Initialize scheduler after bot is created
schedulerHolder.instance = new Scheduler({
	workingDir,
	onTaskDue: handleScheduledTask,
});
schedulerHolder.instance.start();

// Update shutdown handler to clean up scheduler and approval manager
async function shutdownWithCleanup(signal: string): Promise<void> {
	console.log(`\nReceived ${signal}, shutting down...`);

	// Stop scheduler
	schedulerHolder.instance?.stop();

	// Stop approval manager
	approvalManager.stop();

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
