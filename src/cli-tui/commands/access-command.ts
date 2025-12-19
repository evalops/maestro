import { resolve } from "node:path";
import {
	getSafePathMatch,
	getSafePathSummary,
	getSystemPaths,
	isSystemPath,
} from "../../safety/path-containment.js";
import { isHelpRequest } from "./grouped/utils.js";
import type { CommandExecutionContext } from "./types.js";

const ACCESS_USAGE = [
	"Directory access diagnostics:",
	"  /access safe              Show safe roots",
	"  /access restricted        Show system-protected paths",
	"  /access test <path>       Test a path against containment rules",
	"",
	"Notes: containment checks determine whether approval is required for writes.",
].join("\n");

export function handleAccessCommand(context: CommandExecutionContext): void {
	const args = context.argumentText.trim().split(/\s+/).filter(Boolean);
	const subcommand = (args[0] || "").toLowerCase();

	if (!subcommand || isHelpRequest(subcommand)) {
		context.showInfo(ACCESS_USAGE);
		return;
	}

	switch (subcommand) {
		case "safe": {
			const summary = getSafePathSummary();
			const lines = [
				"Safe roots (writes within these do not trigger containment approval):",
				`  Workspace: ${summary.workspaceRoot}`,
				`  Temp: ${summary.tempDir}${
					summary.tempDirReal !== summary.tempDir
						? ` (real: ${summary.tempDirReal})`
						: ""
				}`,
			];
			if (summary.trustedPaths.length > 0) {
				lines.push("  Trusted:");
				for (const trusted of summary.trustedPaths) {
					lines.push(`    - ${trusted}`);
				}
			} else {
				lines.push("  Trusted: (none configured)");
			}
			context.showInfo(lines.join("\n"));
			break;
		}

		case "restricted":
		case "blocked": {
			const lines = [
				"System-protected paths (writes are blocked):",
				...getSystemPaths().map((path) => `  - ${path}`),
				"",
				"Note: temp directories inside /var/folders (macOS) or /tmp are allowed by containment checks.",
			];
			context.showInfo(lines.join("\n"));
			break;
		}

		case "test": {
			const rawPath = args.slice(1).join(" ").trim();
			if (!rawPath) {
				context.showError("Usage: /access test <path>");
				return;
			}
			const resolvedPath = resolve(rawPath);
			const summary = getSafePathSummary();
			const match = getSafePathMatch(resolvedPath, summary);
			const lines = [`Path: ${rawPath}`, `Resolved: ${resolvedPath}`];

			if (match) {
				lines.push(
					`Result: safe (${match}) — containment approval not required for writes.`,
				);
			} else if (isSystemPath(resolvedPath)) {
				lines.push("Result: blocked — system-protected path.");
			} else {
				lines.push(
					"Result: requires approval — outside workspace/temp/trusted roots.",
				);
			}

			context.showInfo(lines.join("\n"));
			break;
		}

		default:
			context.showInfo(ACCESS_USAGE);
	}
}
