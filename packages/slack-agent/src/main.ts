#!/usr/bin/env node

/**
 * Slack Agent - Entry Point
 *
 * A Slack bot that runs an AI coding agent in a sandboxed environment.
 */

import { join, resolve } from "node:path";
import { type AgentRunner, createAgentRunner } from "./agent-runner.js";
import { CostTracker } from "./cost-tracker.js";
import * as logger from "./logger.js";
import { RateLimiter, formatRateLimitMessage } from "./rate-limiter.js";
import {
	type Executor,
	type SandboxConfig,
	createExecutor,
	parseSandboxArg,
	validateSandbox,
} from "./sandbox.js";
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

// Track active runs per channel
const activeRuns = new Map<
	string,
	{ runner: AgentRunner; context: SlackContext; stopContext?: SlackContext }
>();

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

	const runner = createAgentRunner(sandbox, workingDir);
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

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
	console.log(`\nReceived ${signal}, shutting down...`);

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

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Reaction command handlers
// 🛑 octagonal_sign - Stop current run
// 👀 eyes - Check status
// 💰 moneybag - Check usage/costs
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
			if (active) {
				await ctx.postMessage(
					channelId,
					"_Working on a task. React with 🛑 to stop._",
				);
			} else {
				await ctx.postMessage(
					channelId,
					"_Nothing running. Mention me to start._",
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

bot.start();
