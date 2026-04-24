import type {
	ComposerPendingRequest,
	ComposerPendingRequestPlatformRef,
} from "@evalops/contracts";

export interface PendingRequestUiMetadata {
	source: ComposerPendingRequest["source"];
	createdAt?: string;
	expiresAt?: string;
	platform?: ComposerPendingRequestPlatformRef;
}

interface PendingRequestCarrier {
	pendingRequest?: PendingRequestUiMetadata;
}

export function attachPendingRequestMetadata<T extends object>(
	value: T,
	request: ComposerPendingRequest,
): T & PendingRequestCarrier {
	return {
		...value,
		pendingRequest: {
			source: request.source,
			createdAt: request.createdAt,
			expiresAt: request.expiresAt,
			platform: request.platform,
		},
	};
}

export function getPendingRequestMetadata(
	value: unknown,
): PendingRequestUiMetadata | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const metadata = (value as PendingRequestCarrier).pendingRequest;
	if (!metadata) {
		return null;
	}
	return metadata;
}

function formatRelativeTime(ms: number): string {
	const absoluteMs = Math.abs(ms);
	if (absoluteMs < 60_000) {
		return ms <= 0 ? "less than 1 minute ago" : "in less than 1 minute";
	}
	const minutes = Math.round(absoluteMs / 60_000);
	if (minutes < 60) {
		return ms < 0
			? `${minutes} minute${minutes === 1 ? "" : "s"} ago`
			: `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const hours = Math.round(absoluteMs / 3_600_000);
	if (hours < 24) {
		return ms < 0
			? `${hours} hour${hours === 1 ? "" : "s"} ago`
			: `in ${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.round(absoluteMs / 86_400_000);
	return ms < 0
		? `${days} day${days === 1 ? "" : "s"} ago`
		: `in ${days} day${days === 1 ? "" : "s"}`;
}

export function formatPendingRequestStatus(
	value: unknown,
	nowMs = Date.now(),
): string | null {
	const metadata = getPendingRequestMetadata(value);
	if (!metadata) {
		return null;
	}
	const parts = [
		metadata.source === "platform" ? "Platform wait" : "Local wait",
	];
	if (metadata.expiresAt) {
		const expiresAtMs = Date.parse(metadata.expiresAt);
		if (Number.isFinite(expiresAtMs)) {
			const deltaMs = expiresAtMs - nowMs;
			parts.push(
				deltaMs <= 0
					? `Timed out ${formatRelativeTime(deltaMs)}`
					: `Expires ${formatRelativeTime(deltaMs)}`,
			);
		}
	}
	return parts.join(" • ");
}
