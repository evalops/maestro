import { describe, expect, it } from "vitest";
import { createDefaultServers } from "../../src/lsp/servers.js";

describe("LSP servers", () => {
	it("should create default servers based on available binaries", async () => {
		const servers = await createDefaultServers();

		// Should return an array
		expect(Array.isArray(servers)).toBe(true);

		// Check that each server has the required properties
		for (const server of servers) {
			expect(server).toHaveProperty("id");
			expect(server).toHaveProperty("name");
			expect(server).toHaveProperty("command");
			expect(server).toHaveProperty("args");
			expect(server).toHaveProperty("extensions");
			expect(Array.isArray(server.extensions)).toBe(true);
			expect(server.extensions.length).toBeGreaterThan(0);
		}
	});

	it("should include TypeScript server if available", async () => {
		const servers = await createDefaultServers();
		const tsServer = servers.find((s) => s.id === "typescript");

		if (tsServer) {
			expect(tsServer.name).toBe("TypeScript Language Server");
			expect(tsServer.extensions).toContain(".ts");
			expect(tsServer.extensions).toContain(".tsx");
			expect(tsServer.extensions).toContain(".js");
			expect(tsServer.extensions).toContain(".jsx");
		}
	});

	it("should include Python server if available", async () => {
		const servers = await createDefaultServers();
		const pyServer = servers.find((s) => s.id === "python");

		if (pyServer) {
			expect(pyServer.name).toBe("Pyright Language Server");
			expect(pyServer.extensions).toContain(".py");
		}
	});

	it("should include Go server if available", async () => {
		const servers = await createDefaultServers();
		const goServer = servers.find((s) => s.id === "go");

		if (goServer) {
			expect(goServer.name).toBe("Go Language Server");
			expect(goServer.extensions).toContain(".go");
		}
	});

	it("should include Rust server if available", async () => {
		const servers = await createDefaultServers();
		const rustServer = servers.find((s) => s.id === "rust");

		if (rustServer) {
			expect(rustServer.name).toBe("Rust Analyzer");
			expect(rustServer.extensions).toContain(".rs");
		}
	});

	it("should include Vue server if available", async () => {
		const servers = await createDefaultServers();
		const vueServer = servers.find((s) => s.id === "vue");

		if (vueServer) {
			expect(vueServer.name).toBe("Vue Language Server");
			expect(vueServer.extensions).toContain(".vue");
		}
	});

	it("should accept a custom root resolver", async () => {
		const customResolver = async (file: string) => "/custom/root";
		const servers = await createDefaultServers(customResolver);

		for (const server of servers) {
			expect(server.rootResolver).toBe(customResolver);
		}
	});

	it("should not duplicate server IDs", async () => {
		const servers = await createDefaultServers();
		const ids = servers.map((s) => s.id);
		const uniqueIds = new Set(ids);
		expect(ids.length).toBe(uniqueIds.size);
	});
});
