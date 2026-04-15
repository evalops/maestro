#!/usr/bin/env node

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
	const args = {
		check: false,
		manifest: ".github/release-mirror-manifest.json",
		source: process.cwd(),
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--check":
				args.check = true;
				break;
			case "--manifest":
				args.manifest = argv[++index] ?? args.manifest;
				break;
			case "--source":
				args.source = argv[++index] ?? args.source;
				break;
			case "--target":
				args.target = argv[++index] ?? args.target;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.target) {
		throw new Error("Missing required --target <path>");
	}

	return args;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(options.source);
const targetRoot = resolve(options.target);
const manifestPath = resolve(sourceRoot, options.manifest);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];
const changedFiles = [];

for (const relativePath of files) {
	const sourcePath = resolve(sourceRoot, relativePath);
	const targetPath = resolve(targetRoot, relativePath);

	if (!existsSync(sourcePath)) {
		throw new Error(`Missing source file for mirror sync: ${sourcePath}`);
	}

	const sourceContent = readFileSync(sourcePath);
	const targetContent = existsSync(targetPath) ? readFileSync(targetPath) : null;
	if (targetContent && sourceContent.equals(targetContent)) {
		continue;
	}

	changedFiles.push(relativePath);
	if (!options.check) {
		mkdirSync(dirname(targetPath), { recursive: true });
		copyFileSync(sourcePath, targetPath);
	}
}

if (options.check) {
	if (changedFiles.length > 0) {
		console.error("Release mirror drift detected:");
		for (const file of changedFiles) {
			console.error(`- ${file}`);
		}
		process.exit(1);
	}
	console.log("Release mirror is in sync.");
} else if (changedFiles.length > 0) {
	console.log(`Synced ${changedFiles.length} mirrored release files.`);
} else {
	console.log("Release mirror already in sync.");
}
