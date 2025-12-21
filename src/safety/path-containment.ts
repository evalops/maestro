import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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
const SYSTEM_PATHS_REAL = SYSTEM_PATHS.map((sysPath) => {
	if (!isAbsolute(sysPath)) {
		return sysPath;
	}
	try {
		return realpathSync(sysPath);
	} catch {
		return sysPath;
	}
});
const SYSTEM_PATHS_ALL = Array.from(
	new Set([...SYSTEM_PATHS, ...SYSTEM_PATHS_REAL]),
);

export interface SafePathSummary {
	workspaceRoot: string;
	workspaceRootReal: string;
	tempDir: string;
	tempDirReal: string;
	trustedPaths: string[];
	trustedPathsReal: string[];
}

export function getSystemPaths(): string[] {
	return [...SYSTEM_PATHS];
}

export function isSystemPath(filePath: string): boolean {
	const normalized = resolve(filePath);
	const realPath = resolveRealPath(normalized) ?? normalized;
	return SYSTEM_PATHS_ALL.some((sysPath) => {
		return (
			normalized === sysPath ||
			normalized.startsWith(`${sysPath}/`) ||
			normalized.startsWith(`${sysPath}\\`) ||
			realPath === sysPath ||
			realPath.startsWith(`${sysPath}/`) ||
			realPath.startsWith(`${sysPath}\\`)
		);
	});
}

export function getSafePathSummary(): SafePathSummary {
	const workspaceRoot = resolve(process.cwd());
	let workspaceRootReal = workspaceRoot;
	try {
		workspaceRootReal = realpathSync(workspaceRoot);
	} catch {
		// Keep logical workspace root if realpath fails.
	}
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
	const trustedPathsReal = trustedPaths.map((path) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	});
	return {
		workspaceRoot,
		workspaceRootReal,
		tempDir,
		tempDirReal,
		trustedPaths,
		trustedPathsReal,
	};
}

function resolveRealPath(filePath: string): string | null {
	let current = filePath;
	const suffix: string[] = [];

	while (true) {
		if (existsSync(current)) {
			try {
				const realBase = realpathSync(current);
				if (suffix.length === 0) {
					return realBase;
				}
				return resolve(realBase, ...suffix.reverse());
			} catch {
				return null;
			}
		}

		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		suffix.push(basename(current));
		current = parent;
	}
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

export function getSafePathMatch(
	filePath: string,
	summary: SafePathSummary = getSafePathSummary(),
): "workspace" | "temp" | "trusted" | null {
	const resolvedPath = resolve(filePath);
	const realFilePath = resolveRealPath(resolvedPath) ?? resolvedPath;

	const isInsideWorkspace =
		isWithin(summary.workspaceRoot, resolvedPath) &&
		isWithin(summary.workspaceRootReal, realFilePath);

	// File may not exist yet; realFilePath falls back to logical path.
	const tempRoots = new Set([summary.tempDirReal]);
	if (process.platform !== "win32") {
		const tmpReal = resolveRealPath("/tmp");
		if (tmpReal) {
			tempRoots.add(tmpReal);
		}
	}
	const isInsideTemp = Array.from(tempRoots).some((root) =>
		isWithin(root, realFilePath),
	);

	if (isInsideWorkspace) {
		return "workspace";
	}
	if (isInsideTemp) {
		return "temp";
	}

	for (const [index, trustedPath] of summary.trustedPaths.entries()) {
		const trustedReal =
			summary.trustedPathsReal[index] ?? summary.trustedPaths[index];
		if (
			isWithin(trustedPath, resolvedPath) &&
			isWithin(trustedReal, realFilePath)
		) {
			return "trusted";
		}
	}

	return null;
}

export function isContainedInWorkspace(filePath: string): boolean {
	return getSafePathMatch(filePath) !== null;
}
