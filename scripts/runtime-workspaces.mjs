#!/usr/bin/env node
// @ts-check

import { loadRootPackage } from "./workspace-utils.js";

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
