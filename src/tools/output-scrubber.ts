import { recordShellScrubberFailureMetric } from "../telemetry/metrics.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { type SecretMasker, redactSecrets } from "../utils/secret-redactor.js";

const logger = createLogger("tools:output-scrubber");

export const SECRET_SCRUBBER_FAILURE_PLACEHOLDER =
	"[output redacted: secret scrubber failed]";
export const SECRET_STREAM_BOUNDARY_PLACEHOLDER =
	"[output redacted: no safe secret boundary]";
export const DEFAULT_SECRET_SCRUBBING_WINDOW_CHARS = 4096;
export const DEFAULT_SECRET_SCRUBBING_MAX_PENDING_CHARS = 64 * 1024;

const SECRET_TOKEN_CHAR_PATTERN = /[A-Za-z0-9._~+/=-]/u;

export type SecretScrubber = (
	value: string,
	maskSecret: SecretMasker,
) => string;

export interface SecretScrubberFailureContext {
	strict: boolean;
	surface?: string;
}

export class SecretScrubberError extends Error {
	constructor(
		message: string,
		public readonly originalError: unknown,
	) {
		super(message);
		this.name = "SecretScrubberError";
	}
}

export function isSecretScrubberStrict(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.MAESTRO_SCRUBBER_STRICT === "1";
}

export function scrubOutputFailClosed(
	value: string,
	options: {
		maskSecret?: SecretMasker;
		scrubber?: SecretScrubber;
		placeholder?: string;
		strict?: boolean;
		surface?: string;
		onFailure?: (error: unknown, context: SecretScrubberFailureContext) => void;
	} = {},
): string {
	if (!value) {
		return value;
	}
	const maskSecret = options.maskSecret ?? (() => "[secret]");
	const scrubber = options.scrubber ?? redactSecrets;
	try {
		return scrubber(value, maskSecret);
	} catch (error) {
		const strict = options.strict ?? isSecretScrubberStrict();
		const context = { strict, surface: options.surface };
		logger.warn("Secret scrubbing failed; redacting output chunk", {
			error: sanitizeWithStaticMask(
				error instanceof Error ? error.message : String(error),
			),
			surface: options.surface,
			strict,
		});
		try {
			recordShellScrubberFailureMetric({ surface: options.surface, strict });
		} catch {
			// Metrics must never make output handling less safe.
		}
		try {
			options.onFailure?.(error, context);
		} catch {
			// Failure hooks are observability only; preserve the fail-closed outcome.
		}
		if (strict) {
			throw new SecretScrubberError(
				"Output scrubber failed; aborting to avoid leaking raw shell output",
				error,
			);
		}
		return options.placeholder ?? SECRET_SCRUBBER_FAILURE_PLACEHOLDER;
	}
}

export class SecretOutputScrubber {
	private pending = "";
	private readonly windowSize: number;
	private readonly maxPendingChars: number;

	constructor(
		private readonly options: Parameters<typeof scrubOutputFailClosed>[1] & {
			maxPendingChars?: number;
			windowSize?: number;
		} = {},
	) {
		this.windowSize = Math.max(
			0,
			options.windowSize ?? DEFAULT_SECRET_SCRUBBING_WINDOW_CHARS,
		);
		this.maxPendingChars = Math.max(
			this.windowSize,
			options.maxPendingChars ??
				Math.max(
					DEFAULT_SECRET_SCRUBBING_MAX_PENDING_CHARS,
					this.windowSize * 4,
				),
		);
	}

	write(value: string): string {
		if (!value) {
			return "";
		}
		this.pending += value;
		if (this.pending.length <= this.windowSize) {
			return "";
		}
		const emitLength =
			this.windowSize === 0
				? this.pending.length
				: findSafeEmitLength(
						this.pending,
						this.pending.length - this.windowSize,
					);
		if (emitLength <= 0) {
			if (this.pending.length <= this.maxPendingChars) {
				return "";
			}
			this.pending =
				this.windowSize > 0 ? this.pending.slice(-this.windowSize) : "";
			return this.options.placeholder ?? SECRET_STREAM_BOUNDARY_PLACEHOLDER;
		}
		const safeWindow = this.pending.slice(0, emitLength);
		this.pending = this.pending.slice(emitLength);
		return scrubOutputFailClosed(safeWindow, this.options);
	}

	flush(): string {
		if (!this.pending) {
			return "";
		}
		const safeWindow = this.pending;
		this.pending = "";
		return scrubOutputFailClosed(safeWindow, this.options);
	}
}

function isSecretTokenChar(value: string | undefined): boolean {
	return Boolean(value && SECRET_TOKEN_CHAR_PATTERN.test(value));
}

function findSafeEmitLength(value: string, maxEmitLength: number): number {
	const max = Math.min(maxEmitLength, value.length);
	if (max >= value.length) {
		return value.length;
	}
	for (let index = max; index > 0; index -= 1) {
		if (
			!isSecretTokenChar(value[index - 1]) ||
			!isSecretTokenChar(value[index])
		) {
			return index;
		}
	}
	return 0;
}
