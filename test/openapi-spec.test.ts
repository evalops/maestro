import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const spec = JSON.parse(readFileSync("openapi.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

describe("OpenAPI spec", () => {
	it("keeps version in sync with package.json", () => {
		expect(spec.info.version).toBe(pkg.version);
	});

	it("documents sessions path parameter", () => {
		const getSession = spec.paths?.["/api/sessions/{id}"]?.get;
		expect(getSession).toBeTruthy();
		expect(
			getSession.parameters?.some(
				(p: any) => p.name === "id" && p.in === "path" && p.required,
			),
		).toBe(true);
	});

	it("applies API key security to protected endpoints", () => {
		const modelsGet = spec.paths?.["/api/models"]?.get;
		expect(modelsGet?.security?.[0]).toEqual({ ComposerApiKey: [] });
	});

	it("includes referenced schemas for sessions", () => {
		expect(spec.components.schemas.Session).toBeDefined();
		expect(spec.components.schemas.SessionsResponse).toBeDefined();
	});
});
