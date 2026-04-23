import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
	type HeadlessConnectionRole,
	assertHeadlessRuntimeHeartbeatSnapshot,
	assertHeadlessRuntimeStreamEnvelope,
	assertHeadlessRuntimeSubscriptionSnapshot,
	headlessProtocolVersion,
} from "@evalops/contracts";
import chalk from "chalk";
import {
	type HeadlessFromAgentMessage,
	type HeadlessPendingApprovalState,
	type HeadlessRuntimeState,
	type HeadlessToAgentMessage,
	applyIncomingHeadlessMessage,
	applyOutgoingHeadlessMessage,
	createHeadlessRuntimeState,
} from "../cli/headless-protocol.js";

const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_NAME = "maestro-remote-cli";

export interface RemoteRunnerAttachConnection {
	sessionId: string;
	connectionId: string;
	subscriptionId: string;
	heartbeatIntervalMs: number;
	role: "viewer" | "controller";
	state: HeadlessRuntimeState;
}

export interface RemoteRunnerAttachConnectInput {
	gatewayBaseUrl: string;
	sessionId: string;
	tokenId: string;
	tokenSecret: string;
	role: "viewer" | "controller";
	clientName?: string;
	clientVersion?: string;
	protocolVersion?: string;
	takeControl?: boolean;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export interface RemoteRunnerAttachInput
	extends RemoteRunnerAttachConnectInput {
	stdin?: Readable;
	stdout?: Writable & { isTTY?: boolean };
	stderr?: Writable & { isTTY?: boolean };
}

type ParsedSseEvent = {
	event?: string;
	data: string;
};

type AttachRequestContext = Pick<
	RemoteRunnerAttachConnectInput,
	"gatewayBaseUrl" | "tokenId" | "tokenSecret" | "timeoutMs" | "fetchImpl"
>;

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
	if (!text.trim()) {
		return {};
	}
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} returned an invalid JSON payload`);
	}
	return parsed as Record<string, unknown>;
}

function createAttachHeaders(input: {
	tokenId: string;
	tokenSecret: string;
	connectionId?: string;
	subscriptionId?: string;
	accept?: string;
	contentType?: string;
}): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${input.tokenSecret}`);
	headers.set("X-EvalOps-Runner-Attach-Token-Id", input.tokenId);
	headers.set("Accept", input.accept ?? "application/json");
	if (input.contentType) {
		headers.set("Content-Type", input.contentType);
	}
	if (input.connectionId) {
		headers.set("x-maestro-headless-connection-id", input.connectionId);
	}
	if (input.subscriptionId) {
		headers.set("x-maestro-headless-subscriber-id", input.subscriptionId);
	}
	return headers;
}

async function requestJson(
	url: string,
	init: RequestInit,
	input: Pick<RemoteRunnerAttachConnectInput, "timeoutMs" | "fetchImpl">,
	label: string,
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(`${label} timed out`)),
		input.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
	);
	try {
		const response = await (input.fetchImpl ?? fetch)(url, {
			...init,
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`${label} returned ${response.status}: ${text || response.statusText}`,
			);
		}
		return parseJsonRecord(text, label);
	} finally {
		clearTimeout(timeout);
	}
}

function attachCapabilities(
	role: "viewer" | "controller",
): { serverRequests: ["approval", "user_input", "tool_retry"] } | undefined {
	if (role === "viewer") {
		return undefined;
	}
	return {
		serverRequests: ["approval", "user_input", "tool_retry"],
	};
}

function clientInfo(input: RemoteRunnerAttachConnectInput) {
	return {
		name: input.clientName ?? DEFAULT_CLIENT_NAME,
		version: input.clientVersion,
	};
}

function normalizeState(value: unknown): HeadlessRuntimeState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return createHeadlessRuntimeState();
	}
	return structuredClone(value as HeadlessRuntimeState);
}

