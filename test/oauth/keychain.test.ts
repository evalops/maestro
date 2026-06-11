import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFileSync: execFileSyncMock,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value,
	});
}

describe("macOS keychain credential store", () => {
	beforeEach(() => {
		vi.resetModules();
		execFileSyncMock.mockReset();
		setPlatform("darwin");
	});

	afterEach(() => {
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("passes keychain keys and values as literal argv entries", async () => {
		const maliciousKey = 'provider"; touch /tmp/maestro-owned # $(whoami)';
		const maliciousValue =
			'secret"; touch /tmp/maestro-value # `whoami` \\ $HOME';

		execFileSyncMock.mockImplementation((command: string, args: string[]) => {
			if (command === "which") {
				expect(args).toEqual(["security"]);
				return Buffer.from("");
			}
			if (command !== "security") {
				throw new Error(`unexpected command: ${command}`);
			}
			if (args[0] === "find-generic-password") {
				return `${maliciousValue}\n`;
			}
			if (args[0] === "dump-keychain") {
				return [
					`    "svce"<blob>="composer"`,
					`    "acct"<blob>="${maliciousKey}"`,
					`    "svce"<blob>="other"`,
					`    "acct"<blob>="ignored"`,
				].join("\n");
			}
			return Buffer.from("");
		});

		const { secureCredentialStore } = await import(
			"../../src/oauth/keychain.js"
		);

		expect(secureCredentialStore.isUsingKeychain()).toBe(true);
		await secureCredentialStore.set(maliciousKey, maliciousValue);
		expect(await secureCredentialStore.get(maliciousKey)).toBe(maliciousValue);
		await secureCredentialStore.delete(maliciousKey);
		expect(await secureCredentialStore.list()).toEqual([maliciousKey]);

		for (const [command, args] of execFileSyncMock.mock.calls) {
			if (command === "security") {
				expect(Array.isArray(args)).toBe(true);
			}
		}

		expect(execFileSyncMock).toHaveBeenCalledWith(
			"security",
			["delete-generic-password", "-s", "composer", "-a", maliciousKey],
			{ stdio: "ignore" },
		);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"security",
			[
				"add-generic-password",
				"-s",
				"composer",
				"-a",
				maliciousKey,
				"-w",
				maliciousValue,
			],
			{ stdio: "ignore" },
		);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"security",
			["find-generic-password", "-s", "composer", "-a", maliciousKey, "-w"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	});
});
