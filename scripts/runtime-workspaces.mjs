#!/usr/bin/env node
// @ts-check

import { getWorkspacePackages, loadRootPackage } from "./workspace-utils.js";

/**
 * @param {Record<string, unknown>} rootPackage
 * @returns {string[]}
 */
export function getRuntimeWorkspaceNames(rootPackage = loadRootPackage()) {
	const value = rootPackage.maestroRuntimeWorkspaces;
	if (!Array.isArray(value)) {
		return [];
	}

	return Array.from(
		new Set(value.filter((item) => typeof item === "string" && item.length > 0)),
	).sort();
}

/**
 * @param {Record<string, unknown>} rootPackage
 */
export async function getRuntimeWorkspacePackages(rootPackage = loadRootPackage()) {
	const names = getRuntimeWorkspaceNames(rootPackage);
	const workspacePackages = await getWorkspacePackages(rootPackage);
	const packagesByName = new Map(
		workspacePackages.map((workspacePackage) => [
			workspacePackage.name,
			workspacePackage,
		]),
	);
	const missing = names.filter((name) => !packagesByName.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Runtime workspace package(s) are missing from workspaces: ${missing.join(", ")}`,
		);
	}

	return names.map((name) => packagesByName.get(name));
}
