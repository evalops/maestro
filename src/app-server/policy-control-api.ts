import type {
	MaestroAppServerPolicyCheckItem,
	MaestroAppServerPolicyCheckResult,
	MaestroAppServerPolicyReadResult,
	MaestroAppServerRequirementsListResult,
} from "@evalops/contracts";
import type { ActionApprovalContext } from "../agent/action-approval.js";
import {
	type EnterprisePolicy,
	checkModelPolicy,
	checkPolicy,
	checkSessionLimits,
	loadPolicy,
} from "../safety/policy.js";

type UnknownRecord = Record<string, unknown>;

export class MaestroAppServerPolicyControlError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerPolicyControlError";
	}
}

export interface MaestroAppServerPolicyControl {
	readPolicy(): MaestroAppServerPolicyReadResult;
	checkPolicy(
		params?: UnknownRecord,
	): Promise<MaestroAppServerPolicyCheckResult>;
	listRequirements(): MaestroAppServerRequirementsListResult;
}

function readCurrentPolicy() {
	try {
		return loadPolicy();
	} catch (error) {
		throw new MaestroAppServerPolicyControlError(
			-32000,
			`Failed to load managed policy: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

function deepFreezeSnapshot<T>(value: T): T {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		deepFreezeSnapshot((value as Record<string, unknown>)[key]);
	}
	return Object.freeze(value);
}

function clonePolicySnapshot(
	policy: EnterprisePolicy | null,
): MaestroAppServerPolicyReadResult["policy"] {
	if (policy === null) {
		return null;
	}
	return deepFreezeSnapshot(structuredClone(policy));
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalNonEmptyString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new MaestroAppServerPolicyControlError(-32602, `Invalid ${field}`);
	}
	return value.trim();
}

function parseUser(value: unknown): ActionApprovalContext["user"] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid user");
	}
	const id = optionalNonEmptyString(value.id, "user.id");
	const orgId = optionalNonEmptyString(value.orgId, "user.orgId");
	if (!id || !orgId) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid user");
	}
	return { id, orgId };
}

function parseSession(
	value: unknown,
	requireId: boolean,
): ActionApprovalContext["session"] {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid session");
	}
	const id = optionalNonEmptyString(value.id, "session.id");
	if (requireId && !id) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid session.id");
	}
	if (value.startedAt === undefined || value.startedAt === null) {
		throw new MaestroAppServerPolicyControlError(
			-32602,
			"Invalid session.startedAt",
		);
	}
	const startedAt =
		value.startedAt instanceof Date
			? new Date(value.startedAt.getTime())
			: new Date(
					optionalNonEmptyString(value.startedAt, "session.startedAt") ?? "",
				);
	if (!Number.isFinite(startedAt.getTime())) {
		throw new MaestroAppServerPolicyControlError(
			-32602,
			"Invalid session.startedAt",
		);
	}
	return { id: id ?? "app-server-policy-check", startedAt };
}

function parseActionContext(
	value: unknown,
	fallbackSession?: ActionApprovalContext["session"],
): ActionApprovalContext | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid action");
	}
	const toolName = optionalNonEmptyString(value.toolName, "action.toolName");
	if (!toolName) {
		throw new MaestroAppServerPolicyControlError(
			-32602,
			"Invalid action.toolName",
		);
	}
	const actionSession =
		value.session === undefined || value.session === null
			? fallbackSession
			: parseSession(value.session, false);
	return {
		toolName,
		args: hasOwnKey(value, "args") ? value.args : {},
		metadata: isRecord(value.metadata)
			? (value.metadata as ActionApprovalContext["metadata"])
			: undefined,
		user: parseUser(value.user),
		session: actionSession,
		userIntent: optionalNonEmptyString(value.userIntent, "action.userIntent"),
	};
}

function parseUsage(
	value: unknown,
): { tokenCount?: number; activeSessionCount?: number } | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerPolicyControlError(-32602, "Invalid usage");
	}
	const usage: { tokenCount?: number; activeSessionCount?: number } = {};
	for (const key of ["tokenCount", "activeSessionCount"] as const) {
		if (value[key] === undefined || value[key] === null) {
			continue;
		}
		if (
			typeof value[key] !== "number" ||
			!Number.isFinite(value[key]) ||
			value[key] < 0
		) {
			throw new MaestroAppServerPolicyControlError(
				-32602,
				`Invalid usage.${key}`,
			);
		}
		usage[key] = value[key];
	}
	return usage;
}

function firstReason(
	checks: MaestroAppServerPolicyCheckItem[],
): string | undefined {
	return checks.find((check) => !check.allowed)?.reason;
}

export function createMaestroAppServerPolicyControl(): MaestroAppServerPolicyControl {
	return {
		readPolicy() {
			const policy = readCurrentPolicy();
			return {
				loaded: policy !== null,
				policy: clonePolicySnapshot(policy),
			};
		},

		async checkPolicy(params = {}) {
			if (!isRecord(params)) {
				throw new MaestroAppServerPolicyControlError(-32602, "Invalid params");
			}
			const checks: MaestroAppServerPolicyCheckItem[] = [];
			const session = parseSession(params.session, false);
			const action = parseActionContext(params.action, session);
			const sessionForLimits = action?.session ?? session;
			if (action) {
				const result = await checkPolicy(action);
				checks.push({
					kind: "action",
					allowed: result.allowed,
					...(result.reason ? { reason: result.reason } : {}),
				});
			}

			const modelId = optionalNonEmptyString(params.modelId, "modelId");
			if (modelId) {
				const result = checkModelPolicy(modelId);
				checks.push({
					kind: "model",
					allowed: result.allowed,
					...(result.reason ? { reason: result.reason } : {}),
				});
			}

			if (sessionForLimits) {
				const result = checkSessionLimits(
					sessionForLimits,
					parseUsage(params.usage),
				);
				checks.push({
					kind: "session",
					allowed: result.allowed,
					...(result.reason ? { reason: result.reason } : {}),
				});
			}

			if (checks.length === 0) {
				throw new MaestroAppServerPolicyControlError(
					-32602,
					"Missing policy check target",
				);
			}

			const reason = firstReason(checks);
			return {
				allowed: checks.every((check) => check.allowed),
				...(reason ? { reason } : {}),
				checks,
			};
		},

		listRequirements() {
			const policy = readCurrentPolicy();
			const requiredSkills = deepFreezeSnapshot([
				...(policy?.skills?.required ?? []),
			]);
			return {
				requirements: requiredSkills.map((id) => ({
					kind: "skill",
					id,
					required: true,
				})),
				requiredSkills,
			};
		},
	};
}
