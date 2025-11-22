import { spawnSync } from "node:child_process";

export function isInsideGitRepository(cwd: string = process.cwd()): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error || result.status !== 0) {
		return false;
	}

	return (result.stdout ?? "").trim() === "true";
}
