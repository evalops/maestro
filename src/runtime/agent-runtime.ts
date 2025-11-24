import type { Agent } from "../agent/agent.js";
import { composerManager } from "../composers/index.js";
import { PromptQueue } from "../tui/prompt-queue.js";
import type { TuiRenderer } from "../tui/tui-renderer.js";

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
			async (text) => {
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

				await this.options.agent.prompt(text);
			},
			(error) => {
				if (this.options.onError) {
					this.options.onError(error);
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				console.error(message);
			},
		);

		if (this.options.renderer) {
			this.attachRenderer(this.options.renderer);
		}
	}

	attachRenderer(renderer: TuiRenderer): void {
		this.renderer = renderer;
		renderer.attachPromptQueue(this.promptQueue);
		renderer.setInterruptCallback(() => this.abort());
	}

	enqueue(text: string): void {
		this.promptQueue.enqueue(text);
	}

	abort(): void {
		this.options.agent.abort();
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
