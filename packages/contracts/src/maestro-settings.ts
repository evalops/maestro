import { type Static, Type } from "@sinclair/typebox";

/**
 * Maestro runtime settings catalog.
 *
 * A single typed source of truth for the runtime knobs an agent honors, so
 * "what knobs even exist" stops being a code-archaeology question. Settings
 * resolve org -> user -> env (legacy) -> built-in default, and the schema is
 * the auditable artifact: every per-tenant deviation from defaults is a typed,
 * queryable record stored on `organizations.settings` / `users.settings`.
 *
 * See:
 * - evalops/maestro#298 (server-validated runtime knob catalog)
 * - evalops/maestro#296 (auto-compaction promotion)
 */

/**
 * Model selection: a single model id, or a per-mode override map
 * (e.g. `{ "reasoning": "gpt-5", "default": "gpt-4o" }`).
 */
const MaestroModelSelectionSchema = Type.Union([
	Type.String(),
	Type.Record(Type.String(), Type.String()),
]);

/**
 * Compaction runtime knobs. Mirrors the existing auto-compaction behavior in
 * `src/agent/auto-compaction.ts`, promoted from process env to typed settings.
 */
export const MaestroCompactionSettingsSchema = Type.Object({
	/** Context-window usage percentage that triggers compaction (50-100). */
	thresholdPercent: Type.Optional(Type.Integer({ minimum: 50, maximum: 100 })),
	/** Whether auto-compaction is enabled. */
	enabled: Type.Optional(Type.Boolean()),
	/** Minimum message count before compaction is considered. */
	minMessages: Type.Optional(Type.Integer({ minimum: 0 })),
	/** Number of recent messages always retained during compaction. */
	keepRecentMessages: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * Tool gating overlays. `disable` / `enable` are tool-name lists that overlay
 * the PlatformToolExecutionBridge classification.
 */
export const MaestroToolsSettingsSchema = Type.Object({
	disable: Type.Optional(Type.Array(Type.String())),
	enable: Type.Optional(Type.Array(Type.String())),
});

/**
 * Typed catalog of Maestro runtime knobs.
 */
export const MaestroSettingsSchema = Type.Object({
	compaction: Type.Optional(MaestroCompactionSettingsSchema),
	model: Type.Optional(MaestroModelSelectionSchema),
	tools: Type.Optional(MaestroToolsSettingsSchema),
});

export type MaestroSettings = Static<typeof MaestroSettingsSchema>;
export type MaestroCompactionSettings = NonNullable<
	MaestroSettings["compaction"]
>;
export type MaestroToolsSettings = NonNullable<MaestroSettings["tools"]>;

export const DEFAULT_MAESTRO_COMPACTION_SETTINGS: Required<MaestroCompactionSettings> =
	{
		thresholdPercent: 85,
		enabled: true,
		minMessages: 10,
		keepRecentMessages: 6,
	};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
	}
	return undefined;
}

function parseInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Number.isInteger(value) ? value : Math.trunc(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const cleaned = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
}

function normalizeCompaction(
	input: unknown,
): MaestroCompactionSettings | undefined {
	if (!isPlainObject(input)) return undefined;
	const thresholdPercent = parseInteger(input.thresholdPercent);
	const enabled = parseBoolean(input.enabled);
	const minMessages = parseInteger(input.minMessages);
	const keepRecentMessages = parseInteger(input.keepRecentMessages);
	const normalized: MaestroCompactionSettings = {};
	if (thresholdPercent !== undefined) {
		normalized.thresholdPercent = Math.min(100, Math.max(50, thresholdPercent));
	}
	if (enabled !== undefined) normalized.enabled = enabled;
	if (minMessages !== undefined) {
		normalized.minMessages = Math.max(0, minMessages);
	}
	if (keepRecentMessages !== undefined) {
		normalized.keepRecentMessages = Math.max(0, keepRecentMessages);
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeModel(input: unknown): MaestroSettings["model"] {
	if (typeof input === "string" && input.trim()) return input.trim();
	if (isPlainObject(input)) {
		const record: Record<string, string> = {};
		for (const [key, value] of Object.entries(input)) {
			if (typeof value === "string" && value.trim()) {
				record[key.trim()] = value.trim();
			}
		}
		return Object.keys(record).length > 0 ? record : undefined;
	}
	return undefined;
}

function normalizeTools(input: unknown): MaestroToolsSettings | undefined {
	if (!isPlainObject(input)) return undefined;
	const disable = parseStringList(input.disable);
	const enable = parseStringList(input.enable);
	const normalized: MaestroToolsSettings = {};
	if (disable !== undefined) normalized.disable = disable;
	if (enable !== undefined) normalized.enable = enable;
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Defensively parse an untyped settings payload (e.g. raw JSONB) into a typed
 * `MaestroSettings`, dropping anything that does not validate. Unknown keys
 * are ignored so the catalog can grow without rejecting stored rows.
 */
export function normalizeMaestroSettings(input: unknown): MaestroSettings {
	if (!isPlainObject(input)) return {};
	const compaction = normalizeCompaction(input.compaction);
	const model = normalizeModel(input.model);
	const tools = normalizeTools(input.tools);
	const normalized: MaestroSettings = {};
	if (compaction !== undefined) normalized.compaction = compaction;
	if (model !== undefined) normalized.model = model;
	if (tools !== undefined) normalized.tools = tools;
	return normalized;
}

/**
 * Merge organization- and user-level Maestro settings with user-leaf-wins
 * precedence. Both inputs are normalized first; `undefined` namespaces fall
 * through to the other layer. Env / built-in defaults are applied by the
 * runtime consumer, not here, so this stays a pure function.
 */
export function mergeMaestroSettings(
	organization?: MaestroSettings | null,
	user?: MaestroSettings | null,
): MaestroSettings {
	const orgSettings = normalizeMaestroSettings(organization);
	const userSettings = normalizeMaestroSettings(user);
	const merged: MaestroSettings = {};

	const compaction = { ...orgSettings.compaction, ...userSettings.compaction };
	if (Object.keys(compaction).length > 0) merged.compaction = compaction;

	const model = userSettings.model ?? orgSettings.model;
	if (model !== undefined) merged.model = model;

	const tools = { ...orgSettings.tools, ...userSettings.tools };
	if (Object.keys(tools).length > 0) merged.tools = tools;

	return merged;
}
