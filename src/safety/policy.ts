/**
 * Enterprise Policy System - Access Control and Safety Enforcement
 *
 * This module implements enterprise-grade policy enforcement for the Composer CLI,
 * enabling organizations to control what tools, models, paths, and network hosts
 * can be accessed during agent execution.
 *
 * ## Policy File Location
 *
 * Policies are loaded from `~/.maestro/policy.json` and
 * `.maestro/workspace.toml` in the current workspace. The global JSON file is
 * typically deployed by enterprise IT and should be protected with appropriate
 * permissions. Workspace TOML applies a stricter project-specific layer.
 *
 * ## Policy Structure
 *
 * ```json
 * {
 *   "orgId": "org-12345",
 *   "tools": {
 *     "allowed": ["Read", "Grep", "Glob"],
 *     "blocked": ["Bash", "Write"]
 *   },
 *   "models": {
 *     "allowed": ["anthropic/claude-*"],
 *     "blocked": ["openai/*"]
 *   },
 *   "paths": {
 *     "allowed": ["/home/user/projects/**"],
 *     "blocked": ["/etc/**", "/root/**"]
 *   },
 *   "network": {
 *     "allowedHosts": ["api.github.com"],
 *     "blockedHosts": ["*.internal.corp"],
 *     "blockLocalhost": true,
 *     "blockPrivateIPs": true
 *   },
 *   "limits": {
 *     "maxTokensPerSession": 100000,
 *     "maxSessionDurationMinutes": 60,
 *     "maxConcurrentSessions": 3
 *   }
 * }
 * ```
 *
 * Workspace policies use TOML keys such as `allowed_models`, `blocked_tools`,
 * `file_boundaries`, and `max_tokens_per_session`.
 *
 * ## Rule Evaluation
 *
 * Policies use an allow/block list pattern with the following evaluation order:
 *
 * 1. If `blocked` list exists and matches → **DENY**
 * 2. If `allowed` list exists and doesn't match → **DENY**
 * 3. Otherwise → **ALLOW**
 *
 * This means:
 * - If only `allowed` is specified, everything else is blocked
 * - If only `blocked` is specified, everything else is allowed
 * - If both are specified, blocked takes precedence
 *
 * ## Pattern Matching
 *
 * Patterns support glob syntax via the `minimatch` library:
 *
 * | Pattern             | Matches                              |
 * |---------------------|--------------------------------------|
 * | `*`                 | Any single segment                   |
 * | `**`                | Any number of segments               |
 * | `*.md`              | Any file ending in .md               |
 * | `src/** (all .ts)`  | Any .ts file under src/              |
 *
 * ## Network Safety
 *
 * Network policies can block:
 * - Specific hosts by name or pattern
 * - Localhost (127.0.0.1, ::1)
 * - Private IP ranges (10.x, 172.16-31.x, 192.168.x)
 *
 * DNS resolution is performed to validate hosts before connection.
 *
 * ## Hot Reloading
 *
 * The policy file is watched for changes and automatically reloaded.
 * This enables policy updates without restarting active sessions.
 *
 * ## Error Handling
 *
 * Policy violations throw `PolicyError` which includes:
 * - The violated rule type (tool, model, path, network)
 * - A user-friendly error message
 * - Context about what was blocked
 *
 * @module safety/policy
 */

