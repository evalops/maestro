import { lookup } from "node:dns/promises";
import { isIP as netIsIP } from "node:net";
import type { ActionApprovalContext } from "../../agent/action-approval.js";
import {
	isLocalhostAlias,
	isLoopbackIP,
	isPrivateIP,
	parseIPv4,
	parseIPv4MappedHex,
} from "../../utils/ip-address-parser.js";
import {
	extractUrlSubstringsFromShellCommand,
	extractUrlsFromShellCommand,
	extractUrlsFromValue,
	findOpaqueNetworkShellCommand,
} from "../../utils/url-extractor.js";
import type { EnterprisePolicy } from "../policy.js";

export interface NetworkRestrictionCheck {
	allowed: boolean;
	reason?: string;
	host?: string;
	normalizedHost?: string;
	resolvedIPs: string[];
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

function normalizePolicyHost(host: string): string {
	return host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
}

function hostMatchesPolicyEntry(host: string, policyHost: string): boolean {
	const normalizedPolicyHost = normalizePolicyHost(policyHost);
	return (
		host === normalizedPolicyHost || host.endsWith(`.${normalizedPolicyHost}`)
	);
}

/**
 * Extract URLs from tool arguments (recursively checks nested objects)
 * Also extracts statically visible network targets from bash commands.
 */
export function extractPolicyUrls(context: ActionApprovalContext): string[] {
	const args = getArgsObject(context);
	if (!args) return [];

	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		// Run both the bash-token aware extractor (which understands
		// curl/wget argument structure, wrappers, command substitutions,
		// etc.) AND a recursive substring scan over the shell command. The scan
		// catches URLs embedded mid-string in shell commands — e.g.
		// `curl "see https://evil.com here"`, `echo "https://..."`,
		// heredocs — that the token-aware extractor would miss because
		// they don't parse as a clean bash token. Keep the scan shell-aware
		// so comment text is ignored. Union the results so
		// neither path can be bypassed independently. (Codex P1 finding
		// on public mirror PR #781; backported from public commit
		// cef6e3b.)
		const { command, ...otherArgs } = args;
		const urls = extractUrlsFromValue(otherArgs);
		if (typeof command === "string") {
			urls.push(...extractUrlSubstringsFromShellCommand(command));
			urls.push(...extractUrlsFromShellCommand(command));
		}
		return [...new Set(urls)];
	}

	return extractUrlsFromValue(args);
}

function getOpaqueNetworkCommand(
	context: ActionApprovalContext,
): string | null {
	if (context.toolName !== "bash" && context.toolName !== "background_tasks") {
		return null;
	}

	const command = getStringArg(context, "command");
	return command ? findOpaqueNetworkShellCommand(command) : null;
}

/**
 * Check if a URL/host matches network restrictions.
 */
export async function checkNetworkRestrictionsDetailed(
	url: string,
	network: NonNullable<EnterprisePolicy["network"]>,
): Promise<NetworkRestrictionCheck> {
	try {
		const parsed = new URL(url);
		const host = normalizePolicyHost(parsed.hostname);
		const normalizedHost = host;

		if (network.blockedHosts?.length) {
			for (const blockedHost of network.blockedHosts) {
				if (hostMatchesPolicyEntry(host, blockedHost)) {
					return {
						allowed: false,
						reason: `Host "${host}" is blocked by enterprise policy.`,
						host,
						normalizedHost,
						resolvedIPs: [],
					};
				}
			}
		}

		if (network.allowedHosts) {
			if (network.allowedHosts.length === 0) {
				return {
					allowed: false,
					reason: `Host "${host}" is not in the allowed hosts list.`,
					host,
					normalizedHost,
					resolvedIPs: [],
				};
			}
			const isAllowed = network.allowedHosts.some((allowedHost) => {
				return hostMatchesPolicyEntry(host, allowedHost);
			});
			if (!isAllowed) {
				return {
					allowed: false,
					reason: `Host "${host}" is not in the allowed hosts list.`,
					host,
					normalizedHost,
					resolvedIPs: [],
				};
			}
		}

		const resolvedIPs: string[] = [];
		const isIP =
			parseIPv4(normalizedHost) !== null ||
			parseIPv4MappedHex(normalizedHost) !== null ||
			netIsIP(normalizedHost) !== 0;

		if (!isIP) {
			try {
				const addresses = await lookup(normalizedHost, { all: true });
				resolvedIPs.push(...addresses.map(({ address }) => address));
			} catch {
				if (network.blockPrivateIPs || network.blockLocalhost) {
					return {
						allowed: false,
						reason: `DNS resolution failed for "${host}" and network policy requires IP validation (blockPrivateIPs/blockLocalhost enabled). Access blocked.`,
						host,
						normalizedHost,
						resolvedIPs,
					};
				}
			}
		} else {
			resolvedIPs.push(normalizedHost);
		}

		if (network.blockLocalhost) {
			if (isLocalhostAlias(normalizedHost) || resolvedIPs.some(isLoopbackIP)) {
				return {
					allowed: false,
					reason: "Access to localhost is blocked by enterprise policy.",
					host,
					normalizedHost,
					resolvedIPs,
				};
			}
		}

		if (network.blockPrivateIPs) {
			if (resolvedIPs.some(isPrivateIP)) {
				return {
					allowed: false,
					reason:
						"Access to private IP addresses is blocked by enterprise policy.",
					host,
					normalizedHost,
					resolvedIPs,
				};
			}
		}

		return { allowed: true, host, normalizedHost, resolvedIPs };
	} catch {
		return {
			allowed: false,
			reason: "Invalid URL format - cannot validate against network policy.",
			resolvedIPs: [],
		};
	}
}

export async function checkNetworkRestrictions(
	url: string,
	network: NonNullable<EnterprisePolicy["network"]>,
): Promise<{ allowed: boolean; reason?: string }> {
	const check = await checkNetworkRestrictionsDetailed(url, network);
	return check.reason
		? { allowed: check.allowed, reason: check.reason }
		: { allowed: check.allowed };
}

export async function checkNetworkPolicy(
	context: ActionApprovalContext,
	network: NonNullable<EnterprisePolicy["network"]>,
): Promise<{ allowed: boolean; reason?: string }> {
	const urls = extractPolicyUrls(context);
	for (const url of urls) {
		const check = await checkNetworkRestrictions(url, network);
		if (!check.allowed) {
			return check;
		}
	}

	const opaqueNetworkCommand = getOpaqueNetworkCommand(context);
	if (opaqueNetworkCommand) {
		return {
			allowed: false,
			reason: `Network-capable command "${opaqueNetworkCommand}" does not expose a statically validatable host for enterprise network policy.`,
		};
	}

	return { allowed: true };
}
