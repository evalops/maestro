import { readFile } from "node:fs/promises";
import {
	assertHeadlessFromAgentMessage,
	assertHeadlessToAgentMessage,
} from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import {
	HEADLESS_PROTOCOL_VERSION,
	HEADLESS_SERVER_CAPABILITIES,
} from "../../src/cli/headless-protocol.js";

type FixtureDirection = "client_to_agent" | "agent_to_client";

interface FixtureStep {
	direction: FixtureDirection;
	message: Record<string, unknown>;
}

interface HeadlessConformanceFixture {
	schema_version: number;
	name: string;
	description: string;
	steps: FixtureStep[];
}

const FIXTURE_PATH = new URL(
	"../fixtures/headless/conformance-v1.json",
	import.meta.url,
);

async function readFixture(): Promise<HeadlessConformanceFixture> {
	return JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
}

function findStep(
	fixture: HeadlessConformanceFixture,
	type: string,
	direction?: FixtureDirection,
): number {
	return fixture.steps.findIndex(
		(step) =>
			step.message.type === type &&
			(!direction || step.direction === direction),
	);
}

function expectStepOrder(
	fixture: HeadlessConformanceFixture,
	orderedTypes: string[],
) {
	const indexes = orderedTypes.map((type) => {
		const index = findStep(fixture, type);
		expect(index, `missing fixture step: ${type}`).toBeGreaterThanOrEqual(0);
		return index;
	});

	for (let index = 1; index < indexes.length; index += 1) {
		expect(
			indexes[index],
			`${orderedTypes[index]} should follow previous step`,
		).toBeGreaterThan(indexes[index - 1]);
	}
}

describe("headless protocol conformance fixture", () => {
	it("keeps the canonical transcript schema-valid", async () => {
		const fixture = await readFixture();

		expect(fixture).toMatchObject({
			schema_version: 1,
			name: "headless-conformance-v1",
		});
		expect(fixture.steps.length).toBeGreaterThan(0);

		for (const [index, step] of fixture.steps.entries()) {
			expect(
				["client_to_agent", "agent_to_client"],
				`step ${index} direction`,
			).toContain(step.direction);
			if (step.direction === "client_to_agent") {
				expect(() =>
					assertHeadlessToAgentMessage(step.message, `fixture step ${index}`),
				).not.toThrow();
			} else {
				expect(() =>
					assertHeadlessFromAgentMessage(step.message, `fixture step ${index}`),
				).not.toThrow();
			}
		}
	});

	it("pins handshake capabilities to the runtime contract", async () => {
		const fixture = await readFixture();
		const hello =
			fixture.steps[findStep(fixture, "hello", "client_to_agent")]?.message;
		const helloOk =
			fixture.steps[findStep(fixture, "hello_ok", "agent_to_client")]?.message;

		expect(hello).toMatchObject({
			type: "hello",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			role: "controller",
		});
		expect(helloOk).toMatchObject({
			type: "hello_ok",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			client_protocol_version: HEADLESS_PROTOCOL_VERSION,
			role: "controller",
			server_capabilities: HEADLESS_SERVER_CAPABILITIES,
		});
	});

	it("marks canonical ready messages as live executor runs", async () => {
		const fixture = await readFixture();
		const ready =
			fixture.steps[findStep(fixture, "ready", "agent_to_client")]?.message;

		expect(ready).toMatchObject({
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			executor_type: "live",
		});
	});

	it("covers a complete prompt through approval, retry, and result lifecycle", async () => {
		const fixture = await readFixture();

		expectStepOrder(fixture, [
			"hello",
			"hello_ok",
			"ready",
			"init",
			"prompt",
			"response_start",
			"server_request",
			"server_request_response",
			"server_request_resolved",
			"response_chunk",
			"response_end",
		]);

		const serverRequests = fixture.steps.filter(
			(step) =>
				step.direction === "agent_to_client" &&
				step.message.type === "server_request",
		);
		const requestIds = serverRequests.map((step) => step.message.request_id);
		expect(serverRequests.map((step) => step.message.request_type)).toEqual([
			"approval",
			"tool_retry",
		]);

		expect(new Set(requestIds).size, "unique server request ids").toBe(
			requestIds.length,
		);

		const serverRequestResponses = fixture.steps
			.map((step, index) => ({ index, step }))
			.filter(
				({ step }) =>
					step.direction === "client_to_agent" &&
					step.message.type === "server_request_response",
			);
		const serverRequestResolutions = fixture.steps
			.map((step, index) => ({ index, step }))
			.filter(
				({ step }) =>
					step.direction === "agent_to_client" &&
					step.message.type === "server_request_resolved",
			);
		const responseIds = serverRequestResponses.map(
			({ step }) => step.message.request_id,
		);
		const resolutionIds = serverRequestResolutions.map(
			({ step }) => step.message.request_id,
		);
		const expectedRequestIds = [...requestIds].sort();

		expect([...responseIds].sort(), "matched response ids").toEqual(
			expectedRequestIds,
		);
		expect(new Set(responseIds).size, "unique response ids").toBe(
			responseIds.length,
		);
		expect([...resolutionIds].sort(), "matched resolution ids").toEqual(
			expectedRequestIds,
		);
		expect(new Set(resolutionIds).size, "unique resolution ids").toBe(
			resolutionIds.length,
		);

		const responsesByRequestId = new Map(
			serverRequestResponses.map(({ index, step }) => [
				step.message.request_id,
				{ index, step },
			]),
		);
		const resolutionsByRequestId = new Map(
			serverRequestResolutions.map(({ index, step }) => [
				step.message.request_id,
				{ index, step },
			]),
		);

		for (const request of serverRequests) {
			const requestId = request.message.request_id;
			const response = responsesByRequestId.get(requestId);
			const resolution = resolutionsByRequestId.get(requestId);
			const requestIndex = fixture.steps.indexOf(request);

			expect(response, `${requestId} response`).toBeDefined();
			expect(resolution, `${requestId} resolution`).toBeDefined();
			expect(response?.step.message.request_type).toBe(
				request.message.request_type,
			);
			expect(resolution?.step.message.request_type).toBe(
				request.message.request_type,
			);
			expect(resolution?.step.message.call_id).toBe(request.message.call_id);
			expect(
				response?.index,
				`${requestId} response should follow request`,
			).toBeGreaterThan(requestIndex);
			expect(
				resolution?.index,
				`${requestId} resolution should follow response`,
			).toBeGreaterThan(response?.index ?? -1);
		}

		const retryRequest = serverRequests.find(
			(step) => step.message.request_type === "tool_retry",
		);
		expect(
			retryRequest,
			"fixture should include a retry request",
		).toBeDefined();
		const retryCallId = retryRequest?.message.call_id;
		const retryRequestIndex = fixture.steps.indexOf(
			retryRequest as FixtureStep,
		);
		const postRetryToolEvents = fixture.steps
			.slice(retryRequestIndex + 1)
			.filter(
				(step) =>
					step.direction === "agent_to_client" &&
					["tool_start", "tool_output", "tool_end"].includes(
						String(step.message.type),
					),
			);
		expect(postRetryToolEvents.length).toBeGreaterThan(0);
		for (const toolEvent of postRetryToolEvents) {
			expect(toolEvent.message.call_id).toBe(retryCallId);
		}

		expect(
			fixture.steps.at(-1)?.message,
			"fixture should terminate with a completed response",
		).toMatchObject({
			type: "response_end",
			response_id: "resp_conformance_1",
			tools_summary: {
				tools_used: ["bash"],
				calls_succeeded: 1,
				calls_failed: 1,
			},
		});
	});
});
