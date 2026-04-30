import { spawn } from "node:child_process";
import { constants, access } from "node:fs/promises";
import { PLATFORM_HTTP_ROUTES } from "../platform/core-services.js";
import { fetchDownstream } from "../utils/downstream-http.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface DeviceIdentityStatus {
	available: boolean;
	device_id?: string;
	error?: string;
	key_algorithm?: string;
	key_origin?: string;
	public_key_spki?: string;
	signature?: string;
}

export interface DeviceProof {
	challenge_id: string;
	device_id: string;
	signature: string;
}

interface DeviceChallengeResponse {
	challenge?: string;
	challenge_id?: string;
	error?: string;
}

interface RegisterDeviceResponse {
	device?: { id?: string };
	error?: string;
}

function getHelperPath(): string | undefined {
	const value = process.env.MAESTRO_DEVICE_IDENTITY_HELPER?.trim();
	if (!value) {
		return undefined;
	}
	if (process.platform === "darwin") {
		return value;
	}
	return process.env.NODE_ENV === "test" &&
		process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER === "1"
		? value
		: undefined;
}

async function helperExists(helperPath: string): Promise<boolean> {
	try {
		await access(helperPath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function runHelper(
	request: Record<string, unknown>,
): Promise<DeviceIdentityStatus | null> {
	const helperPath = getHelperPath();
	if (!helperPath || !(await helperExists(helperPath))) {
		return null;
	}
	return new Promise((resolve) => {
		const child = spawn(helperPath, [], {
			stdio: ["pipe", "pipe", "ignore"],
			env: { ...process.env },
		});
		let stdout = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, DEFAULT_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
		child.on("close", () => {
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(stdout) as DeviceIdentityStatus);
			} catch {
				resolve(null);
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

export async function getDesktopDeviceIdentityStatus(): Promise<DeviceIdentityStatus | null> {
	return runHelper({ command: "status" });
}

async function signDeviceChallenge(
	challenge: string,
): Promise<DeviceIdentityStatus | null> {
	const response = await runHelper({ command: "sign", challenge });
	if (!response?.available || !response.device_id || !response.signature) {
		return null;
	}
	return response;
}

async function createDeviceChallenge(
	identityBaseUrl: string,
	purpose: string,
	deviceId?: string,
): Promise<DeviceChallengeResponse | null> {
	let response: Response;
	try {
		response = await fetchDownstream(
			`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.deviceChallenges}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					purpose,
					...(deviceId ? { device_id: deviceId } : {}),
				}),
			},
			{
				serviceName: "EvalOps identity service",
				failureMode: "optional",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxAttempts: 1,
			},
		);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
	if (!response.ok) {
		return null;
	}
	try {
		return (await response.json()) as DeviceChallengeResponse;
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
}

export async function buildDesktopDeviceProof(
	identityBaseUrl: string,
	purpose: "refresh" | "delegation" | "verify",
): Promise<DeviceProof | null> {
	const status = await getDesktopDeviceIdentityStatus();
	if (!status?.available || !status.device_id) {
		return null;
	}
	const challenge = await createDeviceChallenge(
		identityBaseUrl,
		purpose,
		status.device_id,
	);
	if (!challenge?.challenge || !challenge.challenge_id) {
		return null;
	}
	const signed = await signDeviceChallenge(challenge.challenge);
	if (!signed?.device_id || !signed.signature) {
		return null;
	}
	return {
		challenge_id: challenge.challenge_id,
		device_id: signed.device_id,
		signature: signed.signature,
	};
}

export async function enrollDesktopDeviceIdentity(
	identityBaseUrl: string,
	accessToken: string,
	appVersion?: string,
): Promise<string | null> {
	const status = await getDesktopDeviceIdentityStatus();
	if (!status?.available || !status.public_key_spki) {
		return null;
	}
	const challenge = await createDeviceChallenge(identityBaseUrl, "enroll");
	if (!challenge?.challenge || !challenge.challenge_id) {
		return null;
	}
	const signed = await signDeviceChallenge(challenge.challenge);
	if (!signed?.device_id || !signed.signature) {
		return null;
	}
	let response: Response;
	try {
		response = await fetchDownstream(
			`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.devices}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					app_bundle_id: "com.evalops.composer",
					app_version: appVersion,
					attestation_kind: "none",
					attestation_status: "unverified",
					challenge_id: challenge.challenge_id,
					device_id: signed.device_id,
					key_algorithm: status.key_algorithm ?? "p256_ecdsa_sha256",
					key_origin: status.key_origin ?? "secure_enclave",
					platform: "macos",
					public_key_spki: status.public_key_spki,
					signature: signed.signature,
				}),
			},
			{
				serviceName: "EvalOps identity service",
				failureMode: "optional",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxAttempts: 1,
			},
		);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
	if (!response.ok) {
		return null;
	}
	let payload: RegisterDeviceResponse | undefined;
	try {
		payload = (await response.json()) as RegisterDeviceResponse;
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
	return payload.device?.id ?? signed.device_id;
}
