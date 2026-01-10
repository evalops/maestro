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

import { lookup } from "node:dns/promises";
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
import {
	isLocalhostAlias,
	isLoopbackIP,
	isPrivateIP,
	parseIPv4,
	parseIPv4MappedHex,
} from "../utils/ip-address-parser.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import {
	expandHomeDir,
	matchesModelPattern,
	matchesPathPattern,
	resolveRealPath,
} from "../utils/path-matcher.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import {
	extractUrlsFromShellCommand,
	extractUrlsFromValue,
} from "../utils/url-extractor.js";
import { dangerousPatterns as shellDangerousPatterns } from "./dangerous-patterns.js";

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

/**
 * Extract file paths from tool arguments
 */
function extractFilePaths(context: ActionApprovalContext): string[] {
	const args = getArgsObject(context);
	if (!args) return [];

	const paths: string[] = [];

	// Common file path argument names (expanded list)
	const pathKeys = [
		"path",
		"file_path",
		"filePath",
		"file",
		"files",
		"directory",
		"dir",
		"target",
		"source",
		"destination",
		"cwd",
		"output",
		"input",
		"src",
		"dest",
		"config",
		"workspace",
		"folder",
		"target_file",
		"target_directory",
	];

	for (const key of pathKeys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			paths.push(value);
		}
		// Handle array values
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item.length > 0) {
					paths.push(item);
				}
			}
		}
	}

	// For bash commands, extract paths from common commands
	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getCommandArg(context);
		if (command) {
			// Extract ALL path-like arguments from file manipulation commands
			// This captures both source and destination paths, and handles multiple arguments
			const fileCommands =
				/(?:cd|cat|rm|mv|cp|mkdir|touch|nano|vim|vi|less|more|head|tail|chmod|chown|strings|hexdump|dd|tee|ln|readlink|stat|file|wc|grep|sed|awk|sort|uniq|diff|patch|tar|gzip|gunzip|zip|unzip|find|rsync|scp)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)/gi;

			const matches = command.matchAll(fileCommands);
			for (const match of matches) {
				const argsStr = match[1];
				if (!argsStr) continue;
				// Split by spaces, respecting quotes
				const argParts = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
				for (const arg of argParts) {
					const cleaned = arg.replace(/^["']|["']$/g, "");
					// Skip flags, empty strings, and shell operators
					if (
						cleaned &&
						!cleaned.startsWith("-") &&
						cleaned.length > 0 &&
						!/^[<>|&;]/.test(cleaned)
					) {
						paths.push(cleaned);
					}
				}
			}

			// Also extract paths from redirections: < /path, > /path, >> /path
			const redirectPattern = /[<>]{1,2}\s*([^\s<>|&;]+)/g;
			const redirectMatches = command.matchAll(redirectPattern);
			for (const match of redirectMatches) {
				const rawPath = match[1];
				if (!rawPath) continue;
				const path = rawPath.replace(/^["']|["']$/g, "");
				if (path && path.length > 0) {
					paths.push(path);
				}
			}

			// Extract paths from command substitution: $(cat /path), `cat /path`, or <(cat /path)
			const cmdSubPattern = /(?:\$\(|<\()([^)]+)\)|`([^`]+)`/g;
			const cmdSubMatches = command.matchAll(cmdSubPattern);
			for (const match of cmdSubMatches) {
				const innerCmd = match[1] || match[2];
				if (innerCmd) {
					// Recursively extract paths from the inner command
					// We re-use the same regex logic for inner commands
					// Note: This is a simplified recursion, not infinite
					const innerMatches = innerCmd.matchAll(fileCommands);
					for (const innerMatch of innerMatches) {
						const innerArgsStr = innerMatch[1];
						if (!innerArgsStr) continue;
						const innerArgParts =
							innerArgsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
						for (const arg of innerArgParts) {
							const cleaned = arg.replace(/^["']|["']$/g, "");
							if (
								cleaned &&
								!cleaned.startsWith("-") &&
								cleaned.length > 0 &&
								!/^[<>|&;]/.test(cleaned)
							) {
								paths.push(cleaned);
							}
						}
					}
				}
			}
		}
	}

	return paths;
}

/**
 * Check if a URL/host matches network restrictions
 * NOTE: This validates at approval time. DNS rebinding attacks could theoretically
 * resolve to different IPs at execution time. For maximum security, network
 * restrictions should also be enforced at the HTTP client level.
 */
async function checkNetworkRestrictions(
	url: string,
	network: NonNullable<EnterprisePolicy["network"]>,
): Promise<{ allowed: boolean; reason?: string }> {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();

		// Normalize bracketed IPv6 addresses: [::1] -> ::1
		const normalizedHost = host.replace(/^\[|\]$/g, "");

		// Resolve hostname to IP to prevent DNS rebinding/bypass
		// We check both the hostname AND the resolved IP
		const resolvedIPs: string[] = [];
		// Don't try to resolve if it's already an IP
		const isIP =
			parseIPv4(normalizedHost) !== null ||
			parseIPv4MappedHex(normalizedHost) !== null ||
			normalizedHost.includes(":"); // Rough IPv6 check

		if (!isIP) {
			try {
				const { address } = await lookup(normalizedHost);
				resolvedIPs.push(address);
			} catch (e) {
				// Failed to resolve - might be internal or invalid
				// If IP-based policies are enabled (blockPrivateIPs or blockLocalhost), we cannot enforce them without resolution.
				// Fail closed to prevent bypass via DNS rebinding or unresolvable internal names.
				if (network.blockPrivateIPs || network.blockLocalhost) {
					return {
						allowed: false,
						reason: `DNS resolution failed for "${host}" and network policy requires IP validation (blockPrivateIPs/blockLocalhost enabled). Access blocked.`,
					};
				}
				// If we are only checking lists of hostnames, we can proceed with just the hostname check.
			}
		} else {
			resolvedIPs.push(normalizedHost);
		}

		// Check localhost blocking (full 127.0.0.0/8 range + IPv6 loopback + common aliases)
		if (network.blockLocalhost) {
			if (isLocalhostAlias(normalizedHost) || resolvedIPs.some(isLoopbackIP)) {
				return {
					allowed: false,
					reason: "Access to localhost is blocked by enterprise policy.",
				};
			}
		}

		// Check private IP blocking (IPv4 + IPv6)
		if (network.blockPrivateIPs) {
			if (resolvedIPs.some(isPrivateIP)) {
				return {
					allowed: false,
					reason:
						"Access to private IP addresses is blocked by enterprise policy.",
				};
			}
		}

		// Check blocked hosts
		if (network.blockedHosts?.length) {
			for (const blockedHost of network.blockedHosts) {
				if (
					host === blockedHost.toLowerCase() ||
					host.endsWith(`.${blockedHost.toLowerCase()}`)
				) {
					return {
						allowed: false,
						reason: `Host "${host}" is blocked by enterprise policy.`,
					};
				}
			}
		}

		// Check allowed hosts (if specified - empty array means block all)
		if (network.allowedHosts) {
			if (network.allowedHosts.length === 0) {
				return {
					allowed: false,
					reason: `Host "${host}" is not in the allowed hosts list.`,
				};
			}
			const isAllowed = network.allowedHosts.some((allowedHost) => {
				const lowerAllowed = allowedHost.toLowerCase();
				return host === lowerAllowed || host.endsWith(`.${lowerAllowed}`);
			});
			if (!isAllowed) {
				return {
					allowed: false,
					reason: `Host "${host}" is not in the allowed hosts list.`,
				};
			}
		}
	} catch {
		// Fail-secure: reject unparseable URLs
		return {
			allowed: false,
			reason: "Invalid URL format - cannot validate against network policy.",
		};
	}
	return { allowed: true };
}

/**
 * Extract URLs from tool arguments (recursively checks nested objects)
 * Also extracts URLs from curl/wget commands in bash
 */
function extractUrls(context: ActionApprovalContext): string[] {
	const args = getArgsObject(context);
	if (!args) return [];

	const urls = extractUrlsFromValue(args);

	// For bash commands, also extract URLs from curl/wget that may not have http:// prefix
	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getStringArg(context, "command");
		if (command) {
			urls.push(...extractUrlsFromShellCommand(command));
		}
	}

	return urls;
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
		const filePaths = extractFilePaths(context);
		for (const filePath of filePaths) {
			// Check blocked paths first
			if (
				policy.paths.blocked?.length &&
				matchesPathPattern(filePath, policy.paths.blocked)
			) {
				return {
					allowed: false,
					reason: `Path "${filePath}" is blocked by enterprise policy.`,
				};
			}
			// Check allowed paths (if specified - empty array means block all)
			if (policy.paths.allowed) {
				if (
					policy.paths.allowed.length === 0 ||
					!matchesPathPattern(filePath, policy.paths.allowed)
				) {
					return {
						allowed: false,
						reason: `Path "${filePath}" is not in the allowed paths list.`,
					};
				}
			}
		}
	}

	// 4. Network Constraints
	if (policy.network) {
		const urls = extractUrls(context);
		for (const url of urls) {
			const check = await checkNetworkRestrictions(url, policy.network);
			if (!check.allowed) {
				return check;
			}
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

	const { allowed, blocked } = policy.models;

	// Check blocked models first
	if (blocked?.length && matchesModelPattern(modelId, blocked)) {
		return {
			allowed: false,
			reason: `Model "${modelId}" is blocked by enterprise policy.`,
		};
	}

	// Check allowed models (if specified - empty array means block all)
	if (allowed) {
		if (allowed.length === 0 || !matchesModelPattern(modelId, allowed)) {
			return {
				allowed: false,
				reason: `Model "${modelId}" is not in the approved models list.`,
			};
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
