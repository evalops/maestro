import {
	type SkillArtifactMetadata,
	getSkillArtifactMetadataFromDetails,
} from "../../skills/artifact-metadata.js";
import type { AgentEvent } from "../types.js";

type GovernedToolOutcome =
	| "approval_required"
	| "approval_pending"
	| "authentication_required"
	| "denied"
	| "rate_limited";

export class AgentEventQueue {
	private events: AgentEvent[] = [];
	private pending?: Promise<void>;
	private wake?: () => void;

	push(event: AgentEvent): void {
		this.events.push(event);
		if (this.wake) {
			const wake = this.wake;
			this.pending = undefined;
			this.wake = undefined;
			wake();
		}
	}

	shift(): AgentEvent | undefined {
		return this.events.shift();
	}

	wait(): Promise<void> {
		if (this.events.length > 0) {
			return Promise.resolve();
		}
		if (!this.pending) {
			this.pending = new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		return this.pending;
	}

	clearPendingWaiter(): void {
		this.pending = undefined;
		this.wake = undefined;
	}
}

export function isDynamicToolApprovalEvent(event: AgentEvent): boolean {
	return (
		event.type === "action_approval_required" ||
		event.type === "action_approval_resolved"
	);
}

export function getGovernedToolResultEventMetadata(details: unknown): {
	errorCode?: string;
	approvalRequestId?: string;
	governedOutcome?: GovernedToolOutcome;
} {
	if (!details || typeof details !== "object") {
		return {};
	}

	const governedOutcome = (details as { governedOutcome?: unknown })
		.governedOutcome;
	if (!governedOutcome || typeof governedOutcome !== "object") {
		return {};
	}

	const normalized = governedOutcome as Record<string, unknown>;
	const classification =
		typeof normalized.classification === "string"
			? (normalized.classification as GovernedToolOutcome)
			: undefined;
	const errorCode =
		typeof normalized.code === "string" && normalized.code.trim().length > 0
			? normalized.code.trim()
			: classification;
	const approvalRequestId =
		typeof normalized.approvalRequestId === "string" &&
		normalized.approvalRequestId.trim().length > 0
			? normalized.approvalRequestId.trim()
			: undefined;

	return {
		errorCode,
		approvalRequestId,
		governedOutcome: classification,
	};
}

export function getSkillToolResultEventMetadata(details: unknown): {
	skillMetadata?: SkillArtifactMetadata;
} {
	return {
		skillMetadata: getSkillArtifactMetadataFromDetails(details),
	};
}