import {
	type FSWatcher,
	existsSync,
	lstatSync,
	readFileSync,
	watch,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { parse as parseTOML } from "smol-toml";
import type { ActionApprovalContext } from "../agent/action-approval.js";
import { PATHS } from "../config/constants.js";
import { extractDependencies } from "../utils/dependency-extractor.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { expandHomeDir, resolveRealPath } from "../utils/path-matcher.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import { dangerousPatterns as shellDangerousPatterns } from "./bash-safety-analyzer.js";
import { checkModelAccess } from "./validators/model-policy-validator.js";
import { checkNetworkPolicy } from "./validators/network-policy-validator.js";
import {
	checkPathPolicy,
	extractPolicyFilePaths,
} from "./validators/path-policy-validator.js";

const logger = createLogger("safety:policy");

/**
 * Enterprise policy configuration interface.
 *
 * Defines all available policy controls that organizations can configure
 * to restrict agent behavior according to their security requirements.
 */
export interface EnterprisePolicy {
	/** Organization identifier for audit logging and policy association */
	orgId?: string;

	/** Tool execution restrictions (e.g., block Bash, allow only Read) */
	tools?: {
		/** Whitelist of allowed tool names (glob patterns supported) */
		allowed?: string[];
		/** Blacklist of blocked tool names (takes precedence over allowed) */
		blocked?: string[];
	};

	/** Package/dependency installation restrictions */
	dependencies?: {
		/** Whitelist of allowed package patterns */
		allowed?: string[];
		/** Blacklist of blocked package patterns */
		blocked?: string[];
	};

	/** Model access restrictions (format: "provider/model-id") */
	models?: {
		/** Whitelist of allowed model patterns (e.g., "anthropic/*") */
		allowed?: string[];
		/** Blacklist of blocked model patterns */
		blocked?: string[];
	};

	/** Required skill names for workspace-controlled workflows */
	skills?: {
		/** Skills that must be available for this workspace */
		required?: string[];
	};

	/** File system path restrictions */
	paths?: {
		/** Whitelist of allowed path patterns (e.g., "/home/user/projects/**") */
		allowed?: string[];
		/** Blacklist of blocked path patterns (e.g., "/etc/**") */
		blocked?: string[];
	};

	/** Network access restrictions */
	network?: {
		/** Whitelist of allowed hostnames (e.g., "api.github.com") */
		allowedHosts?: string[];
		/** Blacklist of blocked hostnames (e.g., "*.internal.corp") */
		blockedHosts?: string[];
		/** Block access to localhost (127.0.0.1, ::1) */
		blockLocalhost?: boolean;
		/** Block access to private IP ranges (10.x, 172.16-31.x, 192.168.x) */
		blockPrivateIPs?: boolean;
	};

	/**
	 * Session limits for resource control.
	 *
	 * NOTE: These are schema definitions for policy configuration.
	 * Actual enforcement requires integration with the billing/token-tracker system.
	 * Currently exposed via getPolicyLimits() for consumers that want to implement limits.
	 */
	limits?: {
		/** Maximum tokens per session before termination */
		maxTokensPerSession?: number;
		/** Maximum session duration in minutes */
		maxSessionDurationMinutes?: number;
		/** Maximum concurrent active sessions */
		maxConcurrentSessions?: number;
	};
}

const PolicySchema = Type.Object({
	orgId: Type.Optional(Type.String()),
	tools: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	dependencies: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	models: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	skills: Type.Optional(
		Type.Object({
			required: Type.Optional(Type.Array(Type.String())),
		}),
	),
	paths: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	network: Type.Optional(
		Type.Object({
			allowedHosts: Type.Optional(Type.Array(Type.String())),
			blockedHosts: Type.Optional(Type.Array(Type.String())),
			blockLocalhost: Type.Optional(Type.Boolean()),
			blockPrivateIPs: Type.Optional(Type.Boolean()),
		}),
	),
	limits: Type.Optional(
		Type.Object({
			maxTokensPerSession: Type.Optional(Type.Number()),
			maxSessionDurationMinutes: Type.Optional(Type.Number()),
			maxConcurrentSessions: Type.Optional(Type.Number()),
		}),
	),
});

const validatePolicy = compileTypeboxSchema(PolicySchema);

type PolicyFormat = "json" | "toml";
type PolicyScope = "user" | "workspace";
type UnknownRecord = Record<string, unknown>;

interface PolicySource {
	path: string;
	format: PolicyFormat;
	scope: PolicyScope;
}

const getUserPolicyPath = (): string => join(PATHS.MAESTRO_HOME, "policy.json");
const isPolicyFile = (path: string): boolean => {
	if (!existsSync(path)) return false;
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
};

const getWorkspacePolicyPath = (): string | null => {
	let current = resolve(process.cwd());
	while (true) {
		const candidate = join(current, ".maestro", "workspace.toml");
		if (isPolicyFile(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
};

let cachedPolicy: EnterprisePolicy | null = null;
let cachedPolicyKey: string | null = null;
let cachedPolicyLayers: EnterprisePolicy[] = [];
let policyWatchers: FSWatcher[] = [];

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPolicySources(): PolicySource[] {
	const sources: PolicySource[] = [];
	const userPolicyPath = getUserPolicyPath();
	if (isPolicyFile(userPolicyPath)) {
		sources.push({ path: userPolicyPath, format: "json", scope: "user" });
	}

	const workspacePolicyPath = getWorkspacePolicyPath();
	if (workspacePolicyPath) {
		sources.push({
			path: workspacePolicyPath,
			format: "toml",
			scope: "workspace",
		});
	}
	return sources;
}

function getPolicyCacheKey(sources: PolicySource[]): string {
	return sources
		.map((source) => `${source.scope}:${source.format}:${source.path}`)
		.join("|");
}

function closePolicyWatchers() {
	for (const watcher of policyWatchers) {
		watcher.close();
	}
	policyWatchers = [];
}

function startPolicyWatchers(sources: PolicySource[]) {
	if (policyWatchers.length > 0) return;

	for (const source of sources) {
		try {
			// Only watch if the file exists
			if (!isPolicyFile(source.path)) continue;

			const watcher = watch(source.path, (eventType) => {
				if (eventType === "rename") {
					// File deleted or renamed
					cachedPolicy = null;
					cachedPolicyKey = null;
					if (!isPolicyFile(source.path)) {
						closePolicyWatchers();
					}
				} else if (eventType === "change") {
					// File modified - invalidate cache so next loadPolicy() reloads
					// We don't proactively reload here to avoid race conditions with partial writes
					cachedPolicy = null;
					cachedPolicyKey = null;
				}
			});
			// Prevent the watcher from keeping the process alive
			watcher.unref();
			policyWatchers.push(watcher);
		} catch (error) {
			// Ignore watcher errors (e.g. system limit reached)
			// We fall back to standard caching behavior
		}
	}
}

function readStringArray(
	source: UnknownRecord,
	key: string,
): string[] | undefined {
	if (!(key in source)) return undefined;

	const value = source[key];
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	) {
		throw new Error(
			`Workspace policy key "${key}" must be an array of strings`,
		);
	}
	return value;
}

function readOptionalString(
	source: UnknownRecord,
	key: string,
): string | undefined {
	if (!(key in source)) return undefined;

	const value = source[key];
	if (typeof value !== "string") {
		throw new Error(`Workspace policy key "${key}" must be a string`);
	}
	return value;
}

function readOptionalNumber(
	source: UnknownRecord,
	key: string,
): number | undefined {
	if (!(key in source)) return undefined;

	const value = source[key];
	if (typeof value !== "number") {
		throw new Error(`Workspace policy key "${key}" must be a number`);
	}
	return value;
}

function readOptionalBoolean(
	source: UnknownRecord,
	key: string,
): boolean | undefined {
	if (!(key in source)) return undefined;

	const value = source[key];
	if (typeof value !== "boolean") {
		throw new Error(`Workspace policy key "${key}" must be a boolean`);
	}
	return value;
}

function readOptionalRecord(
	source: UnknownRecord,
	key: string,
): UnknownRecord | undefined {
	if (!(key in source)) return undefined;

	const value = source[key];
	if (!isRecord(value)) {
		throw new Error(`Workspace policy key "${key}" must be a table`);
	}
	return value;
}

function selectWorkspacePolicyRoot(parsed: unknown): UnknownRecord {
	if (!isRecord(parsed)) {
		throw new Error("Workspace policy must be a TOML table");
	}

	const nestedPolicy = parsed.policy;
	if (nestedPolicy === undefined) {
		return parsed;
	}
	if (!isRecord(nestedPolicy)) {
		throw new Error('Workspace policy key "policy" must be a table');
	}
	return nestedPolicy;
}

function getWorkspaceStringArray(
	source: UnknownRecord,
	tableName: string,
	tableKey: string,
	flatKey: string,
): string[] | undefined {
	const flatValue = readStringArray(source, flatKey);
	if (flatValue !== undefined) return flatValue;

	const table = readOptionalRecord(source, tableName);
	return table ? readStringArray(table, tableKey) : undefined;
}

function mapWorkspacePolicy(parsed: unknown): EnterprisePolicy {
	const source = selectWorkspacePolicyRoot(parsed);
	const policy: EnterprisePolicy = {};

	const orgId = readOptionalString(source, "org_id");
	if (orgId !== undefined) {
		policy.orgId = orgId;
	}

	const allowedTools = getWorkspaceStringArray(
		source,
		"tools",
		"allowed",
		"allowed_tools",
	);
	const blockedTools = getWorkspaceStringArray(
		source,
		"tools",
		"blocked",
		"blocked_tools",
	);
	if (allowedTools !== undefined || blockedTools !== undefined) {
		policy.tools = {
			...(allowedTools !== undefined ? { allowed: allowedTools } : {}),
			...(blockedTools !== undefined ? { blocked: blockedTools } : {}),
		};
	}

	const allowedModels = getWorkspaceStringArray(
		source,
		"models",
		"allowed",
		"allowed_models",
	);
	const blockedModels = getWorkspaceStringArray(
		source,
		"models",
		"blocked",
		"blocked_models",
	);
	if (allowedModels !== undefined || blockedModels !== undefined) {
		policy.models = {
			...(allowedModels !== undefined ? { allowed: allowedModels } : {}),
			...(blockedModels !== undefined ? { blocked: blockedModels } : {}),
		};
	}

	const fileBoundaries = getWorkspaceStringArray(
		source,
		"paths",
		"allowed",
		"file_boundaries",
	);
	const blockedPaths = getWorkspaceStringArray(
		source,
		"paths",
		"blocked",
		"blocked_paths",
	);
	if (fileBoundaries !== undefined || blockedPaths !== undefined) {
		policy.paths = {
			...(fileBoundaries !== undefined ? { allowed: fileBoundaries } : {}),
			...(blockedPaths !== undefined ? { blocked: blockedPaths } : {}),
		};
	}

	const allowedDependencies = getWorkspaceStringArray(
		source,
		"dependencies",
		"allowed",
		"allowed_dependencies",
	);
	const blockedDependencies = getWorkspaceStringArray(
		source,
		"dependencies",
		"blocked",
		"blocked_dependencies",
	);
	if (allowedDependencies !== undefined || blockedDependencies !== undefined) {
		policy.dependencies = {
			...(allowedDependencies !== undefined
				? { allowed: allowedDependencies }
				: {}),
			...(blockedDependencies !== undefined
				? { blocked: blockedDependencies }
				: {}),
		};
	}

	const requiredSkills = getWorkspaceStringArray(
		source,
		"skills",
		"required",
		"required_skills",
	);
	if (requiredSkills !== undefined) {
		policy.skills = { required: requiredSkills };
	}

	const network = readOptionalRecord(source, "network");
	if (network) {
		const allowedHosts = readStringArray(network, "allowed_hosts");
		const blockedHosts = readStringArray(network, "blocked_hosts");
		const blockLocalhost = readOptionalBoolean(network, "block_localhost");
		const blockPrivateIPs = readOptionalBoolean(network, "block_private_ips");
		if (
			allowedHosts !== undefined ||
			blockedHosts !== undefined ||
			blockLocalhost !== undefined ||
			blockPrivateIPs !== undefined
		) {
			policy.network = {
				...(allowedHosts !== undefined ? { allowedHosts } : {}),
				...(blockedHosts !== undefined ? { blockedHosts } : {}),
				...(blockLocalhost !== undefined ? { blockLocalhost } : {}),
				...(blockPrivateIPs !== undefined ? { blockPrivateIPs } : {}),
			};
		}
	}

	const maxTokensPerSession = readOptionalNumber(
		source,
		"max_tokens_per_session",
	);
	const maxSessionDurationMinutes = readOptionalNumber(
		source,
		"max_session_duration_minutes",
	);
	const maxConcurrentSessions = readOptionalNumber(
		source,
		"max_concurrent_sessions",
	);
	if (
		maxTokensPerSession !== undefined ||
		maxSessionDurationMinutes !== undefined ||
		maxConcurrentSessions !== undefined
	) {
		policy.limits = {
			...(maxTokensPerSession !== undefined ? { maxTokensPerSession } : {}),
			...(maxSessionDurationMinutes !== undefined
				? { maxSessionDurationMinutes }
				: {}),
			...(maxConcurrentSessions !== undefined ? { maxConcurrentSessions } : {}),
		};
	}

	return policy;
}

function uniqueUnion(
	left: string[] | undefined,
	right: string[] | undefined,
): string[] | undefined {
	const values = [...(left ?? []), ...(right ?? [])];
	return values.length > 0 ? [...new Set(values)] : undefined;
}

function minPositiveNumber(
	left: number | undefined,
	right: number | undefined,
): number | undefined {
	const values = [left, right].filter(
		(value): value is number => value !== undefined && value > 0,
	);
	if (values.length === 0) {
		return left ?? right;
	}
	return Math.min(...values);
}

function mergeAllowedBlockedPolicy(
	userPolicy: { allowed?: string[]; blocked?: string[] } | undefined,
	workspacePolicy: { allowed?: string[]; blocked?: string[] } | undefined,
): { allowed?: string[]; blocked?: string[] } | undefined {
	const allowed = workspacePolicy?.allowed ?? userPolicy?.allowed;
	const blocked = uniqueUnion(userPolicy?.blocked, workspacePolicy?.blocked);
	if (allowed === undefined && blocked === undefined) return undefined;
	return {
		...(allowed !== undefined ? { allowed } : {}),
		...(blocked !== undefined ? { blocked } : {}),
	};
}

function mergeNetworkPolicy(
	userPolicy: EnterprisePolicy["network"],
	workspacePolicy: EnterprisePolicy["network"],
): EnterprisePolicy["network"] {
	const allowedHosts =
		workspacePolicy?.allowedHosts ?? userPolicy?.allowedHosts;
	const blockedHosts = uniqueUnion(
		userPolicy?.blockedHosts,
		workspacePolicy?.blockedHosts,
	);
	const blockLocalhost =
		userPolicy?.blockLocalhost === true ||
		workspacePolicy?.blockLocalhost === true;
	const blockPrivateIPs =
		userPolicy?.blockPrivateIPs === true ||
		workspacePolicy?.blockPrivateIPs === true;

	if (
		allowedHosts === undefined &&
		blockedHosts === undefined &&
		!blockLocalhost &&
		!blockPrivateIPs
	) {
		return undefined;
	}

	return {
		...(allowedHosts !== undefined ? { allowedHosts } : {}),
		...(blockedHosts !== undefined ? { blockedHosts } : {}),
		...(blockLocalhost ? { blockLocalhost } : {}),
		...(blockPrivateIPs ? { blockPrivateIPs } : {}),
	};
}

function mergePolicyLimits(
	userPolicy: EnterprisePolicy["limits"],
	workspacePolicy: EnterprisePolicy["limits"],
): EnterprisePolicy["limits"] {
	const maxTokensPerSession = minPositiveNumber(
		userPolicy?.maxTokensPerSession,
		workspacePolicy?.maxTokensPerSession,
	);
	const maxSessionDurationMinutes = minPositiveNumber(
		userPolicy?.maxSessionDurationMinutes,
		workspacePolicy?.maxSessionDurationMinutes,
	);
	const maxConcurrentSessions = minPositiveNumber(
		userPolicy?.maxConcurrentSessions,
		workspacePolicy?.maxConcurrentSessions,
	);

	if (
		maxTokensPerSession === undefined &&
		maxSessionDurationMinutes === undefined &&
		maxConcurrentSessions === undefined
	) {
		return undefined;
	}

	return {
		...(maxTokensPerSession !== undefined ? { maxTokensPerSession } : {}),
		...(maxSessionDurationMinutes !== undefined
			? { maxSessionDurationMinutes }
			: {}),
		...(maxConcurrentSessions !== undefined ? { maxConcurrentSessions } : {}),
	};
}

function mergePolicies(
	userPolicy: EnterprisePolicy | null,
	workspacePolicy: EnterprisePolicy | null,
): EnterprisePolicy | null {
	if (!userPolicy) return workspacePolicy;
	if (!workspacePolicy) return userPolicy;

	const policy: EnterprisePolicy = {
		...(userPolicy.orgId || workspacePolicy.orgId
			? { orgId: workspacePolicy.orgId ?? userPolicy.orgId }
			: {}),
	};

	const tools = mergeAllowedBlockedPolicy(
		userPolicy.tools,
		workspacePolicy.tools,
	);
	if (tools) policy.tools = tools;

	const dependencies = mergeAllowedBlockedPolicy(
		userPolicy.dependencies,
		workspacePolicy.dependencies,
	);
	if (dependencies) policy.dependencies = dependencies;

	const models = mergeAllowedBlockedPolicy(
		userPolicy.models,
		workspacePolicy.models,
	);
	if (models) policy.models = models;

	const paths = mergeAllowedBlockedPolicy(
		userPolicy.paths,
		workspacePolicy.paths,
	);
	if (paths) policy.paths = paths;

	const requiredSkills = uniqueUnion(
		userPolicy.skills?.required,
		workspacePolicy.skills?.required,
	);
	if (requiredSkills) {
		policy.skills = { required: requiredSkills };
	}

	const network = mergeNetworkPolicy(
		userPolicy.network,
		workspacePolicy.network,
	);
	if (network) policy.network = network;

	const limits = mergePolicyLimits(userPolicy.limits, workspacePolicy.limits);
	if (limits) policy.limits = limits;

	return policy;
}

function validateLoadedPolicy(policy: EnterprisePolicy, sourcePath: string) {
	if (!validatePolicy(policy)) {
		throw new Error(
			`Invalid schema in ${sourcePath}: ${validatePolicy.errors?.map((e) => e.message).join(", ")}`,
		);
	}
}

function loadPolicySource(source: PolicySource): EnterprisePolicy {
	const raw = readFileSync(source.path, "utf8");
	if (source.format === "json") {
		const result = safeJsonParse<EnterprisePolicy>(raw);
		if (!result.success) {
			throw new Error(
				`JSON parse error in ${source.path}: ${result.error.message}`,
			);
		}
		validateLoadedPolicy(result.data, source.path);
		return result.data;
	}

	const workspacePolicy = mapWorkspacePolicy(parseTOML(raw));
	validateLoadedPolicy(workspacePolicy, source.path);
	return workspacePolicy;
}

export function loadPolicy(force = false): EnterprisePolicy | null {
	const sources = getPolicySources();
	// Check if file exists first - if not, clear cache and return null
	if (sources.length === 0) {
		cachedPolicy = null;
		cachedPolicyKey = null;
		cachedPolicyLayers = [];
		closePolicyWatchers();
		return null;
	}

	const policyKey = getPolicyCacheKey(sources);
	if (cachedPolicy && cachedPolicyKey === policyKey && !force) {
		return cachedPolicy;
	}

	try {
		if (cachedPolicyKey !== policyKey) {
			closePolicyWatchers();
		}

		let userPolicy: EnterprisePolicy | null = null;
		let workspacePolicy: EnterprisePolicy | null = null;

		for (const source of sources) {
			const loadedPolicy = loadPolicySource(source);
			if (source.scope === "user") {
				userPolicy = loadedPolicy;
			} else {
				workspacePolicy = loadedPolicy;
			}
		}

		cachedPolicy = mergePolicies(userPolicy, workspacePolicy);
		cachedPolicyLayers = [userPolicy, workspacePolicy].filter(
			(policy): policy is EnterprisePolicy => policy !== null,
		);
		cachedPolicyKey = policyKey;
		startPolicyWatchers(sources);
		return cachedPolicy;
	} catch (error) {
		logger.error(
			"Critical: Failed to load enterprise policy",
			error instanceof Error ? error : new Error(String(error)),
		);
		// Throw to ensure we fail closed (block access) rather than treating as no policy
		throw error;
	}
}

function getArgsObject(
	context: ActionApprovalContext,
): Record<string, unknown> | null {
	return context.args && typeof context.args === "object"
		? (context.args as Record<string, unknown>)
		: null;
}

function getStringArg(
	context: ActionApprovalContext,
	key: string,
): string | null {
	const args = getArgsObject(context);
	if (!args) {
		return null;
	}
	const value = args[key];
	return typeof value === "string" ? value : null;
}

function getCommandArg(context: ActionApprovalContext): string | null {
	return getStringArg(context, "command");
}

function getEffectivePolicyLayers(
	policy: EnterprisePolicy,
): EnterprisePolicy[] {
	return cachedPolicyLayers.length > 0 ? cachedPolicyLayers : [policy];
}

function hasOwnKey(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function hasActiveDurationLimit(policy: EnterprisePolicy): boolean {
	const duration = policy.limits?.maxSessionDurationMinutes;
	return (
		typeof duration === "number" && Number.isFinite(duration) && duration > 0
	);
}

function validatePolicyContext(
	policy: EnterprisePolicy,
	context: ActionApprovalContext,
): { allowed: false; reason: string } | null {
	if (!isNonEmptyString(context.toolName)) {
		return {
			allowed: false,
			reason: "Policy evaluation context is missing required field: toolName.",
		};
	}

	if (!hasOwnKey(context, "args")) {
		return {
			allowed: false,
			reason: "Policy evaluation context is missing required field: args.",
		};
	}

	if (context.user) {
		if (!isNonEmptyString(context.user.orgId)) {
			return {
				allowed: false,
				reason:
					"Policy evaluation context has invalid user context: missing organization id.",
			};
		}
	}

	if (
		isNonEmptyString(policy.orgId) &&
		!isNonEmptyString(context.user?.orgId)
	) {
		return {
			allowed: false,
			reason:
				"Organization-bound policy requires user organization context. Access blocked.",
		};
	}

	if (hasActiveDurationLimit(policy)) {
		const startedAt = context.session?.startedAt;
		if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
			return {
				allowed: false,
				reason:
					"Session duration policy requires session start context. Access blocked.",
			};
		}
	}

	return null;
}

export async function checkPolicy(context: ActionApprovalContext): Promise<{
	allowed: boolean;
	reason?: string;
}> {
	let policy: EnterprisePolicy | null;
	try {
		policy = loadPolicy();
	} catch (error) {
		return {
			allowed: false,
			reason: `Enterprise policy error: ${error instanceof Error ? error.message : "Unknown error"}. Access blocked.`,
		};
	}

	if (!policy) {
		return { allowed: true };
	}

	for (const policyLayer of getEffectivePolicyLayers(policy)) {
		const result = await checkPolicyLayer(policyLayer, context);
		if (!result.allowed) {
			return result;
		}
	}

	return { allowed: true };
}

async function checkPolicyLayer(
	policy: EnterprisePolicy,
	context: ActionApprovalContext,
): Promise<{
	allowed: boolean;
	reason?: string;
}> {
	const contextValidation = validatePolicyContext(policy, context);
	if (contextValidation) {
		return contextValidation;
	}

	// 0. Organization Context Check
	if (
		policy.orgId &&
		context.user?.orgId &&
		policy.orgId !== context.user.orgId
	) {
		logger.warn("Org mismatch, action blocked", {
			policyOrgId: policy.orgId,
			userOrgId: context.user.orgId,
		});
		return {
			allowed: false,
			reason: `Organization mismatch: This machine is managed by ${policy.orgId}, but you are signed in to ${context.user.orgId}.`,
		};
	}

	// 1. Tool Constraints
	if (policy.tools) {
		const { allowed, blocked } = policy.tools;
		if (allowed && !allowed.includes(context.toolName)) {
			return {
				allowed: false,
				reason: `Tool "${context.toolName}" is not in the approved tools list.`,
			};
		}
		if (blocked?.includes(context.toolName)) {
			return {
				allowed: false,
				reason: `Tool "${context.toolName}" is explicitly blocked by enterprise policy.`,
			};
		}
	}

	// 2. Dangerous Patterns & Dependency Constraints
	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getCommandArg(context);
		if (command) {
			// Check for obfuscation and dangerous patterns
			const obfuscationPatterns = [
				shellDangerousPatterns.base64Decode,
				shellDangerousPatterns.opensslEnc,
				shellDangerousPatterns.pythonEval,
				shellDangerousPatterns.perlEval,
				shellDangerousPatterns.nodeEval,
				shellDangerousPatterns.phpEval,
				shellDangerousPatterns.rubyEval,
				shellDangerousPatterns.evalCall,
				shellDangerousPatterns.execCall,
			];
			for (const pattern of obfuscationPatterns) {
				if (pattern.test(command)) {
					return {
						allowed: false,
						reason:
							"Command contains obfuscated or dangerous patterns (e.g. base64 decoding, inline code execution) which are blocked by enterprise policy.",
					};
				}
			}

			if (policy.dependencies) {
				const deps = extractDependencies(command);

				// Check for shell metacharacters in any package install command,
				// even when no explicit package names are extracted (e.g., "npm install").
				// This prevents bypass via "npm install && rm -rf /"
				const isPackageInstallCommand =
					/(?:npm|yarn|pnpm|bun|pip|pip3|gem|cargo|go\s+get|composer)\s+(?:install|add|i\b)/i.test(
						command,
					);
				if (
					(deps.length > 0 || isPackageInstallCommand) &&
					/[;&|`$()<>]/.test(command)
				) {
					return {
						allowed: false,
						reason:
							"Command contains shell metacharacters which are not allowed by enterprise policy during package installation.",
					};
				}

				const { allowed, blocked } = policy.dependencies;

				for (const dep of deps) {
					if (allowed && !allowed.includes(dep)) {
						return {
							allowed: false,
							reason: `Dependency "${dep}" is not in the approved dependencies list.`,
						};
					}
					if (blocked?.includes(dep)) {
						return {
							allowed: false,
							reason: `Dependency "${dep}" is explicitly blocked by enterprise policy.`,
						};
					}
				}
			}
		}
	}

	// 3. Path Constraints
	if (policy.paths) {
		const filePaths = extractPolicyFilePaths(context);
		const pathCheck = checkPathPolicy(filePaths, policy.paths);
		if (!pathCheck.allowed) {
			return pathCheck;
		}
	}

	// 4. Network Constraints
	if (policy.network) {
		const networkCheck = await checkNetworkPolicy(context, policy.network);
		if (!networkCheck.allowed) {
			return networkCheck;
		}
	}

	// 5. Session Limits
	if (policy.limits && context.session) {
		const { maxSessionDurationMinutes } = policy.limits;
		if (maxSessionDurationMinutes && maxSessionDurationMinutes > 0) {
			const durationMinutes =
				(Date.now() - context.session.startedAt.getTime()) / 1000 / 60;
			if (durationMinutes > maxSessionDurationMinutes) {
				return {
					allowed: false,
					reason: `Session duration limit exceeded (${Math.floor(durationMinutes)}/${maxSessionDurationMinutes} minutes). Please start a new session.`,
				};
			}
		}
	}

	return { allowed: true };
}

export class PolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyError";
	}
}

/**
 * Check if a model is allowed by policy
 * Called separately from tool checks since model selection happens at a different time
 */
export function checkModelPolicy(modelId: string): {
	allowed: boolean;
	reason?: string;
} {
	let policy: EnterprisePolicy | null;
	try {
		policy = loadPolicy();
	} catch (error) {
		return {
			allowed: false,
			reason: `Enterprise policy error: ${error instanceof Error ? error.message : "Unknown error"}. Model blocked.`,
		};
	}

	if (!policy) {
		return { allowed: true };
	}

	for (const policyLayer of getEffectivePolicyLayers(policy)) {
		if (!policyLayer.models) {
			continue;
		}
		const result = checkModelAccess(modelId, policyLayer.models);
		if (!result.allowed) {
			return result;
		}
	}

	return { allowed: true };
}

/**
 * Check if the current session has exceeded policy limits
 */
export function checkSessionLimits(
	session: { startedAt: Date },
	usage?: { tokenCount?: number; activeSessionCount?: number },
): {
	allowed: boolean;
	reason?: string;
} {
	try {
		const limits = getPolicyLimits();
		if (!limits) return { allowed: true };

		// Check duration limit
		if (
			limits.maxSessionDurationMinutes &&
			limits.maxSessionDurationMinutes > 0
		) {
			const durationMinutes =
				(Date.now() - session.startedAt.getTime()) / 1000 / 60;
			if (durationMinutes > limits.maxSessionDurationMinutes) {
				return {
					allowed: false,
					reason: `Session duration limit exceeded (${Math.floor(durationMinutes)}/${limits.maxSessionDurationMinutes} minutes). Please start a new session.`,
				};
			}
		}

		// Check token limit
		if (limits.maxTokensPerSession && limits.maxTokensPerSession > 0) {
			if (usage?.tokenCount !== undefined) {
				if (usage.tokenCount > limits.maxTokensPerSession) {
					return {
						allowed: false,
						reason: `Session token limit exceeded (${usage.tokenCount}/${limits.maxTokensPerSession} tokens). Please start a new session.`,
					};
				}
			} else {
				// Usage undefined but limit is set - should we block?
				// To be safe (fail-closed) for strict limits, we probably should if we can't verify compliance.
				// However, if usage is undefined because metrics are disabled/failing, this might be too aggressive.
				// Given user feedback "Fail-Open Error Handling", we should warn or block.
				// Let's block if we can't verify usage against a set limit.
				return {
					allowed: false,
					reason: `Session token limit is active (${limits.maxTokensPerSession}) but token usage data is unavailable. Access blocked for safety.`,
				};
			}
		}

		// Check concurrent sessions limit
		if (limits.maxConcurrentSessions && limits.maxConcurrentSessions > 0) {
			if (usage?.activeSessionCount !== undefined) {
				if (usage.activeSessionCount > limits.maxConcurrentSessions) {
					return {
						allowed: false,
						reason: `Concurrent session limit exceeded (${usage.activeSessionCount}/${limits.maxConcurrentSessions}). Please close existing sessions before starting a new one.`,
					};
				}
			} else {
				// Same fail-closed logic for concurrent sessions
				return {
					allowed: false,
					reason: `Concurrent session limit is active (${limits.maxConcurrentSessions}) but session count data is unavailable. Access blocked for safety.`,
				};
			}
		}

		return { allowed: true };
	} catch (error) {
		return {
			allowed: false,
			reason: `Policy error checking session limits: ${error}`,
		};
	}
}

/**
 * Get the current policy limits
 */
export function getPolicyLimits(): EnterprisePolicy["limits"] | null {
	// Catch errors and return null (no limits) to prevent crashing callers.
	// Strict enforcement should rely on checkSessionLimits() which handles its own loading.
	try {
		const policy = loadPolicy();
		return policy?.limits ?? null;
	} catch {
		return null;
	}
}

/**
 * Get the full loaded policy (for admin UI display)
 */
export function getCurrentPolicy(): EnterprisePolicy | null {
	try {
		return loadPolicy();
	} catch {
		return null;
	}
}
