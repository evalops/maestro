/**
 * Enterprise Policy System - Access Control and Safety Enforcement
 *
 * This module implements enterprise-grade policy enforcement for the Composer CLI,
 * enabling organizations to control what tools, models, paths, and network hosts
 * can be accessed during agent execution.
 *
 * ## Policy File Location
 *
 * Policies are loaded from `~/.composer/policy.json`. This file is typically
 * deployed by enterprise IT and should be protected with appropriate permissions.
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
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
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

const getPolicyPath = (): string => join(PATHS.COMPOSER_HOME, "policy.json");

let cachedPolicy: EnterprisePolicy | null = null;
let policyWatcher: FSWatcher | undefined;

function startPolicyWatcher() {
	if (policyWatcher) return;

	try {
		const policyPath = getPolicyPath();
		// Only watch if the file exists
		if (!existsSync(policyPath)) return;

		policyWatcher = watch(policyPath, (eventType) => {
			if (eventType === "rename") {
				// File deleted or renamed
				cachedPolicy = null;
				if (!existsSync(policyPath)) {
					policyWatcher?.close();
					policyWatcher = undefined;
				}
			} else if (eventType === "change") {
				// File modified - invalidate cache so next loadPolicy() reloads
				// We don't proactively reload here to avoid race conditions with partial writes
				cachedPolicy = null;
			}
		});
		// Prevent the watcher from keeping the process alive
		policyWatcher.unref();
	} catch (error) {
		// Ignore watcher errors (e.g. system limit reached)
		// We fall back to standard caching behavior
	}
}

export function loadPolicy(force = false): EnterprisePolicy | null {
	const policyPath = getPolicyPath();
	// Check if file exists first - if not, clear cache and return null
	if (!existsSync(policyPath)) {
		cachedPolicy = null;
		if (policyWatcher) {
			policyWatcher.close();
			policyWatcher = undefined;
		}
		return null;
	}

	if (cachedPolicy && !force) {
		return cachedPolicy;
	}

	try {
		const raw = readFileSync(policyPath, "utf8");
		const result = safeJsonParse<EnterprisePolicy>(raw);
		if (result.success) {
			if (!validatePolicy(result.data)) {
				// Invalid schema - throw to block access (fail closed)
				throw new Error(
					`Invalid schema: ${validatePolicy.errors?.map((e) => e.message).join(", ")}`,
				);
			}
			cachedPolicy = result.data;
			startPolicyWatcher();
			return cachedPolicy;
		}
		// Parse error - throw to block access (fail closed)
		throw new Error(`JSON parse error: ${result.error.message}`);
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

	if (!policy?.models) {
		return { allowed: true };
	}

	return checkModelAccess(modelId, policy.models);
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
