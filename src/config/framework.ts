import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH =
	process.env.COMPOSER_DEFAULT_FRAMEWORK_FILE ??
	join(homedir(), ".composer", "default-framework.json");

interface FrameworkPrefs {
	defaultFramework: string | null;
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
