import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";

const SENSITIVE_METADATA_KEY_PATTERN =
	/^(api[_-]?key|authorization|auth|bearer|client[_-]?secret|cookie|credential|credentials|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|set[_-]?cookie|token)$/i;

export interface NormalizedTelemetryMetadata {
	metadata?: Record<string, unknown>;
	sensitiveMetadata?: Record<string, unknown>;
}

export function normalizeTelemetryMetadataInputs(
	metadata?: Record<string, unknown>,
	sensitiveMetadata?: Record<string, unknown>,
): NormalizedTelemetryMetadata {
	const split = splitTelemetryMetadata(metadata);
	const maskedSensitive = maskSensitiveMetadataRecord(sensitiveMetadata);
	const mergedSensitiveMetadata = mergeMetadataRecords(
		split.sensitiveMetadata,
		maskedSensitive,
	);
	return {
		...(split.metadata ? { metadata: split.metadata } : {}),
		...(mergedSensitiveMetadata
			? { sensitiveMetadata: mergedSensitiveMetadata }
			: {}),
	};
}

export function splitTelemetryMetadata(
	metadata?: Record<string, unknown>,
): NormalizedTelemetryMetadata {
	return splitTelemetryMetadataRecord(metadata, new WeakSet<object>());
}

function splitTelemetryMetadataRecord(
	metadata: Record<string, unknown> | undefined,
	seen: WeakSet<object>,
): NormalizedTelemetryMetadata {
	if (!metadata) {
		return {};
	}
	if (seen.has(metadata)) {
		return {
			metadata: {
				circular: "[circular]",
			},
		};
	}
	seen.add(metadata);
	const safe: Record<string, unknown> = {};
	const sensitive: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(metadata)) {
		if (isSensitiveMetadataKey(key)) {
			sensitive[key] = maskSensitiveMetadataValue(value, seen);
			continue;
		}
		const splitValue = splitTelemetryMetadataValue(value, seen);
		if (splitValue.safe !== undefined) {
			safe[key] = splitValue.safe;
		}
		if (splitValue.sensitive !== undefined) {
			sensitive[key] = splitValue.sensitive;
		}
	}
	seen.delete(metadata);

	return {
		metadata: hasEntries(safe) ? safe : undefined,
		sensitiveMetadata: hasEntries(sensitive) ? sensitive : undefined,
	};
}

function splitTelemetryMetadataValue(
	value: unknown,
	seen: WeakSet<object>,
): {
	safe?: unknown;
	sensitive?: unknown;
} {
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return {
				safe: "[circular]",
			};
		}
		seen.add(value);
		const safeItems: unknown[] = [];
		const sensitiveItems: unknown[] = [];
		let hasSensitive = false;
		for (const item of value) {
			const splitItem = splitTelemetryMetadataValue(item, seen);
			safeItems.push(splitItem.safe ?? null);
			sensitiveItems.push(splitItem.sensitive ?? null);
			hasSensitive = hasSensitive || splitItem.sensitive !== undefined;
		}
		seen.delete(value);
		return {
			safe: safeItems,
			sensitive: hasSensitive ? sensitiveItems : undefined,
		};
	}
	if (value && typeof value === "object") {
		const record = plainRecord(value);
		if (!record) {
			return {
				safe: sanitizeTelemetryMetadataValue(value),
			};
		}
		if (seen.has(value)) {
			return {
				safe: "[circular]",
			};
		}
		const nested = splitTelemetryMetadataRecord(record, seen);
		return {
			safe: nested.metadata,
			sensitive: nested.sensitiveMetadata,
		};
	}
	return {
		safe: sanitizeTelemetryMetadataValue(value),
	};
}

function sanitizeTelemetryMetadataValue(value: unknown): unknown {
	return typeof value === "string" ? sanitizeWithStaticMask(value) : value;
}

function maskSensitiveMetadataRecord(
	record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const masked = maskSensitiveMetadataValue(record);
	return plainRecord(masked);
}

function maskSensitiveMetadataValue(
	value: unknown,
	seen = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") {
		return "[sensitive]";
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return "[sensitive]";
		}
		seen.add(value);
		const masked = value.map((item) => maskSensitiveMetadataValue(item, seen));
		seen.delete(value);
		return masked;
	}
	if (value && typeof value === "object") {
		const record = plainRecord(value);
		if (!record) {
			return "[sensitive]";
		}
		if (seen.has(value)) {
			return "[sensitive]";
		}
		seen.add(value);
		const masked = Object.fromEntries(
			Object.entries(record).map(([key, nested]) => [
				key,
				maskSensitiveMetadataValue(nested, seen),
			]),
		);
		seen.delete(value);
		return masked;
	}
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	return "[sensitive]";
}

function isSensitiveMetadataKey(key: string): boolean {
	return SENSITIVE_METADATA_KEY_PATTERN.test(key);
}

function hasEntries(record: Record<string, unknown>): boolean {
	return Object.keys(record).length > 0;
}

function mergeMetadataRecords(
	first?: Record<string, unknown>,
	second?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!first && !second) {
		return undefined;
	}
	const merged: Record<string, unknown> = { ...(first ?? {}) };
	for (const [key, value] of Object.entries(second ?? {})) {
		merged[key] = mergeMetadataValues(merged[key], value);
	}
	return hasEntries(merged) ? merged : undefined;
}

function mergeMetadataValues(first: unknown, second: unknown): unknown {
	if (second === null || second === undefined) {
		return first;
	}
	if (first === null || first === undefined) {
		return second;
	}
	if (Array.isArray(first) && Array.isArray(second)) {
		return mergeMetadataArrays(first, second);
	}
	const firstRecord = plainRecord(first);
	const secondRecord = plainRecord(second);
	if (firstRecord && secondRecord) {
		return mergeMetadataRecords(firstRecord, secondRecord);
	}
	return second;
}

function mergeMetadataArrays(first: unknown[], second: unknown[]): unknown[] {
	const merged: unknown[] = [];
	const length = Math.max(first.length, second.length);
	for (let index = 0; index < length; index += 1) {
		merged[index] = mergeMetadataValues(first[index], second[index]);
	}
	return merged;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null
		? (value as Record<string, unknown>)
		: undefined;
}
