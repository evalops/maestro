#!/usr/bin/env node
// @ts-check

import { loadRootPackage } from "./workspace-utils.js";

/**
 * @param {unknown} value
 * @returns {value is Record<string, string>}
 */
function isStringRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @returns {{name: string; version: string; cliCommand: string}}
 */
export function getPackageMetadata() {
	const rootPackage = loadRootPackage();
	const name = rootPackage.name;
	const version = rootPackage.version;

	if (typeof name !== "string" || !name.trim()) {
		throw new Error("Root package.json is missing a valid name");
	}

	if (typeof version !== "string" || !version.trim()) {
		throw new Error("Root package.json is missing a valid version");
	}

	const bin = rootPackage.bin;
	if (!isStringRecord(bin)) {
		throw new Error("Root package.json is missing a valid bin map");
	}

	const [cliCommand] = Object.keys(bin);
	if (!cliCommand) {
		throw new Error("Root package.json bin map does not declare a CLI command");
	}

	return { name, version, cliCommand };
}

/**
 * @param {"npm" | "bun"} packageManager
 */
export function getGlobalInstallCommand(packageManager) {
	const { name } = getPackageMetadata();
	return `${packageManager} install -g ${name}`;
}
