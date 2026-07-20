#!/usr/bin/env node
// @ts-check

/**
 * Materializes prebuilt per-platform `maestro-tui` (packages/tui-rs) release
 * binaries into the npm package's vendor directory contract:
 *
 *   vendor/maestro-tui/<platform>-<arch>/maestro-tui
 *
 * `<platform>-<arch>` matches Node's `process.platform`/`process.arch`
 * vocabulary joined with a hyphen (e.g. "darwin-arm64"), which is the layout
 * the CLI's runtime spawn code resolves against. Windows is intentionally
 * unsupported: release.yml does not publish Windows release artifacts today.
 *
 * Input layout (produced by the `release-tui-binaries` matrix job in
 * .github/workflows/release.yml and downloaded via actions/download-artifact
 * with merge-multiple): a flat directory containing one file per platform,
 * named `maestro-tui-<platform>` (no extension).
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

export const SUPPORTED_TUI_PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
];

function parseArgs(argv) {
	const options = {
		inputDir: "release-tui-binaries",
		outputDir: "vendor/maestro-tui",
		platforms: SUPPORTED_TUI_PLATFORMS,
		allowMissing: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--input-dir":
				options.inputDir = argv[++index] ?? options.inputDir;
				break;
			case "--output-dir":
				options.outputDir = argv[++index] ?? options.outputDir;
				break;
			case "--platforms":
				options.platforms = (argv[++index] ?? "").split(",").filter(Boolean);
				break;
			case "--allow-missing":
				options.allowMissing = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (options.platforms.length === 0) {
		throw new Error("No platforms requested.");
	}

	return options;
}

function formatBytes(bytes) {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.inputDir);
	const outputDir = resolve(options.outputDir);

	const missing = [];
	const materialized = [];

	for (const platform of options.platforms) {
		if (!SUPPORTED_TUI_PLATFORMS.includes(platform)) {
			throw new Error(
				`Unsupported maestro-tui platform: ${platform}. Expected one of: ${SUPPORTED_TUI_PLATFORMS.join(", ")}`,
			);
		}

		const srcPath = join(inputDir, `maestro-tui-${platform}`);
		if (!existsSync(srcPath)) {
			missing.push(platform);
			continue;
		}

		const destDir = join(outputDir, platform);
		const destPath = join(destDir, "maestro-tui");
		mkdirSync(destDir, { recursive: true });
		copyFileSync(srcPath, destPath);
		chmodSync(destPath, 0o755);

		const size = statSync(destPath).size;
		materialized.push({ platform, destPath, size });
		console.log(`maestro-tui[${platform}] -> ${destPath} (${formatBytes(size)})`);
	}

	if (missing.length > 0 && !options.allowMissing) {
		throw new Error(
			`Missing maestro-tui release binaries for: ${missing.join(", ")}. ` +
				`Expected them at ${join(inputDir, "maestro-tui-<platform>")}. ` +
				"Pass --allow-missing to materialize a partial vendor directory (local/dev testing only).",
		);
	}

	if (missing.length > 0) {
		console.warn(
			`Warning: proceeding without maestro-tui binaries for: ${missing.join(", ")} (--allow-missing set).`,
		);
	}

	if (materialized.length === 0) {
		throw new Error("No maestro-tui binaries were materialized.");
	}

	const totalSize = materialized.reduce((sum, entry) => sum + entry.size, 0);
	console.log(
		`Materialized ${materialized.length} maestro-tui binaries (${formatBytes(totalSize)} total) into ${outputDir}`,
	);
}

if (isDirectCliEntrypoint(import.meta.url)) {
	main();
}
