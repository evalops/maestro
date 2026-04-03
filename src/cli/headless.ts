/**
 * Headless Agent Mode for Native TUI Communication
 *
 * This module wires stdin/stdout to the shared headless protocol helpers.
 * The protocol itself lives in `headless-protocol.ts` so local stdio and
 * remote runtimes stay aligned.
 */

import {
	type HeadlessToAgentMessageType,
	headlessToAgentMessageTypes,
} from "@evalops/contracts";
import type { ActionApprovalService } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import { HeadlessUtilityCommandManager } from "../headless/utility-command-manager.js";
import { searchWorkspaceFiles } from "../headless/utility-file-search.js";
import { HeadlessUtilityFileWatchManager } from "../headless/utility-file-watch-manager.js";
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

function isHeadlessToAgentMessageType(
	value: string,
): value is HeadlessToAgentMessageType {
	return headlessToAgentMessageTypes.includes(
		value as HeadlessToAgentMessageType,
	);
}

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
	const utilityCommands = new HeadlessUtilityCommandManager((event) => {
		switch (event.type) {
			case "started":
				sendMessage({
					type: "utility_command_started",
					command_id: event.command_id,
					command: event.command,
					cwd: event.cwd,
					shell_mode: event.shell_mode,
					pid: event.pid,
				});
				return;
			case "output":
				sendMessage({
					type: "utility_command_output",
					command_id: event.command_id,
					stream: event.stream,
					content: event.content,
				});
				return;
			case "exited":
				sendMessage({
					type: "utility_command_exited",
					command_id: event.command_id,
					success: event.success,
					exit_code: event.exit_code,
					signal: event.signal,
					reason: event.reason,
				});
				return;
		}
	});
	const fileWatches = new HeadlessUtilityFileWatchManager((event) => {
		switch (event.type) {
			case "started":
				sendMessage({
					type: "utility_file_watch_started",
					watch_id: event.watch_id,
					root_dir: event.root_dir,
					include_patterns: event.include_patterns,
					exclude_patterns: event.exclude_patterns,
					debounce_ms: event.debounce_ms,
				});
				return;
			case "event":
				sendMessage({
					type: "utility_file_watch_event",
					watch_id: event.watch_id,
					change_type: event.change_type,
					path: event.path,
					relative_path: event.relative_path,
					timestamp: event.timestamp,
					is_directory: event.is_directory,
				});
				return;
			case "stopped":
				sendMessage({
					type: "utility_file_watch_stopped",
					watch_id: event.watch_id,
					reason: event.reason,
				});
				return;
		}
	});

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
		let msg: HeadlessToAgentMessage;
		try {
			const parsed = JSON.parse(line) as {
				type?: string;
			};
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof parsed.type !== "string" ||
				!isHeadlessToAgentMessageType(parsed.type)
			) {
				sendError(
					"Failed to parse command: Unknown headless command type",
					false,
				);
				return;
			}
			msg = parsed as HeadlessToAgentMessage;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(`Failed to parse command: ${message}`, false);
			return;
		}

		try {
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
					sendMessage(
						translator.buildConnectionInfoMessage({
							connection_id: "local",
							protocol_version: msg.protocol_version,
							client_info: msg.client_info,
							capabilities: msg.capabilities,
							role: msg.role ?? "controller",
							connection_count: 1,
							controller_connection_id:
								(msg.role ?? "controller") === "controller" ? "local" : null,
							lease_expires_at: null,
							connections: state.connections,
						}),
					);
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
					await utilityCommands.dispose(
						msg.type === "interrupt"
							? "Interrupted while utility command was still running"
							: "Cancelled while utility command was still running",
					);
					fileWatches.dispose(
						msg.type === "interrupt"
							? "Interrupted while file watch was still running"
							: "Cancelled while file watch was still running",
					);
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

				case "server_request_response":
					if (msg.request_type === "approval") {
						if (approvalService) {
							if (msg.approved) {
								const resolved = approvalService.approve(msg.request_id);
								if (!resolved) {
									sendError(
										`No pending approval found for request_id: ${msg.request_id}`,
										false,
									);
								}
							} else {
								const reason = msg.result?.error ?? "Denied by user";
								const resolved = approvalService.deny(msg.request_id, reason);
								if (!resolved) {
									sendError(
										`No pending approval found for request_id: ${msg.request_id}`,
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
					} else {
						const resolved = clientToolService.resolve(
							msg.request_id,
							msg.content ?? [],
							msg.is_error ?? false,
						);
						if (!resolved) {
							sendError(
								`No pending client tool request found for request_id: ${msg.request_id}`,
								false,
							);
						}
					}
					applyOutgoingHeadlessMessage(state, msg);
					break;

				case "utility_command_start":
					if (
						!state.capabilities?.utility_operations?.includes("command_exec")
					) {
						sendError(
							"utility_command_start requires command_exec capability",
							false,
						);
						break;
					}
					await utilityCommands.start({
						command_id: msg.command_id,
						command: msg.command,
						cwd: msg.cwd,
						env: msg.env,
						shell_mode: msg.shell_mode,
						allow_stdin: msg.allow_stdin,
					});
					break;

				case "utility_command_terminate":
					await utilityCommands.terminate(msg.command_id, msg.force);
					break;

				case "utility_command_stdin":
					if (
						!state.capabilities?.utility_operations?.includes("command_exec")
					) {
						sendError(
							"utility_command_stdin requires command_exec capability",
							false,
						);
						break;
					}
					await utilityCommands.writeStdin(
						msg.command_id,
						msg.content,
						msg.eof,
					);
					break;

				case "utility_file_search":
					if (
						!state.capabilities?.utility_operations?.includes("file_search")
					) {
						sendError(
							"utility_file_search requires file_search capability",
							false,
						);
						break;
					}
					{
						const result = searchWorkspaceFiles({
							query: msg.query,
							cwd: msg.cwd,
							limit: msg.limit,
						});
						sendMessage({
							type: "utility_file_search_results",
							search_id: msg.search_id,
							query: result.query,
							cwd: result.cwd,
							results: result.results,
							truncated: result.truncated,
						});
					}
					break;

				case "utility_file_watch_start":
					if (!state.capabilities?.utility_operations?.includes("file_watch")) {
						sendError(
							"utility_file_watch_start requires file_watch capability",
							false,
						);
						break;
					}
					await fileWatches.start({
						watch_id: msg.watch_id,
						root_dir: msg.root_dir,
						include_patterns: msg.include_patterns,
						exclude_patterns: msg.exclude_patterns,
						debounce_ms: msg.debounce_ms,
					});
					break;

				case "utility_file_watch_stop":
					fileWatches.stop(msg.watch_id, "Stopped by controller");
					break;

				case "shutdown":
					sendPendingRequestCancellations("Shutdown before request completed");
					applyOutgoingHeadlessMessage(state, msg);
					await utilityCommands.dispose(
						"Headless runtime shutdown while utility command was still running",
					);
					fileWatches.dispose(
						"Headless runtime shutdown while file watch was still running",
					);
					process.exit(0);
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(message, false);
		}
	});

	return new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}