function asTrimmedString(
	record: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function parseSseEvents(buffer: string): {
	events: ParsedSseEvent[];
	remainder: string;
} {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const events: ParsedSseEvent[] = [];
	let remainder = normalized;

	while (true) {
		const separatorIndex = remainder.indexOf("\n\n");
		if (separatorIndex === -1) {
			break;
		}
		const rawEvent = remainder.slice(0, separatorIndex);
		remainder = remainder.slice(separatorIndex + 2);
		if (!rawEvent.trim()) {
			continue;
		}

		let eventType: string | undefined;
		const dataLines: string[] = [];
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("event:")) {
				eventType = line.slice(6).trim();
				continue;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length > 0) {
			events.push({ event: eventType, data: dataLines.join("\n") });
		}
	}

	return { events, remainder };
}

async function sendHeadlessMessage(
	context: AttachRequestContext & {
		sessionId: string;
		connectionId: string;
		subscriptionId: string;
	},
	message: HeadlessToAgentMessage,
): Promise<void> {
	await requestJson(
		`${context.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(context.sessionId)}/messages`,
		{
			method: "POST",
			headers: createAttachHeaders({
				tokenId: context.tokenId,
				tokenSecret: context.tokenSecret,
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
				contentType: "application/json",
			}),
			body: JSON.stringify(message),
		},
		context,
		"remote runner headless message",
	);
}

async function heartbeatAttachConnection(
	context: AttachRequestContext & {
		sessionId: string;
		connectionId: string;
		subscriptionId: string;
	},
): Promise<void> {
	const payload = await requestJson(
		`${context.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(context.sessionId)}/heartbeat`,
		{
			method: "POST",
			headers: createAttachHeaders({
				tokenId: context.tokenId,
				tokenSecret: context.tokenSecret,
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
				contentType: "application/json",
			}),
			body: JSON.stringify({
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
			}),
		},
		context,
		"remote runner headless heartbeat",
	);
	assertHeadlessRuntimeHeartbeatSnapshot(
		payload,
		"remote runner headless heartbeat",
	);
}

async function disconnectAttachConnection(
	context: AttachRequestContext & {
		sessionId: string;
		connectionId: string;
		subscriptionId: string;
	},
): Promise<void> {
	await requestJson(
		`${context.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(context.sessionId)}/disconnect`,
		{
			method: "POST",
			headers: createAttachHeaders({
				tokenId: context.tokenId,
				tokenSecret: context.tokenSecret,
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
				contentType: "application/json",
			}),
			body: JSON.stringify({
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
			}),
		},
		context,
		"remote runner headless disconnect",
	);
}

