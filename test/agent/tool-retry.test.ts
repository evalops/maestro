import {
	type ToolRetryRequest,
	ToolRetryService,
} from "../../src/agent/tool-retry.js";

const buildRequest = (id: string): ToolRetryRequest => ({
	id,
	toolCallId: `call_${id}`,
	toolName: "read",
	args: { path: "/tmp/file.txt" },
	errorMessage: "Network timeout",
	attempt: 1,
});

describe("ToolRetryService", () => {
	it("returns skip decision when mode is skip", async () => {
		const service = new ToolRetryService("skip");
		const decision = await service.requestDecision(buildRequest("skip"));

		expect(decision.action).toBe("skip");
		expect(decision.resolvedBy).toBe("policy");
	});

	it("returns abort decision when mode is abort", async () => {
		const service = new ToolRetryService("abort");
		const decision = await service.requestDecision(buildRequest("abort"));

		expect(decision.action).toBe("abort");
		expect(decision.resolvedBy).toBe("policy");
	});

	it("resolves pending request when user retries", async () => {
		const service = new ToolRetryService("prompt");
		const request = buildRequest("prompt");
		const pending = service.requestDecision(request);

		expect(service.getPendingRequests()).toHaveLength(1);
		expect(service.retry(request.id, "Retrying now")).toBe(true);
		await expect(pending).resolves.toMatchObject({
			action: "retry",
			resolvedBy: "user",
		});
		expect(service.getPendingRequests()).toHaveLength(0);
	});

	it("resolves pending request when user skips", async () => {
		const service = new ToolRetryService("prompt");
		const request = buildRequest("user-skip");
		const pending = service.requestDecision(request);

		expect(service.skip(request.id)).toBe(true);
		await expect(pending).resolves.toMatchObject({
			action: "skip",
			resolvedBy: "user",
		});
	});

	it("resolves pending request when user aborts", async () => {
		const service = new ToolRetryService("prompt");
		const request = buildRequest("user-abort");
		const pending = service.requestDecision(request);

		expect(service.abort(request.id)).toBe(true);
		await expect(pending).resolves.toMatchObject({
			action: "abort",
			resolvedBy: "user",
		});
	});

	it("returns false when resolving non-existent request ID", () => {
		const service = new ToolRetryService("prompt");
		expect(service.retry("non-existent")).toBe(false);
		expect(service.skip("non-existent")).toBe(false);
		expect(service.abort("non-existent")).toBe(false);
	});

	it("aborts pending request when signal fires", async () => {
		const service = new ToolRetryService("prompt");
		const controller = new AbortController();
		const request = buildRequest("signal-abort");
		const pending = service.requestDecision(request, controller.signal);

		expect(service.getPendingRequests()).toHaveLength(1);
		controller.abort();

		const decision = await pending;
		expect(decision.action).toBe("abort");
		expect(decision.resolvedBy).toBe("policy");
		expect(service.getPendingRequests()).toHaveLength(0);
	});

	it("returns abort immediately when signal is already aborted", async () => {
		const service = new ToolRetryService("prompt");
		const controller = new AbortController();
		controller.abort();

		const decision = await service.requestDecision(
			buildRequest("pre-aborted"),
			controller.signal,
		);
		expect(decision.action).toBe("abort");
		expect(decision.resolvedBy).toBe("policy");
	});

	it("clears all pending requests via clearPending()", async () => {
		const service = new ToolRetryService("prompt");
		const p1 = service.requestDecision(buildRequest("clear-1"));
		const p2 = service.requestDecision(buildRequest("clear-2"));
		const p3 = service.requestDecision(buildRequest("clear-3"));

		expect(service.getPendingRequests()).toHaveLength(3);
		service.clearPending("batch cancel");

		const decisions = await Promise.all([p1, p2, p3]);
		for (const d of decisions) {
			expect(d.action).toBe("skip");
			expect(d.reason).toBe("batch cancel");
			expect(d.resolvedBy).toBe("policy");
		}
		expect(service.getPendingRequests()).toHaveLength(0);
	});

	it("allows mode changes via setMode()", async () => {
		const service = new ToolRetryService("prompt");
		expect(service.getMode()).toBe("prompt");
		expect(service.requiresUserInteraction()).toBe(true);

		service.setMode("skip");
		expect(service.getMode()).toBe("skip");
		expect(service.requiresUserInteraction()).toBe(false);

		const decision = await service.requestDecision(buildRequest("mode-change"));
		expect(decision.action).toBe("skip");
	});
});
