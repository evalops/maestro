/**
 * Package Dependency Extractor
 *
 * Parses shell commands to extract package names from package manager
 * install commands. Supports npm, pnpm, yarn, bun, and pip.
 *
 * ## Use Cases
 *
 * - Security policy: detecting which packages are being installed
 * - Audit logging: recording dependency changes
 * - Supply chain analysis: tracking external dependencies
 *
 * ## Supported Package Managers
 *
 * | Manager | Commands |
 * |---------|----------|
 * | npm     | install, i, add |
 * | pnpm    | install, i, add |
 * | yarn    | install, i, add |
 * | bun     | add, install |
 * | pip     | install |
 *
 * @module utils/dependency-extractor
 */

/**
 * Pattern for npm/pnpm/yarn install commands.
 * Captures package names after the install command, handling flags.
 */
const npmInstallPattern =
	/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s+]+)/i;

/**
 * Pattern for bun add/install commands.
 */
const bunAddPattern =
	/\bbun\s+(?:add|install)\s+(?:--?[a-zA-Z-]+(?:=\S+)?\s+)*([\w@\-/.:\s+]+)/i;

/**
 * Pattern for pip install commands.
 * Supports pip, pip3, etc.
 */
const pipInstallPattern =
	/\bpip\d*\s+install\s+(?:-[a-zA-Z-]+\s+)*([\w@\-/.:\s=<>+]+)/i;

/**
 * Clean a package specifier to extract just the package name.
 *
 * Handles:
 * - URLs (git+, http:, local paths) - returned as-is
 * - Scoped packages (@scope/pkg@version → @scope/pkg)
 * - Versioned packages (pkg@1.0.0 → pkg, pkg==1.0.0 → pkg)
 *
 * @param spec - Package specifier from command
 * @returns Cleaned package name
 */
function cleanPackageSpec(spec: string): string {
	// Handle URLs (git+, http:, etc.) and local paths - return as-is
	if (spec.includes("://") || /^git@/.test(spec) || /^\.{0,2}\//.test(spec)) {
		return spec;
	}

	// Handle scoped packages (e.g. @scope/pkg@version)
	if (spec.startsWith("@")) {
		const versionIndex = spec.indexOf("@", 1);
		return versionIndex === -1 ? spec : spec.substring(0, versionIndex);
	}

	// Handle standard packages (e.g. pkg@1.0.0, pkg==1.0.0, pkg>=1.0.0)
	return spec.split(/[@=<>]/)[0] ?? spec;
}

/**
 * Extract package names from a shell command.
 *
 * Parses package manager install commands (npm, yarn, pnpm, bun, pip)
 * and extracts the package names being installed.
 *
 * @example
 * // npm/yarn/pnpm
 * extractDependencies("npm install lodash express")
 * // Returns: ["lodash", "express"]
 *
 * extractDependencies("yarn add @types/node@18.0.0 --dev")
 * // Returns: ["@types/node"]
 *
 * // bun
 * extractDependencies("bun add zod")
 * // Returns: ["zod"]
 *
 * // pip
 * extractDependencies("pip install requests==2.28.0 flask")
 * // Returns: ["requests", "flask"]
 *
 * // Multiple commands
 * extractDependencies("npm i lodash && pip install requests")
 * // Returns: ["lodash", "requests"]
 *
 * @param command - Shell command to parse
 * @returns Array of package names (without version specifiers)
 */
export function extractDependencies(command: string): string[] {
	const patterns = [npmInstallPattern, bunAddPattern, pipInstallPattern];
	const results: string[] = [];

	for (const pattern of patterns) {
		const matches = command.matchAll(new RegExp(pattern, "gi"));
		for (const match of matches) {
			const captured = match[1];
			if (!captured) continue;
			// Split by spaces and cleanup flags/versions
			const deps = captured
				.split(/\s+/)
				.filter((p) => !p.startsWith("-"))
				.map(cleanPackageSpec)
				.filter((p) => p.length > 0);
			results.push(...deps);
		}
	}
	return results;
}

/**
 * Check if a command contains any package install operations.
 *
 * @param command - Shell command to check
 * @returns true if command contains npm/yarn/pnpm/bun/pip install
 */
export function hasPackageInstall(command: string): boolean {
	return extractDependencies(command).length > 0;
}
