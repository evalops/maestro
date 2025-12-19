import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { getFirewallConfig } from "../config/firewall-config.js";

/**
 * Protected system paths that should never be modified.
 *
 * Note: /var/folders (macOS temp) and /tmp are allowed through containment checks
 * before system path blocking is applied.
 */
const SYSTEM_PATHS = [
	// Linux system directories
	"/etc",
	"/usr",
	"/var",
	"/boot",
	"/sys",
	"/proc",
	"/dev",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/opt",
	// Windows system directories
	"C:\\Windows",
	"C:\\Program Files",
	"C:\\Program Files (x86)",
];

export interface SafePathSummary {
	workspaceRoot: string;
	tempDir: string;
	tempDirReal: string;
	trustedPaths: string[];
}

export function getSystemPaths(): string[] {
	return [...SYSTEM_PATHS];
}

export function isSystemPath(filePath: string): boolean {
	const normalized = resolve(filePath);
	return SYSTEM_PATHS.some((sysPath) => {
		return (
			normalized === sysPath ||
			normalized.startsWith(`${sysPath}/`) ||
			normalized.startsWith(`${sysPath}\\`)
		);
	});
}

export function getSafePathSummary(): SafePathSummary {
	const workspaceRoot = resolve(process.cwd());
	const tempDir = tmpdir();
	let tempDirReal = tempDir;
	try {
		tempDirReal = realpathSync(tempDir);
	} catch {
		// Keep logical temp path if realpath fails.
	}
	const config = getFirewallConfig();
	const trustedPaths = (config.containment?.trustedPaths ?? []).map((path) =>
		resolve(path),
	);
	return {
		workspaceRoot,
		tempDir,
		tempDirReal,
		trustedPaths,
	};
}

export function getSafePathMatch(
	filePath: string,
	summary: SafePathSummary = getSafePathSummary(),
): "workspace" | "temp" | "trusted" | null {
	const resolvedPath = resolve(filePath);
	const relToWorkspace = relative(summary.workspaceRoot, resolvedPath);
	const isInsideWorkspace =
		!relToWorkspace.startsWith("..") && !isAbsolute(relToWorkspace);

	let realFilePath = resolvedPath;
	try {
		realFilePath = realpathSync(resolvedPath);
	} catch {
		// File may not exist yet; fall back to logical path.
	}

	const relToTempReal = relative(summary.tempDirReal, realFilePath);
	const relToTempLogical = relative(summary.tempDir, resolvedPath);
	const isInsideTemp =
		(!relToTempReal.startsWith("..") && !isAbsolute(relToTempReal)) ||
		(!relToTempLogical.startsWith("..") && !isAbsolute(relToTempLogical));

	if (isInsideWorkspace) {
		return "workspace";
	}
	if (isInsideTemp) {
		return "temp";
	}

	for (const trustedPath of summary.trustedPaths) {
		const relToTrusted = relative(trustedPath, resolvedPath);
		if (!relToTrusted.startsWith("..") && !isAbsolute(relToTrusted)) {
			return "trusted";
		}
	}

	return null;
}

export function isContainedInWorkspace(filePath: string): boolean {
	return getSafePathMatch(filePath) !== null;
}

export function isContainedInWorkspaceOrTemp(filePath: string): boolean {
	const match = getSafePathMatch(filePath);
	return match === "workspace" || match === "temp";
}
