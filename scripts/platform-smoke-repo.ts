import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ResolvePlatformRepoOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	exists?: (path: string) => boolean;
	homeDir?: string;
}

function hasPlatformGoModule(
	repoPath: string,
	exists: (path: string) => boolean,
): boolean {
	return exists(join(repoPath, "go.mod"));
}

export function resolvePlatformRepo(
	options: ResolvePlatformRepoOptions = {},
): string {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const exists = options.exists ?? existsSync;
	const homeDir = options.homeDir ?? homedir();
	const configured =
		env.MAESTRO_PLATFORM_REPO?.trim() || env.PLATFORM_REPO?.trim();
	const checked: string[] = [];

	if (configured) {
		const repoPath = resolve(configured);
		if (hasPlatformGoModule(repoPath, exists)) {
			return repoPath;
		}
		throw new Error(
			`Configured Platform repo ${repoPath} is not an evalops/platform checkout; expected go.mod at ${join(repoPath, "go.mod")}`,
		);
	}

	const candidates = [
		resolve(cwd, "..", "platform"),
		resolve(homeDir, "repos", "platform"),
		resolve(homeDir, "Documents", "Projects", "platform"),
	];
	for (const candidate of candidates) {
		if (checked.includes(candidate)) {
			continue;
		}
		checked.push(candidate);
		if (hasPlatformGoModule(candidate, exists)) {
			return candidate;
		}
	}

	throw new Error(
		`Could not find a local evalops/platform checkout for Platform smoke tests. Set MAESTRO_PLATFORM_REPO or PLATFORM_REPO. Checked: ${checked.join(", ")}`,
	);
}
