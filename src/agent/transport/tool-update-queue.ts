/**
 * Tool Update Queue
 * Async concurrency primitives for interleaving tool execution completions
 * with streaming tool update events.
 */

import type { AgentEvent, ToolCall, ToolResultMessage } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecutionOutcome {
	message: ToolResultMessage;
	isError: boolean;
}

export interface PendingExecution {
	toolCall: ToolCall;
	promise: Promise<ToolExecutionOutcome>;
}

export type ToolUpdateEvent = Extract<
	AgentEvent,
	{
		type:
			| "tool_execution_update"
			| "tool_retry_required"
			| "tool_retry_resolved";
	}
>;

// ─────────────────────────────────────────────────────────────────────────────
// ToolUpdateQueue
// ─────────────────────────────────────────────────────────────────────────────

export class ToolUpdateQueue {
	private updates: ToolUpdateEvent[] = [];
	private resolve?: (event: ToolUpdateEvent) => void;
	private pending?: Promise<ToolUpdateEvent>;

	push(event: ToolUpdateEvent): void {
		if (this.resolve) {
			const resolve = this.resolve;
			this.resolve = undefined;
			this.pending = undefined;
			resolve(event);
			return;
		}
		this.updates.push(event);
	}

	hasPending(): boolean {
		return this.updates.length > 0;
	}

	shift(): ToolUpdateEvent | undefined {
		return this.updates.shift();
	}

	next(): Promise<ToolUpdateEvent> {
		const queued = this.shift();
		if (queued) {
			return Promise.resolve(queued);
		}
		if (!this.pending) {
			this.pending = new Promise<ToolUpdateEvent>((resolve) => {
				this.resolve = resolve;
			});
		}
		return this.pending;
	}
}

export function createToolUpdateQueue(): ToolUpdateQueue {
	return new ToolUpdateQueue();
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution/Update Interleaving
// ─────────────────────────────────────────────────────────────────────────────

export async function waitForNextExecutionOrUpdate(
	pendingExecutions: PendingExecution[],
	updateQueue: ToolUpdateQueue,
): Promise<
	| { kind: "update"; event: ToolUpdateEvent }
	| {
			kind: "execution";
			execution: PendingExecution;
			outcome: ToolExecutionOutcome;
	  }
> {
	const queued = updateQueue.shift();
	if (queued) {
		return { kind: "update", event: queued };
	}

	const executionPromise = Promise.race(
		pendingExecutions.map((entry) =>
			entry.promise.then((outcome) => ({ entry, outcome })),
		),
	).then((race) => ({
		kind: "execution" as const,
		execution: race.entry,
		outcome: race.outcome,
	}));

	const updatePromise = updateQueue.next().then((event) => ({
		kind: "update" as const,
		event,
	}));

	const next = await Promise.race([executionPromise, updatePromise]);
	if (next.kind === "execution") {
		const index = pendingExecutions.indexOf(next.execution);
		if (index >= 0) {
			pendingExecutions.splice(index, 1);
		}
	}
	return next;
}
