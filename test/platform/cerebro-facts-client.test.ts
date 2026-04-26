import { describe, expect, it, vi } from "vitest";
import { gatherMaestroSessionFactsContext } from "../../src/platform/cerebro-facts-client.js";

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: {};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cerebro facts client", () => {
	it("loads independent thing details in parallel while preserving fact order", async () => {
		let activeGetThingRequests = 0;
		let maxActiveGetThingRequests = 0;
		const getThingOrder: string[] = [];

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body = parseRequestBody(init?.body);

				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					return Response.json({
						things: [{ id: "thing_a" }, { id: "thing_b" }],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/GetThing")) {
					const thingId = body.thingId as string;
					getThingOrder.push(thingId);
					activeGetThingRequests += 1;
					maxActiveGetThingRequests = Math.max(
						maxActiveGetThingRequests,
						activeGetThingRequests,
					);
					try {
						await delay(thingId === "thing_a" ? 20 : 1);
						return Response.json({
							thing: { id: thingId, name: thingId.toUpperCase() },
							facts: [
								{ id: `fact_${thingId.at(-1)}`, subjectThingId: thingId },
							],
						});
					} finally {
						activeGetThingRequests -= 1;
					}
				}

				if (url.endsWith("/cerebro.v1.CerebroService/ListChanges")) {
					return Response.json({ changes: [] });
				}

				return new Response("unexpected endpoint", { status: 404 });
			},
		);

		const context = await gatherMaestroSessionFactsContext(
			{
				sessionId: "session_1",
				workspaceId: "workspace_1",
				factsQuery: "triage pipeline regressions",
			},
			{
				config: {
					baseUrl: "https://cerebro.test",
					timeoutMs: 1_000,
					maxAttempts: 1,
					searchLimit: 2,
					changeLimit: 10,
					fetchImpl: fetchMock,
				},
			},
		);

		expect(getThingOrder).toEqual(["thing_a", "thing_b"]);
		expect(maxActiveGetThingRequests).toBe(2);
		expect(context?.thingIds).toEqual(["thing_a", "thing_b"]);
		expect(context?.factIds).toEqual(["fact_a", "fact_b"]);
	});
});
