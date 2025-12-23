import { parseStreamingJson } from "./json-parse.js";

export type ToolArgumentStage = "start" | "delta" | "done";

export interface ToolArgumentContext {
	callId?: string;
	toolId?: string;
	name?: string;
	stage?: ToolArgumentStage;
}

export interface ToolArgumentLogger {
	warn(message: string, details?: Record<string, unknown>): void;
}

export interface ToolArgumentNormalizer {
	normalize(
		raw: unknown,
		context: ToolArgumentContext,
		options?: { expectString?: boolean; logInvalid?: boolean },
	): Record<string, unknown>;
	normalizeWithPartialJson(
		raw: unknown,
		context: ToolArgumentContext,
		options?: { expectString?: boolean; logInvalid?: boolean },
	): { arguments: Record<string, unknown>; partialJson: string };
	parseFromString(
		raw: string,
		context: ToolArgumentContext,
		options?: { logInvalid?: boolean },
	): Record<string, unknown>;
	warnOnce(
		key: string,
		message: string,
		details: Record<string, unknown>,
	): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function describeValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function buildWarningDetails(
	context: ToolArgumentContext,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...(context.callId ? { callId: context.callId } : {}),
		...(context.toolId ? { toolId: context.toolId } : {}),
		...(context.name ? { name: context.name } : {}),
		...(context.stage ? { stage: context.stage } : {}),
		...(extra ?? {}),
	};
}

export function createToolArgumentNormalizer(options: {
	logger: ToolArgumentLogger;
	providerLabel: string;
}): ToolArgumentNormalizer {
	const warnedToolArgumentKeys = new Set<string>();

	function warnOnce(
		key: string,
		message: string,
		details: Record<string, unknown>,
	): void {
		const scopedKey = `${options.providerLabel}:${key}`;
		if (warnedToolArgumentKeys.has(scopedKey)) return;
		warnedToolArgumentKeys.add(scopedKey);
		options.logger.warn(message, details);
	}

	function parseFromString(
		raw: string,
		context: ToolArgumentContext,
		parseOptions?: { logInvalid?: boolean },
	): Record<string, unknown> {
		const parsed = parseStreamingJson<unknown>(raw);
		if (isRecord(parsed)) {
			return parsed;
		}
		if (parseOptions?.logInvalid ?? true) {
			const parsedType = describeValueType(parsed);
			warnOnce(
				`parsed:${context.stage ?? "unknown"}:${parsedType}`,
				`${options.providerLabel} tool call arguments parsed to non-object`,
				buildWarningDetails(context, { parsedType }),
			);
		}
		return {};
	}

	function normalize(
		raw: unknown,
		context: ToolArgumentContext,
		normalizeOptions?: { expectString?: boolean; logInvalid?: boolean },
	): Record<string, unknown> {
		if (typeof raw === "string") {
			return parseFromString(raw, context, {
				logInvalid: normalizeOptions?.logInvalid,
			});
		}

		if (isRecord(raw)) {
			if (normalizeOptions?.expectString) {
				warnOnce(
					"raw:object",
					`${options.providerLabel} tool call arguments were object, expected string`,
					buildWarningDetails(context),
				);
			}
			return raw;
		}

		if (raw === null || raw === undefined) {
			warnOnce(
				"raw:nullish",
				`${options.providerLabel} tool call arguments were null/undefined`,
				buildWarningDetails(context),
			);
			return {};
		}

		const rawType = describeValueType(raw);
		warnOnce(
			`raw:${rawType}`,
			`${options.providerLabel} tool call arguments had unexpected type`,
			buildWarningDetails(context, { rawType }),
		);
		return {};
	}

	function normalizeWithPartialJson(
		raw: unknown,
		context: ToolArgumentContext,
		normalizeOptions?: { expectString?: boolean; logInvalid?: boolean },
	): { arguments: Record<string, unknown>; partialJson: string } {
		if (typeof raw === "string") {
			return {
				arguments: parseFromString(raw, context, {
					logInvalid: normalizeOptions?.logInvalid ?? false,
				}),
				partialJson: raw,
			};
		}

		if (isRecord(raw)) {
			if (normalizeOptions?.expectString) {
				warnOnce(
					"raw:object",
					`${options.providerLabel} tool call arguments were object, expected string`,
					buildWarningDetails(context),
				);
			}
			return { arguments: raw, partialJson: "" };
		}

		if (raw === null || raw === undefined) {
			warnOnce(
				"raw:nullish",
				`${options.providerLabel} tool call arguments were null/undefined`,
				buildWarningDetails(context),
			);
			return { arguments: {}, partialJson: "" };
		}

		const rawType = describeValueType(raw);
		warnOnce(
			`raw:${rawType}`,
			`${options.providerLabel} tool call arguments had unexpected type`,
			buildWarningDetails(context, { rawType }),
		);
		return { arguments: {}, partialJson: "" };
	}

	return { normalize, normalizeWithPartialJson, parseFromString, warnOnce };
}
