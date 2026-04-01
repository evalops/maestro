/**
 * RPC Client for Maestro Agent
 *
 * Provides a typed TypeScript client for interacting with Maestro
 * over JSON-over-stdio RPC.
 *
 * @module rpc/rpc-client
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Interface, createInterface } from "node:readline";
import type { AgentEvent, Message } from "../agent/types.js";
import type {
	RpcCommand,
	RpcErrorResponse,
	RpcMessagesResponse,
	RpcResponse,
	RpcStateResponse,
} from "./rpc-types.js";
import { isAgentEvent, isErrorResponse } from "./rpc-types.js";

/**
 * Options for creating an RPC client.
 */
export interface RpcClientOptions {
	/** Path to the Maestro CLI executable */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Additional environment variables */
	env?: Record<string, string>;
	/** Timeout for requests in milliseconds (default: 30000) */
	timeout?: number;
}

/**
 * Typed RPC client for Maestro Agent.
 *
 * @example
 * ```ts
 * const client = new RpcClient();
 * await client.start();
 *
 * client.on("message_update", (event) => {
 *   console.log("Streaming:", event.message.content);
 * });
 *
 * await client.promptAndWait("Hello, world!");
 * const messages = await client.getMessages();
 *
 * client.stop();
 * ```
 */
export class RpcClient extends EventEmitter {
	private process: ChildProcess | null = null;
	private readline: Interface | null = null;
	private pending: Map<
		string,
		{
			resolve: (value: RpcResponse) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	> = new Map();
	private requestId = 0;
	private options: Required<RpcClientOptions>;

	constructor(options: RpcClientOptions = {}) {
		super();
		this.options = {
			cliPath: options.cliPath ?? "maestro",
			cwd: options.cwd ?? process.cwd(),
			env: options.env ?? {},
			timeout: options.timeout ?? 30000,
		};
	}

	/**
	 * Start the Maestro agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const env = {
			...process.env,
			...this.options.env,
		};

		this.process = spawn(this.options.cliPath, ["--rpc"], {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create stdio pipes");
		}

		// Set up readline for response parsing
		this.readline = createInterface({
			input: this.process.stdout,
			terminal: false,
		});

		// Handle incoming responses
		this.readline.on("line", (line) => {
			try {
				const response = JSON.parse(line) as RpcResponse;
				this.handleResponse(response);
			} catch (error) {
				this.emit("error", new Error(`Failed to parse response: ${line}`));
			}
		});

		// Handle process errors
		this.process.on("error", (error) => {
			this.emit("error", error);
		});

		this.process.on("exit", (code) => {
			this.emit("exit", code);
			this.cleanup();
		});

		// Forward stderr for debugging
		this.process.stderr?.on("data", (data) => {
			this.emit("stderr", data.toString());
		});

		// Wait for process to be ready
		await new Promise<void>((resolve) => {
			// Give the process a moment to start
			setTimeout(resolve, 100);
		});
	}

	/**
	 * Stop the Maestro agent process.
	 */
	stop(): void {
		this.cleanup();
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
	}

	private cleanup(): void {
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}

		// Reject all pending requests
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Client stopped"));
		}
		this.pending.clear();
	}

	private handleResponse(response: RpcResponse): void {
		// Check if this is a response to a pending request
		const id = (response as { id?: string }).id;
		if (id) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(id);
				pending.resolve(response);
				return;
			}
		}

		// Emit agent events
		if (isAgentEvent(response)) {
			this.emit(response.type, response);
			this.emit("event", response);
		} else if (isErrorResponse(response)) {
			this.emit("error", new Error(response.error));
		} else {
			// Other responses without IDs
			this.emit("response", response);
		}
	}

	/**
	 * Send a command to the agent.
	 */
	private send(command: RpcCommand): void {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}
		this.process.stdin.write(`${JSON.stringify(command)}\n`);
	}

	/**
	 * Send a command and wait for a specific response type.
	 */
	private async request<T extends RpcResponse>(
		command: RpcCommand,
		expectedType?: string,
	): Promise<T> {
		const id = `req_${++this.requestId}`;
		const commandWithId = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request timeout: ${command.type}`));
			}, this.options.timeout);

			this.pending.set(id, {
				resolve: resolve as (value: RpcResponse) => void,
				reject,
				timeout,
			});

			this.send(commandWithId);
		});
	}

	/**
	 * Send a prompt to the agent (fire and forget).
	 * Use promptAndWait() if you need to wait for completion.
	 */
	prompt(message: string): void {
		this.send({ type: "prompt", message });
	}

	/**
	 * Send a prompt and wait for the agent to finish.
	 * Returns when agent_end event is received.
	 */
	async promptAndWait(message: string): Promise<AgentEvent> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.off("agent_end", onEnd);
				this.off("error", onError);
			};

			const onEnd = (event: AgentEvent) => {
				cleanup();
				resolve(event);
			};

			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			this.once("agent_end", onEnd);
			this.once("error", onError);

			this.prompt(message);
		});
	}

	/**
	 * Abort the current operation.
	 */
	abort(): void {
		this.send({ type: "abort" });
	}

	/**
	 * Get the current conversation messages.
	 */
	async getMessages(): Promise<Message[]> {
		const response = await this.request<RpcMessagesResponse>({
			type: "get_messages",
		});
		return response.messages;
	}

	/**
	 * Get the full agent state.
	 */
	async getState(): Promise<RpcStateResponse["state"]> {
		const response = await this.request<RpcStateResponse>({
			type: "get_state",
		});
		return response.state;
	}

	/**
	 * Continue the conversation without a new user message.
	 */
	continue(options?: { systemPromptOverride?: string }): void {
		this.send({ type: "continue", options });
	}

	/**
	 * Continue and wait for the agent to finish.
	 */
	async continueAndWait(options?: {
		systemPromptOverride?: string;
	}): Promise<AgentEvent> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.off("agent_end", onEnd);
				this.off("error", onError);
			};

			const onEnd = (event: AgentEvent) => {
				cleanup();
				resolve(event);
			};

			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			this.once("agent_end", onEnd);
			this.once("error", onError);

			this.continue(options);
		});
	}

	/**
	 * Trigger context compaction.
	 */
	compact(customInstructions?: string): void {
		this.send({ type: "compact", customInstructions });
	}

	/**
	 * Wait for the agent to become idle.
	 */
	async waitForIdle(): Promise<void> {
		const state = await this.getState();
		if (!state.isStreaming) {
			return;
		}

		return new Promise((resolve) => {
			const onEnd = () => {
				this.off("agent_end", onEnd);
				resolve();
			};
			this.once("agent_end", onEnd);
		});
	}

	/**
	 * Check if the agent is currently streaming.
	 */
	async isStreaming(): Promise<boolean> {
		const state = await this.getState();
		return state.isStreaming;
	}
}
