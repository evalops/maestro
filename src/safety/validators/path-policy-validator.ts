import type { ActionApprovalContext } from "../../agent/action-approval.js";
import { matchesPathPattern } from "../../utils/path-matcher.js";
import type { EnterprisePolicy } from "../policy.js";

const PATH_KEYS = [
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
 * Extract file paths from tool arguments.
 */
export function extractPolicyFilePaths(
	context: ActionApprovalContext,
): string[] {
	const args = getArgsObject(context);
	if (!args) return [];

	const paths: string[] = [];

	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			paths.push(value);
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item.length > 0) {
					paths.push(item);
				}
			}
		}
	}

	if (context.toolName === "bash" || context.toolName === "background_tasks") {
		const command = getCommandArg(context);
		if (command) {
			const fileCommands =
				/(?:cd|cat|rm|mv|cp|mkdir|touch|nano|vim|vi|less|more|head|tail|chmod|chown|strings|hexdump|dd|tee|ln|readlink|stat|file|wc|grep|sed|awk|sort|uniq|diff|patch|tar|gzip|gunzip|zip|unzip|find|rsync|scp)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)/gi;

			const matches = command.matchAll(fileCommands);
			for (const match of matches) {
				const argsStr = match[1];
				if (!argsStr) continue;
				const argParts = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
				for (const arg of argParts) {
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

			const cmdSubPattern = /(?:\$\(|<\()([^)]+)\)|`([^`]+)`/g;
			const cmdSubMatches = command.matchAll(cmdSubPattern);
			for (const match of cmdSubMatches) {
				const innerCmd = match[1] || match[2];
				if (innerCmd) {
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

export function checkPathPolicy(
	paths: string[],
	pathPolicy: NonNullable<EnterprisePolicy["paths"]>,
): { allowed: boolean; reason?: string } {
	for (const filePath of paths) {
		if (
			pathPolicy.blocked?.length &&
			matchesPathPattern(filePath, pathPolicy.blocked)
		) {
			return {
				allowed: false,
				reason: `Path "${filePath}" is blocked by enterprise policy.`,
			};
		}
		if (pathPolicy.allowed) {
			if (
				pathPolicy.allowed.length === 0 ||
				!matchesPathPattern(filePath, pathPolicy.allowed)
			) {
				return {
					allowed: false,
					reason: `Path "${filePath}" is not in the allowed paths list.`,
				};
			}
		}
	}

	return { allowed: true };
}
