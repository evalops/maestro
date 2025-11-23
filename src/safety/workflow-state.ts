import type { WorkflowStateSnapshot } from "../agent/action-approval.js";
import type { ToolCall, ToolResultMessage } from "../agent/types.js";

export class WorkflowStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStateError";
	}
}

export interface StateTracker<TSnapshot = unknown> {
	reset(): void;
	snapshot(): TSnapshot;
}

interface PiiArtifactRecord {
	label: string;
	sourceToolCallId: string;
	parents?: string[];
}

export class WorkflowStateTracker
	implements StateTracker<WorkflowStateSnapshot>
{
	private pendingPii = new Map<string, PiiArtifactRecord>();
	private orphanedRedactions = new Set<string>();

	reset(): void {
		this.pendingPii.clear();
		this.orphanedRedactions.clear();
	}

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
		this.orphanedRedactions.delete(params.artifactId);
	}

	noteRedaction(params: {
		artifactId: string;
		allowMissing?: boolean;
	}): boolean {
		const removed = this.pendingPii.delete(params.artifactId);
		if (!removed) {
			this.orphanedRedactions.add(params.artifactId);
			const message = `Attempted to redact unknown artifact "${params.artifactId}". Ensure collect and redact tooling share artifact ids.`;
			console.warn(`[workflow-state] ${message}`);
			if (!params.allowMissing) {
				throw new WorkflowStateError(message);
			}
		}
		return removed;
	}

	findArtifactIdByLabel(label: string): string | undefined {
		for (const [artifactId, record] of this.pendingPii.entries()) {
			if (record.label === label) {
				return artifactId;
			}
		}
		return undefined;
	}

	getSingletonPendingArtifactId(): string | undefined {
		if (this.pendingPii.size !== 1) {
			return undefined;
		}
		const [onlyKey] = this.pendingPii.keys();
		return onlyKey;
	}

	getPendingArtifactSummaries(): Array<{ id: string; label: string }> {
		return Array.from(this.pendingPii.entries()).map(([id, record]) => ({
			id,
			label: record.label,
		}));
	}

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

	isConcurrencyUnsafe(): boolean {
		return this.pendingPii.size > 0;
	}
}

export type WorkflowStateHook = {
	onResult?: (params: {
		toolCall: ToolCall;
		result: ToolResultMessage;
		tracker: WorkflowStateTracker;
		isError: boolean;
	}) => void;
};

// Hooks for tools that participate in workflow-state invariants (PII, etc.).
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

const workflowStateHooks: Record<string, WorkflowStateHook> = {
	...defaultHooks,
};

export function isWorkflowTrackedTool(toolName: string): boolean {
	return Boolean(workflowStateHooks[toolName]);
}

export function registerWorkflowStateHook(
	toolName: string,
	hook: WorkflowStateHook,
): void {
	workflowStateHooks[toolName] = hook;
}

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

export type ToolEgress = "human" | "external" | "internal";

export const TOOL_TAGS: Record<string, { egress?: ToolEgress }> = {
	handoff_to_human: { egress: "human" },
	send_email_update: { egress: "external" },
	post_customer_update: { egress: "external" },
	notify_account_team: { egress: "human" },
};

export function looksLikeEgress(toolName: string): boolean {
	return /handoff|send_|email|notify|escalate/i.test(toolName);
}
