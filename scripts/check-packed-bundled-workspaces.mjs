#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRootPackage } from "./workspace-utils.js";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";

const rootPackage = loadRootPackage();
const runtimeWorkspaceNames = getRuntimeWorkspaceNames(rootPackage);

if (runtimeWorkspaceNames.length === 0) {
	console.log("No runtime workspace packages declared.");
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
	const missing = runtimeWorkspaceNames.filter(
		(name) => !entries.has(`package/dist/node_modules/${name}/package.json`),
	);
	if (missing.length > 0) {
		console.error("Packed tarball is missing vendored runtime workspace packages:");
		for (const name of missing.sort()) {
			console.error(`- ${name}`);
		}
		process.exit(1);
	}

	const manifest = spawnSync("tar", ["-xOf", tarballPath, "package/package.json"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (manifest.status !== 0) {
		console.error(`Failed to read package.json from packed tarball ${tarballs[0]}.`);
		if (manifest.stderr) console.error(manifest.stderr.trim());
		process.exit(manifest.status ?? 1);
	}

	const packedPackage = JSON.parse(manifest.stdout);
	const dependencySections = [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	];
	const metadataOffenders = [];
	for (const section of dependencySections) {
		const deps = packedPackage[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
			continue;
		}
		for (const name of runtimeWorkspaceNames) {
			if (Object.hasOwn(deps, name)) {
				metadataOffenders.push(`${section}.${name}`);
			}
		}
	}
	for (const section of ["bundleDependencies", "bundledDependencies"]) {
		const values = Array.isArray(packedPackage[section])
			? packedPackage[section]
			: [];
		for (const name of runtimeWorkspaceNames) {
			if (values.includes(name)) {
				metadataOffenders.push(`${section}.${name}`);
			}
		}
	}
	if (metadataOffenders.length > 0) {
		console.error(
			"Packed package metadata still exposes vendored runtime workspaces as registry dependencies:",
		);
		for (const offender of metadataOffenders.sort()) {
			console.error(`- ${offender}`);
		}
		process.exit(1);
	}

	console.log(
		`Verified packed tarball vendors runtime workspaces without registry dependency metadata: ${runtimeWorkspaceNames
			.slice()
			.sort()
			.join(", ")}.`,
	);
} finally {
	rmSync(packDir, { recursive: true, force: true });
}
