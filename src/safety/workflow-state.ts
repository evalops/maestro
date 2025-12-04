/**
 * Workflow State Tracking for PII and Sensitive Data
 *
 * This module tracks Personally Identifiable Information (PII) artifacts
 * throughout the agent's workflow. It implements a "capture-and-redact"
 * pattern where:
 *
 * 1. Tools that collect sensitive data (e.g., collect_customer_context)
 *    register PII artifacts with the tracker
 * 2. Tools that finalize work (e.g., redact_transcript) mark artifacts
 *    as redacted/handled
 * 3. The tracker ensures all captured PII is properly redacted before
 *    session completion or data egress
 *
 * Key invariants:
 * - Every captured PII artifact must be redacted before session end
 * - Attempting to redact an unknown artifact triggers an error
 * - Multiple artifacts can be tracked simultaneously (multi-customer flows)
 *
 * This provides a safety net to prevent accidental PII leakage in
 * automated workflows.
 */

import type { WorkflowStateSnapshot } from "../agent/action-approval.js";
import type { ToolCall, ToolResultMessage } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:workflow-state");

/**
 * Error thrown when workflow state invariants are violated.
 * Examples: redacting unknown artifacts, missing required redactions.
 */
export class WorkflowStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStateError";
	}
}

/**
 * Generic interface for state trackers that support snapshotting.
 * Used for serialization and recovery purposes.
 */
export interface StateTracker<TSnapshot = unknown> {
	/** Clear all tracked state */
	reset(): void;
	/** Create a serializable snapshot of current state */
	snapshot(): TSnapshot;
}

/**
 * Internal record for a single PII artifact.
 * Tracks provenance and relationships for audit purposes.
 */
interface PiiArtifactRecord {
	/** Human-readable label for the artifact (e.g., customer name) */
	label: string;
	/** ID of the tool call that captured this artifact */
	sourceToolCallId: string;
	/** Optional parent artifact IDs for hierarchical relationships */
	parents?: string[];
}

/**
 * Tracks PII artifacts through their lifecycle in the workflow.
 *
 * State machine for each artifact:
 *   (not tracked) --[notePiiCapture]--> pending --[noteRedaction]--> (removed)
 *
 * The tracker maintains two sets:
 * - pendingPii: Artifacts captured but not yet redacted (must be empty at end)
 * - orphanedRedactions: Redaction attempts for unknown artifacts (indicates bugs)
 */
export class WorkflowStateTracker
	implements StateTracker<WorkflowStateSnapshot>
{
	/** Map of artifact ID -> record for pending (unredacted) PII */
	private pendingPii = new Map<string, PiiArtifactRecord>();
	/** Set of artifact IDs that were redacted but never captured (bug indicator) */
	private orphanedRedactions = new Set<string>();

	/**
	 * Reset all tracking state. Called at workflow boundaries.
	 */
	reset(): void {
		this.pendingPii.clear();
		this.orphanedRedactions.clear();
	}

	/**
	 * Record that a PII artifact has been captured.
	 * Called by tools like collect_customer_context after fetching sensitive data.
	 *
	 * @param params.artifactId - Unique identifier for this artifact
	 * @param params.label - Human-readable label (for error messages)
	 * @param params.sourceToolCallId - ID of the tool call that captured it
	 * @param params.parents - Optional parent artifact IDs (for hierarchical data)
	 */
	notePiiCapture(params: {
		artifactId: string;
		label: string;
		sourceToolCallId: string;
		parents?: string[];
	}): void {
		// `parents` reserved for future multi-artifact invariants; unused today.
		const label = params.label || params.artifactId;
		this.pendingPii.set(params.artifactId, {
			label,
			sourceToolCallId: params.sourceToolCallId,
			parents: params.parents?.slice() ?? undefined,
		});
		// If this ID was previously in orphaned, it's no longer orphaned
		this.orphanedRedactions.delete(params.artifactId);
	}

	/**
	 * Record that a PII artifact has been redacted/handled.
	 * Called by tools like redact_transcript after sanitizing output.
	 *
	 * @param params.artifactId - ID of the artifact to mark as redacted
	 * @param params.allowMissing - If true, don't throw on unknown artifacts
	 * @returns true if artifact was found and removed, false otherwise
	 */
	noteRedaction(params: {
		artifactId: string;
		allowMissing?: boolean;
	}): boolean {
		const removed = this.pendingPii.delete(params.artifactId);
		if (!removed) {
			// Track orphaned redactions for debugging - indicates tooling mismatch
			this.orphanedRedactions.add(params.artifactId);
			const message = `Attempted to redact unknown artifact "${params.artifactId}". Ensure collect and redact tooling share artifact ids.`;
			logger.warn(message, { artifactId: params.artifactId });
			if (!params.allowMissing) {
				throw new WorkflowStateError(message);
			}
		}
		return removed;
	}

	/**
	 * Look up an artifact ID by its human-readable label.
	 * Useful when redaction tools specify subject by name rather than ID.
	 */
	findArtifactIdByLabel(label: string): string | undefined {
		for (const [artifactId, record] of this.pendingPii.entries()) {
			if (record.label === label) {
				return artifactId;
			}
		}
		return undefined;
	}

	/**
	 * Get the artifact ID if exactly one artifact is pending.
	 * Enables implicit artifact resolution when context is unambiguous.
	 */
	getSingletonPendingArtifactId(): string | undefined {
		if (this.pendingPii.size !== 1) {
			return undefined;
		}
		const [onlyKey] = this.pendingPii.keys();
		return onlyKey;
	}

	/**
	 * Get summaries of all pending (unredacted) artifacts.
	 * Used for error messages and debugging.
	 */
	getPendingArtifactSummaries(): Array<{ id: string; label: string }> {
		return Array.from(this.pendingPii.entries()).map(([id, record]) => ({
			id,
			label: record.label,
		}));
	}

	/**
	 * Create a serializable snapshot of current state.
	 * Used for session persistence and recovery.
	 */
	snapshot(): WorkflowStateSnapshot {
		return {
			pendingPii: Array.from(this.pendingPii.entries()).map(([id, record]) => ({
				id,
				label: record.label,
				sourceToolCallId: record.sourceToolCallId,
				redacted: false,
				...(record.parents ? { parents: record.parents.slice() } : {}),
			})),
			orphanedRedactions: Array.from(this.orphanedRedactions.values()),
		};
	}

	/**
	 * Check if parallel tool execution is unsafe due to pending PII.
	 * When PII is pending, concurrent tool calls might leak data
	 * before redaction completes.
	 */
	isConcurrencyUnsafe(): boolean {
		return this.pendingPii.size > 0;
	}
}

