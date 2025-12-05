#!/usr/bin/env node

/**
 * Slack Agent - Entry Point
 *
 * A Slack bot that runs an AI coding agent in a sandboxed environment.
 */

import { join, resolve } from "node:path";
import { type AgentRunner, createAgentRunner } from "./agent-runner.js";
import * as logger from "./logger.js";
import {
	type SandboxConfig,
	parseSandboxArg,
	validateSandbox,
} from "./sandbox.js";
import { SlackBot, type SlackContext } from "./slack/bot.js";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;

function parseArgs(): { workingDir: string; sandbox: SandboxConfig } {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			const next = args[++i];
			if (!next) {
				console.error(
					"Error: --sandbox requires a value (host or docker:<container-name>)",
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
		console.error(
			"Usage: slack-agent [--sandbox=host|docker:<container-name>] <working-directory>",
		);
		console.error("");
		console.error("Options:");
		console.error(
			"  --sandbox=host                  Run tools directly on host (default)",
		);
		console.error(
			"  --sandbox=docker:<container>    Run tools in Docker container",
		);
		console.error("");
		console.error("Examples:");
		console.error("  slack-agent ./data");
		console.error("  slack-agent --sandbox=docker:slack-agent-sandbox ./data");
		process.exit(1);
	}

	return { workingDir: resolve(workingDir), sandbox };
}

const { workingDir, sandbox } = parseArgs();

logger.logStartup(
	workingDir,
	sandbox.type === "host" ? "host" : `docker:${sandbox.container}`,
);

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

	logger.logUserMessage(logCtx, ctx.message.text);
	const channelDir = join(workingDir, channelId);

	const runner = createAgentRunner(sandbox);
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

const bot = new SlackBot(
	{
		async onChannelMention(ctx) {
			await handleMessage(ctx, "channel");
		},

		async onDirectMessage(ctx) {
			await handleMessage(ctx, "dm");
		},
	},
	{
		appToken: SLACK_APP_TOKEN,
		botToken: SLACK_BOT_TOKEN,
		workingDir,
	},
);

bot.start();
