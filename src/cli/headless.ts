/**
 * Headless Agent Mode for Native TUI Communication
 *
 * This module wires stdin/stdout to the shared headless protocol helpers.
 * The protocol itself lives in `headless-protocol.ts` so local stdio and
 * remote runtimes stay aligned.
 */

import type { ActionApprovalService } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import { clientToolService } from "../server/client-tools-service.js";
import type { SessionManager } from "../session/manager.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessFromAgentMessage,
	HeadlessProtocolTranslator,
	type HeadlessToAgentMessage,
	applyIncomingHeadlessMessage,
	applyInitMessage,
	applyOutgoingHeadlessMessage,
	buildHeadlessCompactionMessage,
	buildHeadlessServerRequestCancellationMessages,
	buildHeadlessToolsSummary,
	buildHeadlessUsage,
	classifyHeadlessError,
	createHeadlessRuntimeState,
	loadPromptAttachments,
} from "./headless-protocol.js";

export {
	HEADLESS_PROTOCOL_VERSION,
	buildHeadlessCompactionMessage,
	buildHeadlessToolsSummary,
	buildHeadlessUsage,
	classifyHeadlessError,
};

function send(msg: HeadlessFromAgentMessage): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendError(message: string, fatal: boolean): void {
	send({
		type: "error",
		message,
		fatal,
		error_type: classifyHeadlessError(message, fatal),
	});
}

export async function runHeadlessMode(
	agent: Agent,
	sessionManager: SessionManager,
	approvalService?: ActionApprovalService,
): Promise<void> {
	const translator = new HeadlessProtocolTranslator();
	const state = createHeadlessRuntimeState();

	const sendMessage = (msg: HeadlessFromAgentMessage): void => {
		applyIncomingHeadlessMessage(state, msg);
		send(msg);
	};

	const sendPendingRequestCancellations = (reason: string): void => {
		for (const message of buildHeadlessServerRequestCancellationMessages(
			state,
			reason,
		)) {
			sendMessage(message);
		}
	};

	agent.subscribe((event) => {
		for (const message of translator.handleAgentEvent(event)) {
			sendMessage(message);
		}
	});

	sendMessage(translator.buildReadyMessage(agent, sessionManager));
	sendMessage(translator.buildSessionInfoMessage(sessionManager));

	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	rl.on("line", async (line: string) => {
		try {
			const msg = JSON.parse(line) as HeadlessToAgentMessage;

			switch (msg.type) {
				case "init": {
					const applied = applyInitMessage(agent, msg, approvalService);
					sendMessage({
						type: "status",
						message:
							applied.length > 0
								? `Initialized: ${applied.join(", ")}`
								: "Init received with no changes",
					});
					break;
				}

				case "hello":
					applyOutgoingHeadlessMessage(state, msg);
					sendMessage(translator.buildConnectionInfoMessage(msg));
					if (
						msg.protocol_version &&
						msg.protocol_version !== HEADLESS_PROTOCOL_VERSION
					) {
						sendMessage({
							type: "status",
							message: `Client protocol ${msg.protocol_version} attached to server ${HEADLESS_PROTOCOL_VERSION}`,
						});
					}
					break;

				case "prompt":
					applyOutgoingHeadlessMessage(state, msg);
					if (msg.attachments && msg.attachments.length > 0) {
						const loaded = await loadPromptAttachments(
							msg.attachments,
							sendError,
						);
						if (loaded.length > 0) {
							sendMessage({
								type: "status",
								message: `Loaded ${loaded.length} attachment(s)`,
							});
							await agent.prompt(msg.content, loaded);
						} else {
							await agent.prompt(msg.content);
						}
					} else {
						await agent.prompt(msg.content);
					}
					break;

				case "interrupt":
				case "cancel":
					sendPendingRequestCancellations(
						msg.type === "interrupt"
							? "Interrupted before request completed"
							: "Cancelled before request completed",
					);
					applyOutgoingHeadlessMessage(state, msg);
					agent.abort();
					break;

				case "tool_response":
					if (approvalService) {
						if (msg.approved) {
							const resolved = approvalService.approve(msg.call_id);
							if (!resolved) {
								sendError(
									`No pending approval found for call_id: ${msg.call_id}`,
									false,
								);
							}
						} else {
							const reason = msg.result?.error ?? "Denied by user";
							const resolved = approvalService.deny(msg.call_id, reason);
							if (!resolved) {
								sendError(
									`No pending approval found for call_id: ${msg.call_id}`,
									false,
								);
							}
						}
					} else {
						sendMessage({
							type: "status",
							message: "Tool response ignored (auto-approval mode)",
						});
					}
					applyOutgoingHeadlessMessage(state, msg);
					break;

				case "client_tool_result": {
					const resolved = clientToolService.resolve(
						msg.call_id,
						msg.content,
						msg.is_error,
					);
					if (!resolved) {
						sendError(
							`No pending client tool request found for call_id: ${msg.call_id}`,
							false,
						);
					} else {
						sendMessage({
							type: "server_request_resolved",
							request_id: msg.call_id,
							request_type: "client_tool",
							call_id: msg.call_id,
							resolution: msg.is_error ? "failed" : "completed",
							reason: msg.is_error
								? "Client tool result reported an error"
								: undefined,
							resolved_by: "client",
						});
					}
					applyOutgoingHeadlessMessage(state, msg);
					break;
				}

				case "shutdown":
					sendPendingRequestCancellations("Shutdown before request completed");
					applyOutgoingHeadlessMessage(state, msg);
					process.exit(0);
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(`Failed to parse command: ${message}`, false);
		}
	});

	return new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}