/**
 * Hook interface for tools that need to update workflow state.
 * Tools register hooks to be notified of their execution results.
 */
export type WorkflowStateHook = {
	/**
	 * Called after a tool execution completes.
	 * Use this to update tracker state based on tool results.
	 */
	onResult?: (params: {
		toolCall: ToolCall;
		result: ToolResultMessage;
		tracker: WorkflowStateTracker;
		isError: boolean;
	}) => void;
};

/**
 * Default hooks for built-in tools that participate in PII tracking.
 * These hooks automatically update the tracker when specific tools execute.
 */
const defaultHooks: Record<string, WorkflowStateHook> = {
	collect_customer_context: {
		onResult: ({ toolCall, tracker, isError }) => {
			if (isError) {
				return;
			}
			const subjectArg =
				typeof toolCall.arguments?.subject === "string"
					? toolCall.arguments.subject
					: undefined;
			const label = subjectArg ?? toolCall.id;
			tracker.notePiiCapture({
				artifactId: toolCall.id,
				label,
				sourceToolCallId: toolCall.id,
			});
		},
	},
	redact_transcript: {
		onResult: ({ toolCall, tracker, isError }) => {
			if (isError) {
				return;
			}
			const artifactIdArg =
				typeof toolCall.arguments?.artifactId === "string"
					? toolCall.arguments.artifactId
					: undefined;
			const rawSubject = toolCall.arguments?.subject;
			const subjectHint =
				typeof rawSubject === "string" && rawSubject.length > 0
					? rawSubject
					: undefined;
			let artifactId = artifactIdArg;
			if (!artifactId && subjectHint) {
				artifactId = tracker.findArtifactIdByLabel(subjectHint);
				if (!artifactId) {
					throw new WorkflowStateError(
						`redact_transcript could not find an artifact for subject "${subjectHint}". Double-check the subject or supply artifactId explicitly.`,
					);
				}
			}
			if (!artifactId) {
				artifactId = tracker.getSingletonPendingArtifactId();
			}
			if (!artifactId) {
				const pendingSummary = tracker
					.getPendingArtifactSummaries()
					.map((entry) => `${entry.label} (${entry.id})`)
					.join(", ");
				throw new WorkflowStateError(
					`redact_transcript could not determine which artifact to redact; provide artifactId or subject. Pending artifacts: ${pendingSummary || "none"}.`,
				);
			}
			tracker.noteRedaction({ artifactId });
		},
	},
};

/** Mutable registry of workflow state hooks (includes defaults + custom) */
const workflowStateHooks: Record<string, WorkflowStateHook> = {
	...defaultHooks,
};

/**
 * Check if a tool participates in workflow state tracking.
 * Used to determine if a tool call should trigger state updates.
 */
export function isWorkflowTrackedTool(toolName: string): boolean {
	return Boolean(workflowStateHooks[toolName]);
}

/**
 * Register a custom hook for a tool.
 * Allows external tools to participate in PII tracking.
 */
export function registerWorkflowStateHook(
	toolName: string,
	hook: WorkflowStateHook,
): void {
	workflowStateHooks[toolName] = hook;
}

/**
 * Apply registered hooks for a completed tool call.
 * Called by the agent after each tool execution to update workflow state.
 */
export function applyWorkflowStateHooks(params: {
	toolCall: ToolCall;
	result: ToolResultMessage;
	tracker: WorkflowStateTracker;
	isError: boolean;
}): void {
	const hook = workflowStateHooks[params.toolCall.name];
	if (!hook?.onResult) {
		return;
	}
	hook.onResult(params);
}

/**
 * Categorizes where tool output can flow.
 * - human: Goes to a human operator (e.g., handoff)
 * - external: Goes outside the system (e.g., email)
 * - internal: Stays within the agent context
 */
export type ToolEgress = "human" | "external" | "internal";

/**
 * Static metadata for known tools that have data egress.
 * Used to enforce PII redaction before external communication.
 */
export const TOOL_TAGS: Record<string, { egress?: ToolEgress }> = {
	handoff_to_human: { egress: "human" },
	send_email_update: { egress: "external" },
	post_customer_update: { egress: "external" },
	notify_account_team: { egress: "human" },
};

/**
 * Heuristic check for tools that might send data externally.
 * Used as a fallback when tool isn't in TOOL_TAGS.
 */
export function looksLikeEgress(toolName: string): boolean {
	return /handoff|send_|email|notify|escalate/i.test(toolName);
}
