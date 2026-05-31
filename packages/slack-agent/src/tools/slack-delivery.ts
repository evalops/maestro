import { Type } from "@sinclair/typebox";
import type { MessageQueue } from "../utils/message-queue.js";
import type { AgentTool } from "./index.js";

export const slackDeliveryToolNames = [
	"send_message",
	"send_thread_reply",
	"send_progress",
	"send_request",
	"send_final",
	"send_error",
	"send_blocker",
] as const;

export type SlackDeliveryToolName = (typeof slackDeliveryToolNames)[number];

export function isSlackDeliveryTool(name: string): boolean {
	return slackDeliveryToolNames.includes(name as SlackDeliveryToolName);
}

export interface SlackDeliveryToolOptions {
	queue: MessageQueue;
	defaultChannel: string;
	defaultThreadTs?: string;
}

const textField = Type.String({
	description: "Slack mrkdwn text to send. Do not include secrets or raw logs.",
});

export function createSlackDeliveryTools(
	options: SlackDeliveryToolOptions,
): AgentTool[] {
	return [
		{
			name: "send_message",
			label: "send_message",
			description:
				"Send a visible Slack channel message. Use sparingly; most task updates should stay in the current thread.",
			parameters: Type.Object({
				channel: Type.Optional(
					Type.String({
						description:
							"Slack channel ID. Defaults to the current channel when omitted.",
					}),
				),
				text: textField,
			}),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				const channel = stringArg(args.channel) || options.defaultChannel;
				const text = requiredText(args.text);
				options.queue.sendMessage(channel, text, true);
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult("Slack message sent.");
			},
		},
		{
			name: "send_thread_reply",
			label: "send_thread_reply",
			description:
				"Send a Slack thread reply. Use for requested side notes, details, or follow-up context that should not replace the final answer.",
			parameters: Type.Object({
				channel: Type.Optional(
					Type.String({
						description:
							"Slack channel ID. Defaults to the current channel when omitted.",
					}),
				),
				threadTs: Type.Optional(
					Type.String({
						description:
							"Slack thread timestamp. Defaults to the current thread when omitted.",
					}),
				),
				text: textField,
			}),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				const channel = stringArg(args.channel) || options.defaultChannel;
				const threadTs = stringArg(args.threadTs) || options.defaultThreadTs;
				if (!threadTs) {
					throw new Error("send_thread_reply requires a thread timestamp");
				}
				const text = requiredText(args.text);
				options.queue.sendThreadReply(channel, threadTs, text, true);
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult("Slack thread reply sent.");
			},
		},
		{
			name: "send_progress",
			label: "send_progress",
			description:
				"Send a short, rate-limited Slack progress update. Use only for meaningful movement, waiting on checks, changing direction, or a blocker.",
			parameters: Type.Object({ text: textField }),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				const sent = options.queue.sendProgress(requiredText(args.text));
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult(
					sent
						? "Slack progress update sent."
						: "Slack progress update skipped by rate limit.",
				);
			},
		},
		{
			name: "send_request",
			label: "send_request",
			description:
				"Ask one concrete Slack question or approval request when you cannot responsibly continue without user input.",
			parameters: Type.Object({ text: textField }),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				options.queue.sendRequest(requiredText(args.text));
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult("Request sent in Slack.");
			},
		},
		{
			name: "send_final",
			label: "send_final",
			description:
				"Send the one clean final Slack answer for this request. Put the outcome first, then important checks/changes, then any real blocker or next human action.",
			parameters: Type.Object({ text: textField }),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				const sent = options.queue.sendFinal(requiredText(args.text));
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult(
					sent ? "Final sent in Slack." : "Final was already sent in Slack.",
				);
			},
		},
		{
			name: "send_error",
			label: "send_error",
			description:
				"Send a separate Slack blocker/error reply when the work cannot continue without access, approval, or an external system recovery.",
			parameters: Type.Object({ text: textField }),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				options.queue.sendError(requiredText(args.text));
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult("Slack error message sent.");
			},
		},
		{
			name: "send_blocker",
			label: "send_blocker",
			description:
				"Send a separate Slack blocker reply when external access, approval, or system recovery is required.",
			parameters: Type.Object({ text: textField }),
			execute: async (_toolCallId, args) => {
				const failureCount = await deliveryFailureBaseline(options.queue);
				options.queue.sendBlocker(requiredText(args.text));
				await options.queue.flushOrThrowIfDeliveryFailed(failureCount);
				return textResult("Slack blocker message sent.");
			},
		},
	];
}

async function deliveryFailureBaseline(queue: MessageQueue): Promise<number> {
	await queue.flush();
	return queue.deliveryFailures();
}

function requiredText(value: unknown): string {
	const text = stringArg(value);
	if (!text) {
		throw new Error("Slack message text is required");
	}
	return text;
}

function stringArg(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function textResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
	};
}
