import { type FSWatcher, existsSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ActionApprovalContext } from "../agent/action-approval.js";
import { safeJsonParse } from "../utils/json.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

export interface EnterprisePolicy {
	orgId?: string;
	tools?: {
		allowed?: string[];
		blocked?: string[];
	};
	dependencies?: {
		allowed?: string[];
		blocked?: string[];
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
				console.warn(
					"Invalid enterprise policy schema:",
					validatePolicy.errors,
				);
				cachedPolicy = null;
				return null;
			}
			cachedPolicy = result.data;
			startPolicyWatcher();
			return cachedPolicy;
		}
		console.warn("Failed to load enterprise policy:", result.error);
		cachedPolicy = null;
		return null;
	} catch (error) {
		console.warn("Failed to load enterprise policy:", error);
		cachedPolicy = null;
		return null;
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
	let matches = command.matchAll(new RegExp(npmInstallPattern, "g"));
	if (!matches) {
		matches = command.matchAll(new RegExp(bunAddPattern, "g"));
	}
	if (!matches) {
		matches = command.matchAll(new RegExp(pipInstallPattern, "g"));
	}

	const results: string[] = [];
	for (const match of matches) {
		if (match[1]) {
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

export function checkPolicy(context: ActionApprovalContext): {
	allowed: boolean;
	reason?: string;
} {
	const policy = loadPolicy();
	if (!policy) {
		return { allowed: true };
	}

	// 0. Organization Context Check
	if (
		policy.orgId &&
		context.user?.orgId &&
		policy.orgId !== context.user.orgId
	) {
		console.warn(
			`[Policy] Org mismatch: Policy=${policy.orgId}, User=${context.user.orgId}. Policy will be skipped.`,
		);
		return { allowed: true };
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

	// 2. Dependency Constraints
	// Only relevant for 'bash' tool (or similar command execution tools)
	if (
		(context.toolName === "bash" || context.toolName === "background_tasks") &&
		policy.dependencies
	) {
		const command = getCommandArg(context);
		if (command) {
			const deps = extractDependencies(command);
			// Only check metacharacters if we actually found dependency installation patterns
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

	return { allowed: true };
}
