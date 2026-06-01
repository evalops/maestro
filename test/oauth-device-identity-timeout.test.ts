import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHelper = process.env.MAESTRO_DEVICE_IDENTITY_HELPER;
const originalAllowTestHelper =
	process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
	process,
	"platform",
);
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
	if (originalHelper === undefined) {
		Reflect.deleteProperty(process.env, "MAESTRO_DEVICE_IDENTITY_HELPER");
	} else {
		process.env.MAESTRO_DEVICE_IDENTITY_HELPER = originalHelper;
	}
	if (originalAllowTestHelper === undefined) {
		Reflect.deleteProperty(
			process.env,
			"MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER",
		);
	} else {
		process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER =
			originalAllowTestHelper;
	}
}

function restorePlatform(): void {
	if (originalPlatformDescriptor) {
		Object.defineProperty(process, "platform", originalPlatformDescriptor);
	}
}

function forcePlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
}

describe("device identity helper timeouts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		process.env.MAESTRO_DEVICE_IDENTITY_HELPER = "/tmp/fake-device-helper";
		process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER = "1";
		forcePlatform("linux");
		globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					challenge: "challenge:refresh:desktop-test-device",
					challenge_id: "challenge-1",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("node:child_process");
		vi.doUnmock("node:fs/promises");
		restoreEnv();
		restorePlatform();
		globalThis.fetch = originalFetch;
	});

	it("allows user-presence signing to outlive the default helper timeout", async () => {
		const kills: string[] = [];
		vi.doMock("node:fs/promises", () => ({
			access: vi.fn(async () => undefined),
			constants: { X_OK: 1 },
		}));
		vi.doMock("node:child_process", () => ({
			spawn: vi.fn(() => {
				const child = new EventEmitter() as EventEmitter & {
					stdout: EventEmitter & { setEncoding: (encoding: string) => void };
					stdin: { end: (input: string) => void };
					kill: (signal: string) => void;
				};
				child.stdout = new EventEmitter() as EventEmitter & {
					setEncoding: (encoding: string) => void;
				};
				child.stdout.setEncoding = vi.fn();
				child.kill = vi.fn((signal: string) => {
					kills.push(signal);
					child.emit("close", null);
				});
				child.stdin = {
					end: (input: string) => {
						const request = JSON.parse(input) as {
							challenge?: string;
							command?: string;
						};
						const base = {
							available: true,
							device_id: "desktop-test-device",
							key_algorithm: "p256_ecdsa_sha256",
							key_origin: "secure_enclave",
							public_key_spki: "fake-p256-public-key-spki",
						};
						const delayMs = request.command === "sign" ? 15_000 : 0;
						setTimeout(() => {
							child.stdout.emit(
								"data",
								JSON.stringify({
									...base,
									...(request.command === "sign"
										? { signature: `fake-signature:${request.challenge}` }
										: {}),
								}),
							);
							child.emit("close", 0);
						}, delayMs);
					},
				};
				return child;
			}),
		}));

		const { buildDesktopDeviceProof } = await import(
			"../src/oauth/device-identity.js"
		);

		const proofPromise = buildDesktopDeviceProof(
			"http://identity.local",
			"refresh",
		);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(kills).toEqual([]);

		await vi.advanceTimersByTimeAsync(5_000);
		await expect(proofPromise).resolves.toEqual({
			challenge_id: "challenge-1",
			device_id: "desktop-test-device",
			signature: "fake-signature:challenge:refresh:desktop-test-device",
		});
	});
});
