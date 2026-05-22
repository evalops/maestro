#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function publicMirrorRefCandidates(internalRef) {
	const ref = String(internalRef ?? "").trim();
	const candidates = [];
	if (!ref) {
		return candidates;
	}

	candidates.push(ref);
	if (ref.includes("/internal-")) {
		const prefix = ref.slice(0, ref.indexOf("/internal-"));
		const suffix = ref.slice(ref.indexOf("/internal-") + "/internal-".length);
		candidates.push(`${prefix}/${suffix}`);
	}
	if (ref.startsWith("internal-")) {
		candidates.push(ref.slice("internal-".length));
	}

	return Array.from(new Set(candidates.filter(Boolean)));
}

function parseArgs(argv) {
	const args = {
		githubOutput: "",
		internalRef: "",
		publicRepo: "https://github.com/evalops/maestro.git",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--github-output":
				args.githubOutput = argv[++index] ?? "";
				break;
			case "--internal-ref":
				args.internalRef = argv[++index] ?? "";
				break;
			case "--public-repo":
				args.publicRepo = argv[++index] ?? args.publicRepo;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return args;
}

function headExists(publicRepo, ref) {
	try {
		execFileSync("git", ["ls-remote", "--exit-code", "--heads", publicRepo, ref], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

export function resolvePublicMirrorRef({
	headExistsFn = headExists,
	internalRef,
	publicRepo = "https://github.com/evalops/maestro.git",
} = {}) {
	for (const candidate of publicMirrorRefCandidates(internalRef)) {
		if (headExistsFn(publicRepo, candidate)) {
			return {
				candidates: publicMirrorRefCandidates(internalRef),
				ref: candidate,
				source: "matched-public-branch",
			};
		}
	}

	return {
		candidates: publicMirrorRefCandidates(internalRef),
		ref: "main",
		source: "fallback-main",
	};
}

function writeGithubOutput(path, key, value) {
	if (!path) {
		return;
	}
	appendFileSync(path, `${key}=${value}\n`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const resolved = resolvePublicMirrorRef(args);

	console.log(`Public mirror candidates: ${resolved.candidates.join(", ") || "(none)"}`);
	console.log(`Using evalops/maestro ref: ${resolved.ref} (${resolved.source})`);

	writeGithubOutput(args.githubOutput, "ref", resolved.ref);
	writeGithubOutput(args.githubOutput, "source", resolved.source);
	writeGithubOutput(args.githubOutput, "candidates", resolved.candidates.join(","));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
