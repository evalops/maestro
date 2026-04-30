import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildDesktopDeviceProof,
	enrollDesktopDeviceIdentity,
} from "../src/oauth/device-identity.js";
import { PLATFORM_HTTP_ROUTES } from "../src/platform/core-services.js";

interface CapturedRequest {
	authorization?: string;
	body: Record<string, unknown>;
	method: string;
	url: string;
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
	process,
	"platform",
);
const originalHelper = process.env.MAESTRO_DEVICE_IDENTITY_HELPER;
const originalAllowTestHelper =
	process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER;
const originalFetch = globalThis.fetch;

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

function restoreFetch(): void {
	globalThis.fetch = originalFetch;
}

function readRequestBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}") as Record<string, unknown>);
			} catch {
				resolve({});
			}
		});
	});
}

function writeJson(
	res: ServerResponse,
	statusCode: number,
	body: Record<string, unknown>,
): void {
	res.writeHead(statusCode, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function startIdentityHarness() {
	const requests: CapturedRequest[] = [];
	let challengeCount = 0;
	const server = createServer(async (req, res) => {
		const body = await readRequestBody(req);
		requests.push({
			authorization: req.headers.authorization,
			body,
			method: req.method ?? "GET",
			url: req.url ?? "/",
		});

		if (
			req.method === "POST" &&
			req.url === PLATFORM_HTTP_ROUTES.identity.deviceChallenges
		) {
			challengeCount += 1;
			const purpose = String(body.purpose ?? "unknown");
			const deviceId = body.device_id ? String(body.device_id) : "none";
			writeJson(res, 200, {
				challenge: `challenge:${purpose}:${deviceId}`,
				challenge_id: `challenge-${challengeCount}`,
			});
			return;
		}

		if (
			req.method === "POST" &&
			req.url === PLATFORM_HTTP_ROUTES.identity.devices
		) {
			writeJson(res, 200, { device: { id: body.device_id } });
			return;
		}

		writeJson(res, 404, { error: "not-found" });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("identity harness failed to bind to a TCP port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			}),
		requests,
	};
}

describe("device identity local harness", () => {
	beforeEach(() => {
		process.env.MAESTRO_DEVICE_IDENTITY_HELPER = fileURLToPath(
			new URL("../scripts/fake-device-identity-helper.mjs", import.meta.url),
		);
		process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER = "1";
		forcePlatform("linux");
	});

	afterEach(() => {
		restorePlatform();
		restoreEnv();
		restoreFetch();
	});

	it("builds a desktop proof against a local identity challenge service", async () => {
		const harness = await startIdentityHarness();
		try {
			const proof = await buildDesktopDeviceProof(harness.baseUrl, "refresh");

			expect(proof).toEqual({
				challenge_id: "challenge-1",
				device_id: "desktop-test-device",
				signature: "fake-signature:challenge:refresh:desktop-test-device",
			});
			expect(harness.requests).toHaveLength(1);
			expect(harness.requests[0]).toMatchObject({
				body: { device_id: "desktop-test-device", purpose: "refresh" },
				method: "POST",
				url: PLATFORM_HTTP_ROUTES.identity.deviceChallenges,
			});
		} finally {
			await harness.close();
		}
	});

	it("enrolls the fake desktop device with the signed local challenge", async () => {
		const harness = await startIdentityHarness();
		try {
			const deviceId = await enrollDesktopDeviceIdentity(
				harness.baseUrl,
				"access-token",
				"1.2.3-test",
			);

			expect(deviceId).toBe("desktop-test-device");
			expect(harness.requests).toHaveLength(2);
			expect(harness.requests[0]).toMatchObject({
				body: { purpose: "enroll" },
				method: "POST",
				url: PLATFORM_HTTP_ROUTES.identity.deviceChallenges,
			});
			expect(harness.requests[1]).toMatchObject({
				authorization: "Bearer access-token",
				body: {
					app_bundle_id: "com.evalops.composer",
					app_version: "1.2.3-test",
					attestation_kind: "none",
					attestation_status: "unverified",
					challenge_id: "challenge-1",
					device_id: "desktop-test-device",
					key_algorithm: "p256_ecdsa_sha256",
					key_origin: "secure_enclave",
					platform: "macos",
					public_key_spki: "fake-p256-public-key-spki",
					signature: "fake-signature:challenge:enroll:none",
				},
				method: "POST",
				url: PLATFORM_HTTP_ROUTES.identity.devices,
			});
		} finally {
			await harness.close();
		}
	});

	it("propagates AbortError while parsing the enrollment response", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.endsWith(PLATFORM_HTTP_ROUTES.identity.deviceChallenges)) {
				return new Response(
					JSON.stringify({
						challenge: "challenge:enroll:none",
						challenge_id: "challenge-1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.endsWith(PLATFORM_HTTP_ROUTES.identity.devices)) {
				return {
					ok: true,
					json: async () => {
						throw abortError;
					},
				} as Response;
			}
			return new Response(JSON.stringify({ error: "not-found" }), {
				status: 404,
			});
		}) as typeof fetch;

		await expect(
			enrollDesktopDeviceIdentity("http://identity.local", "access-token"),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
