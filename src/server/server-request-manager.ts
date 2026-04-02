import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
	ActionApprovalService,
} from "../agent/action-approval.js";
import type { ImageContent, TextContent } from "../agent/types.js";

type ToolResultContent = TextContent | ImageContent;

export type ServerRequestKind = "approval" | "client_tool";
export type ServerRequestResolution =
	| "approved"
	| "denied"
	| "completed"
	| "failed"
	| "cancelled";

export interface PendingServerRequestSnapshot {
	id: string;
	kind: ServerRequestKind;
	sessionId?: string;
	toolName: string;
	args: unknown;
	reason: string;
	timestamp: number;
}

export interface ServerRequestRegisteredEvent {
	type: "registered";
	request: PendingServerRequestSnapshot;
}

export interface ServerRequestResolvedEvent {
	type: "resolved";
	request: PendingServerRequestSnapshot;
	resolution: ServerRequestResolution;
	reason?: string;
	resolvedBy: "user" | "policy" | "client" | "runtime";
}

export type ServerRequestLifecycleEvent =
	| ServerRequestRegisteredEvent
	| ServerRequestResolvedEvent;

type ServerRequestListener = (event: ServerRequestLifecycleEvent) => void;

type ApprovalRequestEntry = PendingServerRequestSnapshot & {
	kind: "approval";
	timeoutMs: number;
	resolve: (decision: ActionApprovalDecision) => boolean;
};

type ClientToolRequestEntry = PendingServerRequestSnapshot & {
	kind: "client_tool";
	timeoutMs: number;
	resolve: (content: ToolResultContent[], isError: boolean) => boolean;
	cancel: (reason: string) => boolean;
};

type PendingServerRequestEntry = ApprovalRequestEntry | ClientToolRequestEntry;

type RegisterApprovalOptions = {
	sessionId?: string;
	request: ActionApprovalRequest;
	service: ActionApprovalService;
	timeoutMs?: number;
};

