import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value,
	});
}

function fileMode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("credential file permissions", () => {
	let testDir: string;

	beforeEach(() => {
		vi.resetModules();
		testDir = join(tmpdir(), `maestro-credential-modes-${Date.now()}`);
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		// File mode pin — this suite specifically tests
		// `oauth.json` permission bits, which only exist in file
		// mode (#2611).
		process.env.MAESTRO_OAUTH_STORAGE_MODE = "file";
		mkdirSync(testDir, { recursive: true, mode: 0o700 });
	});

	afterEach(() => {
		delete process.env.MAESTRO_OAUTH_STORAGE_MODE;
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		delete process.env.MAESTRO_AGENT_DIR;
	});

	it("creates and overwrites oauth.json with owner-only permissions", async () => {
		const oauthPath = join(testDir, "oauth.json");
		writeFileSync(oauthPath, "{}", { encoding: "utf-8", mode: 0o644 });
		chmodSync(oauthPath, 0o644);

		const { saveOAuthCredentials } = await import("../../src/oauth/storage.js");
		saveOAuthCredentials("test-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		expect(fileMode(oauthPath)).toBe(0o600);
	});

	it("creates encrypted fallback credentials with owner-only permissions", async () => {
		setPlatform("linux");

		const { secureCredentialStore } = await import(
			"../../src/oauth/keychain.js"
		);
		await secureCredentialStore.set("test-provider", "secret-token");

		expect(fileMode(join(testDir, ".credentials.enc"))).toBe(0o600);
	});
});
