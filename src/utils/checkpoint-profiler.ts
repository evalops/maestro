export type CheckpointProfileDetail =
	| boolean
	| number
	| string
	| null
	| undefined;
export type CheckpointProfileDetails = Record<string, CheckpointProfileDetail>;

export interface CheckpointProfiler {
	readonly enabled: boolean;
	checkpoint(label: string, details?: CheckpointProfileDetails): void;
	terminal(label: string, details?: CheckpointProfileDetails): void;
}

interface MemorySnapshot {
	rss?: number;
}

interface CheckpointProfilerOptions {
	scope: string;
	enabled: boolean;
	includeMemory?: boolean;
	now?: () => number;
	memoryUsage?: () => MemorySnapshot;
	sink?: (line: string) => void;
}

interface ProfilerEnvOptions {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	memoryUsage?: () => MemorySnapshot;
	sink?: (line: string) => void;
}

const noopProfiler: CheckpointProfiler = Object.freeze({
	enabled: false,
	checkpoint: () => undefined,
	terminal: () => undefined,
});

const SENSITIVE_DETAIL_KEY =
	/(arg|body|content|credential|message|password|prompt|secret|token)/i;
const SAFE_DETAIL_VALUE = /^[A-Za-z0-9._:/@+-]{1,96}$/;

function isEnabled(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

function sanitizeIdentifier(value: string, fallback: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 80);
	return sanitized.length > 0 ? sanitized : fallback;
}

function formatMemory(bytes: number | undefined): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
		return undefined;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

function formatDetailValue(
	key: string,
	value: CheckpointProfileDetail,
): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (SENSITIVE_DETAIL_KEY.test(key)) {
		return "[redacted]";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : undefined;
	}
	if (typeof value === "boolean") {
		return String(value);
	}
	if (SAFE_DETAIL_VALUE.test(value)) {
		return value;
	}
	return "[redacted]";
}

function formatDetails(details?: CheckpointProfileDetails): string[] {
	if (!details) {
		return [];
	}

	const formatted: string[] = [];
	for (const [rawKey, value] of Object.entries(details)) {
		const key = sanitizeIdentifier(rawKey, "field");
		const formattedValue = formatDetailValue(rawKey, value);
		if (formattedValue !== undefined) {
			formatted.push(`${key}=${formattedValue}`);
		}
	}
	return formatted;
}

export function createCheckpointProfiler(
	options: CheckpointProfilerOptions,
): CheckpointProfiler {
	if (!options.enabled) {
		return noopProfiler;
	}

	const scope = sanitizeIdentifier(options.scope, "profile");
	const now = options.now ?? (() => performance.now());
	const memoryUsage =
		options.memoryUsage ?? (() => ({ rss: process.memoryUsage().rss }));
	const sink = options.sink ?? ((line: string) => console.error(line));
	const startedAt = now();
	let previousAt = startedAt;
	let count = 0;
	let finished = false;

	const emit = (
		label: string,
		details: CheckpointProfileDetails | undefined,
		terminal: boolean,
	): void => {
		if (finished) {
			return;
		}

		const current = now();
		const elapsedMs = Math.max(0, Math.round(current - startedAt));
		const deltaMs = Math.max(0, Math.round(current - previousAt));
		const suffixParts: string[] = [];

		if (count > 0) {
			suffixParts.push(`+${deltaMs}ms`);
		}

		if (options.includeMemory) {
			const rss = formatMemory(memoryUsage().rss);
			if (rss) {
				suffixParts.push(`rss=${rss}`);
			}
		}

		suffixParts.push(...formatDetails(details));

		const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(", ")})` : "";
		sink(
			`[${scope}] ${elapsedMs}ms ${sanitizeIdentifier(label, "checkpoint")}${suffix}`,
		);

		previousAt = current;
		count += 1;
		if (terminal) {
			finished = true;
		}
	};

	return {
		enabled: true,
		checkpoint: (label, details) => emit(label, details, false),
		terminal: (label, details) => emit(label, details, true),
	};
}

export function createStartupProfilerFromEnv(
	options: ProfilerEnvOptions = {},
): CheckpointProfiler {
	const env = options.env ?? process.env;
	return createCheckpointProfiler({
		scope: "startup",
		enabled: isEnabled(env.MAESTRO_STARTUP_PROFILE),
		includeMemory: true,
		now: options.now,
		memoryUsage: options.memoryUsage,
		sink: options.sink,
	});
}

export function createQueryProfilerFromEnv(
	options: ProfilerEnvOptions = {},
): CheckpointProfiler {
	const env = options.env ?? process.env;
	return createCheckpointProfiler({
		scope: "query",
		enabled: isEnabled(env.MAESTRO_QUERY_PROFILE),
		now: options.now,
		memoryUsage: options.memoryUsage,
		sink: options.sink,
	});
}
