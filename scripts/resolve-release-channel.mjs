#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveReleaseChannel(version, requested = "") {
	const normalized = version.trim().replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
		throw new Error("release version must be semver-like");
	}
	const prerelease = normalized.match(/-(alpha|beta)\./)?.[1] ?? "";
	if (normalized.includes("-") && !prerelease) {
		throw new Error("prerelease versions must use alpha or beta");
	}
	const inferred = prerelease || "stable";
	const channel = requested.trim() || inferred;
	if (!["stable", "beta", "alpha"].includes(channel)) {
		throw new Error("release channel must be stable, alpha, or beta");
	}
	if (channel !== inferred) {
		throw new Error(`${channel} releases require a matching ${channel} version`);
	}
	return channel;
}

function option(argv, name) {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] ?? "" : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const version = option(process.argv, "--version");
		const requested = option(process.argv, "--requested");
		const channel = resolveReleaseChannel(version, requested);
		console.log(channel);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
