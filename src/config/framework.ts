import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH =
	process.env.COMPOSER_DEFAULT_FRAMEWORK_FILE ??
	join(homedir(), ".composer", "default-framework.json");
const POLICY_PATH =
	process.env.COMPOSER_FRAMEWORK_POLICY_FILE ??
	join(homedir(), ".composer", "policy.json");
const ENV_OVERRIDE = process.env.COMPOSER_FRAMEWORK_OVERRIDE;
const WORKSPACE_FILE = ".composer/workspace.json";

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

export function getDefaultFramework(): string | null {
	if (process.env.COMPOSER_DEFAULT_FRAMEWORK) {
		return process.env.COMPOSER_DEFAULT_FRAMEWORK;
	}
	try {
		const raw = readFileSync(DEFAULT_PATH, "utf8");
		const parsed = JSON.parse(raw) as FrameworkPrefs;
		return parsed.defaultFramework ?? null;
	} catch {
		return null;
	}
}

export function setDefaultFramework(framework: string | null): void {
	const policy = getPolicyFramework();
	if (policy.locked) {
		throw new Error(
			`Framework preference is locked by policy (${policy.id ?? "unspecified"}).`,
		);
	}
	ensureDir(DEFAULT_PATH);
	const data: FrameworkPrefs = { defaultFramework: framework };
	writeFileSync(DEFAULT_PATH, JSON.stringify(data, null, 2), "utf8");
}

export function getFrameworkInfo(
	id: string,
): { id: string; summary: string } | null {
	const lower = id.toLowerCase();
	if (lower === "fastapi") {
		return {
			id: "fastapi",
			summary:
				"Preferred framework: FastAPI on Python 3.12. Use pydantic v2, uvicorn, pytest, httpx for tests, and typed routers.",
		};
	}
	if (lower === "express") {
		return {
			id: "express",
			summary:
				"Preferred framework: Express.js on Node 20. Use TypeScript, zod for validation, vitest, and supertest for HTTP tests.",
		};
	}
	return null;
}

export function getPolicyFramework(): { id: string | null; locked: boolean } {
	try {
		const raw = readFileSync(POLICY_PATH, "utf8");
		const parsed = JSON.parse(raw) as FrameworkPolicy;
		const id = parsed.framework?.default ?? null;
		const locked = parsed.framework?.locked === true;
		return { id, locked };
	} catch {
		return { id: null, locked: false };
	}
}

export function resolveFrameworkPreference(): {
	id: string | null;
	source: string;
	locked: boolean;
} {
	const policy = getPolicyFramework();
	if (policy.id) {
		return {
			id: policy.id,
			source: policy.locked ? "policy (locked)" : "policy",
			locked: policy.locked,
		};
	}

	if (ENV_OVERRIDE) {
		return { id: ENV_OVERRIDE, source: "env override", locked: false };
	}

	if (process.env.COMPOSER_DEFAULT_FRAMEWORK) {
		return {
			id: process.env.COMPOSER_DEFAULT_FRAMEWORK,
			source: "env",
			locked: false,
		};
	}

	// Workspace-scoped file (if present)
	try {
		const raw = readFileSync(WORKSPACE_FILE, "utf8");
		const parsed = JSON.parse(raw) as FrameworkPrefs;
		if (parsed.defaultFramework) {
			return {
				id: parsed.defaultFramework,
				source: WORKSPACE_FILE,
				locked: false,
			};
		}
	} catch {
		// ignore missing/invalid workspace file
	}

	const filePref = getDefaultFramework();
	if (filePref) {
		return { id: filePref, source: DEFAULT_PATH, locked: false };
	}

	return { id: null, source: "none", locked: false };
}
