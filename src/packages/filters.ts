/**
 * Package Resource Filtering
 *
 * Applies glob patterns to filter resources from packages.
 * Supports wildcards (*) and exclusion patterns (!pattern).
 */

import { minimatch } from "minimatch";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("packages:filters");

/**
 * Apply glob patterns to filter resource names
 *
 * Patterns:
 * - "*" - Include all resources
 * - "pattern*" - Include resources matching pattern
 * - "!pattern" - Exclude resources matching pattern
 *
 * Exclusions are processed after inclusions.
 *
 * @param resources - Resource names to filter
 * @param patterns - Glob patterns to apply
 * @returns Filtered resource names
 */
export function filterResources(
	resources: string[],
	patterns: string[] | undefined,
): string[] {
	if (!patterns || patterns.length === 0) {
		return resources;
	}

	// Separate inclusion and exclusion patterns
	const inclusions: string[] = [];
	const exclusions: string[] = [];

	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			exclusions.push(pattern.slice(1)); // Remove ! prefix
		} else {
			inclusions.push(pattern);
		}
	}

	// If no inclusions, include all by default
	let filtered = resources;

	// Apply inclusions
	if (inclusions.length > 0) {
		filtered = resources.filter((resource) => {
			// Wildcard includes all
			if (inclusions.includes("*")) {
				return true;
			}

			// Check if matches any inclusion pattern
			return inclusions.some((pattern) => minimatch(resource, pattern));
		});
	}

	// Apply exclusions
	if (exclusions.length > 0) {
		filtered = filtered.filter((resource) => {
			// Check if matches any exclusion pattern
			return !exclusions.some((pattern) => minimatch(resource, pattern));
		});
	}

	logger.debug("Filtered resources", {
		original: resources.length,
		filtered: filtered.length,
		patterns,
	});

	return filtered;
}

/**
 * Check if a resource name matches any pattern
 *
 * Handles both inclusion and exclusion patterns correctly by processing
 * them in two separate passes (just like filterResources).
 *
 * @param name - Resource name
 * @param patterns - Glob patterns
 * @returns True if name matches any pattern
 */
export function matchesAnyPattern(name: string, patterns: string[]): boolean {
	if (patterns.length === 0) {
		return false;
	}

	const inclusions = patterns.filter((pattern) => !pattern.startsWith("!"));
	const exclusions = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));

	const matchesInclusion =
		inclusions.length === 0 ||
		inclusions.some((pattern) => minimatch(name, pattern));

	if (!matchesInclusion) {
		return false;
	}

	return !exclusions.some((pattern) => minimatch(name, pattern));
}
