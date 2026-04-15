/**
 * Webhook Triggers - Routes webhook events to agent runs.
 *
 * Trigger configs are stored in `webhook-triggers.json`:
 * [
 *   {
 *     "id": "review-prs",
 *     "source": "github",
 *     "filter": { "action": "opened", "pull_request": true },
 *     "channel": "C12345",
 *     "prompt": "Review this PR: {{summary}}",
 *     "enabled": true
 *   }
 * ]
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../logger.js";
import { ensureDirSync } from "../utils/fs.js";
import type { WebhookEvent } from "../webhooks.js";

export interface WebhookTrigger {
	id: string;
	source: string;
	filter?: Record<string, unknown>;
	channel: string;
	prompt: string;
	enabled: boolean;
	createdBy?: string;
}

export interface WebhookTriggersConfig {
	triggers: WebhookTrigger[];
}

export type TriggerRunCallback = (
	channel: string,
	prompt: string,
) => Promise<void>;

export class WebhookTriggerManager {
	private workingDir: string;
	private runCallback: TriggerRunCallback | null = null;

	constructor(workingDir: string) {
		this.workingDir = workingDir;
	}

	setRunCallback(cb: TriggerRunCallback): void {
		this.runCallback = cb;
	}

	private getConfigPath(): string {
		return join(this.workingDir, "webhook-triggers.json");
	}

	private loadConfig(): WebhookTriggersConfig {
		const path = this.getConfigPath();
		if (!existsSync(path)) return { triggers: [] };
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as WebhookTriggersConfig;
		} catch {
			return { triggers: [] };
		}
	}

	private saveConfig(config: WebhookTriggersConfig): void {
		ensureDirSync(this.workingDir);
		writeFileSync(this.getConfigPath(), JSON.stringify(config, null, 2));
	}

	/**
	 * Process a webhook event against all triggers.
	 * Returns the number of triggers that fired.
	 */
	async processEvent(event: WebhookEvent): Promise<number> {
		const config = this.loadConfig();
		let fired = 0;

		for (const trigger of config.triggers) {
			if (!trigger.enabled) continue;
			if (trigger.source !== event.source && trigger.source !== "*") continue;

			if (
				trigger.filter &&
				!matchesFilter(event.data as Record<string, unknown>, trigger.filter)
			) {
				continue;
			}

			const prompt = trigger.prompt
				.replace(/\{\{summary\}\}/g, event.summary)
				.replace(/\{\{source\}\}/g, event.source)
				.replace(/\{\{timestamp\}\}/g, event.timestamp);

			const channel = trigger.channel;

			if (this.runCallback) {
				try {
					await this.runCallback(channel, prompt);
					fired++;
					logger.logInfo(`Trigger fired: ${trigger.id} -> #${channel}`);
				} catch (error) {
					logger.logWarning(
						`Trigger ${trigger.id} failed`,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		}

		return fired;
	}

	addTrigger(trigger: Omit<WebhookTrigger, "id">): WebhookTrigger {
		const config = this.loadConfig();
		const full: WebhookTrigger = {
			...trigger,
			id: randomUUID().slice(0, 8),
		};
		config.triggers.push(full);
		this.saveConfig(config);
		return full;
	}

	removeTrigger(id: string): boolean {
		const config = this.loadConfig();
		const idx = config.triggers.findIndex((t) => t.id === id);
		if (idx === -1) return false;
		config.triggers.splice(idx, 1);
		this.saveConfig(config);
		return true;
	}

	listTriggers(): WebhookTrigger[] {
		return this.loadConfig().triggers;
	}

	/**
	 * Handle `/triggers` command from Slack.
	 */
	handleTriggersCommand(args: string, userId: string): string {
		const parts = args.trim().split(/\s+/);
		const subcommand = parts[0] || "list";

		switch (subcommand) {
			case "list":
				return this.formatTriggerList();
			case "add": {
				if (parts.length < 4) {
					return [
						"Usage: `/triggers add <source> <channel> <prompt>`",
						"Example: `/triggers add github C12345 Review this PR: {{summary}}`",
						"",
						"Template variables: `{{summary}}`, `{{source}}`, `{{timestamp}}`",
					].join("\n");
				}
				const source = parts[1]!;
				const channel = parts[2]!;
				const prompt = parts.slice(3).join(" ");
				const trigger = this.addTrigger({
					source,
					channel,
					prompt,
					enabled: true,
					createdBy: userId,
				});
				return `Trigger \`${trigger.id}\` created: ${source} events -> #${channel}`;
			}
			case "remove":
			case "delete": {
				const id = parts[1];
				if (!id) return "Usage: `/triggers remove <id>`";
				const removed = this.removeTrigger(id);
				return removed
					? `Trigger \`${id}\` removed.`
					: `Trigger \`${id}\` not found.`;
			}
			default:
				return "Unknown subcommand. Use: `list`, `add`, `remove`";
		}
	}

	private formatTriggerList(): string {
		const triggers = this.listTriggers();
		if (triggers.length === 0) {
			return [
				"_No webhook triggers configured._",
				"",
				"Use `/triggers add <source> <channel> <prompt>` to create one.",
			].join("\n");
		}

		const lines = ["*Webhook Triggers:*"];
		for (const t of triggers) {
			const status = t.enabled ? ":large_green_circle:" : ":white_circle:";
			lines.push(
				`  ${status} \`${t.id}\` ${t.source} -> #${t.channel}: "${t.prompt.slice(0, 60)}"`,
			);
		}
		return lines.join("\n");
	}
}

function matchesFilter(
	data: Record<string, unknown>,
	filter: Record<string, unknown>,
): boolean {
	for (const [key, value] of Object.entries(filter)) {
		if (value === true) {
			if (!data[key]) return false;
		} else if (typeof value === "string") {
			if (String(data[key]) !== value) return false;
		} else if (typeof value === "number") {
			if (Number(data[key]) !== value) return false;
		}
	}
	return true;
}
