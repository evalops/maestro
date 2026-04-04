/**
 * Headless Agent Mode for Native TUI Communication
 *
 * This module wires stdin/stdout to the shared headless protocol helpers.
 * The protocol itself lives in `headless-protocol.ts` so local stdio and
 * remote runtimes stay aligned.
 */

import {
	assertHeadlessFromAgentMessage,
	assertHeadlessToAgentMessage,
} from "@evalops/contracts";
import type { ActionApprovalService } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type { ToolRetryService } from "../agent/tool-retry.js";
import { HeadlessUtilityCommandManager } from "../headless/utility-command-manager.js";
import { readWorkspaceFile } from "../headless/utility-file-read.js";
import { searchWorkspaceFiles } from "../headless/utility-file-search.js";
import { HeadlessUtilityFileWatchManager } from "../headless/utility-file-watch-manager.js";
import { clientToolService } from "../server/client-tools-service.js";
import { serverRequestManager } from "../server/server-request-manager.js";
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
	buildHeadlessRawAgentEventMessage,
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

const LOCAL_HEADLESS_CONNECTION_ID = "local";

function localHeadlessViewerCanSend(msg: HeadlessToAgentMessage): boolean {
	switch (msg.type) {
		case "hello":
		case "shutdown":
			return true;
		default:
			return false;
	}
}

