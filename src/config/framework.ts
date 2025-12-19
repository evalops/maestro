/**
 * Framework Preferences - Development Framework Configuration
 *
 * This module manages framework preferences for code generation and
 * development assistance. It supports global defaults, workspace-specific
 * settings, policy overrides, and environment variable configuration.
 *
 * ## Supported Frameworks
 *
 * | Framework | Description                                    |
 * |-----------|------------------------------------------------|
 * | fastapi   | Python 3.12 with pydantic v2, uvicorn, pytest  |
 * | express   | Node 20 with TypeScript, zod, vitest           |
 * | node      | Generic Node.js/TypeScript with zod, vitest    |
 *
 * ## Configuration Sources (precedence order)
 *
 * 1. **Policy (locked)**: `~/.composer/policy.json` with `locked: true`
 * 2. **Policy**: `~/.composer/policy.json`
 * 3. **Env override**: `COMPOSER_FRAMEWORK_OVERRIDE`
 * 4. **Env default**: `COMPOSER_DEFAULT_FRAMEWORK`
 * 5. **Workspace**: `.composer/workspace.json`
 * 6. **Global default**: `~/.composer/default-framework.json`
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   resolveFrameworkPreference,
 *   setDefaultFramework,
 *   listFrameworks,
 * } from './framework';
 *
 * // Get active framework preference
 * const { id, source, locked } = resolveFrameworkPreference();
 *
 * // Set default framework
 * setDefaultFramework('fastapi');
 *
 * // List available frameworks
 * const frameworks = listFrameworks();
 * ```
 *
 * @module config/framework
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { PATHS } from "./constants.js";

const WORKSPACE_FILE = ".composer/workspace.json";
const FRAMEWORKS: Record<string, { summary: string }> = {
	fastapi: {
		summary:
			"Preferred framework: FastAPI on Python 3.12. Use pydantic v2, uvicorn, pytest, httpx for tests, and typed routers.",
	},
	express: {
		summary:
			"Preferred framework: Express.js on Node 20. Use TypeScript, zod for validation, vitest, and supertest for HTTP tests.",
	},
	node: {
		summary:
			"Preferred framework: Generic Node.js on TypeScript/Node 20. Use zod for validation, vitest for unit tests, supertest for HTTP, and eslint/biome for linting.",
	},
};

const getDefaultPath = (): string =>
	resolveEnvPath(process.env.COMPOSER_DEFAULT_FRAMEWORK_FILE) ??
	join(PATHS.COMPOSER_HOME, "default-framework.json");

const getPolicyPath = (): string =>
	resolveEnvPath(process.env.COMPOSER_FRAMEWORK_POLICY_FILE) ??
	join(PATHS.COMPOSER_HOME, "policy.json");

const getWorkspacePath = (): string => join(process.cwd(), WORKSPACE_FILE);

interface FrameworkPrefs {
	defaultFramework: string | null;
}

interface FrameworkPolicy {
	framework?: {
		default?: string | null;
		locked?: boolean;
	};
}

const ensureDir = (filePath: string) => {
	mkdirSync(dirname(filePath), { recursive: true });
};

const normalizeId = (id: string | null): string | null =>
	id?.trim().toLowerCase() ?? null;

const coerceNoneToNull = (id: string | null): string | null => {
	const normalized = normalizeId(id);
	if (normalized === "none" || normalized === "off") return null;
	return normalized;
};

const assertFrameworkAllowed = (id: string | null) => {
	const normalized = coerceNoneToNull(id);
	if (!normalized) return;
	if (!FRAMEWORKS[normalized]) {
		const available = Object.keys(FRAMEWORKS).sort().join(", ");
		throw new Error(
			`Unknown framework "${id}". Available options: ${available}. Use "none" to clear.`,
		);
	}
};

const getEnvOverride = (): string | null =>
	coerceNoneToNull(process.env.COMPOSER_FRAMEWORK_OVERRIDE ?? null);

export function getDefaultFramework(): string | null {
	if (process.env.COMPOSER_DEFAULT_FRAMEWORK) {
		return coerceNoneToNull(process.env.COMPOSER_DEFAULT_FRAMEWORK);
	}
	try {
		const raw = readFileSync(getDefaultPath(), "utf8");
		const parsed = JSON.parse(raw) as FrameworkPrefs;
		return coerceNoneToNull(parsed.defaultFramework ?? null);
	} catch {
		return null;
	}
}

export function setDefaultFramework(framework: string | null): void {
	const normalized = coerceNoneToNull(framework);
	assertFrameworkAllowed(normalized);
	const policy = getPolicyFramework();
	if (policy.locked) {
		throw new Error(
			`Framework preference is locked by policy (${policy.id ?? "unspecified"}).`,
		);
	}
	const targetPath = getDefaultPath();
	ensureDir(targetPath);
	const data: FrameworkPrefs = { defaultFramework: normalized };
	writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf8");
}

export function getFrameworkInfo(
	id: string,
): { id: string; summary: string } | null {
	const lower = normalizeId(id);
	if (!lower) return null;
	const info = FRAMEWORKS[lower];
	if (!info) return null;
	return { id: lower, summary: info.summary };
}

export function listFrameworks(): { id: string; summary: string }[] {
	return Object.entries(FRAMEWORKS)
		.map(([id, info]) => ({ id, summary: info.summary }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function validateFrameworkPreference(): string | null {
	const pref = resolveFrameworkPreference();
	if (!pref.id) return null;
	const info = getFrameworkInfo(pref.id);
	if (info) return null;
	const available = Object.keys(FRAMEWORKS).sort().join(", ");
	return `Unknown framework "${pref.id}" from ${pref.source}. Available options: ${available}. Use /framework none to clear.`;
}

export function getFrameworkSummary(
	id: string | null,
): { id: string; summary: string } | null {
	if (!id) return null;
	const normalized = normalizeId(id);
	if (!normalized) return null;
	const info = getFrameworkInfo(normalized);
	if (!info) {
		const available = Object.keys(FRAMEWORKS).sort().join(", ");
		throw new Error(
			`Unknown framework "${id}". Available options: ${available}. Use "none" to clear.`,
		);
	}
	return info;
}

export function getPolicyFramework(): { id: string | null; locked: boolean } {
	try {
		const raw = readFileSync(getPolicyPath(), "utf8");
		const parsed = JSON.parse(raw) as FrameworkPolicy;
		const id = coerceNoneToNull(parsed.framework?.default ?? null);
		const locked = parsed.framework?.locked === true;
		return { id, locked };
	} catch {
		return { id: null, locked: false };
	}
}

export function getWorkspaceFramework(): string | null {
	try {
		const raw = readFileSync(getWorkspacePath(), "utf8");
		const parsed = JSON.parse(raw) as FrameworkPrefs;
		return coerceNoneToNull(parsed.defaultFramework ?? null);
	} catch {
		return null;
	}
}

export function setWorkspaceFramework(framework: string | null): void {
	const normalized = coerceNoneToNull(framework);
	assertFrameworkAllowed(normalized);
	const policy = getPolicyFramework();
	if (policy.locked) {
		throw new Error(
			`Framework preference is locked by policy (${policy.id ?? "unspecified"}).`,
		);
	}
	const targetPath = getWorkspacePath();
	ensureDir(targetPath);
	const data: FrameworkPrefs = { defaultFramework: normalized };
	writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf8");
}

export function resolveFrameworkPreference(): {
	id: string | null;
	source: string;
	locked: boolean;
} {
	const policy = getPolicyFramework();
	if (policy.locked) {
		return {
			id: policy.id,
			source: "policy (locked)",
			locked: true,
		};
	}

	if (policy.id) {
		return { id: policy.id, source: "policy", locked: false };
	}

	const envOverride = getEnvOverride();
	if (envOverride) {
		return { id: envOverride, source: "env override", locked: false };
	}

	if (process.env.COMPOSER_DEFAULT_FRAMEWORK) {
		return {
			id: normalizeId(process.env.COMPOSER_DEFAULT_FRAMEWORK),
			source: "env",
			locked: false,
		};
	}

	const workspacePref = getWorkspaceFramework();
	if (workspacePref) {
		return { id: workspacePref, source: WORKSPACE_FILE, locked: false };
	}

	const filePref = getDefaultFramework();
	if (filePref) {
		return { id: filePref, source: getDefaultPath(), locked: false };
	}

	return { id: null, source: "none", locked: false };
}
