import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_EXCLUDES } from "../src/guardian/types.js";
import { detectEvidenceIntegrityFindings } from "../src/guardian/runner.js";

function listTrackedFiles(root: string): string[] {
	const output = execFileSync("git", ["ls-files"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => {
			const normalized = file.replace(/\\/g, "/");
			return !DEFAULT_EXCLUDES.some(
				(exclude) =>
					normalized === exclude ||
					normalized.startsWith(exclude) ||
					normalized.includes(`/${exclude}`),
			);
		});
}

function shouldSkipFixtureSelfTest(relative: string): boolean {
	return (
		/test\/guardian\/evidence-integrity\.test\.ts$/.test(relative) ||
		/src\/guardian\/runner\.ts$/.test(relative)
	);
}

function readTextFile(path: string): string | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		const stats = statSync(path);
		if (stats.size > 2 * 1024 * 1024) {
			return null;
		}
		const contents = readFileSync(path, "utf8");
		return contents.includes("\0") ? null : contents;
	} catch {
		return null;
	}
}

function main(): void {
	const root = process.cwd();
	const findings: string[] = [];
	for (const relative of listTrackedFiles(root)) {
		if (shouldSkipFixtureSelfTest(relative)) {
			continue;
		}
		const contents = readTextFile(resolve(root, relative));
		if (!contents) {
			continue;
		}
		for (const finding of detectEvidenceIntegrityFindings(contents)) {
			findings.push(`${finding}: ${relative}`);
		}
	}
	if (findings.length > 0) {
		console.error("Evidence integrity check failed:");
		for (const finding of findings) {
			console.error(`- ${finding}`);
		}
		console.error(
			"Deterministic replay fixtures must not be presented as live production evidence. Use dereferenceable git SHAs, integer PRs, Actions run IDs/logs, deploy-verifier outcomes, and signed bundle identifiers for production proof.",
		);
		process.exitCode = 1;
		return;
	}
	console.log("Evidence integrity check passed.");
}

main();
