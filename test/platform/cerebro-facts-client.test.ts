import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherMaestroSessionFactsContext } from "../../src/platform/cerebro-facts-client.js";

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: undefined;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("cerebro facts client", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches thing details in parallel after search", async () => {
		const firstThing = createDeferred<Response>();
		const secondThing = createDeferred<Response>();
		const getThingOrder: string[] = [];
		const listChangesStarted = vi.fn();

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = headersToRecord(init?.headers);
				const body = parseRequestBody(init?.body);

				expect(headers["content-type"]).toBe("application/json");

				if (url.endsWith("/cerebro.v1.CerebroService/Search")) {
					return Response.json({
						things: [{ id: "thing-1" }, { id: "thing-2" }],
					});
				}

				if (url.endsWith("/cerebro.v1.CerebroService/GetThing")) {
					const thingId = body?.thingId;
					if (thingId === "thing-1") {
						getThingOrder.push("thing-1");
						return firstThing.promise;
					}
					if (thingId === "thing-2") {
						getThingOrder.push("thing-2");
						return secondThing.promise;
					}
				}

				if (url.endsWith("/cerebro.v1.CerebroService/ListChanges")) {
					listChangesStarted();
					return Response.json({
						changes: [{ id: "change-1", thingId: "thing-1" }],
					});
				}

				return new Response("unexpected endpoint", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const contextPromise = gatherMaestroSessionFactsContext(
			{
				workspaceId: "ws_1",
				factsQuery: "pipeline regressions",
			},
			{
				config: {
					baseUrl: "https://cerebro.test",
					timeoutMs: 1_500,
					maxAttempts: 1,
					searchLimit: 5,
					changeLimit: 10,
				},
			},
		);

		await vi.waitFor(() =>
			expect(getThingOrder).toEqual(["thing-1", "thing-2"]),
		);
		expect(listChangesStarted).not.toHaveBeenCalled();

		secondThing.resolve(
			Response.json({
				thing: { id: "thing-2", name: "Thing 2" },
				facts: [{ id: "fact-2", subjectThingId: "thing-2" }],
				recentEvents: [{ id: "event-2" }],
				evidence: [{ id: "evidence-2" }],
			}),
		);
		await Promise.resolve();
		expect(listChangesStarted).not.toHaveBeenCalled();

		firstThing.resolve(
			Response.json({
				thing: { id: "thing-1", name: "Thing 1" },
				facts: [{ id: "fact-1", subjectThingId: "thing-1" }],
				recentEvents: [{ id: "event-1" }],
				evidence: [{ id: "evidence-1" }],
			}),
		);

		await expect(contextPromise).resolves.toMatchObject({
			thingIds: ["thing-1", "thing-2"],
			factIds: expect.arrayContaining(["fact-1", "fact-2"]),
			changes: [{ id: "change-1", thingId: "thing-1" }],
		});
		expect(listChangesStarted).toHaveBeenCalledOnce();
	});
});