type RegisterClientToolOptions = {
	id: string;
	sessionId?: string;
	toolName: string;
	args: unknown;
	reason?: string;
	timeoutMs?: number;
	resolve: (content: ToolResultContent[], isError: boolean) => boolean;
	cancel: (reason: string) => boolean;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = 60 * 1000;

export class ServerRequestManager {
	private readonly pending = new Map<string, PendingServerRequestEntry>();
	private readonly listeners = new Set<ServerRequestListener>();

	subscribe(listener: ServerRequestListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	registerApproval(options: RegisterApprovalOptions): void {
		const { request, service } = options;
		const entry: ApprovalRequestEntry = {
			id: request.id,
			kind: "approval",
			sessionId: options.sessionId,
			toolName: request.toolName,
			args: request.args,
			reason: request.reason,
			timestamp: Date.now(),
			timeoutMs: options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
			resolve: (decision) => service.resolve(request.id, decision),
		};
		this.pending.set(request.id, entry);
		this.emit({
			type: "registered",
			request: this.toSnapshot(entry),
		});
	}

	registerClientTool(options: RegisterClientToolOptions): void {
		const entry: ClientToolRequestEntry = {
			id: options.id,
			kind: "client_tool",
			sessionId: options.sessionId,
			toolName: options.toolName,
			args: options.args,
			reason:
				options.reason ??
				`Client tool ${options.toolName} requires local execution`,
			timestamp: Date.now(),
			timeoutMs: options.timeoutMs ?? DEFAULT_CLIENT_TOOL_TIMEOUT_MS,
			resolve: options.resolve,
			cancel: options.cancel,
		};
		this.pending.set(options.id, entry);
		this.emit({
			type: "registered",
			request: this.toSnapshot(entry),
		});
	}

	unregister(id: string): void {
		this.pending.delete(id);
	}

	get(id: string): PendingServerRequestSnapshot | undefined {
		const entry = this.pending.get(id);
		if (!entry) {
			return undefined;
		}
		return {
			id: entry.id,
			kind: entry.kind,
			sessionId: entry.sessionId,
			toolName: entry.toolName,
			args: entry.args,
			reason: entry.reason,
			timestamp: entry.timestamp,
		};
	}

	listPending(filters?: {
		sessionId?: string;
		kind?: ServerRequestKind;
	}): PendingServerRequestSnapshot[] {
		return Array.from(this.pending.values())
			.filter((entry) =>
				filters?.sessionId ? entry.sessionId === filters.sessionId : true,
			)
			.filter((entry) => (filters?.kind ? entry.kind === filters.kind : true))
			.map((entry) => ({
				id: entry.id,
				kind: entry.kind,
				sessionId: entry.sessionId,
				toolName: entry.toolName,
				args: entry.args,
				reason: entry.reason,
				timestamp: entry.timestamp,
			}));
	}

	resolveApproval(
		id: string,
		decision: Pick<
			ActionApprovalDecision,
			"approved" | "reason" | "resolvedBy"
		>,
	): boolean {
		const entry = this.pending.get(id);
		if (!entry || entry.kind !== "approval") {
			return false;
		}
		const request = this.toSnapshot(entry);
		this.pending.delete(id);
		const handled = entry.resolve({
			approved: decision.approved,
			reason: decision.reason,
			resolvedBy: decision.resolvedBy,
		});
		if (handled) {
			this.emit({
				type: "resolved",
				request,
				resolution: decision.approved ? "approved" : "denied",
				reason: decision.reason,
				resolvedBy: decision.resolvedBy,
			});
		}
		return handled;
	}

	resolveClientTool(
		id: string,
		content: ToolResultContent[],
		isError: boolean,
	): boolean {
		const entry = this.pending.get(id);
		if (!entry || entry.kind !== "client_tool") {
			return false;
		}
		const request = this.toSnapshot(entry);
		this.pending.delete(id);
		const handled = entry.resolve(content, isError);
		if (handled) {
			this.emit({
				type: "resolved",
				request,
				resolution: isError ? "failed" : "completed",
				reason: isError ? "Client tool result reported an error" : undefined,
				resolvedBy: "client",
			});
		}
		return handled;
	}

	cancel(
		id: string,
		reason: string,
		resolvedBy: "policy" | "runtime" = "policy",
	): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		const request = this.toSnapshot(entry);
		this.pending.delete(id);
		if (entry.kind === "approval") {
			const handled = entry.resolve({
				approved: false,
				reason,
				resolvedBy: resolvedBy === "runtime" ? "policy" : resolvedBy,
			});
			if (handled) {
				this.emit({
					type: "resolved",
					request,
					resolution: resolvedBy === "runtime" ? "cancelled" : "denied",
					reason,
					resolvedBy,
				});
			}
			return handled;
		}
		const handled = entry.cancel(reason);
		if (handled) {
			this.emit({
				type: "resolved",
				request,
				resolution: resolvedBy === "runtime" ? "cancelled" : "failed",
				reason,
				resolvedBy,
			});
		}
		return handled;
	}

	cancelBySession(
		sessionId: string,
		reason: string,
		resolvedBy: "policy" | "runtime" = "policy",
	): number {
		let cancelled = 0;
		for (const entry of Array.from(this.pending.values())) {
			if (entry.sessionId !== sessionId) {
				continue;
			}
			if (this.cancel(entry.id, reason, resolvedBy)) {
				cancelled += 1;
			}
		}
		return cancelled;
	}

	cleanup(now = Date.now()): void {
		for (const entry of Array.from(this.pending.values())) {
			if (now - entry.timestamp <= entry.timeoutMs) {
				continue;
			}
			if (entry.kind === "approval") {
				this.cancel(entry.id, "Approval request timed out");
			} else {
				this.cancel(
					entry.id,
					"Client tool execution timed out after 60 seconds. The VS Code extension may not be responding.",
				);
			}
		}
	}

	private emit(event: ServerRequestLifecycleEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private toSnapshot(
		entry: PendingServerRequestEntry,
	): PendingServerRequestSnapshot {
		return {
			id: entry.id,
			kind: entry.kind,
			sessionId: entry.sessionId,
			toolName: entry.toolName,
			args: entry.args,
			reason: entry.reason,
			timestamp: entry.timestamp,
		};
	}
}

export const serverRequestManager = new ServerRequestManager();

setInterval(() => serverRequestManager.cleanup(), 60 * 1000).unref();
