import { describe, expect, it } from "vitest";
import {
	type PermissionRequest,
	PermissionRequestHandler,
	approveAll,
	denyAll,
	processConfirmationOutcome,
} from "../../src/agent/permission-handler.js";

function makeRequest(
	overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
	return {
		batchId: "batch-1",
		tools: [
			{ id: "t-1", toolName: "bash", label: "run rg" },
			{ id: "t-2", toolName: "write", label: "write src/x.ts" },
		],
		caller: { cwd: "/repo" },
		...overrides,
	};
}

describe("agent/permission-handler", () => {
	describe("PermissionRequestHandler.requestPermission", () => {
		it("routes the request through the injected function and normalizes the result", async () => {
			const h = new PermissionRequestHandler(async (req) => ({
				outcome: "approved",
				approvedToolIds: req.tools.map((t) => t.id),
			}));
			const decision = await h.requestPermission(makeRequest());
			expect(decision.outcome).toBe("approved");
			expect(decision.approvedToolIds).toEqual(["t-1", "t-2"]);
		});

		it("propagates the decision comment when present", async () => {
			const h = new PermissionRequestHandler(async () => ({
				outcome: "approved-with-comment",
				approvedToolIds: ["t-1", "t-2"],
				comment: "looks good, log it",
			}));
			const decision = await h.requestPermission(makeRequest());
			expect(decision.comment).toBe("looks good, log it");
		});

		it("rejects requests with a blank batchId before calling the injected fn", async () => {
			const calls: number[] = [];
			const h = new PermissionRequestHandler(async () => {
				calls.push(1);
				return approveAll(makeRequest());
			});
			await expect(
				h.requestPermission(makeRequest({ batchId: "  " })),
			).rejects.toThrow(/batchId is required/);
			expect(calls).toHaveLength(0);
		});

		it("rejects requests with no tools", async () => {
			const h = new PermissionRequestHandler(async (req) => approveAll(req));
			await expect(
				h.requestPermission(makeRequest({ tools: [] })),
			).rejects.toThrow(/tools is required and non-empty/);
		});

		it("rejects requests with duplicate tool ids", async () => {
			const h = new PermissionRequestHandler(async (req) => approveAll(req));
			await expect(
				h.requestPermission(
					makeRequest({
						tools: [
							{ id: "t-1", toolName: "bash", label: "a" },
							{ id: "t-1", toolName: "write", label: "b" },
						],
					}),
				),
			).rejects.toThrow(/duplicate tool id/);
		});
	});

	describe("processConfirmationOutcome", () => {
		it("returns approved + every tool id when outcome is approved", () => {
			const request = makeRequest();
			const decision = processConfirmationOutcome(request, {
				outcome: "approved",
				approvedToolIds: ["t-2", "t-1"], // out-of-order
			});
			// Sorted back into request order.
			expect(decision.approvedToolIds).toEqual(["t-1", "t-2"]);
		});

		it("dedupes repeated tool ids", () => {
			const decision = processConfirmationOutcome(makeRequest(), {
				outcome: "approved",
				approvedToolIds: ["t-1", "t-1", "t-2"],
			});
			expect(decision.approvedToolIds).toEqual(["t-1", "t-2"]);
		});

		it("rejects approved ids not present in the request", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved",
					approvedToolIds: ["t-1", "t-2", "ghost"],
				}),
			).toThrow(/"ghost" is not in the request/);
		});

		it("rejects approved-but-not-every-tool when outcome is approved (use approved-with-comment for partial)", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved",
					approvedToolIds: ["t-1"],
				}),
			).toThrow(/does not cover every request tool/);
		});

		it("rejects denied + non-empty approvedToolIds", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "denied",
					approvedToolIds: ["t-1"],
					comment: "no",
				}),
			).toThrow(/outcome is denied but approvedToolIds is non-empty/);
		});

		it("rejects skipped + non-empty approvedToolIds", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "skipped",
					approvedToolIds: ["t-1"],
				}),
			).toThrow(/outcome is skipped but approvedToolIds is non-empty/);
		});

		it("rejects denied without a comment", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "denied",
					approvedToolIds: [],
				}),
			).toThrow(/denied decisions require a non-empty comment/);
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "denied",
					approvedToolIds: [],
					comment: "   ",
				}),
			).toThrow(/denied decisions require a non-empty comment/);
		});

		it("rejects approved-with-comment lacking a comment", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved-with-comment",
					approvedToolIds: ["t-1", "t-2"],
				}),
			).toThrow(/approved-with-comment .* non-empty comment/);
		});

		it("rejects non-string comments with a permission handler error", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "denied",
					approvedToolIds: [],
					comment: 1 as unknown as string,
				}),
			).toThrow(/decision.comment must be a string/);
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved-with-comment",
					approvedToolIds: ["t-1", "t-2"],
					comment: true as unknown as string,
				}),
			).toThrow(/decision.comment must be a string/);
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved",
					approvedToolIds: ["t-1", "t-2"],
					comment: {} as unknown as string,
				}),
			).toThrow(/decision.comment must be a string/);
		});

		it("rejects unknown outcomes", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "yolo" as never,
					approvedToolIds: [],
				}),
			).toThrow(/unknown outcome/);
		});

		it("rejects non-array approvedToolIds and non-string entries", () => {
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved",
					approvedToolIds: "yes" as unknown as string[],
				}),
			).toThrow(/approvedToolIds must be an array/);
			expect(() =>
				processConfirmationOutcome(makeRequest(), {
					outcome: "approved",
					approvedToolIds: [42 as unknown as string],
				}),
			).toThrow(/approvedToolIds must be strings/);
		});
	});

	describe("approveAll / denyAll", () => {
		it("approveAll returns approved with every tool id in request order", () => {
			const d = approveAll(makeRequest());
			expect(d.outcome).toBe("approved");
			expect(d.approvedToolIds).toEqual(["t-1", "t-2"]);
		});

		it("denyAll returns denied with the supplied comment", () => {
			const d = denyAll(makeRequest(), "policy refused");
			expect(d.outcome).toBe("denied");
			expect(d.approvedToolIds).toEqual([]);
			expect(d.comment).toBe("policy refused");
		});

		it("denyAll rejects an empty comment", () => {
			expect(() => denyAll(makeRequest(), "   ")).toThrow(
				/comment must be non-empty/,
			);
		});
	});
});
