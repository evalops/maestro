import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const spec = JSON.parse(readFileSync("openapi.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

interface OpenApiParameter {
	name: string;
	in: string;
	required?: boolean;
}

describe("OpenAPI spec", () => {
	it("keeps version in sync with package.json", () => {
		expect(spec.info.version).toBe(pkg.version);
	});

	it("documents sessions path parameter", () => {
		const getSession = spec.paths?.["/api/sessions/{id}"]?.get;
		expect(getSession).toBeTruthy();
		expect(
			getSession.parameters?.some(
				(p: OpenApiParameter) =>
					p.name === "id" && p.in === "path" && p.required,
			),
		).toBe(true);
	});

	it("applies API key security to protected endpoints", () => {
		const modelsGet = spec.paths?.["/api/models"]?.get;
		expect(modelsGet?.security?.[0]).toEqual({ ComposerApiKey: [] });
	});

	it("describes session schemas accurately", () => {
		const { Session, SessionSummary, SessionsResponse } =
			spec.components.schemas;
		expect(Session).toBeDefined();
		expect(SessionSummary).toBeDefined();
		expect(Session.required).toEqual(
			expect.arrayContaining(["id", "messages", "messageCount"]),
		);
		expect(Session.properties.messages).toBeDefined();
		expect(SessionSummary.required).toEqual(
			expect.arrayContaining(["id", "messageCount"]),
		);
		const sessionsItems = SessionsResponse.properties.sessions.items?.$ref;
		expect(sessionsItems).toBe("#/components/schemas/SessionSummary");
	});

	it("documents session mutation responses", () => {
		const postSession = spec.paths?.["/api/sessions"]?.post;
		const deleteSession = spec.paths?.["/api/sessions/{id}"]?.delete;
		expect(postSession?.responses?.[201]).toBeTruthy();
		expect(
			postSession?.responses?.[201]?.content?.["application/json"]?.schema
				?.$ref,
		).toBe("#/components/schemas/Session");
		expect(deleteSession?.responses?.[204]).toBeTruthy();
	});
});
