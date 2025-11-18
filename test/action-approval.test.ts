import { describe, expect, it } from "vitest";
import { ActionApprovalService } from "../src/agent/action-approval.js";

describe("ActionApprovalService", () => {
	it("reports and updates approval mode", () => {
		const service = new ActionApprovalService();
		expect(service.getMode()).toBe("prompt");
		service.setMode("auto");
		expect(service.getMode()).toBe("auto");
	});
});
