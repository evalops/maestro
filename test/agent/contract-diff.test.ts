import { describe, expect, it } from "vitest";
import {
	contractsEqual,
	diffContracts,
} from "../../src/agent/contract-diff.js";
import type {
	Assertion,
	AssertionStatus,
	ValidationContract,
} from "../../src/agent/validation-contract.js";

function makeAssertion(
	id: string,
	status: AssertionStatus = "pending",
	overrides: Partial<Assertion> = {},
): Assertion {
	return {
		id,
		description: `assertion ${id}`,
		status,
		...overrides,
	};
}

function makeContract(
	overrides: Partial<ValidationContract> = {},
): ValidationContract {
	return {
		version: 1,
		id: "c-1",
		surface: "ui",
		title: "Test contract",
		createdAt: "2026-06-15T18:00:00.000Z",
		updatedAt: "2026-06-15T18:00:00.000Z",
		areas: [
			{
				name: "auth",
				assertions: [makeAssertion("a-1"), makeAssertion("a-2", "passed")],
			},
		],
		crossAreaFlows: [],
		...overrides,
	};
}

describe("agent/contract-diff", () => {
	describe("diffContracts", () => {
		it("returns empty lists when both contracts are equal", () => {
			const diff = diffContracts(makeContract(), makeContract());
			expect(diff.added).toEqual([]);
			expect(diff.removed).toEqual([]);
			expect(diff.modified).toEqual([]);
			expect(diff.summary).toEqual({
				addedCount: 0,
				removedCount: 0,
				modifiedCount: 0,
			});
		});

		it("flags added assertions", () => {
			const from = makeContract();
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1"),
							makeAssertion("a-2", "passed"),
							makeAssertion("a-3"),
						],
					},
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.added).toEqual([
				{
					id: "a-3",
					surface: "auth",
					description: "assertion a-3",
					status: "pending",
				},
			]);
		});

		it("flags removed assertions", () => {
			const from = makeContract();
			const to = makeContract({
				areas: [{ name: "auth", assertions: [makeAssertion("a-1")] }],
			});
			const diff = diffContracts(from, to);
			expect(diff.removed.map((a) => a.id)).toEqual(["a-2"]);
		});

		it("flags description changes", () => {
			const from = makeContract();
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "pending", {
								description: "renamed assertion",
							}),
							makeAssertion("a-2", "passed"),
						],
					},
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toHaveLength(1);
			expect(diff.modified[0]?.descriptionChanged).toEqual({
				from: "assertion a-1",
				to: "renamed assertion",
			});
		});

		it("flags status transitions", () => {
			const from = makeContract();
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "passed"),
							makeAssertion("a-2", "failed"),
						],
					},
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toHaveLength(2);
			expect(diff.modified.find((m) => m.id === "a-1")?.statusChanged).toEqual({
				from: "pending",
				to: "passed",
			});
			expect(diff.modified.find((m) => m.id === "a-2")?.statusChanged).toEqual({
				from: "passed",
				to: "failed",
			});
		});

		it("flags evidence add/remove", () => {
			const from = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "passed", { evidence: "test/a.test.ts" }),
						],
					},
				],
			});
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "passed", { evidence: "test/b.test.ts" }),
						],
					},
				],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified[0]?.evidenceChanged).toEqual({
				from: "test/a.test.ts",
				to: "test/b.test.ts",
			});
		});

		it("ignores area and flow reordering when assertions stay put", () => {
			const from = makeContract({
				areas: [
					{ name: "auth", assertions: [makeAssertion("area-1")] },
					{ name: "dashboard", assertions: [makeAssertion("area-2")] },
				],
				crossAreaFlows: [
					{ name: "login", assertions: [makeAssertion("flow-1")] },
					{ name: "checkout", assertions: [makeAssertion("flow-2")] },
				],
			});
			const to = makeContract({
				areas: [
					{ name: "dashboard", assertions: [makeAssertion("area-2")] },
					{ name: "auth", assertions: [makeAssertion("area-1")] },
				],
				crossAreaFlows: [
					{ name: "checkout", assertions: [makeAssertion("flow-2")] },
					{ name: "login", assertions: [makeAssertion("flow-1")] },
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toEqual([]);
			expect(contractsEqual(from, to)).toBe(true);
		});

		it("flags surface moves (area → flow or area-to-area)", () => {
			const from = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [makeAssertion("a-1")],
					},
					{ name: "dashboard", assertions: [] },
				],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [
					{ name: "auth", assertions: [] },
					{ name: "dashboard", assertions: [makeAssertion("a-1")] },
				],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified[0]?.movedToSurface).toEqual({
				from: "auth",
				to: "dashboard",
			});
		});

		it("flags moves between same-named area and flow surfaces", () => {
			const from = makeContract({
				areas: [{ name: "checkout", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [{ name: "checkout", assertions: [] }],
			});
			const to = makeContract({
				areas: [{ name: "checkout", assertions: [] }],
				crossAreaFlows: [
					{ name: "checkout", assertions: [makeAssertion("a-1")] },
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toEqual([
				{
					id: "a-1",
					surface: "checkout",
					movedToSurface: {
						from: "checkout",
						to: "checkout",
					},
				},
			]);
		});

		it("flags surface renames even when container order stays the same", () => {
			const from = makeContract({
				areas: [{ name: "auth", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [{ name: "signin", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toEqual([
				{
					id: "a-1",
					surface: "signin",
					movedToSurface: {
						from: "auth",
						to: "signin",
					},
				},
			]);
		});

		it("flags moves between duplicate area names", () => {
			const from = makeContract({
				areas: [
					{ name: "checkout", assertions: [makeAssertion("a-1")] },
					{ name: "checkout", assertions: [] },
				],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [
					{ name: "checkout", assertions: [] },
					{ name: "checkout", assertions: [makeAssertion("a-1")] },
				],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.modified).toEqual([
				{
					id: "a-1",
					surface: "checkout",
					movedToSurface: {
						from: "checkout",
						to: "checkout",
					},
				},
			]);
		});

		it("sorts every list by assertion id ascending", () => {
			const from = makeContract({
				areas: [{ name: "auth", assertions: [] }],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("z-1"),
							makeAssertion("a-1"),
							makeAssertion("m-1"),
						],
					},
				],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.added.map((a) => a.id)).toEqual(["a-1", "m-1", "z-1"]);
		});

		it("handles diffs across cross-area flows", () => {
			const from = makeContract({
				areas: [{ name: "auth", assertions: [] }],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [{ name: "auth", assertions: [] }],
				crossAreaFlows: [
					{
						name: "login-then-redirect",
						assertions: [makeAssertion("flow-1")],
					},
				],
			});
			const diff = diffContracts(from, to);
			expect(diff.added).toEqual([
				{
					id: "flow-1",
					surface: "login-then-redirect",
					description: "assertion flow-1",
					status: "pending",
				},
			]);
		});

		it("populates summary counters", () => {
			const from = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1"),
							makeAssertion("a-2", "passed"),
							makeAssertion("a-removed"),
						],
					},
				],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [
					{
						name: "auth",
						assertions: [
							makeAssertion("a-1", "passed"),
							makeAssertion("a-2", "passed"),
							makeAssertion("a-added"),
						],
					},
				],
				crossAreaFlows: [],
			});
			const diff = diffContracts(from, to);
			expect(diff.summary).toEqual({
				addedCount: 1,
				removedCount: 1,
				modifiedCount: 1,
			});
		});
	});

	describe("contractsEqual", () => {
		it("returns true for identical contracts", () => {
			expect(contractsEqual(makeContract(), makeContract())).toBe(true);
		});

		it("returns false when assertions differ", () => {
			const from = makeContract();
			const to = makeContract({
				areas: [{ name: "auth", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [],
			});
			expect(contractsEqual(from, to)).toBe(false);
		});

		it("returns false when an assertion moves between same-named surfaces", () => {
			const from = makeContract({
				areas: [{ name: "checkout", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [{ name: "checkout", assertions: [] }],
			});
			const to = makeContract({
				areas: [{ name: "checkout", assertions: [] }],
				crossAreaFlows: [
					{ name: "checkout", assertions: [makeAssertion("a-1")] },
				],
			});
			expect(contractsEqual(from, to)).toBe(false);
		});

		it("returns false when an assertion stays in place but its surface is renamed", () => {
			const from = makeContract({
				areas: [{ name: "auth", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [],
			});
			const to = makeContract({
				areas: [{ name: "signin", assertions: [makeAssertion("a-1")] }],
				crossAreaFlows: [],
			});
			expect(contractsEqual(from, to)).toBe(false);
		});
	});
});
