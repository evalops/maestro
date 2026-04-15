/**
 * Package Discovery
 *
 * Discovers and validates maestro packages from the filesystem.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { DiscoveredPackage, PackageJson } from "./types.js";

const logger = createLogger("packages:discovery");

/**
 * Discover a maestro package at the given path
 *
 * @param packagePath - Path to package directory
 * @returns Discovered package info or null if invalid
 */
export function discoverPackage(packagePath: string): DiscoveredPackage | null {
	const packageJsonPath = join(packagePath, "package.json");

	if (!existsSync(packageJsonPath)) {
		logger.debug("No package.json found", { path: packagePath });
		return null;
	}

	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const packageJson = JSON.parse(content) as PackageJson;

		// Validate required fields
		if (!packageJson.name) {
			return {
				path: packagePath,
				packageJson,
				isMaestroPackage: false,
				errors: ["Package name is required"],
			};
		}

		// Check for maestro-package keyword
		const isMaestroPackage =
			packageJson.keywords?.includes("maestro-package") ?? false;

		// Validate maestro manifest if present
		const errors: string[] = [];
		if (packageJson.maestro) {
			const manifest = packageJson.maestro;

			// Validate that resource paths are arrays
			for (const key of [
				"extensions",
				"skills",
				"prompts",
				"themes",
			] as const) {
				if (manifest[key] !== undefined && !Array.isArray(manifest[key])) {
					errors.push(`maestro.${key} must be an array`);
				}
			}
		}

		logger.debug("Discovered package", {
			name: packageJson.name,
			version: packageJson.version,
			isMaestroPackage,
			hasManifest: !!packageJson.maestro,
		});

		return {
			path: packagePath,
			packageJson,
			isMaestroPackage,
			errors: errors.length > 0 ? errors : undefined,
		};
	} catch (error) {
		logger.warn("Failed to parse package.json", {
			path: packageJsonPath,
			error,
		});
		return null;
	}
}

/**
 * Check if a directory contains a valid maestro package
 *
 * @param packagePath - Path to check
 * @returns True if valid maestro package
 */
export function isValidMaestroPackage(packagePath: string): boolean {
	const discovered = discoverPackage(packagePath);
	return (
		(discovered?.isMaestroPackage ?? false) &&
		(discovered?.errors?.length ?? 0) === 0
	);
}
