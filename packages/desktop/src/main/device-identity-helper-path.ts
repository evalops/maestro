import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getDeviceIdentityHelperPath(): string | undefined {
	if (process.env.MAESTRO_DEVICE_IDENTITY_HELPER) {
		if (
			process.platform === "darwin" ||
			(process.env.NODE_ENV === "test" &&
				process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER === "1")
		) {
			return process.env.MAESTRO_DEVICE_IDENTITY_HELPER;
		}
	}
	if (process.platform !== "darwin") {
		return undefined;
	}
	if (
		process.env.NODE_ENV === "development" ||
		process.env.VITE_DEV_SERVER_URL
	) {
		return join(
			app.getAppPath(),
			"native/device-identity/.build/release/maestro-device-identity",
		);
	}
	const resourcesPath = process.resourcesPath || app.getAppPath();
	return join(resourcesPath, "native", "maestro-device-identity");
}