function send(msg: HeadlessFromAgentMessage): void {
	try {
		assertHeadlessFromAgentMessage(msg, "headless stdout message");
		process.stdout.write(`${JSON.stringify(msg)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			process.stdout.write(
				`${JSON.stringify({
					type: "error",
					message: `Failed to emit headless message: ${message}`,
					fatal: false,
					error_type: "protocol",
				} satisfies HeadlessFromAgentMessage)}\n`,
			);
		} catch {
			// Ignore fallback write failures; there is no safer recovery path on stdout.
		}
	}
}

function sendError(
	message: string,
	fatal: boolean,
	options?: { request_id?: string },
): void {
	send({
		type: "error",
		request_id: options?.request_id,
		message,
		fatal,
		error_type: classifyHeadlessError(message, fatal),
	});
}

export async function runHeadlessMode(
	agent: Agent,
	sessionManager: SessionManager,
	approvalService?: ActionApprovalService,
	toolRetryService?: ToolRetryService,
): Promise<void> {
	const translator = new HeadlessProtocolTranslator();
	const state = createHeadlessRuntimeState();

	const shouldFilterOutgoingMessage = (
		msg: HeadlessFromAgentMessage,
		force = false,
	): boolean => {
		if (force || !state.opt_out_notifications?.length) {
			return false;
		}
		switch (msg.type) {
			case "status":
				return state.opt_out_notifications.includes("status");
			case "compaction":
				return state.opt_out_notifications.includes("compaction");
			case "connection_info":
				return state.opt_out_notifications.includes("connection_info");
			default:
				return false;
		}
	};

	const sendMessage = (
		msg: HeadlessFromAgentMessage,
		options?: { force?: boolean },
	): void => {
		applyIncomingHeadlessMessage(state, msg);
		if (shouldFilterOutgoingMessage(msg, options?.force)) {
			return;
		}
		send(msg);
	};
	const shouldHandleServerRequestEvent = (
		sessionId: string | undefined,
	): boolean => {
		const currentSessionId = sessionManager.getSessionId() ?? undefined;
		if (!currentSessionId) {
			return sessionId === undefined;
		}
		return sessionId === currentSessionId;
	};

	const cancelPendingServerRequests = (reason: string): void => {
		const sessionId = sessionManager.getSessionId() ?? undefined;
		if (sessionId) {
			serverRequestManager.cancelBySession(sessionId, reason, "runtime");
		}
		for (const request of [
			...state.pending_approvals,
			...state.pending_client_tools,
			...state.pending_user_inputs,
			...state.pending_tool_retries,
		]) {
			serverRequestManager.cancel(
				request.request_id ?? request.call_id,
				reason,
				"runtime",
			);
		}
	};
	const utilityCommands = new HeadlessUtilityCommandManager((event) => {
		switch (event.type) {
			case "started":
				sendMessage({
					type: "utility_command_started",
					command_id: event.command_id,
					command: event.command,
					shell_mode: event.shell_mode,
					terminal_mode: event.terminal_mode,
					...(event.cwd ? { cwd: event.cwd } : {}),
					...(event.pid !== undefined ? { pid: event.pid } : {}),
					...(event.columns !== undefined ? { columns: event.columns } : {}),
					...(event.rows !== undefined ? { rows: event.rows } : {}),
					...(event.owner_connection_id
						? { owner_connection_id: event.owner_connection_id }
						: {}),
				});
				return;
			case "resized":
				sendMessage({
					type: "utility_command_resized",
					command_id: event.command_id,
					columns: event.columns,
					rows: event.rows,
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
					owner_connection_id: event.owner_connection_id,
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

	const unsubscribeServerRequests = serverRequestManager.subscribe((event) => {
		if (!shouldHandleServerRequestEvent(event.request.sessionId)) {
			return;
		}
		if (event.type === "registered") {
			sendMessage({
				type: "server_request",
				request_id: event.request.id,
				request_type: event.request.kind,
				call_id: event.request.callId,
				tool: event.request.toolName,
				args: event.request.args,
				reason: event.request.reason,
			});
			return;
		}
		sendMessage({
			type: "server_request_resolved",
			request_id: event.request.id,
			request_type: event.request.kind,
			call_id: event.request.callId,
			resolution: event.resolution,
			reason: event.reason,
			resolved_by: event.resolvedBy,
		});
	});

	agent.subscribe((event) => {
		if (state.capabilities?.raw_agent_events) {
			sendMessage(buildHeadlessRawAgentEventMessage(event));
		}
		if (
			event.type === "action_approval_required" &&
			!approvalService?.requiresUserInteraction()
		) {
			return;
		}
		const pendingApprovalRegistration =
			event.type === "action_approval_required" &&
			approvalService?.requiresUserInteraction() &&
			!serverRequestManager.get(event.request.id)
				? {
						sessionId: sessionManager.getSessionId() ?? undefined,
						request: event.request,
						service: approvalService,
					}
				: null;
		for (const message of translator.handleAgentEvent(event)) {
			if (
				message.type === "server_request" ||
				message.type === "server_request_resolved"
			) {
				continue;
			}
			sendMessage(message);
		}
		if (pendingApprovalRegistration) {
			serverRequestManager.registerApproval(pendingApprovalRegistration);
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
			const parsed = JSON.parse(line) as unknown;
			assertHeadlessToAgentMessage(parsed, "headless command");
			msg = parsed;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(`Failed to parse command: ${message}`, false);
			return;
		}

		try {
			if (
				state.connection_role === "viewer" &&
				!localHeadlessViewerCanSend(msg)
			) {
				send({
					type: "error",
					message: "Viewer headless connections cannot send messages",
					fatal: false,
					error_type: "protocol",
				});
				return;
			}

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
					toolRetryService?.setMode(
						msg.capabilities?.server_requests?.includes("tool_retry")
							? "prompt"
							: "skip",
					);
					sendMessage(
						translator.buildHelloOkMessage({
							connection_id: LOCAL_HEADLESS_CONNECTION_ID,
							protocol_version: HEADLESS_PROTOCOL_VERSION,
							client_protocol_version: msg.protocol_version,
							client_info: msg.client_info,
							capabilities: msg.capabilities,
							opt_out_notifications: msg.opt_out_notifications,
							role: msg.role ?? "controller",
							controller_connection_id:
								(msg.role ?? "controller") === "controller"
									? LOCAL_HEADLESS_CONNECTION_ID
									: null,
							lease_expires_at: null,
						}),
						{ force: true },
					);
					sendMessage(
						translator.buildConnectionInfoMessage({
							connection_id: LOCAL_HEADLESS_CONNECTION_ID,
							protocol_version: msg.protocol_version,
							client_info: msg.client_info,
							capabilities: msg.capabilities,
							opt_out_notifications: msg.opt_out_notifications,
							role: msg.role ?? "controller",
							connection_count: 1,
							controller_connection_id:
								(msg.role ?? "controller") === "controller"
									? LOCAL_HEADLESS_CONNECTION_ID
									: null,
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
					cancelPendingServerRequests(
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
					if (approvalService?.requiresUserInteraction()) {
						const reason = msg.approved
							? (msg.result?.output ?? "Approved")
							: (msg.result?.error ?? "Denied by user");
						const resolved = serverRequestManager.resolveApproval(msg.call_id, {
							approved: msg.approved,
							reason,
							resolvedBy: "user",
						});
						if (!resolved) {
							sendError(
								`No pending approval found for call_id: ${msg.call_id}`,
								false,
							);
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
					}
					applyOutgoingHeadlessMessage(state, msg);
					break;
				}

				case "server_request_response":
					if (msg.request_type === "approval") {
						if (approvalService?.requiresUserInteraction()) {
							const reason = msg.approved
								? (msg.result?.output ?? "Approved")
								: (msg.result?.error ?? "Denied by user");
							const resolved = serverRequestManager.resolveApproval(
								msg.request_id,
								{
									approved: msg.approved ?? false,
									reason,
									resolvedBy: "user",
								},
							);
							if (!resolved) {
								sendError(
									`No pending approval found for request_id: ${msg.request_id}`,
									false,
								);
							}
						} else {
							sendMessage({
								type: "status",
								message: "Tool response ignored (auto-approval mode)",
							});
						}
					} else if (msg.request_type === "tool_retry") {
						const resolved = serverRequestManager.resolveToolRetry(
							msg.request_id,
							{
								action: msg.decision_action ?? "abort",
								reason: msg.reason,
								resolvedBy: "user",
							},
						);
						if (!resolved) {
							sendError(
								`No pending tool retry request found for request_id: ${msg.request_id}`,
								false,
							);
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
						terminal_mode: msg.terminal_mode,
						allow_stdin: msg.allow_stdin,
						columns: msg.columns,
						rows: msg.rows,
						owner_connection_id: LOCAL_HEADLESS_CONNECTION_ID,
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

				case "utility_command_resize":
					if (
						!state.capabilities?.utility_operations?.includes("command_exec")
					) {
						sendError(
							"utility_command_resize requires command_exec capability",
							false,
						);
						break;
					}
					await utilityCommands.resize(msg.command_id, msg.columns, msg.rows);
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

				case "utility_file_read":
					if (!state.capabilities?.utility_operations?.includes("file_read")) {
						sendError("utility_file_read requires file_read capability", false);
						break;
					}
					{
						let result: Awaited<ReturnType<typeof readWorkspaceFile>>;
						try {
							result = await readWorkspaceFile({
								path: msg.path,
								cwd: msg.cwd,
								offset: msg.offset,
								limit: msg.limit,
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							sendError(message, false, { request_id: msg.read_id });
							break;
						}
						sendMessage({
							type: "utility_file_read_result",
							read_id: msg.read_id,
							path: result.path,
							relative_path: result.relative_path,
							cwd: result.cwd,
							content: result.content,
							start_line: result.start_line,
							end_line: result.end_line,
							total_lines: result.total_lines,
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
						owner_connection_id: LOCAL_HEADLESS_CONNECTION_ID,
					});
					break;

				case "utility_file_watch_stop":
					fileWatches.stop(msg.watch_id, "Stopped by controller");
					break;

				case "shutdown":
					cancelPendingServerRequests("Shutdown before request completed");
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
			unsubscribeServerRequests();
			resolve();
		});
	});
}
