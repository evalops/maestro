import {
	type MaestroAppServerClientMethod,
	type MaestroAppServerProtocolMode,
	type MaestroAppServerProtocolModeId,
	type MaestroAppServerProtocolModeListResult,
	type MaestroAppServerProtocolModeSetResult,
	maestroAppServerClientMethods,
	maestroAppServerProtocolModeIds,
	maestroAppServerServerMethods,
} from "@evalops/contracts";

type UnknownRecord = Record<string, unknown>;

const DEFAULT_MODE: MaestroAppServerProtocolModeId = "standard";

const REVIEW_BLOCKED_METHODS = new Set<MaestroAppServerClientMethod>([
	"network/fetch",
	"sandbox/proof/run",
	"externalAgent/import",
	"pluginBundle/install",
	"pluginBundle/remove",
	"remoteControl/lease/heartbeat",
	"remoteControl/drain",
	"command/exec",
	"command/exec/write",
	"command/exec/terminate",
	"fs/writeFile",
	"fs/createDirectory",
	"fs/remove",
	"fs/copy",
	"fs/watch",
	"thread/metadata/update",
	"thread/name/set",
	"thread/goal/set",
	"thread/goal/clear",
	"thread/start",
	"thread/fork",
	"thread/archive",
	"thread/unarchive",
	"thread/delete",
]);

export class MaestroAppServerProtocolModesError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerProtocolModesError";
	}
}

export interface MaestroAppServerProtocolModeDecision {
	allowed: boolean;
	reason?: string;
}

export interface MaestroAppServerProtocolModes {
	listModes(params?: UnknownRecord): MaestroAppServerProtocolModeListResult;
	setMode(params?: UnknownRecord): MaestroAppServerProtocolModeSetResult;
	checkMethod(
		method: MaestroAppServerClientMethod,
	): MaestroAppServerProtocolModeDecision;
	activeMode(): MaestroAppServerProtocolModeId;
}

export interface MaestroAppServerProtocolModesOptions {
	initialMode?: MaestroAppServerProtocolModeId;
}

function normalizeMode(value: unknown): MaestroAppServerProtocolModeId {
	if (value === undefined || value === null) {
		throw new MaestroAppServerProtocolModesError(-32602, "Missing mode");
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerProtocolModesError(-32602, "Invalid mode");
	}
	if (
		maestroAppServerProtocolModeIds.includes(
			value as MaestroAppServerProtocolModeId,
		)
	) {
		return value as MaestroAppServerProtocolModeId;
	}
	throw new MaestroAppServerProtocolModesError(-32602, "Invalid mode");
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsRecord(params: unknown): UnknownRecord {
	if (params === undefined) {
		return {};
	}
	if (isRecord(params)) {
		return params;
	}
	throw new MaestroAppServerProtocolModesError(-32602, "Invalid params");
}

function modeLabel(mode: MaestroAppServerProtocolModeId): string {
	switch (mode) {
		case "review":
			return "Review";
		case "realtime":
			return "Realtime";
		case "standard":
			return "Standard";
	}
}

function isMethodAllowedInMode(
	mode: MaestroAppServerProtocolModeId,
	method: MaestroAppServerClientMethod,
): boolean {
	if (mode !== "review") {
		return true;
	}
	return !REVIEW_BLOCKED_METHODS.has(method);
}

function describeMode(
	mode: MaestroAppServerProtocolModeId,
): MaestroAppServerProtocolMode {
	const allowedMethods = maestroAppServerClientMethods.filter((method) =>
		isMethodAllowedInMode(mode, method),
	);
	const blockedMethods = maestroAppServerClientMethods.filter(
		(method) => !isMethodAllowedInMode(mode, method),
	);
	return {
		id: mode,
		label: modeLabel(mode),
		readOnly: mode === "review",
		realtime: mode === "realtime",
		allowedMethods: [...allowedMethods],
		blockedMethods: [...blockedMethods],
		serverNotifications:
			mode === "realtime" ? [...maestroAppServerServerMethods] : [],
	};
}

export function createMaestroAppServerProtocolModes(
	options: MaestroAppServerProtocolModesOptions = {},
): MaestroAppServerProtocolModes {
	let activeMode =
		options.initialMode === undefined
			? DEFAULT_MODE
			: normalizeMode(options.initialMode);
	return {
		listModes(params) {
			paramsRecord(params);
			return {
				activeMode,
				defaultMode: DEFAULT_MODE,
				modes: maestroAppServerProtocolModeIds.map(describeMode),
			};
		},

		setMode(params) {
			const normalizedParams = paramsRecord(params);
			activeMode = normalizeMode(normalizedParams.mode);
			return {
				activeMode,
				mode: describeMode(activeMode),
			};
		},

		checkMethod(method) {
			if (isMethodAllowedInMode(activeMode, method)) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `${method} is blocked while protocol mode is ${activeMode}`,
			};
		},

		activeMode() {
			return activeMode;
		},
	};
}
