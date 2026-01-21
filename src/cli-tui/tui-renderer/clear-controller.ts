/**
 * ClearController - Handles session clearing functionality
 *
 * Manages the /clear command which resets the conversation state,
 * aborts any running agent work, and starts a fresh session.
 */

import type { AgentState } from "../../agent/types.js";

export interface ClearControllerCallbacks {
	/** Abort agent and wait for idle */
	abortAndWait: () => Promise<void>;
	/** Set agent running state */
	setAgentRunning: (running: boolean) => void;
	/** Cancel all queued prompts */
	cancelQueuedPrompts: () => void;
	/** Stop loading animation */
	stopLoader: () => void;
	/** Clear status container */
	clearStatusContainer: () => void;
	/** Reset agent state */
	resetAgent: () => void;
	/** Reset session */
	resetSession: () => void;
	/** Reset session artifacts */
	resetArtifacts: () => void;
	/** Clear active skills */
	clearActiveSkills?: () => void;
	/** Clear tool output tracking */
	clearToolTracking: () => void;
	/** Clear chat container */
	clearChatContainer: () => void;
	/** Clear scroll history */
	clearScrollHistory: () => void;
	/** Clear startup container */
	clearStartupContainer: () => void;
	/** Sync plan hint with store */
	syncPlanHint: () => void;
	/** Set plan hint */
	setPlanHint: (hint: string | null) => void;
	/** Clear editor */
	clearEditor: () => void;
	/** Clear pending tools */
	clearPendingTools: () => void;
	/** Clear interrupt state */
	clearInterruptState: () => void;
	/** Render initial messages */
	renderInitialMessages: (state: AgentState) => void;
	/** Get current agent state */
	getAgentState: () => AgentState;
	/** Update footer state */
	updateFooterState: (state: AgentState) => void;
	/** Refresh footer hint */
	refreshFooterHint: () => void;
	/** Show success notification */
	showSuccess: (message: string) => void;
	/** Show error in chat */
	showError: (message: string) => void;
	/** Request UI render */
	requestRender: () => void;
}

export interface ClearControllerOptions {
	callbacks: ClearControllerCallbacks;
}

export class ClearController {
	private readonly callbacks: ClearControllerCallbacks;
	private clearInProgress = false;

	constructor(options: ClearControllerOptions) {
		this.callbacks = options.callbacks;
	}

	async handleClearCommand(): Promise<void> {
		// Prevent concurrent clear operations
		if (this.clearInProgress) {
			return;
		}
		this.clearInProgress = true;

		try {
			// Abort any in-flight agent work
			await this.callbacks.abortAndWait();

			// Reset running flag immediately so the UI reflects idle state
			this.callbacks.setAgentRunning(false);

			// Cancel any queued prompts
			this.callbacks.cancelQueuedPrompts();

			// Stop loading animation if present
			this.callbacks.stopLoader();
			this.callbacks.clearStatusContainer();

			// Reset agent and session
			this.callbacks.resetAgent();
			this.callbacks.resetSession();
			this.callbacks.clearActiveSkills?.();

			// Reset session artifacts and tool tracking
			this.callbacks.resetArtifacts();
			this.callbacks.clearToolTracking();

			// Clear all UI containers and scroll history
			this.callbacks.clearChatContainer();
			this.callbacks.clearScrollHistory();
			this.callbacks.clearStartupContainer();

			// Reset plan state
			this.callbacks.syncPlanHint();
			this.callbacks.setPlanHint(null);

			// Clear editor input
			this.callbacks.clearEditor();

			// Clear pending tools
			this.callbacks.clearPendingTools();

			// Clear interrupt state if armed
			this.callbacks.clearInterruptState();

			// Reset message view state and render initial messages
			const state = this.callbacks.getAgentState();
			this.callbacks.renderInitialMessages(state);

			// Update footer and refresh hints
			this.callbacks.updateFooterState(state);
			this.callbacks.refreshFooterHint();

			// Show success confirmation
			this.callbacks.showSuccess("Context cleared - started fresh session");
		} catch (error) {
			// On error, ensure UI is in a consistent state
			this.callbacks.stopLoader();
			this.callbacks.clearStatusContainer();

			const errorMsg = error instanceof Error ? error.message : String(error);
			this.callbacks.showError(`✗ Error clearing context: ${errorMsg}`);
		} finally {
			this.clearInProgress = false;
			this.callbacks.requestRender();
		}
	}
}

export function createClearController(
	options: ClearControllerOptions,
): ClearController {
	return new ClearController(options);
}
