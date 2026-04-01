import { detectSensitiveContent } from "./content-detection.js";
import type { SensitiveContentFinding } from "./credential-patterns.js";

export interface OutboundSecretScanResult {
	findings: SensitiveContentFinding[];
	blockingFindings: SensitiveContentFinding[];
}

type AttachmentLike = {
	type?: unknown;
	fileName?: unknown;
	mimeType?: unknown;
	content?: unknown;
	preview?: unknown;
	extractedText?: unknown;
};

const BLOCKING_SEVERITIES = new Set<SensitiveContentFinding["severity"]>([
	"high",
]);

function isAttachmentLike(value: unknown): value is AttachmentLike {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.fileName === "string" ||
		typeof record.mimeType === "string" ||
		record.type === "image" ||
		record.type === "document"
	);
}

function prepareForOutboundScan(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => prepareForOutboundScan(entry));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const record = value as Record<string, unknown>;
	const attachmentLike = isAttachmentLike(record);
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (
			attachmentLike &&
			(key === "content" || key === "preview") &&
			typeof entry === "string"
		) {
			continue;
		}
		out[key] = prepareForOutboundScan(entry);
	}
	return out;
}

export function isBlockingOutboundSensitiveFinding(
	finding: SensitiveContentFinding,
): boolean {
	return BLOCKING_SEVERITIES.has(finding.severity);
}

export function scanOutboundSensitiveContent(
	payload: unknown,
): OutboundSecretScanResult {
	const findings = detectSensitiveContent(prepareForOutboundScan(payload));
	return {
		findings,
		blockingFindings: findings.filter(isBlockingOutboundSensitiveFinding),
	};
}

export function summarizeOutboundSensitiveFindings(
	findings: SensitiveContentFinding[],
	limit = 5,
): Array<Record<string, string>> {
	return findings.slice(0, limit).map((finding) => ({
		type: finding.type,
		severity: finding.severity,
		path: finding.path,
		description: finding.description,
	}));
}
