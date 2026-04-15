import { lookup } from "node:dns/promises";
import type { ActionApprovalContext } from "../../agent/action-approval.js";
import {
	isLocalhostAlias,
	isLoopbackIP,
	isPrivateIP,
	parseIPv4,
	parseIPv4MappedHex,
} from "../../utils/ip-address-parser.js";
import {
	extractUrlsFromShellCommand,
	extractUrlsFromValue,
} from "../../utils/url-extractor.js";
import type { EnterprisePolicy } from "../policy.js";

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

/**
 * Extract URLs from tool arguments (recursively checks nested objects)
 * Also extracts URLs from curl/wget commands in bash.
 */
export function extractPolicyUrls(context: ActionApprovalContext): string[] {
	const args = getArgsObject(context);
	if (!args) return [];

	const urls = extractUrlsFromValue(args);

	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getStringArg(context, "command");
		if (command) {
			urls.push(...extractUrlsFromShellCommand(command));
		}
	}

	return urls;
}

/**
 * Check if a URL/host matches network restrictions.
 */
export async function checkNetworkRestrictions(
	url: string,
	network: NonNullable<EnterprisePolicy["network"]>,
): Promise<{ allowed: boolean; reason?: string }> {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();

		const normalizedHost = host.replace(/^\[|\]$/g, "");

		const resolvedIPs: string[] = [];
		const isIP =
			parseIPv4(normalizedHost) !== null ||
			parseIPv4MappedHex(normalizedHost) !== null ||
			normalizedHost.includes(":");

		if (!isIP) {
			try {
				const { address } = await lookup(normalizedHost);
				resolvedIPs.push(address);
			} catch {
				if (network.blockPrivateIPs || network.blockLocalhost) {
					return {
						allowed: false,
						reason: `DNS resolution failed for "${host}" and network policy requires IP validation (blockPrivateIPs/blockLocalhost enabled). Access blocked.`,
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
				};
			}
		}

		if (network.blockPrivateIPs) {
			if (resolvedIPs.some(isPrivateIP)) {
				return {
					allowed: false,
					reason:
						"Access to private IP addresses is blocked by enterprise policy.",
				};
			}
		}

		if (network.blockedHosts?.length) {
			for (const blockedHost of network.blockedHosts) {
				const lowerBlocked = blockedHost.toLowerCase();
				if (host === lowerBlocked || host.endsWith(`.${lowerBlocked}`)) {
					return {
						allowed: false,
						reason: `Host "${host}" is blocked by enterprise policy.`,
					};
				}
			}
		}

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
		return {
			allowed: false,
			reason: "Invalid URL format - cannot validate against network policy.",
		};
	}
	return { allowed: true };
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
	return { allowed: true };
}
