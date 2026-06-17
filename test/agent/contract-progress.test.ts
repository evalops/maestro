import { describe, expect, it } from "vitest";
import {
	CONTRACT_PROGRESS_VERSION,
	buildContractProgress,
	unfinishedAreas,
	unfinishedFlows,
} from "../../src/agent/contract-progress.js";
import type {
	Assertion,
	AssertionStatus,
	ValidationContract,
} from "../../src/agent/validation-contract.js";

function makeAssertion(
	id: string,
	status: AssertionStatus,
	overrides: Partial<Assertion> = {},
): Assertion {
	return {
		id,
		description: `assertion ${id}`,
		status,
		...overrides,
	};
}

function makeContract(): ValidationContract {
	return {
		version: 1,
		id: "test-contract",
		surface: "ui",
		title: "Test contract",
		createdAt: "2026-06-15T18:00:00.000Z",
		updatedAt: "2026-06-15T18:00:00.000Z",
		areas: [
			{
				name: "auth",
				assertions: [
					makeAssertion("a-1", "passed"),
					makeAssertion("a-2", "passed"),
					makeAssertion("a-3", "pending"),
					makeAssertion("a-4", "failed"),
				],
			},
			{
				name: "dashboard",
				assertions: [
					makeAssertion("d-1", "in-progress"),
					makeAssertion("d-2", "pending"),
				],
			},
		],
		crossAreaFlows: [
			{
				name: "login-then-deep-link",
				description: "User follows a deep link, redirects to login, returns",
				assertions: [
					makeAssertion("flow-1", "pending"),
					makeAssertion("flow-2", "passed"),
				],
			},
		],
	};
}

describe("agent/contract-progress", () => {
	describe("buildContractProgress", () => {
		it("returns a versioned report with overall + per-area counts", () => {
			const report = buildContractProgress(makeContract());
			expect(report.version).toBe(CONTRACT_PROGRESS_VERSION);
			expect(report.contractId).toBe("test-contract");
			// 4 + 2 + 2 = 8 total assertions across areas + flows.
			expect(report.counts.total).toBe(8);
			expect(report.counts.passed).toBe(3);
			expect(report.counts.pending).toBe(3);
			expect(report.counts["in-progress"]).toBe(1);
			expect(report.counts.failed).toBe(1);
		});

		it("computes percentComplete as passed/total clamped to [0,1]", () => {
			const report = buildContractProgress(makeContract());
			expect(report.percentComplete).toBeCloseTo(3 / 8);
			const authArea = report.areas.find((a) => a.name === "auth");
			expect(authArea?.percentComplete).toBeCloseTo(2 / 4);
		});

		it("returns 0% complete (not NaN) when an area has 0 assertions", () => {
			const contract: ValidationContract = {
				...makeContract(),
				areas: [{ name: "empty", assertions: [] }],
				crossAreaFlows: [],
			};
			const report = buildContractProgress(contract);
			expect(report.areas[0]?.percentComplete).toBe(0);
			expect(report.percentComplete).toBe(0);
			expect(report.counts.total).toBe(0);
		});

		it("populates nextToDo with pending + in-progress assertions, area then flow order", () => {
			const report = buildContractProgress(makeContract(), {
				nextToDoLimit: 10,
			});
			// `failed` and `passed` excluded; nextToDo holds the others
			// in area order, then flow order.
			expect(report.nextToDo.map((p) => p.id)).toEqual([
				"a-3", // pending in auth
				"d-1", // in-progress in dashboard
				"d-2", // pending in dashboard
				"flow-1", // pending in flow
			]);
		});

		it("caps nextToDo at nextToDoLimit", () => {
			const report = buildContractProgress(makeContract(), {
				nextToDoLimit: 2,
			});
			expect(report.nextToDo).toHaveLength(2);
			expect(report.nextToDo.map((p) => p.id)).toEqual(["a-3", "d-1"]);
		});

		it("collects every failed assertion into `failing` regardless of limit", () => {
			const report = buildContractProgress(makeContract(), {
				nextToDoLimit: 0,
			});
			expect(report.nextToDo).toEqual([]);
			expect(report.failing).toHaveLength(1);
			expect(report.failing[0]?.id).toBe("a-4");
		});

		it("flows enter the `flows` field, not the `areas` field", () => {
			const report = buildContractProgress(makeContract());
			expect(report.flows.map((f) => f.name)).toEqual(["login-then-deep-link"]);
			expect(report.areas.map((a) => a.name)).toEqual(["auth", "dashboard"]);
		});

		it("tags flow assertion pointers with both areaName and flowName", () => {
			const report = buildContractProgress(makeContract());
			const flowEntry = report.nextToDo.find((p) => p.id === "flow-1");
			expect(flowEntry?.areaName).toBe("login-then-deep-link");
			expect(flowEntry?.flowName).toBe("login-then-deep-link");
		});

		it("throws on a malformed status string", () => {
			const contract: ValidationContract = {
				...makeContract(),
				areas: [
					{
						name: "x",
						assertions: [
							makeAssertion("a-1", "ghost" as unknown as AssertionStatus),
						],
					},
				],
				crossAreaFlows: [],
			};
			expect(() => buildContractProgress(contract)).toThrow(
				/unknown status "ghost"/,
			);
		});

		it("throws on a negative nextToDoLimit", () => {
			expect(() =>
				buildContractProgress(makeContract(), { nextToDoLimit: -1 }),
			).toThrow(/nextToDoLimit must be a non-negative integer/);
		});

		it("passes through evidence from the assertion to the pointer", () => {
			const contract: ValidationContract = {
				...makeContract(),
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "pending", {
								evidence: "test/auth/login.test.ts",
							}),
						],
					},
				],
				crossAreaFlows: [],
			};
			const report = buildContractProgress(contract);
			expect(report.nextToDo[0]?.evidence).toBe("test/auth/login.test.ts");
		});
	});

	describe("unfinishedAreas / unfinishedFlows", () => {
		it("returns areas / flows that have assertions and are not 100% complete", () => {
			const contract: ValidationContract = {
				...makeContract(),
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "passed"),
							makeAssertion("a-2", "pending"),
						],
					},
					{
						name: "done",
						assertions: [makeAssertion("d-1", "passed")],
					},
					{ name: "empty", assertions: [] },
				],
				crossAreaFlows: [
					{
						name: "f1",
						description: "x",
						assertions: [makeAssertion("f-1", "pending")],
					},
				],
			};
			const report = buildContractProgress(contract);
			expect(unfinishedAreas(report).map((a) => a.name)).toEqual(["auth"]);
			expect(unfinishedFlows(report).map((f) => f.name)).toEqual(["f1"]);
		});
	});
});