async function streamAttachEvents(
	context: AttachRequestContext & {
		sessionId: string;
		connectionId: string;
		subscriptionId: string;
	},
	handlers: {
		onMessage: (message: HeadlessFromAgentMessage) => void;
		onReset: (snapshotState: HeadlessRuntimeState) => void;
	},
	signal: AbortSignal,
): Promise<void> {
	const response = await (context.fetchImpl ?? fetch)(
		`${context.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(context.sessionId)}/events?subscriptionId=${encodeURIComponent(context.subscriptionId)}`,
		{
			method: "GET",
			headers: createAttachHeaders({
				tokenId: context.tokenId,
				tokenSecret: context.tokenSecret,
				connectionId: context.connectionId,
				subscriptionId: context.subscriptionId,
				accept: "text/event-stream",
			}),
			signal,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`remote runner headless events returned ${response.status}: ${
				text || response.statusText
			}`,
		);
	}
	if (!response.body) {
		throw new Error("remote runner headless events returned no response body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = parseSseEvents(buffer);
			buffer = parsed.remainder;
			for (const event of parsed.events) {
				const payload = JSON.parse(event.data) as unknown;
				assertHeadlessRuntimeStreamEnvelope(
					payload,
					"remote runner headless stream event",
				);
				switch (payload.type) {
					case "message":
						handlers.onMessage(payload.message as HeadlessFromAgentMessage);
						break;
					case "reset":
						handlers.onReset(normalizeState(payload.snapshot.state));
						break;
					case "snapshot":
						handlers.onReset(normalizeState(payload.snapshot.state));
						break;
					case "heartbeat":
						break;
				}
			}
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
}

export async function connectToRemoteRunnerSession(
	input: RemoteRunnerAttachConnectInput,
): Promise<RemoteRunnerAttachConnection> {
	const protocolVersion = input.protocolVersion ?? headlessProtocolVersion;
	const connectionPayload = await requestJson(
		`${input.gatewayBaseUrl}/api/headless/connections`,
		{
			method: "POST",
			headers: createAttachHeaders({
				tokenId: input.tokenId,
				tokenSecret: input.tokenSecret,
				contentType: "application/json",
			}),
			body: JSON.stringify({
				sessionId: input.sessionId,
				protocolVersion,
				clientInfo: clientInfo(input),
				role: input.role,
				takeControl: input.takeControl ?? false,
				optOutNotifications: ["heartbeat"],
				capabilities: attachCapabilities(input.role),
			}),
		},
		input,
		"remote runner headless connection",
	);
	const connectionId = asTrimmedString(
		connectionPayload,
		"connection_id",
		"connectionId",
	);
	if (!connectionId) {
		throw new Error("remote runner headless connection returned no id");
	}
	const runtimeSessionId =
		asTrimmedString(connectionPayload, "session_id", "sessionId") ??
		input.sessionId;

	const subscriptionPayload = await requestJson(
		`${input.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(runtimeSessionId)}/subscribe`,
		{
			method: "POST",
			headers: createAttachHeaders({
				tokenId: input.tokenId,
				tokenSecret: input.tokenSecret,
				connectionId,
				contentType: "application/json",
			}),
			body: JSON.stringify({
				connectionId,
				protocolVersion,
				clientInfo: clientInfo(input),
				role: input.role,
				takeControl: input.takeControl ?? false,
				optOutNotifications: ["heartbeat"],
				capabilities: attachCapabilities(input.role),
			}),
		},
		input,
		"remote runner headless subscription",
	);
	assertHeadlessRuntimeSubscriptionSnapshot(
		subscriptionPayload,
		"remote runner headless subscription",
	);

	return {
		sessionId:
			subscriptionPayload.snapshot.session_id?.trim() || runtimeSessionId,
		connectionId: subscriptionPayload.connection_id,
		subscriptionId: subscriptionPayload.subscription_id,
		heartbeatIntervalMs: subscriptionPayload.heartbeat_interval_ms,
		role: subscriptionPayload.role,
		state: normalizeState(subscriptionPayload.snapshot.state),
	};
}

export function shouldUseInteractiveRemoteAttach(input: {
	json: boolean;
	printEnv: boolean;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}): boolean {
	return (
		!input.json && !input.printEnv && input.stdinIsTTY && input.stdoutIsTTY
	);
}

class UpdateSignal {
	private version = 0;
	private waiter: ((value: number) => void) | null = null;

	current(): number {
		return this.version;
	}

	notify(): void {
		this.version += 1;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.(this.version);
	}

	waitForChange(previous: number): Promise<number> {
		if (this.version !== previous) {
			return Promise.resolve(this.version);
		}
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}
}

function formatRequestLabel(request: HeadlessPendingApprovalState): string {
	return (
		request.display_name ??
		request.summary_label ??
		request.action_description ??
		request.tool
	);
}

function summarizeArgs(args: unknown): string | undefined {
	if (args === undefined) {
		return undefined;
	}
	const serialized = JSON.stringify(args, null, 2);
	if (!serialized) {
		return undefined;
	}
	if (serialized.length <= 400) {
		return serialized;
	}
	return `${serialized.slice(0, 397)}...`;
}

function pendingRequest(
	state: HeadlessRuntimeState,
): {
	kind: "approval" | "user_input" | "tool_retry";
	request: HeadlessPendingApprovalState;
} | null {
	if (state.pending_approvals.length > 0) {
		return { kind: "approval", request: state.pending_approvals[0]! };
	}
	if (state.pending_user_inputs.length > 0) {
		return { kind: "user_input", request: state.pending_user_inputs[0]! };
	}
	if (state.pending_tool_retries.length > 0) {
		return { kind: "tool_retry", request: state.pending_tool_retries[0]! };
	}
	return null;
}

function clearPromptLine(stdout: Writable & { isTTY?: boolean }): void {
	if (!stdout.isTTY) {
		return;
	}
	clearLine(stdout, 0);
	cursorTo(stdout, 0);
}

export async function attachToRemoteRunnerSession(
	input: RemoteRunnerAttachInput,
): Promise<void> {
	const stdout =
		(input.stdout as (Writable & { isTTY?: boolean }) | undefined) ??
		(process.stdout as Writable & { isTTY?: boolean });
	const stderr =
		(input.stderr as (Writable & { isTTY?: boolean }) | undefined) ??
		(process.stderr as Writable & { isTTY?: boolean });
	const stdin =
		(input.stdin as Readable | undefined) ?? (process.stdin as Readable);
	const rl = createInterface({
		input: stdin,
		output: stdout,
		terminal: Boolean(
			(stdin as Readable & { isTTY?: boolean }).isTTY && stdout.isTTY,
		),
	});

	let state = createHeadlessRuntimeState();
	const updates = new UpdateSignal();
	let closeRequested = false;
	let streamError: Error | null = null;
	let visibleResponseOpen = false;
	let responseEndsWithNewline = true;

	const ensureAssistantBreak = () => {
		if (visibleResponseOpen && !responseEndsWithNewline) {
			stdout.write("\n");
			responseEndsWithNewline = true;
		}
	};

	const writeLine = (message = "") => {
		ensureAssistantBreak();
		clearPromptLine(stdout);
		stdout.write(`${message}\n`);
	};

	const beginAssistantOutput = () => {
		if (!visibleResponseOpen) {
			clearPromptLine(stdout);
			stdout.write(chalk.bold("assistant> "));
			visibleResponseOpen = true;
			responseEndsWithNewline = false;
		}
	};

	const printAssistantChunk = (content: string) => {
		if (!content) {
			return;
		}
		beginAssistantOutput();
		stdout.write(content);
		responseEndsWithNewline = content.endsWith("\n");
	};

	const printStatus = () => {
		writeLine(chalk.bold(`Remote session ${input.sessionId}`));
		writeLine(`  role: ${input.role}`);
		writeLine(`  ready: ${state.is_ready ? "yes" : "no"}`);
		writeLine(`  responding: ${state.is_responding ? "yes" : "no"}`);
		writeLine(`  model: ${state.model ?? "-"}`);
		writeLine(`  provider: ${state.provider ?? "-"}`);
		writeLine(`  cwd: ${state.cwd ?? "-"}`);
		writeLine(`  git: ${state.git_branch ?? "-"}`);
		writeLine(`  approvals: ${state.pending_approvals.length}`);
		writeLine(`  user input: ${state.pending_user_inputs.length}`);
		writeLine(`  tool retries: ${state.pending_tool_retries.length}`);
		writeLine(`  active tools: ${state.active_tools.length}`);
	};

	const connection = await connectToRemoteRunnerSession(input);
	state = connection.state;
	writeLine(
		chalk.bold(
			`Attached to ${connection.sessionId} as ${connection.role === "viewer" ? "viewer" : "controller"}`,
		),
	);
	if (connection.role === "controller") {
		writeLine(
			chalk.dim(
				"Enter a prompt below. Use /status, /help, or /exit. Press Ctrl+C to interrupt an active response.",
			),
		);
	} else {
		writeLine(chalk.dim("Viewer mode is read-only. Use /status or /exit."));
	}

	const attachContext = {
		gatewayBaseUrl: input.gatewayBaseUrl,
		tokenId: input.tokenId,
		tokenSecret: input.tokenSecret,
		timeoutMs: input.timeoutMs,
		fetchImpl: input.fetchImpl,
		sessionId: connection.sessionId,
		connectionId: connection.connectionId,
		subscriptionId: connection.subscriptionId,
	};

	const streamAbort = new AbortController();
	const streamPromise = streamAttachEvents(
		attachContext,
		{
			onMessage: (message) => {
				applyIncomingHeadlessMessage(state, message);
				switch (message.type) {
					case "response_start":
						visibleResponseOpen = false;
						responseEndsWithNewline = true;
						break;
					case "response_chunk":
						if (!message.is_thinking) {
							printAssistantChunk(message.content);
						}
						break;
					case "response_end":
						ensureAssistantBreak();
						visibleResponseOpen = false;
						break;
					case "status":
						writeLine(chalk.dim(message.message));
						break;
					case "error":
						writeLine(chalk.red(message.message));
						break;
					case "compaction":
						writeLine(
							chalk.dim(`Compacted remote history: ${message.summary}`),
						);
						break;
					default:
						break;
				}
				updates.notify();
			},
			onReset: (snapshotState) => {
				state = snapshotState;
				writeLine(chalk.dim("Remote session state resynced from snapshot."));
				updates.notify();
			},
		},
		streamAbort.signal,
	).catch((error) => {
		if (!streamAbort.signal.aborted) {
			streamError = error instanceof Error ? error : new Error(String(error));
			updates.notify();
		}
	});

	const heartbeatTimer = setInterval(
		() => {
			if (closeRequested) {
				return;
			}
			void heartbeatAttachConnection(attachContext).catch((error) => {
				streamError = error instanceof Error ? error : new Error(String(error));
				updates.notify();
			});
		},
		Math.max(1_000, Math.floor(connection.heartbeatIntervalMs / 2)),
	);
	heartbeatTimer.unref();

	const sendInteractiveMessage = async (message: HeadlessToAgentMessage) => {
		await sendHeadlessMessage(attachContext, message);
		applyOutgoingHeadlessMessage(state, message);
		updates.notify();
	};

	const handleCommand = async (line: string): Promise<boolean> => {
		switch (line.trim()) {
			case "/help":
				writeLine("Commands: /status, /interrupt, /exit");
				return true;
			case "/status":
				printStatus();
				return true;
			case "/interrupt":
				if (connection.role !== "controller") {
					writeLine(chalk.yellow("Viewer mode cannot interrupt the session."));
					return true;
				}
				if (!state.is_responding) {
					writeLine(chalk.dim("No active response to interrupt."));
					return true;
				}
				await sendInteractiveMessage({ type: "interrupt" });
				writeLine(chalk.dim("Interrupt sent."));
				return true;
			case "/exit":
			case "/quit":
				closeRequested = true;
				updates.notify();
				return true;
			default:
				if (line.startsWith("/")) {
					writeLine(chalk.yellow(`Unknown command: ${line}`));
					return true;
				}
				return false;
		}
	};

	const handleApproval = async (request: HeadlessPendingApprovalState) => {
		writeLine(
			chalk.yellow(`Approval required: ${formatRequestLabel(request)}`),
		);
		const summary = summarizeArgs(request.args);
		if (summary) {
			writeLine(chalk.dim(summary));
		}
		while (!closeRequested) {
			const answer = (await rl.question("Approve? [y/N]: ")).trim();
			if (await handleCommand(answer)) {
				continue;
			}
			const approved = /^(y|yes)$/iu.test(answer);
			if (request.request_id) {
				await sendInteractiveMessage({
					type: "server_request_response",
					request_id: request.request_id,
					request_type: "approval",
					approved,
					result: approved
						? {
								success: true,
								output: "Approved by remote attach client",
							}
						: {
								success: false,
								output: "",
								error: "Denied by remote attach client",
							},
				});
			} else {
				await sendInteractiveMessage({
					type: "tool_response",
					call_id: request.call_id,
					approved,
					result: approved
						? {
								success: true,
								output: "Approved by remote attach client",
							}
						: {
								success: false,
								output: "",
								error: "Denied by remote attach client",
							},
				});
			}
			return;
		}
	};

	const handleUserInput = async (request: HeadlessPendingApprovalState) => {
		writeLine(chalk.yellow(`Input requested: ${formatRequestLabel(request)}`));
		const summary = summarizeArgs(request.args);
		if (summary) {
			writeLine(chalk.dim(summary));
		}
		while (!closeRequested) {
			const answer = await rl.question("Reply: ");
			if (await handleCommand(answer.trim())) {
				continue;
			}
			if (request.request_id) {
				await sendInteractiveMessage({
					type: "server_request_response",
					request_id: request.request_id,
					request_type: "user_input",
					content: [{ type: "text", text: answer }],
					is_error: false,
				});
			} else {
				await sendInteractiveMessage({
					type: "client_tool_result",
					call_id: request.call_id,
					content: [{ type: "text", text: answer }],
					is_error: false,
				});
			}
			return;
		}
	};

	const handleToolRetry = async (request: HeadlessPendingApprovalState) => {
		writeLine(
			chalk.yellow(`Tool retry requested: ${formatRequestLabel(request)}`),
		);
		const summary = summarizeArgs(request.args);
		if (summary) {
			writeLine(chalk.dim(summary));
		}
		while (!closeRequested) {
			const answer = (await rl.question("Decision [retry/skip/abort]: "))
				.trim()
				.toLowerCase();
			if (await handleCommand(answer)) {
				continue;
			}
			if (!["retry", "skip", "abort"].includes(answer)) {
				writeLine(chalk.yellow("Enter retry, skip, or abort."));
				continue;
			}
			await sendInteractiveMessage({
				type: "server_request_response",
				request_id: request.request_id ?? request.call_id,
				request_type: "tool_retry",
				decision_action: answer as "retry" | "skip" | "abort",
			});
			return;
		}
	};

	const sigintHandler = () => {
		if (
			connection.role === "controller" &&
			state.is_responding &&
			!closeRequested
		) {
			void sendInteractiveMessage({ type: "interrupt" }).catch((error) => {
				streamError = error instanceof Error ? error : new Error(String(error));
				updates.notify();
			});
			writeLine(chalk.dim("Interrupt sent."));
			return;
		}
		closeRequested = true;
		updates.notify();
	};

	rl.on("SIGINT", sigintHandler);

	try {
		let version = updates.current();
		while (!closeRequested) {
			if (streamError) {
				throw streamError;
			}

			if (connection.role === "controller") {
				const next = pendingRequest(state);
				if (next) {
					switch (next.kind) {
						case "approval":
							await handleApproval(next.request);
							break;
						case "user_input":
							await handleUserInput(next.request);
							break;
						case "tool_retry":
							await handleToolRetry(next.request);
							break;
					}
					version = updates.current();
					continue;
				}
			}

			if (state.is_responding || !state.is_ready) {
				version = await updates.waitForChange(version);
				continue;
			}

			const prompt = connection.role === "controller" ? "remote> " : "viewer> ";
			const line = await rl.question(prompt);
			if (await handleCommand(line.trim())) {
				version = updates.current();
				continue;
			}
			if (connection.role !== "controller") {
				writeLine(chalk.yellow("Viewer mode is read-only."));
				version = updates.current();
				continue;
			}
			if (!line.trim()) {
				version = updates.current();
				continue;
			}
			await sendInteractiveMessage({
				type: "prompt",
				content: line,
			});
			version = updates.current();
		}
	} finally {
		clearInterval(heartbeatTimer);
		streamAbort.abort();
		rl.close();
		try {
			await disconnectAttachConnection(attachContext);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stderr.write(`${message}\n`);
		}
		await streamPromise.catch(() => undefined);
	}
}
