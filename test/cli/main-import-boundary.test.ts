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
		vi.doMock(
			"../../src/agent/providers/scripted.js",
			failIfImported("scripted replay provider"),
		);
		vi.doMock(
			"../../src/agent/scenario-source.js",
			failIfImported("scenario source helpers"),
		);
		vi.doMock("../../src/sandbox/index.js", failIfImported("sandbox runtime"));
		vi.doMock(
			"../../src/sandbox/local-sandbox.js",
			failIfImported("local sandbox runtime"),
		);

		try {
			const mainModule = await import("../../src/main.js");
			expect(mainModule.main).toEqual(expect.any(Function));
		} finally {
			vi.doUnmock("../../src/server/approval-service.js");
			vi.doUnmock("../../src/server/client-tools-service.js");
			vi.doUnmock("../../src/server/tool-retry-service.js");
			vi.doUnmock("../../src/tools/ask-user-client.js");
			vi.doUnmock("../../src/agent/providers/scripted.js");
			vi.doUnmock("../../src/agent/scenario-source.js");
			vi.doUnmock("../../src/sandbox/index.js");
			vi.doUnmock("../../src/sandbox/local-sandbox.js");
			vi.resetModules();
		}
	});
});
