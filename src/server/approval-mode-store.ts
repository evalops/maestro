import type { ApprovalMode } from "../agent/action-approval.js";

const approvalModeStore = new Map<string, ApprovalMode>();
const approvalModeStrictness: Record<ApprovalMode, number> = {
	auto: 0,
	prompt: 1,
	fail: 2,
};

function normalizeApprovalSubject(subject: string | null | undefined): string {
	const normalized = subject?.trim();
	return normalized && normalized.length > 0 ? normalized : "anon";
}

function getApprovalModeStoreKey(
	sessionId: string | null | undefined,
	subject: string | null | undefined,
): string {
	return `${normalizeApprovalSubject(subject)}:${normalizeApprovalSessionId(sessionId)}`;
}

export function resolveApprovalModeOverride(
	defaultApprovalMode: ApprovalMode,
	overrideMode: ApprovalMode | undefined,
): ApprovalMode {
	if (!overrideMode) {
		return defaultApprovalMode;
	}
	return approvalModeStrictness[overrideMode] >=
		approvalModeStrictness[defaultApprovalMode]
		? overrideMode
		: defaultApprovalMode;
}

export function normalizeApprovalMode(
	rawMode: string | null | undefined,
): ApprovalMode | undefined {
	const normalized = rawMode?.trim().toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "prompt" ||
		normalized === "fail"
	) {
		return normalized;
	}
	return undefined;
}

export function normalizeApprovalSessionId(
	sessionId: string | null | undefined,
): string {
	const normalized = sessionId?.trim();
	return normalized && normalized.length > 0 ? normalized : "default";
}

export function getStoredApprovalMode(
	sessionId: string | null | undefined,
	subject?: string | null,
): ApprovalMode | undefined {
	return approvalModeStore.get(getApprovalModeStoreKey(sessionId, subject));
}

export function getApprovalModeForSession(
	sessionId: string | null | undefined,
	defaultApprovalMode: ApprovalMode,
	subject?: string | null,
): ApprovalMode {
	return resolveApprovalModeOverride(
		defaultApprovalMode,
		getStoredApprovalMode(sessionId, subject),
	);
}

export function setApprovalModeForSession(
	sessionId: string | null | undefined,
	mode: ApprovalMode,
	options?: {
		subject?: string | null;
		defaultApprovalMode?: ApprovalMode;
	},
): ApprovalMode {
	const effectiveMode = resolveApprovalModeOverride(
		options?.defaultApprovalMode ?? mode,
		mode,
	);
	approvalModeStore.set(
		getApprovalModeStoreKey(sessionId, options?.subject),
		effectiveMode,
	);
	return effectiveMode;
}

export function resolveApprovalModeForRequest(params: {
	sessionId?: string | null;
	subject?: string | null;
	headerApprovalMode?: ApprovalMode;
	defaultApprovalMode: ApprovalMode;
}): ApprovalMode {
	return resolveApprovalModeOverride(
		params.defaultApprovalMode,
		params.headerApprovalMode ??
			getStoredApprovalMode(params.sessionId, params.subject),
	);
}

export function resetApprovalModeStore(): void {
	approvalModeStore.clear();
}
