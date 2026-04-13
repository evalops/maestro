import type { ApprovalMode } from "../agent/action-approval.js";
import { isDraftAndConfirmDefaultEnabled } from "./feature-flags.js";

function normalizeApprovalMode(value?: string | null): ApprovalMode {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "prompt" ||
		normalized === "fail"
	) {
		return normalized;
	}
	return "prompt";
}

function isProductionProfile(profile?: string | null): boolean {
	const normalized = profile?.trim().toLowerCase();
	return (
		normalized === "prod" ||
		normalized === "production" ||
		normalized === "secure" ||
		normalized === "hardened"
	);
}

export function resolveDefaultApprovalMode(options?: {
	profile?: string | null;
	explicitApprovalMode?: string | null;
}): ApprovalMode {
	const explicitApprovalMode = options?.explicitApprovalMode;
	if (explicitApprovalMode?.trim()) {
		return normalizeApprovalMode(explicitApprovalMode);
	}

	if (isDraftAndConfirmDefaultEnabled()) {
		return "prompt";
	}

	return normalizeApprovalMode(
		isProductionProfile(options?.profile) ? "fail" : null,
	);
}
