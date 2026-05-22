#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";

const rootPackage = loadRootPackage();
const bundled = Array.isArray(rootPackage.bundleDependencies)
	? rootPackage.bundleDependencies
	: [];
const workspacePackages = await getWorkspacePackages(rootPackage);
const workspaceNames = new Set(
	workspacePackages.map((workspacePackage) => workspacePackage.name),
);
const bundledWorkspaceNames = bundled.filter((name) => workspaceNames.has(name));

if (bundledWorkspaceNames.length === 0) {
	console.log("No bundled workspace packages declared.");
	process.exit(0);
}

const packDir = mkdtempSync(join(tmpdir(), "maestro-packed-workspaces-"));

try {
	const pack = spawnSync(
		"npm",
		["pack", "--silent", "--pack-destination", packDir],
		{
			cwd: process.cwd(),
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (pack.status !== 0) {
		console.error("npm pack failed while checking bundled workspaces.");
		if (pack.stdout) console.error(pack.stdout.trim());
		if (pack.stderr) console.error(pack.stderr.trim());
		process.exit(pack.status ?? 1);
	}

	const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
	if (tarballs.length !== 1) {
		console.error(
			`Expected npm pack to create one tarball, found ${tarballs.length}.`,
		);
		process.exit(1);
	}

	const tarballPath = join(packDir, tarballs[0]);
	const listing = spawnSync("tar", ["-tzf", tarballPath], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (listing.status !== 0) {
		console.error(`Failed to inspect packed tarball ${tarballs[0]}.`);
		if (listing.stderr) console.error(listing.stderr.trim());
		process.exit(listing.status ?? 1);
	}

	const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
	const missing = bundledWorkspaceNames.filter(
		(name) => !entries.has(`package/node_modules/${name}/package.json`),
	);
	if (missing.length > 0) {
		console.error("Packed tarball is missing bundled workspace packages:");
		for (const name of missing.sort()) {
			console.error(`- ${name}`);
		}
		process.exit(1);
	}

	console.log(
		`Verified packed tarball includes bundled workspaces: ${bundledWorkspaceNames
			.slice()
			.sort()
			.join(", ")}.`,
	);
} finally {
	rmSync(packDir, { recursive: true, force: true });
}
