#!/usr/bin/env node
// @ts-check

/**
 * Verifies that a packed npm tarball (from `npm pack`) contains the
 * maestro-tui vendor binaries at the contract path expected by the CLI's
 * runtime spawn code:
 *
 *   package/vendor/maestro-tui/<platform>-<arch>/maestro-tui
 *
 * Also checks that each entry is a regular file with the executable bit set,
 * since `npm pack`/`npm publish` can silently drop file modes if the source
 * tree lost them.
 *
 * Usage:
 *   node scripts/check-tui-vendor-packed.mjs <tarball.tgz> [--platforms a,b,c]
 */

import { spawnSync } from "node:child_process";
import { SUPPORTED_TUI_PLATFORMS } from "./materialize-tui-vendor.mjs";

function parseArgs(argv) {
	const options = { tarball: "", platforms: SUPPORTED_TUI_PLATFORMS };
	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--platforms") {
			options.platforms = (argv[++index] ?? "").split(",").filter(Boolean);
		} else {
			positionals.push(arg);
		}
	}

	options.tarball = positionals[0] ?? "";
	if (!options.tarball) {
		throw new Error("Usage: check-tui-vendor-packed.mjs <tarball.tgz> [--platforms a,b,c]");
	}

	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));

	const listing = spawnSync("tar", ["-tvzf", options.tarball], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (listing.status !== 0) {
		console.error(`Failed to list tarball ${options.tarball}.`);
		if (listing.stderr) console.error(listing.stderr.trim());
		process.exit(listing.status ?? 1);
	}

	const lines = listing.stdout.split(/\r?\n/).filter(Boolean);
	const missing = [];
	const notExecutable = [];

	for (const platform of options.platforms) {
		const expectedPath = `package/vendor/maestro-tui/${platform}/maestro-tui`;
		const line = lines.find((entry) => entry.trimEnd().endsWith(expectedPath));
		if (!line) {
			missing.push(expectedPath);
			continue;
		}

		const permissions = line.trim().split(/\s+/, 1)[0] ?? "";
		const isExecutable = /^-r.x/.test(permissions) || permissions.includes("x");
		if (!isExecutable) {
			notExecutable.push(`${expectedPath} (mode: ${permissions})`);
		}
	}

	if (missing.length > 0) {
		console.error("Packed tarball is missing maestro-tui vendor binaries:");
		for (const entry of missing) console.error(`- ${entry}`);
	}
	if (notExecutable.length > 0) {
		console.error("Packed maestro-tui vendor binaries are missing the executable bit:");
		for (const entry of notExecutable) console.error(`- ${entry}`);
	}

	if (missing.length > 0 || notExecutable.length > 0) {
		process.exit(1);
	}

	console.log(
		`Verified ${options.platforms.length} maestro-tui vendor binaries in ${options.tarball}: ${options.platforms.join(", ")}`,
	);
}

main();
