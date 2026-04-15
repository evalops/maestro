import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAuth } from "./auth.js";

function createPrivateKey(): string {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	return privateKey.export({ format: "pem", type: "pkcs1" }).toString();
}

describe("GitHubAuth", () => {
	it("returns PAT token when provided", async () => {
		const auth = new GitHubAuth({ token: "pat-123" });
		const token = await auth.getToken();
		expect(token.token).toBe("pat-123");
		expect(token.type).toBe("pat");
	});

	it("generates app JWT when configured", async () => {
		const key = createPrivateKey();
		const auth = new GitHubAuth({
			appId: "12345",
			appPrivateKey: key,
		});
		const jwt = await auth.getAppJwt();
		expect(jwt.split(".")).toHaveLength(3);
	});
});
