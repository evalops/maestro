import { describe, expect, it, vi } from "vitest";

describe("main import boundary", () => {
	it("keeps headless and interactive client-tool services out of the default import path", async () => {
		vi.resetModules();
		const failIfImported = (moduleName: string) => () => {
			throw new Error(`${moduleName} should stay lazy during main import`);
		};

		vi.doMock(
			"../../src/server/approval-service.js",
			failIfImported("server approval service"),
		);
		vi.doMock(
			"../../src/server/client-tools-service.js",
			failIfImported("server client tool service"),
		);
		vi.doMock(
			"../../src/server/tool-retry-service.js",
			failIfImported("server tool retry service"),
		);
		vi.doMock(
			"../../src/tools/ask-user-client.js",
			failIfImported("ask_user client tool"),
		);

		try {
			const mainModule = await import("../../src/main.js");
			expect(mainModule.main).toEqual(expect.any(Function));
		} finally {
			vi.doUnmock("../../src/server/approval-service.js");
			vi.doUnmock("../../src/server/client-tools-service.js");
			vi.doUnmock("../../src/server/tool-retry-service.js");
			vi.doUnmock("../../src/tools/ask-user-client.js");
			vi.resetModules();
		}
	});
});
