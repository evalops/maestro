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
	realpathSync,
	watch,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { minimatch } from "minimatch";
import type { ActionApprovalContext } from "../agent/action-approval.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

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

const POLICY_PATH = join(homedir(), ".composer", "policy.json");

let cachedPolicy: EnterprisePolicy | null = null;
let policyWatcher: FSWatcher | undefined;

function startPolicyWatcher() {
	if (policyWatcher) return;

	try {
		// Only watch if the file exists
		if (!existsSync(POLICY_PATH)) return;

		policyWatcher = watch(POLICY_PATH, (eventType) => {
			if (eventType === "rename") {
				// File deleted or renamed
				cachedPolicy = null;
				if (!existsSync(POLICY_PATH)) {
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
	// Check if file exists first - if not, clear cache and return null
	if (!existsSync(POLICY_PATH)) {
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
		const raw = readFileSync(POLICY_PATH, "utf8");
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

// Regex to catch npm install, pip install, bun add, etc.
// Captures the package names. Added ':' to capture URLs.
const npmInstallPattern =
	/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s]+)/i;
const bunAddPattern =
	/\bbun\s+(?:add|install)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s]+)/i;
const pipInstallPattern =
	/\bpip\d*\s+install\s+(?:-[a-zA-Z-]+\s+)*([\w@\-/.:\s=<>]+)/i;

function extractDependencies(command: string): string[] {
	const patterns = [npmInstallPattern, bunAddPattern, pipInstallPattern];
	const results: string[] = [];

	for (const pattern of patterns) {
		const matches = command.matchAll(new RegExp(pattern, "gi"));
		for (const match of matches) {
			// Split by spaces and cleanup flags/versions
			const deps = match[1]
				.split(/\s+/)
				.filter((p) => !p.startsWith("-"))
				.map((p) => {
					// Handle URLs (git+, http:, etc.) and local paths
					if (p.includes("://") || p.match(/^git@/) || p.match(/^\.{0,2}\//)) {
						return p;
					}

					// Handle scoped packages (e.g. @scope/pkg)
					if (p.startsWith("@")) {
						const versionIndex = p.indexOf("@", 1);
						return versionIndex === -1 ? p : p.substring(0, versionIndex);
					}
					// Handle standard packages (e.g. pkg@1.0.0, pkg==1.0.0)
					return p.split(/[@=<>]/)[0];
				}) // simple cleanup
				.filter((p) => p.length > 0);
			results.push(...deps);
		}
	}
	return results;
}

/**
 * Expand ~ to user's home directory
 */
function expandHomeDir(filePath: string): string {
	if (filePath === "~" || filePath.startsWith("~/")) {
		return join(homedir(), filePath.slice(1));
	}
	return filePath;
}

/**
 * Resolve a path to its real location, following symlinks
 * Returns the resolved path, or the original if resolution fails
 */
function resolveRealPath(filePath: string): string {
	try {
		const expanded = expandHomeDir(filePath);
		const resolved = resolve(expanded);
		// Check if path exists and resolve symlinks
		if (existsSync(resolved)) {
			return realpathSync(resolved);
		}
		// For non-existent paths, resolve parent directory symlinks if possible
		const parentDir = resolve(expanded, "..");
		if (existsSync(parentDir)) {
			const realParent = realpathSync(parentDir);
			const basename = resolve(expanded).split("/").pop() || "";
			return join(realParent, basename);
		}
		return resolved;
	} catch {
		return resolve(expandHomeDir(filePath));
	}
}

/**
 * Check if a path matches any pattern in a list using glob syntax
 * SECURITY:
 * - matchBase is disabled to prevent patterns like "*.txt" from matching anywhere
 * - Symlinks are resolved to prevent bypasses via symbolic links
 * - Both original and resolved paths are checked for defense in depth
 */
function matchesPathPattern(filePath: string, patterns: string[]): boolean {
	const expandedPath = expandHomeDir(filePath);
	const normalizedPath = resolve(expandedPath);
	// Also check the real path (symlinks resolved) for security
	const realPath = resolveRealPath(filePath);

	for (const pattern of patterns) {
		// Resolve pattern to absolute path for consistent matching, unless it's a glob
		const expandedPattern = expandHomeDir(pattern);
		// If pattern contains glob characters, do not resolve (avoids pinning to CWD)
		// If pattern is relative and NOT a glob, resolve it to absolute CWD-based path
		const isGlob = /[*?{\[]/.test(expandedPattern);
		const resolvedPattern = isGlob ? expandedPattern : resolve(expandedPattern);

		// Check both the original path and the symlink-resolved path
		for (const pathToCheck of [normalizedPath, realPath]) {
			// Use minimatch for glob patterns (**, *, ?)
			// IMPORTANT: matchBase: false ensures patterns must match from root
			if (minimatch(pathToCheck, resolvedPattern, { dot: true })) {
				return true;
			}

			// For directory patterns without globs, check proper hierarchy (with separator)
			// This handles cases like "/home/user" matching "/home/user/file.txt"
			if (
				!pattern.includes("*") &&
				!pattern.includes("?") &&
				(pathToCheck === resolvedPattern ||
					pathToCheck.startsWith(`${resolvedPattern}/`))
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Check if a model ID matches any pattern (supports wildcards)
 * Uses minimatch for safe, consistent glob matching (avoids ReDoS)
 */
function matchesModelPattern(modelId: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (minimatch(modelId, pattern, { nocase: true, dot: true })) {
			return true;
		}
	}
	return false;
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
				const path = match[1].replace(/^["']|["']$/g, "");
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
 * Parse an IPv4 address and validate octets are in range 0-255
 * Returns the octets array if valid, null otherwise
 */
function parseIPv4(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;

	const octets: number[] = [];
	for (const part of parts) {
		const num = Number.parseInt(part, 10);
		if (Number.isNaN(num) || num < 0 || num > 255 || String(num) !== part) {
			return null; // Invalid octet or leading zeros
		}
		octets.push(num);
	}
	return octets;
}

/**
 * Check if an IPv4 address is in the localhost range (127.0.0.0/8)
 */
function isLoopbackIPv4(octets: number[]): boolean {
	return octets[0] === 127;
}

/**
 * Check if an IPv4 address is in a private range
 */
function isPrivateIPv4(octets: number[]): boolean {
	const [a, b] = octets;
	return (
		a === 10 || // 10.0.0.0/8
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
		(a === 192 && b === 168) || // 192.168.0.0/16
		(a === 169 && b === 254) || // 169.254.0.0/16 link-local
		(a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
	);
}

/**
 * Parse an IPv4-mapped IPv6 address in hex format (e.g., ::ffff:c0a8:101)
 * Returns the IPv4 octets if valid, null otherwise
 */
function parseIPv4MappedHex(host: string): number[] | null {
	// Match ::ffff:XXXX:XXXX format (hex representation of IPv4)
	const match = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!match) return null;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);

	if (Number.isNaN(high) || Number.isNaN(low)) return null;

	// Convert to octets: high = (octet1 << 8) | octet2, low = (octet3 << 8) | octet4
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
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

		// Helper to check if an IP is blocked
		const isIpBlocked = (ip: string): boolean => {
			// Check IPv4 localhost
			const ipv4Octets = parseIPv4(ip);
			if (ipv4Octets && isLoopbackIPv4(ipv4Octets)) return true;

			// Check IPv4-mapped localhost
			const mappedHexOctets = parseIPv4MappedHex(ip);
			if (mappedHexOctets && isLoopbackIPv4(mappedHexOctets)) return true;

			// Check IPv6/aliases
			if (
				ip === "::1" ||
				/^0*:0*:0*:0*:0*:0*:0*:0*1$/i.test(ip) ||
				/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(ip)
			)
				return true;

			return false;
		};

		// Helper to check if an IP is private
		const isIpPrivate = (ip: string): boolean => {
			const ipv4Octets = parseIPv4(ip);
			if (ipv4Octets && isPrivateIPv4(ipv4Octets)) return true;

			const mappedHexOctets = parseIPv4MappedHex(ip);
			if (mappedHexOctets && isPrivateIPv4(mappedHexOctets)) return true;

			// Check IPv6 private
			if (
				/^fe80:/i.test(ip) ||
				/^fc[0-9a-f]{2}:/i.test(ip) ||
				/^fd[0-9a-f]{0,2}:/i.test(ip) ||
				/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(ip)
			) {
				if (ip.startsWith("::ffff:")) {
					// Extract embedded IPv4 and check
					const match = ip.match(
						/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
					);
					if (match) {
						const embeddedOctets = parseIPv4(match[1]);
						if (embeddedOctets && isPrivateIPv4(embeddedOctets)) return true;
					}
				} else {
					return true;
				}
			}
			return false;
		};

		// Check localhost blocking (full 127.0.0.0/8 range + IPv6 loopback + common aliases)
		if (network.blockLocalhost) {
			// Check hostname aliases
			const isLocalhostAlias =
				normalizedHost === "localhost" ||
				normalizedHost === "localhost.localdomain" ||
				normalizedHost === "0.0.0.0";

			if (isLocalhostAlias || resolvedIPs.some(isIpBlocked)) {
				return {
					allowed: false,
					reason: "Access to localhost is blocked by enterprise policy.",
				};
			}
		}

		// Check private IP blocking (IPv4 + IPv6)
		if (network.blockPrivateIPs) {
			if (resolvedIPs.some(isIpPrivate)) {
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

	const urls: string[] = [];
	const urlPattern = /https?:\/\/[^\s"'<>]+/gi;

	// Recursively extract URLs from any value
	function extractFromValue(value: unknown): void {
		if (typeof value === "string") {
			const matches = value.match(urlPattern);
			if (matches) {
				// Trim common trailing punctuation that gets captured
				for (const match of matches) {
					urls.push(match.replace(/[)}\],.;:]+$/, ""));
				}
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				extractFromValue(item);
			}
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) {
				extractFromValue(v);
			}
		}
	}

	extractFromValue(args);

	// For bash commands, also extract URLs from curl/wget that may not have http:// prefix
	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getStringArg(context, "command");
		if (command) {
			// Extract URLs from curl/wget commands (may not have http prefix)
			// Capture all arguments to handle flags interspersed with URLs
			const curlWgetPattern =
				/(?:curl|wget)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)/gi;
			const matches = command.matchAll(curlWgetPattern);
			for (const match of matches) {
				const argsStr = match[1];
				// Split by spaces, respecting quotes
				const argParts = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

				for (const arg of argParts) {
					let url = arg.replace(/^["']|["']$/g, ""); // strip quotes

					// Skip flags
					if (url.startsWith("-")) continue;

					// Add http:// if no protocol specified
					if (url && !url.match(/^https?:\/\//i)) {
						url = `http://${url}`;
					}
					if (url) {
						urls.push(url.replace(/[)}\],.;:]+$/, ""));
					}
				}
			}
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
			const dangerousPatterns = [
				/base64\s+-d/i,
				/openssl\s+enc/i,
				/python\s+-c/i,
				/perl\s+-e/i,
				/node\s+-e/i,
				/php\s+-r/i,
				/ruby\s+-e/i,
				/eval\s*\(+/i,
				/exec\s*\(+/i,
			];
			for (const pattern of dangerousPatterns) {
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
				if (deps.length > 0 && /[;&|`$()<>]/.test(command)) {
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
