import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import {
	pipelineCreateSignalTool,
	pipelineLogActivityTool,
	pipelineSearchContactsTool,
	pipelineSearchDealsTool,
} from "../../src/tools/pipeline.js";

const originalEnv = { ...process.env };

function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("pipeline tools", () => {
	beforeEach(() => {
		process.env = {
			...originalEnv,
			PIPELINE_API_URL: "https://pipeline.internal",
			PIPELINE_SERVICE_TOKEN: "test-token",
		};
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("requires pipeline configuration", async () => {
		process.env.PIPELINE_API_URL = "";

		await expect(
			pipelineSearchContactsTool.execute("pipeline-1", { name: "Jane" }),
		).rejects.toThrow(
			"Pipeline CRM is not configured. Set PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
		);
	});

	it("searches contacts with bearer auth and query params", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							id: "contact-1",
							first_name: "Jane",
							last_name: "Smith",
							email: "jane@acme.com",
							title: "VP Engineering",
							stage: "qualified",
						},
					],
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pipelineSearchContactsTool.execute("pipeline-2", {
			query: "Jane",
			stage: "qualified",
			limit: 5,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://pipeline.internal/api/v1/contacts?name=Jane&stage=qualified&limit=5",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
				}),
			}),
		);
		expect(getTextOutput(result)).toContain("Found 1 Pipeline contact");
		expect(result.details).toEqual({
			contacts: [
				expect.objectContaining({
					id: "contact-1",
					name: "Jane Smith",
					email: "jane@acme.com",
					stage: "qualified",
				}),
			],
			count: 1,
		});
	});

	it("searches deals with structured filters", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							id: "deal-1",
							title: "Acme Renewal",
							stage: "proposal",
							value: 250000,
							currency: "USD",
							company_id: "company-1",
						},
					],
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pipelineSearchDealsTool.execute("pipeline-3", {
			stage: "proposal",
			companyId: "company-1",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://pipeline.internal/api/v1/deals?stage=proposal&company_id=company-1&limit=10",
			expect.objectContaining({
				method: "GET",
			}),
		);
		expect(getTextOutput(result)).toContain("Found 1 Pipeline deal");
		expect(result.details).toEqual({
			deals: [
				expect.objectContaining({
					id: "deal-1",
					title: "Acme Renewal",
					stage: "proposal",
					companyId: "company-1",
				}),
			],
			count: 1,
		});
	});

	it("creates signals with idempotency and merged summary payload", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "signal-1" }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pipelineCreateSignalTool.execute("pipeline-4", {
			ownerType: "company",
			ownerId: "company-1",
			signalType: "product_release",
			source: "maestro",
			summary: "Feature X shipped for Acme",
			data: { release: "Feature X" },
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://pipeline.internal/api/v1/signals",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
					"Idempotency-Key": expect.any(String),
				}),
				body: JSON.stringify({
					owner_type: "company",
					owner_id: "company-1",
					signal_type: "product_release",
					source: "maestro",
					data: {
						summary: "Feature X shipped for Acme",
						release: "Feature X",
					},
				}),
			}),
		);
		expect(getTextOutput(result)).toContain("Created Pipeline signal signal-1");
	});

	it("logs activities with outbound direction by default", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "activity-1" }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await pipelineLogActivityTool.execute("pipeline-5", {
			ownerType: "contact",
			ownerId: "contact-1",
			activityType: "email_sent",
			channel: "email",
			subject: "Feature X shipped",
			body: "Relevant for Acme renewal",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://pipeline.internal/api/v1/activities",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"Idempotency-Key": expect.any(String),
				}),
				body: JSON.stringify({
					owner_type: "contact",
					owner_id: "contact-1",
					activity_type: "email_sent",
					channel: "email",
					direction: "outbound",
					subject: "Feature X shipped",
					body: "Relevant for Acme renewal",
				}),
			}),
		);
		expect(getTextOutput(result)).toContain(
			"Logged Pipeline activity activity-1 for contact contact-1.",
		);
	});
});
