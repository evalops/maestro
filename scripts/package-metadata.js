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
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	);
}

/**
 * @returns {{
 *   name: string;
 *   version: string;
 *   cliCommand: string;
 *   canonicalPackageName: string;
 *   packageAliases: string[];
 * }}
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

	const maestroMetadata =
		rootPackage.maestro &&
		typeof rootPackage.maestro === "object" &&
		!Array.isArray(rootPackage.maestro)
			? rootPackage.maestro
			: {};
	const canonicalPackageName =
		typeof maestroMetadata.canonicalPackageName === "string" &&
		maestroMetadata.canonicalPackageName.trim().length > 0
			? maestroMetadata.canonicalPackageName
			: name;
	const configuredAliases = isStringArray(maestroMetadata.packageAliases)
		? maestroMetadata.packageAliases
		: [];
	const packageAliases = Array.from(
		new Set([name, canonicalPackageName, ...configuredAliases]),
	);

	return {
		name,
		version,
		cliCommand,
		canonicalPackageName,
		packageAliases,
	};
}

/**
 * @param {"npm" | "bun"} packageManager
 * @param {string} [packageName]
 */
export function getGlobalInstallCommand(packageManager, packageName) {
	const installPackageName = packageName ?? getPackageMetadata().name;
	return `${packageManager} install -g ${installPackageName}`;
}
