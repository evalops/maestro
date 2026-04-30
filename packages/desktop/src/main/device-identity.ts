import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { getDeviceIdentityHelperPath } from "./device-identity-helper-path.js";

export interface DesktopDeviceIdentityStatus {
	available: boolean;
	device_id?: string;
	error?: string;
	key_algorithm?: string;
	key_origin?: string;
	public_key_spki?: string;
}

export async function getDeviceIdentityStatus(): Promise<DesktopDeviceIdentityStatus> {
	const helperPath = getDeviceIdentityHelperPath();
	if (!helperPath) {
		return { available: false, error: "unsupported_platform" };
	}
	try {
		await access(helperPath, constants.X_OK);
	} catch {
		return { available: false, error: "helper_not_found" };
	}
	return new Promise((resolve) => {
		const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
		let stdout = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ available: false, error: "helper_timeout" });
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve({ available: false, error: error.message });
		});
		child.on("close", () => {
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(stdout) as DesktopDeviceIdentityStatus);
			} catch {
				resolve({ available: false, error: "invalid_helper_response" });
			}
		});
		child.stdin.end(JSON.stringify({ command: "status" }));
	});
}
