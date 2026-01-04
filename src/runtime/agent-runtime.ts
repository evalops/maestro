import type { Agent } from "../agent/agent.js";
import type { AppMessage } from "../agent/types.js";
import { type PromptPayload, PromptQueue } from "../cli-tui/prompt-queue.js";
import type { TuiRenderer } from "../cli-tui/tui-renderer.js";
import { composerManager } from "../composers/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-runtime");

export interface InterruptOptions {
	/** If true, preserve the partial response in message history */
	keepPartial?: boolean;
}

export interface InterruptResult {
	/** The partial message that was saved, if keepPartial was true */
	partialMessage?: AppMessage | null;
}

interface AgentRuntimeControllerOptions {
	agent: Agent;
	renderer?: TuiRenderer;
	onError?: (error: unknown) => void;
}

export class AgentRuntimeController {
	private readonly promptQueue: PromptQueue;
	private running = true;
	private renderer?: TuiRenderer;

	constructor(private readonly options: AgentRuntimeControllerOptions) {
		this.promptQueue = new PromptQueue(
			async (text, attachments) => {
				if (this.renderer?.ensureContextBudgetBeforePrompt) {
					await this.renderer.ensureContextBudgetBeforePrompt();
				}

				// Check if prompt matches any composer triggers (only if no composer active)
				const composerState = composerManager.getState();
				if (!composerState.active) {
					const triggered = composerManager.checkTriggers(text, process.cwd());
					if (triggered) {
						composerManager.activate(triggered.name, process.cwd());
					}
				}

				await this.options.agent.prompt(text, attachments);
			},
			(error) => {
				if (this.options.onError) {
					this.options.onError(error);
					return;
				}
				logger.error(
					"Runtime error",
					error instanceof Error ? error : undefined,
				);
			},
		);

		if (this.options.renderer) {
			this.attachRenderer(this.options.renderer);
		}
	}

	attachRenderer(renderer: TuiRenderer): void {
		this.renderer = renderer;
		renderer.attachPromptQueue(this.promptQueue);
		renderer.setInterruptCallback((options) => this.interrupt(options));
	}

	enqueue(payload: PromptPayload): void {
		this.promptQueue.enqueue(payload.text, payload.attachments);
	}

	/**
	 * Interrupt the current agent operation.
	 *
	 * @param options - Control how the interrupt is handled
	 * @returns Result containing any saved partial message
	 */
	interrupt(options?: InterruptOptions): InterruptResult {
		if (options?.keepPartial) {
			const partialMessage = this.options.agent.abortAndKeepPartial();
			logger.info("Interrupted with partial acceptance", {
				hasPartial: !!partialMessage,
			});
			return { partialMessage };
		}

		this.options.agent.abort();
		return {};
	}

	stop(): void {
		this.running = false;
	}

	async runInteractiveLoop(renderer: TuiRenderer): Promise<void> {
		if (renderer !== this.renderer) {
			this.attachRenderer(renderer);
		}
		while (this.running) {
			const input = await renderer.getUserInput();
			this.enqueue(input);
		}
	}
}
